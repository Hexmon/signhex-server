import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildScreenPlaybackStateByIdMock,
  emitScreenStateUpdateGlobalMock,
  getSocketServerMock,
} = vi.hoisted(() => ({
  buildScreenPlaybackStateByIdMock: vi.fn(),
  emitScreenStateUpdateGlobalMock: vi.fn(),
  getSocketServerMock: vi.fn(),
}));

vi.mock('@/screens/playback', () => ({
  buildScreenPlaybackStateById: buildScreenPlaybackStateByIdMock,
}));

vi.mock('@/realtime/screens-namespace', () => ({
  emitScreenStateUpdateGlobal: emitScreenStateUpdateGlobalMock,
}));

vi.mock('@/realtime/socket-server', () => ({
  getSocketServer: getSocketServerMock,
}));

import { clearQueuedScreenStateRefreshes, queueScreenStateRefresh } from '@/services/screen-state-refresh';

describe('screen state refresh queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearQueuedScreenStateRefreshes();
    buildScreenPlaybackStateByIdMock.mockReset();
    emitScreenStateUpdateGlobalMock.mockReset();
    getSocketServerMock.mockReset();
    getSocketServerMock.mockReturnValue({} as any);
    buildScreenPlaybackStateByIdMock.mockResolvedValue({ id: 'screen-1' });
  });

  afterEach(() => {
    clearQueuedScreenStateRefreshes();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('coalesces repeated refresh requests for the same screen', async () => {
    queueScreenStateRefresh('screen-1', { debounceMs: 50 });
    queueScreenStateRefresh('screen-1', { debounceMs: 50 });
    queueScreenStateRefresh('screen-1', { debounceMs: 50 });

    await vi.advanceTimersByTimeAsync(50);

    expect(buildScreenPlaybackStateByIdMock).toHaveBeenCalledTimes(1);
    expect(buildScreenPlaybackStateByIdMock).toHaveBeenCalledWith('screen-1');
    expect(emitScreenStateUpdateGlobalMock).toHaveBeenCalledTimes(1);
  });

  it('schedules one follow-up refresh when a request arrives during an in-flight refresh', async () => {
    let resolveRefresh: ((value: { id: string }) => void) | undefined;
    buildScreenPlaybackStateByIdMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );

    queueScreenStateRefresh('screen-1', { debounceMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    expect(buildScreenPlaybackStateByIdMock).toHaveBeenCalledTimes(1);

    queueScreenStateRefresh('screen-1', { debounceMs: 25 });
    queueScreenStateRefresh('screen-1', { debounceMs: 25 });

    resolveRefresh?.({ id: 'screen-1' });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(25);

    expect(buildScreenPlaybackStateByIdMock).toHaveBeenCalledTimes(2);
    expect(emitScreenStateUpdateGlobalMock).toHaveBeenCalledTimes(2);
  });

  it('skips refresh work when no socket server is available', async () => {
    getSocketServerMock.mockReturnValue(null);

    queueScreenStateRefresh('screen-1', { debounceMs: 25 });
    await vi.advanceTimersByTimeAsync(25);

    expect(buildScreenPlaybackStateByIdMock).not.toHaveBeenCalled();
    expect(emitScreenStateUpdateGlobalMock).not.toHaveBeenCalled();
  });
});
