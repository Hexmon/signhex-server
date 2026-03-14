import { FastifyInstance } from 'fastify';
import { Socket } from 'socket.io';
import { verifyAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';
import { getDatabase, schema } from '@/db';
import { createLogger } from '@/utils/logger';
import { buildScreenPlaybackStateById, buildScreensOverviewPayload } from '@/screens/playback';
import { resolveSocketAuthToken } from '@/realtime/chat-namespace';
import { getOrCreateSocketServer, getSocketAllowedOrigins } from '@/realtime/socket-server';
import { inArray } from 'drizzle-orm';

const logger = createLogger('screens-namespace');
const SCREENS_NAMESPACE = '/screens';

function isSessionValidForUser(
  session: { user_id: string; expires_at: Date } | null,
  userId: string
): boolean {
  if (!session) return false;
  if (session.user_id !== userId) return false;
  return session.expires_at.getTime() > Date.now();
}

export function screensAllRoom(): string {
  return 'screens:all';
}

export function screenRoom(screenId: string): string {
  return `screens:${screenId}`;
}

export async function setupScreensNamespace(fastify: FastifyInstance) {
  if ((fastify as any)._screensNamespaceReady) return;

  const io = getOrCreateSocketServer(fastify);
  const allowlist = getSocketAllowedOrigins();
  const sessionRepo = createSessionRepository();
  const db = getDatabase();
  const nsp = io.of(SCREENS_NAMESPACE);

  nsp.use(async (socket, next) => {
    try {
      const resolved = resolveSocketAuthToken({
        authToken: typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : undefined,
        authorizationHeader:
          typeof socket.handshake.headers.authorization === 'string'
            ? socket.handshake.headers.authorization
            : undefined,
        cookieHeader:
          typeof socket.handshake.headers.cookie === 'string' ? socket.handshake.headers.cookie : undefined,
        origin:
          typeof socket.handshake.headers.origin === 'string' ? socket.handshake.headers.origin : undefined,
        allowlist,
      });

      if (!resolved.token) {
        return next(new Error(resolved.error || 'Unauthorized'));
      }

      const payload = await verifyAccessToken(resolved.token);
      const session = await sessionRepo.findByJti(payload.jti);
      if (!isSessionValidForUser(session, payload.sub)) {
        return next(new Error('Token has been revoked'));
      }

      (socket.data as any).user = payload;
      return next();
    } catch (error) {
      logger.warn(error, 'Screen socket auth failed');
      return next(new Error('Unauthorized'));
    }
  });

  nsp.on('connection', (socket: Socket) => {
    socket.on(
      'screens:subscribe',
      async (payload: { screenIds?: string[]; includeAll?: boolean }, ack?: (result: any) => void) => {
        const ids = Array.isArray(payload?.screenIds)
          ? Array.from(new Set(payload.screenIds.filter((value) => typeof value === 'string' && value)))
          : [];
        const subscribed: string[] = [];
        const rejected: string[] = [];
        const includeAll = payload?.includeAll === true;

        if (includeAll) {
          socket.join(screensAllRoom());
        }

        if (ids.length > 0) {
          const rows = await db
            .select({ id: schema.screens.id })
            .from(schema.screens)
            .where(inArray(schema.screens.id, ids as any));
          const existing = new Set(rows.map((row) => row.id));

          for (const id of ids) {
            if (!existing.has(id)) {
              rejected.push(id);
              continue;
            }
            socket.join(screenRoom(id));
            subscribed.push(id);
          }
        }

        if (ack) {
          ack({
            subscribed_all: includeAll,
            subscribed,
            rejected,
          });
        }
      }
    );

    socket.on('screens:sync', async (payload: { screenIds?: string[] } | undefined, ack?: (result: any) => void) => {
      try {
        const ids = Array.isArray(payload?.screenIds)
          ? Array.from(new Set(payload.screenIds.filter((value) => typeof value === 'string' && value)))
          : [];

        if (ids.length === 0) {
          const overview = await buildScreensOverviewPayload({ db });
          if (ack) {
            ack(overview);
          } else {
            socket.emit('screens:sync', overview);
          }
          return;
        }

        const screens = (
          await Promise.all(ids.map((screenId) => buildScreenPlaybackStateById(screenId, { db })))
        ).filter(Boolean);

        const result = {
          server_time: new Date().toISOString(),
          screens,
        };

        if (ack) {
          ack(result);
        } else {
          socket.emit('screens:sync', result);
        }
      } catch (error) {
        logger.warn(error, 'Failed to sync screens state');
        if (ack) {
          ack({
            server_time: new Date().toISOString(),
            screens: [],
          });
        }
      }
    });
  });

  (fastify as any)._screensNamespaceReady = true;
}

export function emitScreenStateUpdate(
  fastify: FastifyInstance,
  screen: Record<string, unknown> & { id: string }
) {
  const io = getOrCreateSocketServer(fastify);
  io.of(SCREENS_NAMESPACE)
    .to(screensAllRoom())
    .to(screenRoom(screen.id))
    .emit('screens:state:update', {
      server_time: new Date().toISOString(),
      screen,
    });
}

export function emitScreenPreviewUpdate(
  fastify: FastifyInstance,
  payload: {
    screenId: string;
    captured_at: string;
    screenshot_url: string | null;
    stale: boolean;
    storage_object_id?: string | null;
  }
) {
  const io = getOrCreateSocketServer(fastify);
  io.of(SCREENS_NAMESPACE)
    .to(screensAllRoom())
    .to(screenRoom(payload.screenId))
    .emit('screens:preview:update', payload);
}

export function emitScreensRefreshRequired(
  fastify: FastifyInstance,
  payload: {
    reason: 'PUBLISH' | 'EMERGENCY' | 'GROUP_MEMBERSHIP';
    screen_ids?: string[];
    group_ids?: string[];
  }
) {
  const io = getOrCreateSocketServer(fastify);
  let emitter = io.of(SCREENS_NAMESPACE).to(screensAllRoom());

  for (const screenId of payload.screen_ids || []) {
    emitter = emitter.to(screenRoom(screenId));
  }

  emitter.emit('screens:refresh:required', {
    reason: payload.reason,
    screen_ids: payload.screen_ids || [],
    group_ids: payload.group_ids || [],
  });
}
