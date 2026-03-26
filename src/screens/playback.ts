import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { resolveDefaultMediaForScreen } from '@/utils/default-media';
import { getPresignedUrl } from '@/s3';
import { buildResolvedMediaRecord } from '@/utils/resolved-media';
import { createScheduleReservationRepository } from '@/db/repositories/schedule-reservation';

type ScreenRecord = typeof schema.screens.$inferSelect;
type ScreenGroupRecord = typeof schema.screenGroups.$inferSelect;

type PlaybackSource = 'HEARTBEAT' | 'SCHEDULE' | 'EMERGENCY' | 'DEFAULT' | 'UNKNOWN';
export type ScreenHealthState = 'ONLINE' | 'OFFLINE' | 'STALE' | 'ERROR' | 'RECOVERY_REQUIRED';
export type EmergencyScopeMatch = 'GLOBAL' | 'GROUP' | 'SCREEN';

export type ScreenScheduleTimelineItem = {
  id: string;
  presentation_id: string | null;
  presentation_name: string | null;
  start_at: string;
  end_at: string;
  priority: number;
  is_current: boolean;
};

type BuildScreenPlaybackStateOptions = {
  db?: ReturnType<typeof getDatabase>;
  now?: Date;
  includeMedia?: boolean;
  includePreview?: boolean;
  includeUrls?: boolean;
  groupIds?: string[];
  lastProofOfPlayAt?: string | null;
};

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const SCREENSHOT_PREVIEW_STALE_MS = 90 * 1000;

function getEmergencySeverityRank(priority: string | null | undefined): number {
  switch ((priority || '').toUpperCase()) {
    case 'CRITICAL':
      return 4;
    case 'HIGH':
      return 3;
    case 'MEDIUM':
      return 2;
    case 'LOW':
      return 1;
    default:
      return 0;
  }
}

function resolveEmergencyScopeMatch(
  emergency: typeof schema.emergencies.$inferSelect,
  screenId: string,
  groupIds: string[]
): EmergencyScopeMatch | null {
  const emergencyScreenIds = Array.isArray((emergency as any).screen_ids)
    ? ((emergency as any).screen_ids as string[])
    : [];
  const emergencyGroupIds = Array.isArray((emergency as any).screen_group_ids)
    ? ((emergency as any).screen_group_ids as string[])
    : [];
  const hasTargets = emergencyScreenIds.length > 0 || emergencyGroupIds.length > 0;
  const targetAll = (emergency as any).target_all === true || !hasTargets;

  if (targetAll) return 'GLOBAL';
  if (emergencyGroupIds.some((groupId) => groupIds.includes(groupId))) return 'GROUP';
  if (emergencyScreenIds.includes(screenId)) return 'SCREEN';
  return null;
}

function getEmergencyScopeRank(scope: EmergencyScopeMatch): number {
  switch (scope) {
    case 'GLOBAL':
      return 3;
    case 'GROUP':
      return 2;
    case 'SCREEN':
      return 1;
    default:
      return 0;
  }
}

function pickPrimaryMediaIdFromPresentation(presentation: any): string | null {
  if (!presentation || typeof presentation !== 'object') return null;
  const itemMedia = Array.isArray(presentation.items)
    ? presentation.items.find((item: any) => typeof item?.media_id === 'string' && item.media_id)
    : null;
  if (itemMedia?.media_id) return itemMedia.media_id;

  const slotMedia = Array.isArray(presentation.slots)
    ? presentation.slots.find((slot: any) => typeof slot?.media_id === 'string' && slot.media_id)
    : null;
  if (slotMedia?.media_id) return slotMedia.media_id;

  return null;
}

function itemIncludesMediaId(item: any, mediaId: string): boolean {
  if (!item || !mediaId) return false;
  const presentation = item.presentation;
  if (!presentation || typeof presentation !== 'object') return false;

  const matchesCollection = (entries: any[] | undefined) =>
    Array.isArray(entries) && entries.some((entry: any) => entry?.media_id === mediaId);

  return matchesCollection(presentation.items) || matchesCollection(presentation.slots);
}

