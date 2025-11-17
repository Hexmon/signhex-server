import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createConversationRepository } from '@/db/repositories/conversation';
import { createLogger } from '@/utils/logger';

const logger = createLogger('conversation-routes');

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
    '/v1/conversations',
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
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Conversation')) return reply.status(403).send({ error: 'Forbidden' });

        const data = startConversationSchema.parse(request.body);
        const conversation = await repo.getOrCreate(payload.sub, data.participant_id);
        return reply.status(201).send(conversation);
      } catch (error) {
        logger.error(error, 'Start conversation error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  fastify.get(
    '/v1/conversations',
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
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Conversation')) return reply.status(403).send({ error: 'Forbidden' });

        const items = await repo.listForUser(payload.sub);
        return reply.send({ items });
      } catch (error) {
        logger.error(error, 'List conversations error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  fastify.get<{ Params: { id: string }; Querystring: { page?: number; limit?: number } }>(
    '/v1/conversations/:id/messages',
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
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Conversation')) return reply.status(403).send({ error: 'Forbidden' });

        const page = (request.query as any).page ? parseInt((request.query as any).page as string) : 1;
        const limit = (request.query as any).limit ? parseInt((request.query as any).limit as string) : 50;
        const result = await repo.listMessages((request.params as any).id, page, limit);
        return reply.send(result);
      } catch (error) {
        logger.error(error, 'List messages error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: typeof sendMessageSchema._type }>(
    '/v1/conversations/:id/messages',
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
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Conversation')) return reply.status(403).send({ error: 'Forbidden' });

        const data = sendMessageSchema.parse(request.body);
        const message = await repo.addMessage((request.params as any).id, payload.sub, data.content, data.attachments);
        return reply.status(201).send(message);
      } catch (error) {
        logger.error(error, 'Send message error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/v1/conversations/:id/read',
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
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Conversation')) return reply.status(403).send({ error: 'Forbidden' });

        const record = await repo.markRead((request.params as any).id, payload.sub);
        return reply.send(record);
      } catch (error) {
        logger.error(error, 'Read conversation error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
