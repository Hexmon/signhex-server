import { randomUUID } from 'crypto';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import {
  createScheduleReservationRepository,
  type ScheduleReservationState,
} from '@/db/repositories/schedule-reservation';
import { AppError } from '@/utils/app-error';

type DBLike = ReturnType<typeof getDatabase> | any;

const HOLD_TTL_MS = 4 * 60 * 60 * 1000;
const ACTIVE_STATES = new Set<ScheduleReservationState>(['HELD', 'RESERVED', 'PUBLISHED']);

export type ReservationConflictItem = {
  screen_id: string;
  screen_name: string;
  start_at: string;
  end_at: string;
  conflict_start_at: string;
  conflict_end_at: string;
  state: ScheduleReservationState;
  hold_expires_at: string | null;
  owned_by_current_user: boolean;
  schedule_request_id?: string | null;
  schedule_id?: string | null;
};

export type ReservationPreviewResult = {
  resolved_screen_ids: string[];
  reservation_conflicts: ReservationConflictItem[];
};

type ReservationWindow = {
  screen_id: string;
  schedule_id: string;
  schedule_item_id: string;
  start_at: Date;
  end_at: Date;
};

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function isOverlap(startAt: Date, endAt: Date, otherStart: Date, otherEnd: Date) {
  return otherStart < endAt && startAt < otherEnd;
}

function normalizePgConstraintError(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const code = 'code' in error ? String((error as any).code) : '';
  const constraint = 'constraint' in error ? String((error as any).constraint ?? '') : '';
  return { code, constraint };
}

export class ScheduleReservationService {
  private repo = createScheduleReservationRepository();

  async expireStaleHolds(db: DBLike = getDatabase()) {
    return this.repo.expireStaleHolds(new Date(), db);
  }

  async resolveScreenIds(screenIds: string[] = [], screenGroupIds: string[] = [], db: DBLike = getDatabase()) {
    const resolved = new Set<string>(screenIds);
    if (screenGroupIds.length === 0) {
      return Array.from(resolved);
    }

    const members = await db
      .select({
        group_id: schema.screenGroupMembers.group_id,
        screen_id: schema.screenGroupMembers.screen_id,
      })
      .from(schema.screenGroupMembers)
      .where(inArray(schema.screenGroupMembers.group_id, Array.from(new Set(screenGroupIds)) as any));

    for (const member of members) {
      resolved.add(member.screen_id);
    }

    return Array.from(resolved);
  }

