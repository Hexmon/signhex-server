import { createHash } from 'crypto';
import { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { isJobsInitialized, queuePlaybackRefreshDispatch } from '@/jobs';
import { emitScreensRefreshRequired } from '@/realtime/screens-namespace';
import {
  createPlaybackRefreshCommands,
  REFRESH_COMMAND_DEDUPE_MS,
  type PlaybackRefreshCommandBatch,
  type PlaybackRefreshReason,
} from '@/services/playback-refresh-commands';
import { createLogger } from '@/utils/logger';

const logger = createLogger('playback-refresh-dispatch');

export type DispatchPlaybackRefreshParams = {
  reason: PlaybackRefreshReason;
  screenIds?: string[];
  groupIds?: string[];
  targetAll?: boolean;
  createdBy: string;
  publishId?: string | null;
  snapshotId?: string | null;
};

export const PLAYBACK_REFRESH_JOB_CHUNK_SIZE = 100;
const PLAYBACK_REFRESH_JOB_SINGLETON_SECONDS = Math.floor(REFRESH_COMMAND_DEDUPE_MS / 1000);

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

function buildPlaybackRefreshJob(
  params: DispatchPlaybackRefreshParams,
  screenIds: string[]
): PlaybackRefreshCommandBatch {
  return {
    reason: params.reason,
    screenIds,
    createdBy: params.createdBy,
    publishId: params.publishId ?? null,
    snapshotId: params.snapshotId ?? null,
  };
}

function buildPlaybackRefreshJobSingletonKey(job: PlaybackRefreshCommandBatch) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...job,
        screenIds: [...job.screenIds].sort(),
      })
    )
    .digest('hex');
}

function chunkScreenIds(screenIds: string[], chunkSize: number) {
  const chunks: string[][] = [];
  for (let index = 0; index < screenIds.length; index += chunkSize) {
    chunks.push(screenIds.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function dispatchPlaybackRefresh(
  fastify: FastifyInstance,
  params: DispatchPlaybackRefreshParams
) {
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

  if (!isJobsInitialized()) {
    const inlineResult = await createPlaybackRefreshCommands({
      reason: params.reason,
      screenIds: resolvedScreenIds,
      createdBy: params.createdBy,
      publishId: params.publishId ?? null,
      snapshotId: params.snapshotId ?? null,
    });

    return {
      resolvedScreenIds,
      commandsCreated: inlineResult.commandsCreated,
    };
  }

  const queuedScreenIds = new Set<string>();

  try {
    for (const screenIdChunk of chunkScreenIds(resolvedScreenIds, PLAYBACK_REFRESH_JOB_CHUNK_SIZE)) {
      const job = buildPlaybackRefreshJob(params, screenIdChunk);
      const queueOptions =
        params.reason === 'TAKE_DOWN' || params.reason === 'DEFAULT_MEDIA'
          ? undefined
          : {
              singletonKey: buildPlaybackRefreshJobSingletonKey(job),
              singletonSeconds: PLAYBACK_REFRESH_JOB_SINGLETON_SECONDS,
            };

      await queuePlaybackRefreshDispatch(job, queueOptions);
      screenIdChunk.forEach((screenId) => queuedScreenIds.add(screenId));
    }

    return {
      resolvedScreenIds,
      commandsCreated: 0,
    };
  } catch (error) {
    logger.warn(
      {
        err: error,
        reason: params.reason,
        queuedScreenCount: queuedScreenIds.size,
      },
      'Queued playback refresh dispatch failed; falling back to inline command creation'
    );

    const remainingScreenIds = resolvedScreenIds.filter((screenId) => !queuedScreenIds.has(screenId));
    if (remainingScreenIds.length === 0) {
      return {
        resolvedScreenIds,
        commandsCreated: 0,
      };
    }

    const inlineResult = await createPlaybackRefreshCommands({
      reason: params.reason,
      screenIds: remainingScreenIds,
      createdBy: params.createdBy,
      publishId: params.publishId ?? null,
      snapshotId: params.snapshotId ?? null,
    });

    return {
      resolvedScreenIds,
      commandsCreated: inlineResult.commandsCreated,
    };
  }
}
