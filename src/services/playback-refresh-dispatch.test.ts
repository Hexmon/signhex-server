import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { inArray } from 'drizzle-orm';

const {
  emitScreensRefreshRequiredMock,
  isJobsInitializedMock,
  queuePlaybackRefreshDispatchMock,
} = vi.hoisted(() => ({
  emitScreensRefreshRequiredMock: vi.fn(),
  isJobsInitializedMock: vi.fn(),
  queuePlaybackRefreshDispatchMock: vi.fn(),
}));

vi.mock('@/realtime/screens-namespace', () => ({
  emitScreensRefreshRequired: emitScreensRefreshRequiredMock,
}));

vi.mock('@/jobs', () => ({
  isJobsInitialized: isJobsInitializedMock,
  queuePlaybackRefreshDispatch: queuePlaybackRefreshDispatchMock,
}));

import { closeDatabase, getDatabase, initializeDatabase, schema } from '@/db';
import {
  PLAYBACK_REFRESH_JOB_CHUNK_SIZE,
  dispatchPlaybackRefresh,
} from '@/services/playback-refresh-dispatch';

describe('playback refresh dispatch', () => {
  beforeAll(async () => {
    await initializeDatabase();
  });

  beforeEach(async () => {
    isJobsInitializedMock.mockReset();
    queuePlaybackRefreshDispatchMock.mockReset();
    emitScreensRefreshRequiredMock.mockReset();
    const db = getDatabase();
    await db.delete(schema.deviceCommands);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('queues chunked refresh-dispatch jobs when the job runtime is available', async () => {
    isJobsInitializedMock.mockReturnValue(true);
    queuePlaybackRefreshDispatchMock.mockResolvedValue('job-id');

    const screenIds = Array.from(
      { length: PLAYBACK_REFRESH_JOB_CHUNK_SIZE * 2 + 5 },
      () => randomUUID()
    );

    const result = await dispatchPlaybackRefresh({} as any, {
      reason: 'PUBLISH',
      screenIds,
      createdBy: randomUUID(),
      publishId: randomUUID(),
      snapshotId: randomUUID(),
    });

    expect(result.commandsCreated).toBe(0);
    expect(queuePlaybackRefreshDispatchMock).toHaveBeenCalledTimes(3);
    expect(
      queuePlaybackRefreshDispatchMock.mock.calls.map(([job]) => job.screenIds.length)
    ).toEqual([PLAYBACK_REFRESH_JOB_CHUNK_SIZE, PLAYBACK_REFRESH_JOB_CHUNK_SIZE, 5]);
    expect(queuePlaybackRefreshDispatchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        singletonKey: expect.any(String),
        singletonSeconds: 60,
      })
    );
    expect(emitScreensRefreshRequiredMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reason: 'PUBLISH',
        screen_ids: screenIds,
        group_ids: [],
      })
    );

    const db = getDatabase();
    const commands = await db
      .select()
      .from(schema.deviceCommands)
      .where(inArray(schema.deviceCommands.screen_id, screenIds as string[]));

    expect(commands).toHaveLength(0);
  });

  it('falls back to inline command creation when queueing fails', async () => {
    isJobsInitializedMock.mockReturnValue(true);
    queuePlaybackRefreshDispatchMock.mockRejectedValue(new Error('pg-boss unavailable'));

    const screenIds = [randomUUID(), randomUUID()];
    const result = await dispatchPlaybackRefresh({} as any, {
      reason: 'EMERGENCY',
      screenIds,
      createdBy: randomUUID(),
    });

    expect(queuePlaybackRefreshDispatchMock).toHaveBeenCalledTimes(1);
    expect(result.commandsCreated).toBe(2);

    const db = getDatabase();
    const commands = await db
      .select()
      .from(schema.deviceCommands)
      .where(inArray(schema.deviceCommands.screen_id, screenIds as string[]));

    expect(commands).toHaveLength(2);
    expect(commands.every((command) => command.type === 'REFRESH' && command.status === 'PENDING')).toBe(true);
    expect(commands.every((command) => (command.payload as { reason?: string } | null)?.reason === 'EMERGENCY')).toBe(true);
  });
});