  async resolveScheduleWindows(
    params: {
      scheduleId: string;
      explicitScreenIds?: string[];
      explicitScreenGroupIds?: string[];
    },
    db: DBLike = getDatabase()
  ): Promise<{
    schedule: typeof schema.schedules.$inferSelect;
    scheduleItems: Array<typeof schema.scheduleItems.$inferSelect>;
    windows: ReservationWindow[];
    resolvedScreenIds: string[];
  }> {
    const [schedule] = await db.select().from(schema.schedules).where(eq(schema.schedules.id, params.scheduleId));
    if (!schedule) {
      throw AppError.notFound('Schedule not found');
    }

    const scheduleItems = await db
      .select()
      .from(schema.scheduleItems)
      .where(eq(schema.scheduleItems.schedule_id, params.scheduleId));

    if (scheduleItems.length === 0) {
      throw AppError.badRequest('Cannot submit or publish a schedule without schedule items');
    }

    const allGroupIds = Array.from(
      new Set([
        ...(params.explicitScreenGroupIds ?? []),
        ...scheduleItems.flatMap((item: typeof schema.scheduleItems.$inferSelect) => (item.screen_group_ids ?? []) as string[]),
      ])
    );

    const members = allGroupIds.length
      ? await db
          .select({
            group_id: schema.screenGroupMembers.group_id,
            screen_id: schema.screenGroupMembers.screen_id,
          })
          .from(schema.screenGroupMembers)
          .where(inArray(schema.screenGroupMembers.group_id, allGroupIds as any))
      : [];

    const groupMemberMap = new Map<string, string[]>();
    for (const member of members) {
      const list = groupMemberMap.get(member.group_id) ?? [];
      list.push(member.screen_id);
      groupMemberMap.set(member.group_id, list);
    }

    const expandGroups = (groupIds: string[] = []) => {
      const ids = new Set<string>();
      for (const groupId of groupIds) {
        for (const screenId of groupMemberMap.get(groupId) ?? []) {
          ids.add(screenId);
        }
      }
      return ids;
    };

    const publishScopeScreenIds = new Set<string>(params.explicitScreenIds ?? []);
    for (const screenId of expandGroups(params.explicitScreenGroupIds ?? [])) {
      publishScopeScreenIds.add(screenId);
    }

    const itemDerivedScreenIds = new Set<string>();
    for (const item of scheduleItems) {
      for (const screenId of (item.screen_ids ?? []) as string[]) {
        itemDerivedScreenIds.add(screenId);
      }
      for (const screenId of expandGroups((item.screen_group_ids ?? []) as string[])) {
        itemDerivedScreenIds.add(screenId);
      }
    }

    const resolvedScreenIds = new Set<string>(publishScopeScreenIds);
    if (resolvedScreenIds.size === 0) {
      for (const screenId of itemDerivedScreenIds) {
        resolvedScreenIds.add(screenId);
      }
    }

    if (resolvedScreenIds.size === 0) {
      throw AppError.badRequest('No target screens found');
    }

    const windows: ReservationWindow[] = [];
    for (const item of scheduleItems) {
      const targetedScreenIds = new Set<string>();
      for (const screenId of (item.screen_ids ?? []) as string[]) {
        targetedScreenIds.add(screenId);
      }
      for (const screenId of expandGroups((item.screen_group_ids ?? []) as string[])) {
        targetedScreenIds.add(screenId);
      }
      if (targetedScreenIds.size === 0) {
        for (const screenId of resolvedScreenIds) {
          targetedScreenIds.add(screenId);
        }
      }

      for (const screenId of targetedScreenIds) {
        windows.push({
          screen_id: screenId,
          schedule_id: params.scheduleId,
          schedule_item_id: item.id,
          start_at: item.start_at,
          end_at: item.end_at,
        });
      }
    }

    return {
      schedule,
      scheduleItems,
      windows,
      resolvedScreenIds: Array.from(resolvedScreenIds),
    };
  }

  async buildConflictPayload(
    params: {
      windows: ReservationWindow[];
      currentUserId: string;
      allowPrivateRefs: boolean;
      excludeRequestId?: string | null;
    },
    db: DBLike = getDatabase()
  ): Promise<ReservationConflictItem[]> {
    await this.expireStaleHolds(db);

    const screenIds = Array.from(new Set(params.windows.map((window) => window.screen_id)));
    if (screenIds.length === 0) return [];

    const [screens, existingReservations] = await Promise.all([
      db
        .select({ id: schema.screens.id, name: schema.screens.name })
        .from(schema.screens)
        .where(inArray(schema.screens.id, screenIds as any)),
      db
        .select()
        .from(schema.scheduleReservations)
        .where(
          and(
            inArray(schema.scheduleReservations.screen_id, screenIds as any),
            inArray(schema.scheduleReservations.state, ['HELD', 'RESERVED', 'PUBLISHED'] as any)
          )
        ),
    ]);

    const screenNameMap = new Map(screens.map((screen: any) => [screen.id, screen.name]));
    const conflicts: ReservationConflictItem[] = [];

    for (const window of params.windows) {
      for (const existing of existingReservations) {
        if (params.excludeRequestId && existing.schedule_request_id === params.excludeRequestId) {
          continue;
        }
        if (existing.screen_id !== window.screen_id) continue;
        if (!ACTIVE_STATES.has(existing.state as ScheduleReservationState)) continue;
        if (!isOverlap(window.start_at, window.end_at, existing.start_at, existing.end_at)) continue;

        conflicts.push({
          screen_id: existing.screen_id,
          screen_name: screenNameMap.get(existing.screen_id) ?? existing.screen_id,
          start_at: window.start_at.toISOString(),
          end_at: window.end_at.toISOString(),
          conflict_start_at: existing.start_at.toISOString(),
          conflict_end_at: existing.end_at.toISOString(),
          state: existing.state as ScheduleReservationState,
          hold_expires_at: toIso(existing.hold_expires_at),
          owned_by_current_user: existing.owner_user_id === params.currentUserId,
          ...(params.allowPrivateRefs || existing.owner_user_id === params.currentUserId
            ? {
                schedule_request_id: existing.schedule_request_id ?? null,
                schedule_id: existing.schedule_id,
              }
            : {}),
        });
      }
    }

    const deduped = new Map<string, ReservationConflictItem>();
    for (const conflict of conflicts) {
      const key = [
        conflict.screen_id,
        conflict.start_at,
        conflict.end_at,
        conflict.conflict_start_at,
        conflict.conflict_end_at,
        conflict.state,
        conflict.schedule_request_id ?? '',
        conflict.schedule_id ?? '',
      ].join('|');
      if (!deduped.has(key)) {
        deduped.set(key, conflict);
      }
    }

    return Array.from(deduped.values()).sort((left, right) => {
      if (left.screen_name !== right.screen_name) return left.screen_name.localeCompare(right.screen_name);
      return left.conflict_start_at.localeCompare(right.conflict_start_at);
    });
  }

