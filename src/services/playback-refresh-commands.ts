import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export type PlaybackRefreshReason = 'PUBLISH' | 'EMERGENCY' | 'GROUP_MEMBERSHIP' | 'TAKE_DOWN' | 'DEFAULT_MEDIA';

export type PlaybackRefreshCommandBatch = {
  reason: PlaybackRefreshReason;
  screenIds: string[];
  createdBy: string;
  publishId?: string | null;
  snapshotId?: string | null;
};

export const REFRESH_COMMAND_DEDUPE_MS = 60_000;

export async function createPlaybackRefreshCommands(params: PlaybackRefreshCommandBatch) {
  const db = getDatabase();
  const resolvedScreenIds = Array.from(new Set((params.screenIds || []).filter(Boolean)));

  if (resolvedScreenIds.length === 0) {
    return {
      resolvedScreenIds,
      queuedScreenIds: [] as string[],
      commandsCreated: 0,
    };
  }

  const screenIdsToQueue =
    params.reason === 'TAKE_DOWN' || params.reason === 'DEFAULT_MEDIA'
      ? resolvedScreenIds
      : await (async () => {
          const dedupeCutoff = new Date(Date.now() - REFRESH_COMMAND_DEDUPE_MS);
          const activeLeaseCutoff = new Date(Date.now() - REFRESH_COMMAND_DEDUPE_MS);
          const existingRefreshes = await db
            .select({
              screen_id: schema.deviceCommands.screen_id,
            })
            .from(schema.deviceCommands)
            .where(
              and(
                inArray(schema.deviceCommands.screen_id, resolvedScreenIds as string[]),
                eq(schema.deviceCommands.type, 'REFRESH'),
                or(
                  and(
                    eq(schema.deviceCommands.status, 'PENDING'),
                    gte(schema.deviceCommands.created_at, dedupeCutoff)
                  ),
                  and(
                    eq(schema.deviceCommands.status, 'SENT'),
                    isNull(schema.deviceCommands.acknowledged_at),
                    gte(schema.deviceCommands.claimed_at, activeLeaseCutoff)
                  )
                )
              )
            );

          const blockedScreenIds = new Set(existingRefreshes.map((row) => row.screen_id));
          return resolvedScreenIds.filter((screenId) => !blockedScreenIds.has(screenId));
        })();

  if (screenIdsToQueue.length === 0) {
    return {
      resolvedScreenIds,
      queuedScreenIds: [] as string[],
      commandsCreated: 0,
    };
  }

  const requestedAt = new Date().toISOString();
  const inserted = await db
    .insert(schema.deviceCommands)
    .values(
      screenIdsToQueue.map((screenId) => ({
        screen_id: screenId,
        type: 'REFRESH' as const,
        status: 'PENDING' as const,
        created_by: params.createdBy,
        payload: {
          reason: params.reason,
          publish_id: params.publishId ?? null,
          snapshot_id: params.snapshotId ?? null,
          requested_at: requestedAt,
        },
      }))
    )
    .returning({ id: schema.deviceCommands.id });

  return {
    resolvedScreenIds,
    queuedScreenIds: screenIdsToQueue,
    commandsCreated: inserted.length,
  };
}