export async function getGroupIdsForScreen(
  screenId: string,
  db = getDatabase()
): Promise<string[]> {
  const rows = await db
    .select({ group_id: schema.screenGroupMembers.group_id })
    .from(schema.screenGroupMembers)
    .where(eq(schema.screenGroupMembers.screen_id, screenId));

  return rows.map((row) => row.group_id);
}

export async function getLatestPublishForScreen(
  screenId: string,
  db = getDatabase()
) {
  const reservationRepo = createScheduleReservationRepository();
  await reservationRepo.expireStaleHolds(new Date(), db);

  const active = await reservationRepo.findCurrentPublishedForScreen(screenId, new Date(), db);
  if (active) {
    return {
      publish_id: active.publish_id,
      schedule_id: active.schedule_id,
      snapshot_id: active.snapshot_id,
      published_at: active.published_at,
      payload: active.payload,
      reservation_version: active.reservation_version,
      selection_reason: 'active_reservation' as const,
      reservation_start_at: active.start_at,
      reservation_end_at: active.end_at,
    };
  }

  const upcoming = await reservationRepo.findUpcomingPublishedForScreen(screenId, new Date(), db);
  if (upcoming) {
    return {
      publish_id: upcoming.publish_id,
      schedule_id: upcoming.schedule_id,
      snapshot_id: upcoming.snapshot_id,
      published_at: upcoming.published_at,
      payload: upcoming.payload,
      reservation_version: upcoming.reservation_version,
      selection_reason: 'upcoming_reservation' as const,
      reservation_start_at: upcoming.start_at,
      reservation_end_at: upcoming.end_at,
    };
  }

  const [latestPublish] = await db
    .select({
      publish_id: schema.publishes.id,
      schedule_id: schema.publishes.schedule_id,
      snapshot_id: schema.publishes.snapshot_id,
      published_at: schema.publishes.published_at,
      payload: schema.scheduleSnapshots.payload,
    })
    .from(schema.publishTargets)
    .innerJoin(schema.publishes, eq(schema.publishTargets.publish_id, schema.publishes.id))
    .innerJoin(schema.scheduleSnapshots, eq(schema.publishes.snapshot_id, schema.scheduleSnapshots.id))
    .where(eq(schema.publishTargets.screen_id, screenId))
    .orderBy(desc(schema.publishes.published_at), desc(schema.publishes.id))
    .limit(1);

  if (!latestPublish) return null;

  return {
    publish_id: latestPublish.publish_id,
    schedule_id: latestPublish.schedule_id,
    snapshot_id: latestPublish.snapshot_id,
    published_at: latestPublish.published_at,
    payload: latestPublish.payload,
    reservation_version: null,
    selection_reason: 'latest_publish' as const,
    reservation_start_at: null,
    reservation_end_at: null,
  };
}

export function filterItemsForScreen(items: any[], screenId: string, groupIds: string[]) {
  return items.filter((item) => {
    const itemScreens = Array.isArray(item?.screen_ids) ? (item.screen_ids as string[]) : [];
    const itemGroups = Array.isArray(item?.screen_group_ids) ? (item.screen_group_ids as string[]) : [];
    const hasTargets = itemScreens.length > 0 || itemGroups.length > 0;

    if (!hasTargets) return true;
    if (itemScreens.includes(screenId)) return true;
    return itemGroups.some((groupId) => groupIds.includes(groupId));
  });
}

export function buildTimeline(items: any[], now = new Date()) {
  const activeItems = items
    .filter((item) => {
      const start = new Date(item.start_at);
      const end = new Date(item.end_at);
      return start <= now && end >= now;
    })
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());

  const upcomingItems = items
    .filter((item) => new Date(item.start_at) > now)
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());

  const bookedUntil = items.length
    ? new Date(Math.max(...items.map((item) => new Date(item.end_at).getTime()))).toISOString()
    : null;

  return { activeItems, upcomingItems, bookedUntil };
}

