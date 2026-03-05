import { describe, it, expect } from 'vitest';
import { canSocketSubscribe, resolveSocketAuthToken } from '@/realtime/chat-namespace';

describe('chat namespace auth resolution', () => {
  const allowlist = ['http://localhost:8080'];

  it('rejects cookie auth when origin is not allowlisted', () => {
    const result = resolveSocketAuthToken({
      cookieHeader: 'access_token=cookie-token',
      origin: 'http://malicious.local',
      allowlist,
    });
    expect(result.token).toBeUndefined();
    expect(result.error).toContain('Origin not allowed');
  });

  it('rejects cookie auth when origin is missing', () => {
    const result = resolveSocketAuthToken({
      cookieHeader: 'access_token=cookie-token',
      allowlist,
    });
    expect(result.token).toBeUndefined();
    expect(result.error).toContain('Origin is required');
  });

  it('accepts cookie auth when origin is allowlisted', () => {
    const result = resolveSocketAuthToken({
      cookieHeader: 'access_token=cookie-token',
      origin: 'http://localhost:8080',
      allowlist,
    });
    expect(result.token).toBe('cookie-token');
    expect(result.source).toBe('cookie');
  });

  it('accepts handshake auth token without origin', () => {
    const result = resolveSocketAuthToken({
      authToken: 'token-123',
      allowlist,
    });
    expect(result.token).toBe('token-123');
    expect(result.source).toBe('handshake_auth');
  });

  it('rejects socket subscription when user is actively banned', () => {
    const allowed = canSocketSubscribe(true, {
      banned_until: new Date(Date.now() + 60_000),
    });
    expect(allowed).toBe(false);
  });

  it('allows socket subscription for muted users', () => {
    const allowed = canSocketSubscribe(true, {
      muted_until: new Date(Date.now() + 60_000),
    });
    expect(allowed).toBe(true);
  });
});
