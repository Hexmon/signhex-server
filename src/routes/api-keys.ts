import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createApiKeyRepository } from '@/db/repositories/api-key';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';

const logger = createLogger('api-keys-routes');

const createApiKeySchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  expires_at: z.string().datetime().optional(),
});

export async function apiKeyRoutes(fastify: FastifyInstance) {
  const repo = createApiKeyRepository();

  // Create
  fastify.post<{ Body: typeof createApiKeySchema._type }>(
    apiEndpoints.apiKeys.create,
    {
      schema: {
        description: 'Create API key (admin only)',
        tags: ['API Keys'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('create', 'ApiKey')) return reply.status(403).send({ error: 'Forbidden' });

        const data = createApiKeySchema.parse(request.body);
        const { record, secret } = await repo.create({
          name: data.name,
          scopes: data.scopes,
          roles: data.roles,
          created_by: payload.sub,
          expires_at: data.expires_at ? new Date(data.expires_at) : undefined,
        });

        return reply.status(201).send({ ...record, secret });
      } catch (error) {
        logger.error(error, 'Create API key error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // List
  fastify.get(
    apiEndpoints.apiKeys.list,
    {
      schema: {
        description: 'List API keys (admin only)',
        tags: ['API Keys'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'ApiKey')) return reply.status(403).send({ error: 'Forbidden' });

        const result = await repo.list({ page: 1, limit: 100, includeRevoked: true });
        return reply.send(result);
      } catch (error) {
        logger.error(error, 'List API keys error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Rotate
  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.apiKeys.rotate,
    {
      schema: {
        description: 'Rotate API key secret (admin only)',
        tags: ['API Keys'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'ApiKey')) return reply.status(403).send({ error: 'Forbidden' });

        const { record, secret } = await repo.rotate((request.params as any).id);
        if (!record) return reply.status(404).send({ error: 'API key not found' });
        return reply.send({ ...record, secret });
      } catch (error) {
        logger.error(error, 'Rotate API key error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Revoke
  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.apiKeys.revoke,
    {
      schema: {
        description: 'Revoke API key (admin only)',
        tags: ['API Keys'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('delete', 'ApiKey')) return reply.status(403).send({ error: 'Forbidden' });

        const record = await repo.revoke((request.params as any).id);
        if (!record) return reply.status(404).send({ error: 'API key not found' });
        return reply.send(record);
      } catch (error) {
        logger.error(error, 'Revoke API key error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
