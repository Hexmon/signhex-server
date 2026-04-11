import { buildScreenPlaybackStateById } from '@/screens/playback';
import { emitScreenStateUpdateGlobal } from '@/realtime/screens-namespace';
import { getSocketServer } from '@/realtime/socket-server';
import { createLogger } from '@/utils/logger';

const logger = createLogger('screen-state-refresh');
const DEFAULT_DEBOUNCE_MS = 750;

type ScreenRefreshState = {
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  rerun: boolean;
  debounceMs: number;
};

const refreshStateByScreenId = new Map<string, ScreenRefreshState>();

function scheduleRefresh(screenId: string, state: ScreenRefreshState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }

  state.timer = setTimeout(() => {
    state.timer = null;
    void runRefresh(screenId);
  }, state.debounceMs);
}

async function runRefresh(screenId: string) {
  const state = refreshStateByScreenId.get(screenId);
  if (!state) {
    return;
  }

  if (state.inFlight) {
    state.rerun = true;
    return;
  }

  if (!getSocketServer()) {
    refreshStateByScreenId.delete(screenId);
    return;
  }

  state.inFlight = true;
  let shouldReschedule = false;

  try {
    const playbackState = await buildScreenPlaybackStateById(screenId);
    if (playbackState) {
      emitScreenStateUpdateGlobal(playbackState);
    }
  } catch (error) {
    logger.warn({ error, screenId }, 'Failed to refresh screen state');
  } finally {
    state.inFlight = false;
    shouldReschedule = state.rerun;
    state.rerun = false;
  }

  if (shouldReschedule) {
    scheduleRefresh(screenId, state);
    return;
  }

  if (!state.timer) {
    refreshStateByScreenId.delete(screenId);
  }
}

export function queueScreenStateRefresh(
  screenId: string,
  options?: {
    debounceMs?: number;
  }
) {
  if (!screenId) {
    return;
  }

  const debounceMs = Math.max(0, options?.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const state = refreshStateByScreenId.get(screenId) ?? {
    timer: null,
    inFlight: false,
    rerun: false,
    debounceMs,
  };

  state.debounceMs = debounceMs;
  refreshStateByScreenId.set(screenId, state);

  if (state.inFlight) {
    state.rerun = true;
    return;
  }

  scheduleRefresh(screenId, state);
}

export function clearQueuedScreenStateRefreshes() {
  for (const state of refreshStateByScreenId.values()) {
    if (state.timer) {
      clearTimeout(state.timer);
    }
  }
  refreshStateByScreenId.clear();
}
