import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createApiKeyRepository } from '@/db/repositories/api-key';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';

const logger = createLogger('api-keys-routes');
const { BAD_REQUEST, CREATED, FORBIDDEN, NOT_FOUND, UNAUTHORIZED } = HTTP_STATUS;

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
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('create', 'ApiKey')) throw AppError.forbidden('Forbidden');

        const data = createApiKeySchema.parse(request.body);
        const { record, secret } = await repo.create({
          name: data.name,
          scopes: data.scopes,
          roles: data.roles,
          created_by: payload.sub,
          expires_at: data.expires_at ? new Date(data.expires_at) : undefined,
        });

        return reply.status(CREATED).send({ ...record, secret });
      } catch (error) {
        logger.error(error, 'Create API key error');
        return respondWithError(reply, error);
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
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'ApiKey')) throw AppError.forbidden('Forbidden');

        const result = await repo.list({ page: 1, limit: 100, includeRevoked: true });
        return reply.send(result);
      } catch (error) {
        logger.error(error, 'List API keys error');
        return respondWithError(reply, error);
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
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('update', 'ApiKey')) throw AppError.forbidden('Forbidden');

        const { record, secret } = await repo.rotate((request.params as any).id);
        if (!record) throw AppError.notFound('API key not found');
        return reply.send({ ...record, secret });
      } catch (error) {
        logger.error(error, 'Rotate API key error');
        return respondWithError(reply, error);
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
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('delete', 'ApiKey')) throw AppError.forbidden('Forbidden');

        const record = await repo.revoke((request.params as any).id);
        if (!record) throw AppError.notFound('API key not found');
        return reply.send(record);
      } catch (error) {
        logger.error(error, 'Revoke API key error');
        return respondWithError(reply, error);
      }
    }
  );
}