  async previewConflicts(
    params: {
      scheduleId?: string;
      startAt?: Date;
      endAt?: Date;
      screenIds?: string[];
      screenGroupIds?: string[];
      currentUserId: string;
      allowPrivateRefs: boolean;
    },
    db: DBLike = getDatabase()
  ): Promise<ReservationPreviewResult> {
    await this.expireStaleHolds(db);

    let windows: ReservationWindow[] = [];
    let resolvedScreenIds: string[] = [];
    if (params.scheduleId) {
      const resolved = await this.resolveScheduleWindows({ scheduleId: params.scheduleId }, db);
      windows = resolved.windows;
      resolvedScreenIds = resolved.resolvedScreenIds;
    } else {
      if (!params.startAt || !params.endAt) {
        throw AppError.validation([
          { field: 'start_at', message: 'start_at is required' },
          { field: 'end_at', message: 'end_at is required' },
        ]);
      }
      resolvedScreenIds = await this.resolveScreenIds(params.screenIds, params.screenGroupIds, db);
      windows = resolvedScreenIds.map((screenId) => ({
        screen_id: screenId,
        schedule_id: '',
        schedule_item_id: '',
        start_at: params.startAt!,
        end_at: params.endAt!,
      }));
    }

    return {
      resolved_screen_ids: resolvedScreenIds,
      reservation_conflicts: await this.buildConflictPayload(
        {
          windows,
          currentUserId: params.currentUserId,
          allowPrivateRefs: params.allowPrivateRefs,
        },
        db
      ),
    };
  }

