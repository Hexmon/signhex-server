import { FastifyInstance } from 'fastify';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { emitScreensRefreshRequired } from '@/realtime/screens-namespace';

type PlaybackRefreshReason = 'PUBLISH' | 'EMERGENCY' | 'GROUP_MEMBERSHIP' | 'TAKE_DOWN' | 'DEFAULT_MEDIA';

type DispatchPlaybackRefreshParams = {
  reason: PlaybackRefreshReason;
  screenIds?: string[];
  groupIds?: string[];
  targetAll?: boolean;
  createdBy: string;
  publishId?: string | null;
  snapshotId?: string | null;
};

const REFRESH_COMMAND_DEDUPE_MS = 60_000;

async function resolveScreenIds(
  params: Pick<DispatchPlaybackRefreshParams, 'screenIds' | 'groupIds' | 'targetAll'>
) {
  const db = getDatabase();
  const resolved = new Set<string>(params.screenIds || []);

  if (params.targetAll) {
    const screens = await db.select({ id: schema.screens.id }).from(schema.screens);
    for (const screen of screens) {
      resolved.add(screen.id);
    }
  }

  const groupIds = Array.from(new Set((params.groupIds || []).filter(Boolean)));
  if (groupIds.length > 0) {
    const members = await db
      .select({ screen_id: schema.screenGroupMembers.screen_id })
      .from(schema.screenGroupMembers)
      .where(inArray(schema.screenGroupMembers.group_id, groupIds as string[]));

    for (const member of members) {
      resolved.add(member.screen_id);
    }
  }

  return Array.from(resolved);
}

export async function dispatchPlaybackRefresh(
  fastify: FastifyInstance,
  params: DispatchPlaybackRefreshParams
) {
  const db = getDatabase();
  const resolvedScreenIds = await resolveScreenIds(params);
  const groupIds = Array.from(new Set((params.groupIds || []).filter(Boolean)));

  emitScreensRefreshRequired(fastify, {
    reason: params.reason,
    screen_ids: resolvedScreenIds,
    group_ids: groupIds,
  });

  if (resolvedScreenIds.length === 0) {
    return {
      resolvedScreenIds,
      commandsCreated: 0,
    };
  }

  const screenIdsToQueue =
    params.reason === 'TAKE_DOWN' || params.reason === 'DEFAULT_MEDIA'
      ? resolvedScreenIds
      : await (async () => {
          const dedupeCutoff = new Date(Date.now() - REFRESH_COMMAND_DEDUPE_MS);
          const existingRefreshes = await db
            .select({
              screen_id: schema.deviceCommands.screen_id,
            })
            .from(schema.deviceCommands)
            .where(
              and(
                inArray(schema.deviceCommands.screen_id, resolvedScreenIds as string[]),
                eq(schema.deviceCommands.type, 'REFRESH'),
                inArray(schema.deviceCommands.status, ['PENDING', 'SENT'] as const),
                gte(schema.deviceCommands.created_at, dedupeCutoff)
              )
            );

          const blockedScreenIds = new Set(existingRefreshes.map((row) => row.screen_id));
          return resolvedScreenIds.filter((screenId) => !blockedScreenIds.has(screenId));
        })();

  if (screenIdsToQueue.length === 0) {
    return {
      resolvedScreenIds,
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
    commandsCreated: inserted.length,
  };
}
