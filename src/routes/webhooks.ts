import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createWebhookRepository } from '@/db/repositories/webhook';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';

const logger = createLogger('webhook-routes');
const { BAD_REQUEST, CREATED, FORBIDDEN, NO_CONTENT, NOT_FOUND, UNAUTHORIZED } = HTTP_STATUS;

const webhookSchema = z.object({
  name: z.string().min(1),
  event_types: z.array(z.string()).min(1),
  target_url: z.string().url(),
  headers: z.record(z.string()).optional(),
  is_active: z.boolean().optional(),
});

export async function webhookRoutes(fastify: FastifyInstance) {
  const repo = createWebhookRepository();

  fastify.post<{ Body: typeof webhookSchema._type }>(
    apiEndpoints.webhooks.create,
    {
      schema: {
        description: 'Create webhook (admin only)',
        tags: ['Webhooks'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('create', 'Webhook')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const data = webhookSchema.parse(request.body);
        const { record, secret } = await repo.create({ ...data, created_by: payload.sub });
        return reply.status(CREATED).send({ ...record, secret });
      } catch (error) {
        logger.error(error, 'Create webhook error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.webhooks.list,
    {
      schema: {
        description: 'List webhooks (admin only)',
        tags: ['Webhooks'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Webhook')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const items = await repo.list();
        return reply.send({ items });
      } catch (error) {
        logger.error(error, 'List webhooks error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.patch<{ Params: { id: string }; Body: Partial<typeof webhookSchema._type> }>(
    apiEndpoints.webhooks.update,
    {
      schema: {
        description: 'Update webhook (admin only)',
        tags: ['Webhooks'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'Webhook')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const record = await repo.update((request.params as any).id, webhookSchema.partial().parse(request.body));
        if (!record) return reply.status(NOT_FOUND).send({ error: 'Webhook not found' });
        return reply.send(record);
      } catch (error) {
        logger.error(error, 'Update webhook error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.webhooks.delete,
    {
      schema: {
        description: 'Delete webhook (admin only)',
        tags: ['Webhooks'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('delete', 'Webhook')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        await repo.delete((request.params as any).id);
        return reply.status(NO_CONTENT).send();
      } catch (error) {
        logger.error(error, 'Delete webhook error');
        return respondWithError(reply, error);
      }
    }
  );

  // Test fire (simple ping)
  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.webhooks.test,
    {
      schema: {
        description: 'Test webhook delivery (admin only)',
        tags: ['Webhooks'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'Webhook')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const record = await repo.findById((request.params as any).id);
        if (!record) return reply.status(NOT_FOUND).send({ error: 'Webhook not found' });

        // For now just echo; real delivery queue would be added later
        return reply.send({ success: true, attempted: record.target_url });
      } catch (error) {
        logger.error(error, 'Test webhook error');
        return respondWithError(reply, error);
      }
    }
  );
}
