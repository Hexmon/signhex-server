import { describe, it, expect, beforeEach } from 'vitest';
import { isLockedOut, recordFailedAttempt, resetAttempts, _clearAllAttemptsForTests } from './login-throttle';

const KEY = 'user@example.com:127.0.0.1';

describe('login throttle', () => {
  beforeEach(() => {
    _clearAllAttemptsForTests();
  });

  it('locks after max attempts within window', () => {
    const maxAttempts = 3;
    const lockMs = 1000;

    expect(isLockedOut(KEY, lockMs)).toEqual({ locked: false });
    recordFailedAttempt(KEY, maxAttempts, lockMs);
    recordFailedAttempt(KEY, maxAttempts, lockMs);
    const result = recordFailedAttempt(KEY, maxAttempts, lockMs);
    expect(result.locked).toBe(true);
    const locked = isLockedOut(KEY, lockMs);
    expect(locked.locked).toBe(true);
  });

  it('resets after successful login', () => {
    const maxAttempts = 2;
    const lockMs = 1000;
    recordFailedAttempt(KEY, maxAttempts, lockMs);
    resetAttempts(KEY);
    expect(isLockedOut(KEY, lockMs).locked).toBe(false);
  });
});
