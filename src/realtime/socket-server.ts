import { FastifyInstance } from 'fastify';
import { Server as SocketIOServer } from 'socket.io';
import { config as appConfig } from '@/config';

const DEFAULT_ORIGIN = 'http://localhost:8080';

export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getSocketAllowedOrigins(): string[] {
  const fromSocketEnv = parseAllowedOrigins(appConfig.SOCKET_ALLOWED_ORIGINS || '');
  if (fromSocketEnv.length > 0) {
    return fromSocketEnv;
  }

  const fromCorsEnv = parseAllowedOrigins(appConfig.CORS_ORIGINS || '');
  return Array.from(new Set([DEFAULT_ORIGIN, ...fromCorsEnv]));
}

export function isAllowedOrigin(origin: string | undefined, allowlist = getSocketAllowedOrigins()): boolean {
  if (!origin) return false;
  return allowlist.includes(origin);
}

export function getOrCreateSocketServer(fastify: FastifyInstance): SocketIOServer {
  const existing = (fastify as any).io as SocketIOServer | undefined;
  if (existing) return existing;

  const allowlist = getSocketAllowedOrigins();
  const io = new SocketIOServer(fastify.server, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (isAllowedOrigin(origin, allowlist)) return cb(null, true);
        return cb(new Error('CORS origin not allowed'), false);
      },
      credentials: true,
    },
  });

  (fastify as any).io = io;
  return io;
}
