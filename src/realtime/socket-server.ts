import { FastifyInstance } from 'fastify';
import { Server as SocketIOServer } from 'socket.io';
import { config as appConfig } from '@/config';
import { setWebsocketConnections } from '@/observability/metrics';

const DEFAULT_ORIGIN = 'http://localhost:8080';
const DEVELOPMENT_LOCAL_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const SOCKET_SERVER_KEY = Symbol.for('signhex.socket.io.server');
const SOCKET_OBSERVABILITY_KEY = Symbol.for('signhex.socket.io.observability');
let socketServer: SocketIOServer | null = null;

type HttpServerWithSocket = {
  [SOCKET_SERVER_KEY]?: SocketIOServer;
};

type SocketServerWithObservability = SocketIOServer & {
  [SOCKET_OBSERVABILITY_KEY]?: boolean;
};

function attachSocketObservability(io: SocketIOServer) {
  const instrumented = io as SocketServerWithObservability;
  if (instrumented[SOCKET_OBSERVABILITY_KEY]) {
    return;
  }

  instrumented[SOCKET_OBSERVABILITY_KEY] = true;
  setWebsocketConnections(io.engine.clientsCount);
  io.on('connection', (socket) => {
    setWebsocketConnections(io.engine.clientsCount);
    socket.on('disconnect', () => {
      setWebsocketConnections(io.engine.clientsCount);
    });
  });
}

export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupeOrigins(origins: string[]): string[] {
  return Array.from(new Set(origins.filter(Boolean)));
}

function getConfiguredHttpOrigins(): string[] {
  return dedupeOrigins([
    appConfig.APP_PUBLIC_BASE_URL || '',
    ...parseAllowedOrigins(appConfig.CORS_ORIGINS || ''),
  ]);
}

export function getHttpAllowedOrigins(): string[] {
  const configured = getConfiguredHttpOrigins();
  if (appConfig.NODE_ENV === 'production') {
    return configured;
  }

  return dedupeOrigins([DEFAULT_ORIGIN, ...configured]);
}

export function getSocketAllowedOrigins(): string[] {
  const fromSocketEnv = parseAllowedOrigins(appConfig.SOCKET_ALLOWED_ORIGINS || '');
  if (fromSocketEnv.length > 0) {
    return dedupeOrigins(fromSocketEnv);
  }

  const fromHttpOrigins = getConfiguredHttpOrigins();
  if (appConfig.NODE_ENV === 'production') {
    return fromHttpOrigins;
  }

  return dedupeOrigins([DEFAULT_ORIGIN, ...fromHttpOrigins]);
}

function isDevelopmentLocalOrigin(origin: string): boolean {
  if (appConfig.NODE_ENV === 'production') {
    return false;
  }

  try {
    const parsed = new URL(origin);
    return DEVELOPMENT_LOCAL_ORIGIN_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function isAllowedOrigin(
  origin: string | undefined,
  allowlist = getSocketAllowedOrigins()
): boolean {
  if (!origin) return false;
  return allowlist.includes(origin) || isDevelopmentLocalOrigin(origin);
}

export function getOrCreateSocketServer(fastify: FastifyInstance): SocketIOServer {
  const httpServer = fastify.server as HttpServerWithSocket;
  const existingOnServer = httpServer[SOCKET_SERVER_KEY];
  if (existingOnServer) {
    (fastify as any).io = existingOnServer;
    socketServer = existingOnServer;
    attachSocketObservability(existingOnServer);
    return existingOnServer;
  }

  const existing = (fastify as any).io as SocketIOServer | undefined;
  if (existing) {
    socketServer = existing;
    attachSocketObservability(existing);
    return existing;
  }

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
  httpServer[SOCKET_SERVER_KEY] = io;
  socketServer = io;
  attachSocketObservability(io);
  return io;
}

export function getSocketServer(): SocketIOServer | null {
  return socketServer;
}