export async function getActiveEmergencyForScreen(
  screenId: string,
  options: { db?: ReturnType<typeof getDatabase>; includeUrls?: boolean; groupIds?: string[] } = {}
) {
  const db = options.db ?? getDatabase();
  const emergencies = await db
    .select()
    .from(schema.emergencies)
    .where(
      and(
        eq(schema.emergencies.is_active, true),
        isNull(schema.emergencies.cleared_at),
        sql`(${schema.emergencies.expires_at} IS NULL OR ${schema.emergencies.expires_at} > now())`
      )
    )
    .orderBy(desc(schema.emergencies.created_at));

  if (emergencies.length === 0) return null;

  const groupIds = options.groupIds ?? (await getGroupIdsForScreen(screenId, db));
  const ranked = emergencies
    .map((emergency) => {
      const scopeMatch = resolveEmergencyScopeMatch(emergency, screenId, groupIds);
      if (!scopeMatch) return null;
      return {
        emergency,
        scopeMatch,
        scopeRank: getEmergencyScopeRank(scopeMatch),
        severityRank: getEmergencySeverityRank(emergency.priority),
      };
    })
    .filter(Boolean) as Array<{
    emergency: typeof schema.emergencies.$inferSelect;
    scopeMatch: EmergencyScopeMatch;
    scopeRank: number;
    severityRank: number;
  }>;

  if (ranked.length === 0) return null;

  ranked.sort((left, right) => {
    if (right.scopeRank !== left.scopeRank) return right.scopeRank - left.scopeRank;
    if (right.severityRank !== left.severityRank) return right.severityRank - left.severityRank;
    return new Date(right.emergency.created_at).getTime() - new Date(left.emergency.created_at).getTime();
  });

  const { emergency, scopeMatch } = ranked[0];

  const emergencyScreenIds = Array.isArray((emergency as any).screen_ids)
    ? ((emergency as any).screen_ids as string[])
    : [];
  const emergencyGroupIds = Array.isArray((emergency as any).screen_group_ids)
    ? ((emergency as any).screen_group_ids as string[])
    : [];

  const resolvedEmergencyMedia =
    options.includeUrls && (emergency as any).media_id
      ? await buildResolvedMediaRecord((emergency as any).media_id, db)
      : null;

  return {
    id: emergency.id,
    emergency_type_id: (emergency as any).emergency_type_id ?? null,
    triggered_by: emergency.triggered_by,
    message: emergency.message,
    severity: emergency.priority,
    media_id: (emergency as any).media_id ?? null,
    media_url: resolvedEmergencyMedia?.media_url ?? null,
    fallback_url: resolvedEmergencyMedia?.fallback_url ?? null,
    source_url: resolvedEmergencyMedia?.source_url ?? null,
    url: resolvedEmergencyMedia?.url ?? null,
    media_type: resolvedEmergencyMedia?.media_type ?? null,
    type:
      resolvedEmergencyMedia?.type === 'WEBPAGE'
        ? 'url'
        : resolvedEmergencyMedia?.type ?? null,
    content_type: resolvedEmergencyMedia?.content_type ?? null,
    source_content_type: resolvedEmergencyMedia?.source_content_type ?? null,
    screen_ids: emergencyScreenIds,
    screen_group_ids: emergencyGroupIds,
    target_all: (emergency as any).target_all ?? false,
    scope: scopeMatch,
    expires_at: toIso((emergency as any).expires_at),
    audit_note: (emergency as any).audit_note ?? null,
    created_at: toIso(emergency.created_at),
    cleared_at: toIso(emergency.cleared_at),
  };
}

async function getMediaById(id: string, db = getDatabase()) {
  const [media] = await db.select().from(schema.media).where(eq(schema.media.id, id)).limit(1);
  return media || null;
}

async function getMediaSummary(id: string, db = getDatabase()) {
  return await buildResolvedMediaRecord(id, db);
}

