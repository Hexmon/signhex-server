import { config as appConfig } from '@/config';
import { createLogger } from '@/utils/logger';

const logger = createLogger('chat-rate-limit');

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds?: number;
};

export interface RateLimiter {
  consume(key: string, tokens?: number): RateLimitDecision;
}

type TokenBucketState = {
  tokens: number;
  lastRefillMs: number;
};

export class InMemoryTokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, TokenBucketState>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number
  ) {}

  consume(key: string, tokens = 1): RateLimitDecision {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? {
      tokens: this.capacity,
      lastRefillMs: now,
    };

    const elapsedSeconds = Math.max((now - bucket.lastRefillMs) / 1000, 0);
    const refilled = elapsedSeconds * this.refillPerSecond;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + refilled);
    bucket.lastRefillMs = now;

    if (bucket.tokens < tokens) {
      this.buckets.set(key, bucket);
      const missing = tokens - bucket.tokens;
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(missing / this.refillPerSecond),
      };
    }

    bucket.tokens -= tokens;
    this.buckets.set(key, bucket);
    return { allowed: true };
  }
}

// TODO(signhex): Implement distributed token bucket with Redis + Lua for multi-node deployments.
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redisUrl: string) {}

  consume(_key: string, _tokens = 1): RateLimitDecision {
    logger.warn(
      { redisUrl: this.redisUrl },
      'RedisRateLimiter is not implemented yet; falling back to in-memory limiter is recommended'
    );
    return { allowed: true };
  }
}

export function createRateLimiter(options?: {
  capacity?: number;
  refillPerSecond?: number;
}): RateLimiter {
  const capacity = options?.capacity ?? 20;
  const refillPerSecond = options?.refillPerSecond ?? 1;

  if (appConfig.REDIS_URL) {
    logger.warn('REDIS_URL is set but RedisRateLimiter is a stub; using in-memory limiter');
  }

  return new InMemoryTokenBucketRateLimiter(capacity, refillPerSecond);
}
