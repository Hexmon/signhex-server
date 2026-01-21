import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createSsoConfigRepository } from '@/db/repositories/sso-config';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';

const logger = createLogger('sso-config-routes');
const { BAD_REQUEST, CREATED, FORBIDDEN, NOT_FOUND, UNAUTHORIZED } = HTTP_STATUS;

const ssoSchema = z.object({
  provider: z.string().default('oidc'),
  issuer: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  authorization_url: z.string().url().optional(),
  token_url: z.string().url().optional(),
  jwks_url: z.string().url().optional(),
  redirect_uri: z.string().url().optional(),
  scopes: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});

export async function ssoConfigRoutes(fastify: FastifyInstance) {
  const repo = createSsoConfigRepository();

  fastify.post<{ Body: typeof ssoSchema._type }>(
    apiEndpoints.ssoConfig.upsert,
    {
      schema: {
        description: 'Upsert SSO config (admin only)',
        tags: ['SSO'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('manage', 'SsoConfig') && !ability.can('update', 'SsoConfig')) {
          throw AppError.forbidden('Forbidden');
        }

        const data = ssoSchema.parse(request.body);
        const record = await repo.upsertActive(data);
        return reply.status(CREATED).send(record);
      } catch (error) {
        logger.error(error, 'Upsert SSO error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.ssoConfig.list,
    {
      schema: {
        description: 'List active SSO configs (admin only)',
        tags: ['SSO'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'SsoConfig')) throw AppError.forbidden('Forbidden');

        const result = await repo.listActive();
        return reply.send({ items: result });
      } catch (error) {
        logger.error(error, 'List SSO error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.ssoConfig.deactivate,
    {
      schema: {
        description: 'Deactivate SSO config (admin only)',
        tags: ['SSO'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'SsoConfig')) throw AppError.forbidden('Forbidden');

        const record = await repo.deactivate((request.params as any).id);
        if (!record) throw AppError.notFound('SSO config not found');
        return reply.send(record);
      } catch (error) {
        logger.error(error, 'Deactivate SSO error');
        return respondWithError(reply, error);
      }
    }
  );
}