async function getLatestScreenshotPreview(
  screenId: string,
  options: { db?: ReturnType<typeof getDatabase>; now?: Date } = {}
) {
  const db = options.db ?? getDatabase();
  const now = options.now ?? new Date();
  const [latest] = await db
    .select({
      storage_object_id: schema.screenshots.storage_object_id,
      captured_at: schema.screenshots.created_at,
      bucket: schema.storageObjects.bucket,
      object_key: schema.storageObjects.object_key,
    })
    .from(schema.screenshots)
    .innerJoin(schema.storageObjects, eq(schema.screenshots.storage_object_id, schema.storageObjects.id))
    .where(eq(schema.screenshots.screen_id, screenId))
    .orderBy(desc(schema.screenshots.created_at))
    .limit(1);

  if (!latest) return null;

  let screenshotUrl: string | null = null;
  try {
    screenshotUrl = await getPresignedUrl(latest.bucket, latest.object_key, 3600);
  } catch {
    screenshotUrl = null;
  }

  const capturedAtIso = toIso(latest.captured_at);
  const capturedAtMs =
    latest.captured_at instanceof Date ? latest.captured_at.getTime() : Date.parse(String(latest.captured_at));

  return {
    storage_object_id: latest.storage_object_id,
    captured_at: capturedAtIso,
    screenshot_url: screenshotUrl,
    stale: Number.isFinite(capturedAtMs) ? now.getTime() - capturedAtMs > SCREENSHOT_PREVIEW_STALE_MS : true,
  };
}

async function getScreenRecoveryState(screenId: string, db = getDatabase()) {
  const [activePairing] = await db
    .select({
      id: schema.devicePairings.id,
      created_at: schema.devicePairings.created_at,
      expires_at: schema.devicePairings.expires_at,
      device_info: schema.devicePairings.device_info,
    })
    .from(schema.devicePairings)
    .where(
      and(
        eq(schema.devicePairings.device_id, screenId),
        eq(schema.devicePairings.used, false),
        gt(schema.devicePairings.expires_at, new Date())
      )
    )
    .orderBy(desc(schema.devicePairings.created_at))
    .limit(1);

  const [latestCertificate] = await db
    .select({
      id: schema.deviceCertificates.id,
      serial: schema.deviceCertificates.serial,
      expires_at: schema.deviceCertificates.expires_at,
      revoked_at: schema.deviceCertificates.revoked_at,
      is_revoked: schema.deviceCertificates.is_revoked,
      created_at: schema.deviceCertificates.created_at,
    })
    .from(schema.deviceCertificates)
    .where(eq(schema.deviceCertificates.screen_id, screenId))
    .orderBy(desc(schema.deviceCertificates.created_at))
    .limit(1);

  const pairingInfo = ((activePairing?.device_info as Record<string, unknown> | null) || {}) as Record<string, any>;
  const pairingMeta = (pairingInfo?.pairing || {}) as Record<string, any>;
  const activePairingMode =
    typeof pairingMeta.mode === 'string' && pairingMeta.mode.trim().length > 0 ? pairingMeta.mode.trim() : null;
  const activePairingConfirmed = pairingMeta.confirmed === true;
  const activePairingState = activePairing
    ? {
        id: activePairing.id,
        created_at: toIso(activePairing.created_at),
        expires_at: toIso(activePairing.expires_at),
        confirmed: activePairingConfirmed,
        mode: activePairingMode,
      }
    : null;

  let authState: 'VALID' | 'MISSING_CERTIFICATE' | 'EXPIRED_CERTIFICATE' | 'REVOKED_CERTIFICATE' = 'VALID';
  let authReason = 'Device credentials are valid.';

  if (!latestCertificate) {
    authState = 'MISSING_CERTIFICATE';
    authReason = 'No device certificate exists for this screen.';
  } else if (latestCertificate.is_revoked || latestCertificate.revoked_at) {
    authState = 'REVOKED_CERTIFICATE';
    authReason = 'The latest device certificate has been revoked.';
  } else if (latestCertificate.expires_at && latestCertificate.expires_at.getTime() <= Date.now()) {
    authState = 'EXPIRED_CERTIFICATE';
    authReason = 'The latest device certificate has expired.';
  }

  return {
    active_pairing: activePairingState,
    auth_diagnostics: {
      state: authState,
      reason: authReason,
      latest_certificate_expires_at: toIso(latestCertificate?.expires_at),
      latest_certificate_revoked_at: toIso(latestCertificate?.revoked_at),
      latest_certificate_serial: latestCertificate?.serial ?? null,
    },
  };
}

