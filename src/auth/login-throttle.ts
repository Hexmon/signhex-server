type AttemptState = {
  count: number;
  windowStart: number;
  lockedUntil?: number;
};

const attempts = new Map<string, AttemptState>();

export function isLockedOut(key: string, lockoutWindowMs: number): { locked: boolean; retryAfter?: number } {
  const now = Date.now();
  const state = attempts.get(key);
  if (!state?.lockedUntil) return { locked: false };

  if (state.lockedUntil > now) {
    return { locked: true, retryAfter: Math.ceil((state.lockedUntil - now) / 1000) };
  }

  // Lock expired, reset
  attempts.delete(key);
  return { locked: false };
}

export function recordFailedAttempt(
  key: string,
  maxAttempts: number,
  lockoutWindowMs: number
): { locked: boolean; retryAfter?: number } {
  const now = Date.now();
  const state = attempts.get(key);

  if (!state) {
    const next: AttemptState = { count: 1, windowStart: now };
    attempts.set(key, next);
    return { locked: false };
  }

  // Reset window if stale
  if (now - state.windowStart > lockoutWindowMs) {
    state.count = 1;
    state.windowStart = now;
    delete state.lockedUntil;
    attempts.set(key, state);
    return { locked: false };
  }

  state.count += 1;
  if (state.count >= maxAttempts) {
    state.lockedUntil = now + lockoutWindowMs;
    attempts.set(key, state);
    return { locked: true, retryAfter: Math.ceil(lockoutWindowMs / 1000) };
  }

  attempts.set(key, state);
  return { locked: false };
}

export function resetAttempts(key: string): void {
  attempts.delete(key);
}

export function _clearAllAttemptsForTests() {
  attempts.clear();
}