  async acquireHoldsForRequest(
    params: {
      scheduleRequestId: string;
      scheduleId: string;
      ownerUserId: string;
      allowPrivateRefs: boolean;
    },
    db: DBLike = getDatabase()
  ) {
    await this.expireStaleHolds(db);
    const resolved = await this.resolveScheduleWindows({ scheduleId: params.scheduleId }, db);
    const holdExpiresAt = new Date(Date.now() + HOLD_TTL_MS);

    const [request] = await db
      .select()
      .from(schema.scheduleRequests)
      .where(eq(schema.scheduleRequests.id, params.scheduleRequestId));
    if (!request) {
      throw AppError.notFound('Schedule request not found');
    }

    const existingRows = await this.repo.listActiveByRequest(params.scheduleRequestId, db);
    if (
      existingRows.length === resolved.windows.length &&
      existingRows.length > 0 &&
      request.reservation_version === resolved.schedule.revision &&
      request.reservation_token
    ) {
      return {
        reservation_token: request.reservation_token,
        reservation_version: request.reservation_version,
        reservation_state: request.reservation_state ?? 'HELD',
        hold_expires_at: toIso(request.hold_expires_at),
        resolved_screen_ids: resolved.resolvedScreenIds,
      };
    }

    const conflicts = await this.buildConflictPayload(
      {
        windows: resolved.windows,
        currentUserId: params.ownerUserId,
        allowPrivateRefs: params.allowPrivateRefs,
        excludeRequestId: params.scheduleRequestId,
      },
      db
    );
    if (conflicts.length > 0) {
      throw AppError.conflict('Selected screens already have active schedule ownership for part of this time window.', {
        conflict_type: 'SCREEN_TIME_WINDOW_CONFLICT',
        reservation_conflicts: conflicts,
      });
    }

    const reservationToken = randomUUID();
    const reservationVersion = resolved.schedule.revision;
    const rows = resolved.windows.map((window) => ({
      screen_id: window.screen_id,
      schedule_id: params.scheduleId,
      schedule_item_id: window.schedule_item_id,
      schedule_request_id: params.scheduleRequestId,
      owner_user_id: params.ownerUserId,
      state: 'HELD' as const,
      start_at: window.start_at,
      end_at: window.end_at,
      hold_expires_at: holdExpiresAt,
      reservation_token: reservationToken,
      reservation_version: reservationVersion,
    }));

    try {
      await this.repo.insertMany(rows, db);
    } catch (error) {
      const normalized = normalizePgConstraintError(error);
      if (normalized?.code === '23P01') {
        const retryConflicts = await this.buildConflictPayload(
          {
            windows: resolved.windows,
            currentUserId: params.ownerUserId,
            allowPrivateRefs: params.allowPrivateRefs,
            excludeRequestId: params.scheduleRequestId,
          },
          db
        );
        throw AppError.conflict('Selected screens already have active schedule ownership for part of this time window.', {
          conflict_type: 'SCREEN_TIME_WINDOW_CONFLICT',
          reservation_conflicts: retryConflicts,
        });
      }
      throw error;
    }

    await db
      .update(schema.scheduleRequests)
      .set({
        reservation_token: reservationToken,
        reservation_version: reservationVersion,
        reservation_state: 'HELD',
        hold_expires_at: holdExpiresAt,
        updated_at: new Date(),
      })
      .where(eq(schema.scheduleRequests.id, params.scheduleRequestId));

    return {
      reservation_token: reservationToken,
      reservation_version: reservationVersion,
      reservation_state: 'HELD',
      hold_expires_at: holdExpiresAt.toISOString(),
      resolved_screen_ids: resolved.resolvedScreenIds,
    };
  }

  async promoteRequestHold(
    params: {
      scheduleRequestId: string;
      reviewerId: string;
      reviewNotes?: string | null;
    },
    db: DBLike = getDatabase()
  ) {
    await this.expireStaleHolds(db);

    const [request] = await db
      .select()
      .from(schema.scheduleRequests)
      .where(eq(schema.scheduleRequests.id, params.scheduleRequestId));
    if (!request) throw AppError.notFound('Schedule request not found');
    if (request.status === 'EXPIRED') {
      throw AppError.conflict('The pending hold expired before approval. Refresh and resubmit the request.');
    }

    const [schedule] = await db.select().from(schema.schedules).where(eq(schema.schedules.id, request.schedule_id));
    if (!schedule) throw AppError.notFound('Schedule not found');
    if ((request.reservation_version ?? 0) !== schedule.revision) {
      throw AppError.conflict('The schedule changed after the hold was created. Cancel and resubmit the request.', {
        conflict_type: 'STALE_RESERVATION',
      });
    }

    const rows = await this.repo.listActiveByRequest(params.scheduleRequestId, db);
    if (rows.length === 0) {
      throw AppError.conflict('No active hold exists for this request. Refresh and resubmit.', {
        conflict_type: 'MISSING_RESERVATION',
      });
    }

    const hasExpiredHold = rows.some((row: any) => row.state === 'HELD' && row.hold_expires_at && row.hold_expires_at < new Date());
    if (hasExpiredHold) {
      throw AppError.conflict('The pending hold expired before approval. Refresh and resubmit the request.');
    }

    if (request.status === 'APPROVED' && rows.every((row: any) => row.state === 'RESERVED')) {
      return {
        reservation_state: 'RESERVED',
        reservation_token: request.reservation_token,
        reservation_version: request.reservation_version,
      };
    }

    await this.repo.promoteHeldToReserved(params.scheduleRequestId, new Date(), db);
    await db
      .update(schema.scheduleRequests)
      .set({
        status: 'APPROVED',
        reviewed_by: params.reviewerId,
        reviewed_at: new Date(),
        review_notes: params.reviewNotes ?? undefined,
        reservation_state: 'RESERVED',
        hold_expires_at: null,
        updated_at: new Date(),
      })
      .where(eq(schema.scheduleRequests.id, params.scheduleRequestId));

    return {
      reservation_state: 'RESERVED',
      reservation_token: request.reservation_token,
      reservation_version: request.reservation_version,
    };
  }