function deriveHealthState(params: {
  screen: ScreenRecord;
  authDiagnostics: {
    state: 'VALID' | 'MISSING_CERTIFICATE' | 'EXPIRED_CERTIFICATE' | 'REVOKED_CERTIFICATE';
  };
  activePairing: { mode?: string | null } | null;
  now: Date;
}) {
  if (
    params.authDiagnostics.state !== 'VALID' ||
    (params.activePairing?.mode === 'RECOVERY' && params.activePairing)
  ) {
    return {
      health_state: 'RECOVERY_REQUIRED' as ScreenHealthState,
      health_reason:
        params.activePairing?.mode === 'RECOVERY'
          ? 'Recovery pairing is in progress for this screen.'
          : 'The screen requires credential recovery before it can authenticate again.',
    };
  }

  if (params.screen.status === 'OFFLINE') {
    return {
      health_state: 'OFFLINE' as ScreenHealthState,
      health_reason: 'The screen is reporting offline.',
    };
  }

  if (params.screen.status === 'INACTIVE') {
    return {
      health_state: 'ERROR' as ScreenHealthState,
      health_reason: 'The screen reported an error or inactive state.',
    };
  }

  if (!params.screen.last_heartbeat_at) {
    return {
      health_state: 'STALE' as ScreenHealthState,
      health_reason: 'The screen has not reported a heartbeat yet.',
    };
  }

  if (params.now.getTime() - params.screen.last_heartbeat_at.getTime() > HEARTBEAT_STALE_MS) {
    return {
      health_state: 'STALE' as ScreenHealthState,
      health_reason: 'The last heartbeat is older than the freshness threshold.',
    };
  }

  return {
    health_state: 'ONLINE' as ScreenHealthState,
    health_reason: 'The screen is healthy and reporting recent heartbeats.',
  };
}

export async function getLastProofOfPlayMap(
  screenIds: string[],
  db = getDatabase()
): Promise<Map<string, string>> {
  if (screenIds.length === 0) return new Map();

  const rows = await db
    .select({
      screen_id: schema.proofOfPlay.screen_id,
      last_created_at: sql<Date | null>`max(${schema.proofOfPlay.created_at})`,
    })
    .from(schema.proofOfPlay)
    .where(inArray(schema.proofOfPlay.screen_id, screenIds as any))
    .groupBy(schema.proofOfPlay.screen_id);

  return new Map(
    rows
      .filter((row) => row.last_created_at)
      .map((row) => [row.screen_id, toIso(row.last_created_at)!])
  );
}

