import { describe, expect, it } from 'vitest';
import { InMemoryTokenBucketRateLimiter } from '@/chat/rate-limit';

describe('InMemoryTokenBucketRateLimiter', () => {
  it('blocks once bucket capacity is exhausted', () => {
    const limiter = new InMemoryTokenBucketRateLimiter(2, 0);
    expect(limiter.consume('k').allowed).toBe(true);
    expect(limiter.consume('k').allowed).toBe(true);
    const denied = limiter.consume('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(0);
  });
});
