import { FastifyInstance } from 'fastify';
import { Socket } from 'socket.io';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';
import { createChatRepository } from '@/db/repositories/chat';
import { createLogger } from '@/utils/logger';
import { getActiveModeration } from '@/chat/guard';
import {
  getOrCreateSocketServer,
  getSocketAllowedOrigins,
  isAllowedOrigin,
} from '@/realtime/socket-server';

const logger = createLogger('chat-namespace');

const CHAT_NAMESPACE = '/chat';

function parseCookieValue(cookieHeader: string | undefined, key: string): string | undefined {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(';').map((item) => item.trim());
  for (const part of parts) {
    const [name, ...rest] = part.split('=');
    if (name === key) return rest.join('=');
  }
  return undefined;
}

type SocketAuthResolution = {
  token?: string;
  source?: 'handshake_auth' | 'authorization_header' | 'cookie';
  error?: string;
};

function isSessionValidForUser(
  session: { user_id: string; expires_at: Date } | null,
  userId: string
): boolean {
  if (!session) return false;
  if (session.user_id !== userId) return false;
  return session.expires_at.getTime() > Date.now();
}

export function resolveSocketAuthToken(input: {
  authToken?: string;
  authorizationHeader?: string;
  cookieHeader?: string;
  origin?: string;
  allowlist: string[];
}): SocketAuthResolution {
  const hasOrigin = Boolean(input.origin);
  const originAllowed = isAllowedOrigin(input.origin, input.allowlist);

  if (hasOrigin && !originAllowed) {
    return { error: 'Origin not allowed' };
  }

  if (input.authToken) {
    return { token: input.authToken, source: 'handshake_auth' };
  }

  const headerToken = extractTokenFromHeader(input.authorizationHeader);
  if (headerToken) {
    return { token: headerToken, source: 'authorization_header' };
  }

  const cookieToken = parseCookieValue(input.cookieHeader, 'access_token');
  if (cookieToken) {
    if (!input.origin) {
      return { error: 'Origin is required for cookie-based WebSocket auth' };
    }
    if (!originAllowed) {
      return { error: 'Origin not allowed' };
    }
    return { token: cookieToken, source: 'cookie' };
  }

  return { error: 'Missing websocket authentication token' };
}

export function chatConversationRoom(conversationId: string): string {
  return `chat:conv:${conversationId}`;
}

export function canSocketSubscribe(
  canAccess: boolean,
  moderation: { muted_until?: Date | string | null; banned_until?: Date | string | null } | null
): boolean {
  if (!canAccess) return false;
  const { bannedUntil } = getActiveModeration(moderation);
  return !bannedUntil;
}

export async function setupChatNamespace(fastify: FastifyInstance) {
  if ((fastify as any)._chatNamespaceReady) return;

  const io = getOrCreateSocketServer(fastify);
  const allowlist = getSocketAllowedOrigins();
  const sessionRepo = createSessionRepository();
  const chatRepo = createChatRepository();
  const nsp = io.of(CHAT_NAMESPACE);

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
      logger.warn(error, 'Chat socket auth failed');
      return next(new Error('Unauthorized'));
    }
  });

  nsp.on('connection', (socket: Socket) => {
    const user = (socket.data as any).user;
    if (!user?.sub) {
      socket.disconnect(true);
      return;
    }

    socket.on(
      'chat:subscribe',
      async (payload: { conversationIds?: string[] }, ack?: (result: any) => void) => {
        const ids = Array.isArray(payload?.conversationIds) ? payload.conversationIds : [];
        const subscribed: string[] = [];
        const rejected: string[] = [];

        for (const id of ids) {
          const canAccess = await chatRepo.canAccessConversation(id, user.sub, user.role);
          const moderation = await chatRepo.getModeration(id, user.sub);
          if (!canSocketSubscribe(canAccess, moderation)) {
            rejected.push(id);
            continue;
          }
          socket.join(chatConversationRoom(id));
          subscribed.push(id);
        }

        if (ack) ack({ subscribed, rejected });
      }
    );

    socket.on('chat:typing', async (payload: { conversationId: string; isTyping: boolean }) => {
      if (!payload?.conversationId) return;
      const canAccess = await chatRepo.canAccessConversation(payload.conversationId, user.sub, user.role);
      if (!canAccess) return;
      const moderation = await chatRepo.getModeration(payload.conversationId, user.sub);
      if (getActiveModeration(moderation).bannedUntil) return;

      nsp.to(chatConversationRoom(payload.conversationId)).emit('chat:typing', {
        conversationId: payload.conversationId,
        userId: user.sub,
        isTyping: Boolean(payload.isTyping),
        ttlSeconds: 7,
      });
    });

    socket.on('chat:read', async (payload: { conversationId: string; lastReadSeq: number }) => {
      if (!payload?.conversationId || typeof payload.lastReadSeq !== 'number') return;
      const canAccess = await chatRepo.canAccessConversation(payload.conversationId, user.sub, user.role);
      if (!canAccess) return;
      const moderation = await chatRepo.getModeration(payload.conversationId, user.sub);
      if (getActiveModeration(moderation).bannedUntil) return;
      await chatRepo.markRead(payload.conversationId, user.sub, payload.lastReadSeq);
    });
  });

  (fastify as any)._chatNamespaceReady = true;
}

export function emitChatEvent(
  fastify: FastifyInstance,
  conversationId: string,
  event:
    | 'chat:message:new'
    | 'chat:message:updated'
    | 'chat:message:deleted'
    | 'chat:conversation:updated'
    | 'chat:pin:update'
    | 'chat:bookmark:update'
    | 'chat:typing',
  payload: Record<string, unknown>
) {
  const io = getOrCreateSocketServer(fastify);
  io.of(CHAT_NAMESPACE).to(chatConversationRoom(conversationId)).emit(event, payload);
}