function derivePlaybackState(params: {
  screen: ScreenRecord;
  activeItems: any[];
  latest: Awaited<ReturnType<typeof getLatestPublishForScreen>> | null;
  emergency: Awaited<ReturnType<typeof getActiveEmergencyForScreen>> | null;
  defaultMedia: Awaited<ReturnType<typeof resolveDefaultMediaForScreen>>;
  currentMediaId?: string | null;
  lastProofOfPlayAt?: string | null;
  includeMedia?: boolean;
  currentMedia?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const fallbackItem =
    params.activeItems.find((item) => params.currentMediaId && itemIncludesMediaId(item, params.currentMediaId)) ??
    params.activeItems[0] ??
    null;

  const fallbackMediaIdFromItem = fallbackItem
    ? pickPrimaryMediaIdFromPresentation(fallbackItem.presentation)
    : null;

  const resolvedCurrentMediaId =
    params.emergency?.media_id ??
    params.currentMediaId ??
    fallbackMediaIdFromItem ??
    params.defaultMedia?.media_id ??
    null;

  let source: PlaybackSource = 'UNKNOWN';
  if (params.emergency?.media_id) source = 'EMERGENCY';
  else if (params.currentMediaId) source = 'HEARTBEAT';
  else if (fallbackItem) source = 'SCHEDULE';
  else if (params.defaultMedia?.media_id) source = 'DEFAULT';

  const playback: Record<string, unknown> = {
    source,
    is_live: Boolean(resolvedCurrentMediaId || fallbackItem || params.emergency || params.defaultMedia?.media_id),
    current_media_id: resolvedCurrentMediaId,
    current_schedule_id: params.screen.current_schedule_id ?? params.latest?.schedule_id ?? null,
    current_item_id: fallbackItem?.id ?? null,
    started_at: toIso(fallbackItem?.start_at),
    ends_at: toIso(fallbackItem?.end_at),
    heartbeat_received_at: toIso(params.screen.last_heartbeat_at),
    last_proof_of_play_at: params.lastProofOfPlayAt ?? null,
  };

  if (params.includeMedia) {
    playback.current_media = params.currentMedia ?? null;
  }

  return playback;
}

export async function buildScreenPlaybackState(
  screen: ScreenRecord,
  options: BuildScreenPlaybackStateOptions = {}
) {
  const db = options.db ?? getDatabase();
  const now = options.now ?? new Date();
  const groupIds = options.groupIds ?? (await getGroupIdsForScreen(screen.id, db));
  const latest = await getLatestPublishForScreen(screen.id, db);
  const schedulePayload = (latest?.payload as any)?.schedule;
  const items = filterItemsForScreen(Array.isArray(schedulePayload?.items) ? schedulePayload.items : [], screen.id, groupIds);
  const { activeItems, upcomingItems, bookedUntil } = buildTimeline(items, now);
  const defaultMedia = await resolveDefaultMediaForScreen(screen, db);
  const emergency = await getActiveEmergencyForScreen(screen.id, {
    db,
    includeUrls: options.includeUrls,
    groupIds,
  });
  const currentMediaId =
    emergency?.media_id ??
    screen.current_media_id ??
    pickPrimaryMediaIdFromPresentation(activeItems[0]?.presentation) ??
    defaultMedia?.media_id ??
    null;
  const currentMedia =
    options.includeMedia && currentMediaId ? await getMediaSummary(currentMediaId, db) : null;
  const preview = options.includePreview ? await getLatestScreenshotPreview(screen.id, { db, now }) : null;
  const recoveryState = await getScreenRecoveryState(screen.id, db);
  const health = deriveHealthState({
    screen,
    authDiagnostics: recoveryState.auth_diagnostics,
    activePairing: recoveryState.active_pairing,
    now,
  });

  return {
    id: screen.id,
    name: screen.name,
    location: screen.location ?? null,
    aspect_ratio: (screen as any).aspect_ratio ?? null,
    width: (screen as any).width ?? null,
    height: (screen as any).height ?? null,
    orientation: (screen as any).orientation ?? null,
    device_info: (screen as any).device_info ?? null,
    status: screen.status,
    health_state: health.health_state,
    health_reason: health.health_reason,
    auth_diagnostics: recoveryState.auth_diagnostics,
    active_pairing: recoveryState.active_pairing,
    last_heartbeat_at: toIso(screen.last_heartbeat_at),
    current_schedule_id: screen.current_schedule_id ?? null,
    current_media_id: screen.current_media_id ?? null,
    active_items: activeItems,
    upcoming_items: upcomingItems,
    booked_until: bookedUntil,
    publish: latest
      ? {
          publish_id: latest.publish_id,
          schedule_id: latest.schedule_id,
          snapshot_id: latest.snapshot_id,
          published_at: toIso(latest.published_at),
          reservation_version: (latest as any).reservation_version ?? null,
          selection_reason: (latest as any).selection_reason ?? null,
          schedule_start_at: schedulePayload?.start_at ?? null,
          schedule_end_at: schedulePayload?.end_at ?? null,
        }
      : null,
    playback: derivePlaybackState({
      screen,
      activeItems,
      latest,
      emergency,
      defaultMedia,
      currentMediaId,
      lastProofOfPlayAt: options.lastProofOfPlayAt ?? null,
      includeMedia: options.includeMedia,
      currentMedia,
    }),
    emergency,
    preview,
    created_at: screen.created_at,
    updated_at: screen.updated_at,
  };
}

function dedupeItems(items: any[]) {
  const seen = new Set<string>();
  const result: any[] = [];

  for (const item of items) {
    const key = typeof item?.id === 'string' ? item.id : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
}

function summarizeGroupPlayback(
  group: ScreenGroupRecord,
  memberIds: string[],
  screenSummaries: Map<string, Awaited<ReturnType<typeof buildScreenPlaybackState>>>
) {
  const memberStates = memberIds
    .map((screenId) => screenSummaries.get(screenId))
    .filter(Boolean) as Awaited<ReturnType<typeof buildScreenPlaybackState>>[];

  const activeItems = dedupeItems(memberStates.flatMap((state) => state.active_items || []));
  const upcomingItems = dedupeItems(memberStates.flatMap((state) => state.upcoming_items || []));
  const bookedUntilCandidates = memberStates
    .map((state) => state.booked_until)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime());

  return {
    id: group.id,
    name: group.name,
    description: group.description,
    screen_ids: memberIds,
    active_items: activeItems,
    upcoming_items: upcomingItems,
    booked_until: bookedUntilCandidates.length
      ? new Date(Math.max(...bookedUntilCandidates)).toISOString()
      : null,
  };
}

export async function buildScreensOverviewPayload(options: {
  db?: ReturnType<typeof getDatabase>;
  includeMedia?: boolean;
  includePreview?: boolean;
  onlineOnly?: boolean;
}) {
  const db = options.db ?? getDatabase();
  const serverTime = new Date();
  const onlineThreshold = new Date(serverTime.getTime() - HEARTBEAT_STALE_MS);
  const screens = options.onlineOnly
    ? await db
        .select()
        .from(schema.screens)
        .where(and(eq(schema.screens.status, 'ACTIVE'), gte(schema.screens.last_heartbeat_at, onlineThreshold)))
    : await db.select().from(schema.screens);
  const groups = options.onlineOnly ? [] : await db.select().from(schema.screenGroups);
  const proofOfPlayMap = await getLastProofOfPlayMap(screens.map((screen) => screen.id), db);

  const screenSummaries = (
    await Promise.all(
    screens.map((screen) =>
      buildScreenPlaybackState(screen, {
        db,
        now: serverTime,
        includeMedia: options.includeMedia,
        includePreview: options.includePreview,
        lastProofOfPlayAt: proofOfPlayMap.get(screen.id) ?? null,
      })
    )
    )
  ).filter((summary) => (options.onlineOnly ? summary.health_state === 'ONLINE' : true));

  const screenSummaryMap = new Map(screenSummaries.map((summary) => [summary.id, summary]));
  const groupSummaries = options.onlineOnly
    ? []
    : (() => {
        const groupMembersMap = (db
          .select()
          .from(schema.screenGroupMembers)
          .then((memberRows) =>
            memberRows.reduce((acc, row) => {
              const list = acc.get(row.group_id) || [];
              list.push(row.screen_id);
              acc.set(row.group_id, list);
              return acc;
            }, new Map<string, string[]>())
          )) as Promise<Map<string, string[]>>;
        return groupMembersMap.then((resolvedGroupMembersMap) =>
          groups.map((group) =>
            summarizeGroupPlayback(group, resolvedGroupMembersMap.get(group.id) || [], screenSummaryMap)
          )
        );
      })();

  return {
    server_time: serverTime.toISOString(),
    screens: screenSummaries,
    groups: await groupSummaries,
  };
}

export async function buildScreenPlaybackStateById(
  screenId: string,
  options: BuildScreenPlaybackStateOptions = {}
) {
  const db = options.db ?? getDatabase();
  const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, screenId)).limit(1);
  if (!screen) return null;

  const lastProofOfPlayMap = await getLastProofOfPlayMap([screenId], db);

  return buildScreenPlaybackState(screen, {
    ...options,
    db,
    lastProofOfPlayAt: options.lastProofOfPlayAt ?? lastProofOfPlayMap.get(screenId) ?? null,
  });
}