  async releaseRequestReservations(
    params: {
      scheduleRequestId: string;
      nextStatus: typeof schema.scheduleRequestStatusEnum.enumValues[number];
      releaseState: Extract<ScheduleReservationState, 'RELEASED' | 'CANCELLED' | 'EXPIRED'>;
      releaseReason: string;
      reviewedBy?: string | null;
      reviewNotes?: string | null;
    },
    db: DBLike = getDatabase()
  ) {
    await this.repo.markRequestReservationsReleased(params.scheduleRequestId, params.releaseState, params.releaseReason, db);
    await db
      .update(schema.scheduleRequests)
      .set({
        status: params.nextStatus,
        reviewed_by: params.reviewedBy ?? null,
        reviewed_at: params.reviewedBy ? new Date() : undefined,
        review_notes: params.reviewNotes ?? undefined,
        reservation_state: params.releaseState,
        hold_expires_at: null,
        updated_at: new Date(),
      })
      .where(eq(schema.scheduleRequests.id, params.scheduleRequestId));
  }

  async assertScheduleMutable(scheduleId: string, db: DBLike = getDatabase()) {
    await this.expireStaleHolds(db);
    const [reservation] = await db
      .select()
      .from(schema.scheduleReservations)
      .where(
        and(
          eq(schema.scheduleReservations.schedule_id, scheduleId),
          inArray(schema.scheduleReservations.state, ['HELD', 'RESERVED', 'PUBLISHED'] as any),
          isNotNull(schema.scheduleReservations.schedule_request_id)
        )
      )
      .limit(1);

    if (reservation?.schedule_request_id) {
      throw AppError.conflict('This schedule already has an active held, reserved, or published request. Cancel or reject that request before editing the schedule.', {
        conflict_type: 'ACTIVE_SCHEDULE_RESERVATION',
        schedule_request_id: reservation.schedule_request_id,
      });
    }
  }

  async validateApprovedRequestForPublish(
    scheduleRequestId: string,
    db: DBLike = getDatabase()
  ) {
    await this.expireStaleHolds(db);
    const [request] = await db
      .select()
      .from(schema.scheduleRequests)
      .where(eq(schema.scheduleRequests.id, scheduleRequestId));
    if (!request) throw AppError.notFound('Schedule request not found');

    const rows = await this.repo.listActiveByRequest(scheduleRequestId, db);
    const publishId = Array.from(new Set(rows.map((row: any) => row.publish_id).filter(Boolean)))[0] as string | undefined;

    if (request.status === 'PUBLISHED' && publishId) {
      return {
        request,
        alreadyPublished: true,
        publishId,
      };
    }

    if (request.status !== 'APPROVED') {
      throw AppError.badRequest('Schedule request must be APPROVED to publish');
    }

    const [schedule] = await db.select().from(schema.schedules).where(eq(schema.schedules.id, request.schedule_id));
    if (!schedule) throw AppError.notFound('Schedule not found');
    if ((request.reservation_version ?? 0) !== schedule.revision) {
      throw AppError.conflict('The reservation is stale because the schedule changed. Cancel and resubmit the request.', {
        conflict_type: 'STALE_RESERVATION',
      });
    }

    const reservedRows = rows.filter((row: any) => row.state === 'RESERVED');
    if (reservedRows.length === 0) {
      throw AppError.conflict('The request no longer owns its reserved screen windows. Refresh and resubmit.', {
        conflict_type: 'MISSING_RESERVATION',
      });
    }

    return {
      request,
      alreadyPublished: false,
      publishId: null,
    };
  }

