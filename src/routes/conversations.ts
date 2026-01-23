import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createConversationRepository } from '@/db/repositories/conversation';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';

const logger = createLogger('conversation-routes');
const { BAD_REQUEST, CREATED, FORBIDDEN, UNAUTHORIZED } = HTTP_STATUS;

const startConversationSchema = z.object({
  participant_id: z.string().uuid(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1),
  attachments: z.array(z.any()).optional(),
});

export async function conversationRoutes(fastify: FastifyInstance) {
  const repo = createConversationRepository();

  fastify.post<{ Body: typeof startConversationSchema._type }>(
    apiEndpoints.conversations.start,
    {
      schema: {
        description: 'Start or get a 1:1 conversation',
        tags: ['Conversations'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'Conversation')) throw AppError.forbidden('Forbidden');

        const data = startConversationSchema.parse(request.body);
        const conversation = await repo.getOrCreate(payload.sub, data.participant_id);
        return reply.status(CREATED).send(conversation);
      } catch (error) {
        logger.error(error, 'Start conversation error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.conversations.list,
    {
      schema: {
        description: 'List conversations for current user',
        tags: ['Conversations'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'Conversation')) throw AppError.forbidden('Forbidden');

        const items = await repo.listForUser(payload.sub);
        return reply.send({ items });
      } catch (error) {
        logger.error(error, 'List conversations error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Params: { id: string }; Querystring: { page?: number; limit?: number } }>(
    apiEndpoints.conversations.listMessages,
    {
      schema: {
        description: 'List messages in a conversation',
        tags: ['Conversations'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'Conversation')) throw AppError.forbidden('Forbidden');

        const page = (request.query as any).page ? parseInt((request.query as any).page as string) : 1;
        const limit = (request.query as any).limit ? parseInt((request.query as any).limit as string) : 50;
        const result = await repo.listMessages((request.params as any).id, page, limit);
        return reply.send(result);
      } catch (error) {
        logger.error(error, 'List messages error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: typeof sendMessageSchema._type }>(
    apiEndpoints.conversations.sendMessage,
    {
      schema: {
        description: 'Send message in a conversation',
        tags: ['Conversations'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'Conversation')) throw AppError.forbidden('Forbidden');

        const data = sendMessageSchema.parse(request.body);
        const message = await repo.addMessage((request.params as any).id, payload.sub, data.content, data.attachments);
        return reply.status(CREATED).send(message);
      } catch (error) {
        logger.error(error, 'Send message error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.conversations.markRead,
    {
      schema: {
        description: 'Mark conversation as read',
        tags: ['Conversations'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'Conversation')) throw AppError.forbidden('Forbidden');

        const record = await repo.markRead((request.params as any).id, payload.sub);
        return reply.send(record);
      } catch (error) {
        logger.error(error, 'Read conversation error');
        return respondWithError(reply, error);
      }
    }
  );
}