function isActiveAt(item: any, now: Date) {
  const start = Date.parse(String(item?.start_at));
  const end = Date.parse(String(item?.end_at));
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return start <= now.getTime() && end >= now.getTime();
}

function clipItemToWindow(
  item: any,
  windowStartMs: number,
  windowEndMs: number,
  now: Date
): ScreenScheduleTimelineItem | null {
  const start = Date.parse(String(item?.start_at));
  const end = Date.parse(String(item?.end_at));
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (end <= windowStartMs || start >= windowEndMs) return null;

  const clippedStart = Math.max(start, windowStartMs);
  const clippedEnd = Math.min(end, windowEndMs);
  if (clippedEnd <= clippedStart) return null;

  return {
    id: typeof item?.id === 'string' ? item.id : `${item?.presentation_id || 'item'}:${clippedStart}`,
    presentation_id: typeof item?.presentation_id === 'string' ? item.presentation_id : null,
    presentation_name:
      typeof item?.presentation?.name === 'string' && item.presentation.name.trim().length > 0
        ? item.presentation.name.trim()
        : null,
    start_at: new Date(clippedStart).toISOString(),
    end_at: new Date(clippedEnd).toISOString(),
    priority: Number.isFinite(item?.priority) ? Number(item.priority) : 0,
    is_current: isActiveAt(item, now),
  };
}

