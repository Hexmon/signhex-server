import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { getDefaultMedia, resolveMediaUrl } from '@/utils/default-media';

type ScreenRecord = typeof schema.screens.$inferSelect;
type ScreenGroupRecord = typeof schema.screenGroups.$inferSelect;

type PlaybackSource = 'HEARTBEAT' | 'SCHEDULE' | 'EMERGENCY' | 'DEFAULT' | 'UNKNOWN';

type BuildScreenPlaybackStateOptions = {
  db?: ReturnType<typeof getDatabase>;
  now?: Date;
  includeMedia?: boolean;
  includeUrls?: boolean;
  defaultMedia?: Awaited<ReturnType<typeof getDefaultMedia>>;
  groupIds?: string[];
  lastProofOfPlayAt?: string | null;
};

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
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
  const [latest] = await db
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
    .orderBy(desc(schema.publishes.published_at))
    .limit(1);

  return latest || null;
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
  const [emergency] = await db
    .select()
    .from(schema.emergencies)
    .where(and(eq(schema.emergencies.is_active, true), isNull(schema.emergencies.cleared_at)))
    .orderBy(desc(schema.emergencies.created_at))
    .limit(1);

  if (!emergency) return null;

  const emergencyScreenIds = Array.isArray((emergency as any).screen_ids)
    ? ((emergency as any).screen_ids as string[])
    : [];
  const emergencyGroupIds = Array.isArray((emergency as any).screen_group_ids)
    ? ((emergency as any).screen_group_ids as string[])
    : [];
  const hasTargets = emergencyScreenIds.length > 0 || emergencyGroupIds.length > 0;
  const targetAll = (emergency as any).target_all === true || !hasTargets;

  if (!targetAll) {
    const groupIds = options.groupIds ?? (await getGroupIdsForScreen(screenId, db));
    const screenMatch = emergencyScreenIds.includes(screenId);
    const groupMatch = emergencyGroupIds.some((groupId) => groupIds.includes(groupId));
    if (!screenMatch && !groupMatch) {
      return null;
    }
  }

  let mediaUrl: string | null = null;
  if (options.includeUrls && (emergency as any).media_id) {
    const emergencyMedia = await getMediaById((emergency as any).media_id, db);
    mediaUrl = emergencyMedia ? await resolveMediaUrl(emergencyMedia, db) : null;
  }

  return {
    id: emergency.id,
    emergency_type_id: (emergency as any).emergency_type_id ?? null,
    triggered_by: emergency.triggered_by,
    message: emergency.message,
    severity: emergency.priority,
    media_id: (emergency as any).media_id ?? null,
    media_url: mediaUrl,
    screen_ids: emergencyScreenIds,
    screen_group_ids: emergencyGroupIds,
    target_all: (emergency as any).target_all ?? false,
    created_at: toIso(emergency.created_at),
    cleared_at: toIso(emergency.cleared_at),
  };
}

async function getMediaById(id: string, db = getDatabase()) {
  const [media] = await db.select().from(schema.media).where(eq(schema.media.id, id)).limit(1);
  return media || null;
}

async function getMediaSummary(id: string, db = getDatabase()) {
  const media = await getMediaById(id, db);
  if (!media) return null;

  return {
    id: media.id,
    name: media.name,
    type: media.type,
    status: media.status,
    source_content_type: media.source_content_type ?? null,
    source_size: media.source_size ?? null,
    width: media.width ?? null,
    height: media.height ?? null,
    duration_seconds: media.duration_seconds ?? null,
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
  defaultMedia: Awaited<ReturnType<typeof getDefaultMedia>>;
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
    is_live: Boolean(resolvedCurrentMediaId || fallbackItem || params.emergency || params.defaultMedia),
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
  const defaultMedia = options.defaultMedia ?? (await getDefaultMedia(db));
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

  return {
    id: screen.id,
    name: screen.name,
    status: screen.status,
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
}) {
  const db = options.db ?? getDatabase();
  const serverTime = new Date();
  const screens = await db.select().from(schema.screens);
  const groups = await db.select().from(schema.screenGroups);
  const defaultMedia = await getDefaultMedia(db);
  const proofOfPlayMap = await getLastProofOfPlayMap(screens.map((screen) => screen.id), db);

  const screenSummaries = await Promise.all(
    screens.map((screen) =>
      buildScreenPlaybackState(screen, {
        db,
        now: serverTime,
        includeMedia: options.includeMedia,
        defaultMedia,
        lastProofOfPlayAt: proofOfPlayMap.get(screen.id) ?? null,
      })
    )
  );

  const screenSummaryMap = new Map(screenSummaries.map((summary) => [summary.id, summary]));
  const memberRows = await db.select().from(schema.screenGroupMembers);
  const groupMembersMap = memberRows.reduce((acc, row) => {
    const list = acc.get(row.group_id) || [];
    list.push(row.screen_id);
    acc.set(row.group_id, list);
    return acc;
  }, new Map<string, string[]>());

  const groupSummaries = groups.map((group) =>
    summarizeGroupPlayback(group, groupMembersMap.get(group.id) || [], screenSummaryMap)
  );

  return {
    server_time: serverTime.toISOString(),
    screens: screenSummaries,
    groups: groupSummaries,
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