  async finalizeRequestPublish(
    params: {
      scheduleRequestId: string;
      publishId: string;
    },
    db: DBLike = getDatabase()
  ) {
    await this.repo.finalizeRequestPublish(params.scheduleRequestId, params.publishId, db);
    await db
      .update(schema.scheduleRequests)
      .set({
        status: 'PUBLISHED',
        reservation_state: 'PUBLISHED',
        published_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(schema.scheduleRequests.id, params.scheduleRequestId));
  }

  async takeDownPublishedRequest(
    params: {
      scheduleRequestId: string;
      takenDownBy: string;
      takedownReason?: string | null;
    },
    db: DBLike = getDatabase()
  ) {
    await this.expireStaleHolds(db);

    const [request] = await db
      .select()
      .from(schema.scheduleRequests)
      .where(eq(schema.scheduleRequests.id, params.scheduleRequestId));
    if (!request) {
      throw AppError.notFound('Schedule request not found');
    }

    if (request.status === 'TAKEN_DOWN') {
      const publishedRows = await this.repo.listActiveByRequest(params.scheduleRequestId, db);
      return {
        request,
        screenIds: Array.from(new Set(publishedRows.map((row: any) => row.screen_id))),
        alreadyTakenDown: true,
      };
    }

    if (request.status !== 'PUBLISHED') {
      throw AppError.badRequest('Only published schedule requests can be taken down');
    }

    const releasedRows = await this.repo.markPublishedRequestReservationsReleased(
      params.scheduleRequestId,
      'request-taken-down-by-admin',
      db
    );

    const now = new Date();
    const [updatedRequest] = await db
      .update(schema.scheduleRequests)
      .set({
        status: 'TAKEN_DOWN',
        reservation_state: 'TAKEN_DOWN',
        taken_down_at: now,
        taken_down_by: params.takenDownBy,
        takedown_reason: params.takedownReason ?? null,
        updated_at: now,
      })
      .where(eq(schema.scheduleRequests.id, params.scheduleRequestId))
      .returning();

    return {
      request: updatedRequest ?? request,
      screenIds: Array.from(new Set(releasedRows.map((row: { screen_id: string }) => row.screen_id))),
      alreadyTakenDown: false,
    };
  }

  async acquireDirectPublishedReservations(
    params: {
      scheduleId: string;
      ownerUserId: string;
      publishId: string;
      explicitScreenIds?: string[];
      explicitScreenGroupIds?: string[];
    },
    db: DBLike = getDatabase()
  ) {
    await this.expireStaleHolds(db);
    const resolved = await this.resolveScheduleWindows(
      {
        scheduleId: params.scheduleId,
        explicitScreenIds: params.explicitScreenIds,
        explicitScreenGroupIds: params.explicitScreenGroupIds,
      },
      db
    );

    const conflicts = await this.buildConflictPayload(
      {
        windows: resolved.windows,
        currentUserId: params.ownerUserId,
        allowPrivateRefs: true,
      },
      db
    );
    if (conflicts.length > 0) {
      throw AppError.conflict('Selected screens already have active schedule ownership for part of this time window.', {
        conflict_type: 'SCREEN_TIME_WINDOW_CONFLICT',
        reservation_conflicts: conflicts,
      });
    }

    const now = new Date();
    const reservationToken = randomUUID();
    const rows = resolved.windows.map((window) => ({
      screen_id: window.screen_id,
      schedule_id: params.scheduleId,
      schedule_item_id: window.schedule_item_id,
      schedule_request_id: null,
      owner_user_id: params.ownerUserId,
      state: 'PUBLISHED' as const,
      start_at: window.start_at,
      end_at: window.end_at,
      hold_expires_at: null,
      reservation_token: reservationToken,
      reservation_version: resolved.schedule.revision,
      publish_id: params.publishId,
      published_at: now,
    }));

    try {
      await this.repo.createPublishedRows(rows, db);
    } catch (error) {
      const normalized = normalizePgConstraintError(error);
      if (normalized?.code === '23P01') {
        const retryConflicts = await this.buildConflictPayload(
          {
            windows: resolved.windows,
            currentUserId: params.ownerUserId,
            allowPrivateRefs: true,
          },
          db
        );
        throw AppError.conflict('Selected screens already have active schedule ownership for part of this time window.', {
          conflict_type: 'SCREEN_TIME_WINDOW_CONFLICT',
          reservation_conflicts: retryConflicts,
        });
      }
      throw error;
    }
  }
}

export function createScheduleReservationService() {
  return new ScheduleReservationService();
}