export async function buildScreenScheduleTimelinePayload(options: {
  db?: ReturnType<typeof getDatabase>;
  now?: Date;
  windowStart: Date;
  windowHours: number;
  onlyActiveNow?: boolean;
}) {
  const db = options.db ?? getDatabase();
  const now = options.now ?? new Date();
  const windowStart = options.windowStart;
  const windowEnd = new Date(windowStart.getTime() + options.windowHours * 60 * 60 * 1000);
  const screens = options.onlyActiveNow
    ? await db
        .select()
        .from(schema.screens)
        .where(and(eq(schema.screens.status, 'ACTIVE'), isNotNull(schema.screens.current_schedule_id)))
    : await db.select().from(schema.screens);
  const proofOfPlayMap = await getLastProofOfPlayMap(screens.map((screen) => screen.id), db);
  const windowStartMs = windowStart.getTime();
  const windowEndMs = windowEnd.getTime();

  const rows = await Promise.all(
    screens.map(async (screen) => {
      const groupIds = await getGroupIdsForScreen(screen.id, db);
      const latest = await getLatestPublishForScreen(screen.id, db);
      const schedulePayload = (latest?.payload as any)?.schedule;
      const publishedItems = filterItemsForScreen(
        Array.isArray(schedulePayload?.items) ? schedulePayload.items : [],
        screen.id,
        groupIds
      );
      const hasActiveNow = publishedItems.some((item) => isActiveAt(item, now));

      if (options.onlyActiveNow && !hasActiveNow) {
        return null;
      }

      const timelineItems = publishedItems
        .map((item) => clipItemToWindow(item, windowStartMs, windowEndMs, now))
        .filter((item): item is ScreenScheduleTimelineItem => Boolean(item))
        .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || b.priority - a.priority);

      if (options.onlyActiveNow && timelineItems.length === 0) {
        return null;
      }

      const summary = await buildScreenPlaybackState(screen, {
        db,
        now,
        includeMedia: true,
        lastProofOfPlayAt: proofOfPlayMap.get(screen.id) ?? null,
      });

      return {
        id: summary.id,
        name: summary.name,
        location: summary.location,
        health_state: summary.health_state,
        health_reason: summary.health_reason,
        playback: summary.playback,
        publish: summary.publish,
        timeline_items: timelineItems,
      };
    })
  );

  return {
    server_time: now.toISOString(),
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    screens: rows
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function countActiveScheduledScreensNow(options: {
  db?: ReturnType<typeof getDatabase>;
  now?: Date;
}) {
  const now = options.now ?? new Date();
  const payload = await buildScreenScheduleTimelinePayload({
    db: options.db,
    now,
    windowStart: new Date(now.getTime() - 60 * 60 * 1000),
    windowHours: 24,
    onlyActiveNow: true,
  });

  return payload.screens.length;
}
