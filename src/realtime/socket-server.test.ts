import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadSocketServer() {
  vi.resetModules();
  return await import('./socket-server');
}

function applyRequiredEnv(): void {
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/signhex';
  process.env.JWT_SECRET = '12345678901234567890123456789012';
  process.env.MINIO_ACCESS_KEY = 'minioadmin';
  process.env.MINIO_SECRET_KEY = 'minioadmin';
  process.env.ADMIN_EMAIL = 'admin@signhex.invalid';
  process.env.ADMIN_PASSWORD = 'ChangeMe123!';
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('socket-server origin handling', () => {
  it('allows localhost fallback only outside production', async () => {
    applyRequiredEnv();
    process.env.NODE_ENV = 'development';
    process.env.CORS_ORIGINS = '';
    process.env.SOCKET_ALLOWED_ORIGINS = '';
    delete process.env.APP_PUBLIC_BASE_URL;

    const { getHttpAllowedOrigins, getSocketAllowedOrigins } = await loadSocketServer();

    expect(getHttpAllowedOrigins()).toContain('http://localhost:8080');
    expect(getSocketAllowedOrigins()).toContain('http://localhost:8080');
  });

  it('uses only configured IP-based origins in production', async () => {
    applyRequiredEnv();
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGINS = 'https://10.20.0.30';
    process.env.SOCKET_ALLOWED_ORIGINS = '';
    process.env.APP_PUBLIC_BASE_URL = 'https://10.20.0.30';

    const { getHttpAllowedOrigins, getSocketAllowedOrigins } = await loadSocketServer();

    expect(getHttpAllowedOrigins()).toEqual(['https://10.20.0.30']);
    expect(getSocketAllowedOrigins()).toEqual(['https://10.20.0.30']);
    expect(getHttpAllowedOrigins()).not.toContain('http://localhost:8080');
  });

  it('prefers explicit socket origins in production', async () => {
    applyRequiredEnv();
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGINS = 'https://10.20.0.30';
    process.env.APP_PUBLIC_BASE_URL = 'https://10.20.0.30';
    process.env.SOCKET_ALLOWED_ORIGINS = 'https://10.20.0.31, https://10.20.0.32';

    const { getSocketAllowedOrigins } = await loadSocketServer();

    expect(getSocketAllowedOrigins()).toEqual(['https://10.20.0.31', 'https://10.20.0.32']);
  });
});
