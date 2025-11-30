import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createSsoConfigRepository } from '@/db/repositories/sso-config';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';

const logger = createLogger('sso-config-routes');

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
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('manage', 'SsoConfig') && !ability.can('update', 'SsoConfig')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const data = ssoSchema.parse(request.body);
        const record = await repo.upsertActive(data);
        return reply.status(201).send(record);
      } catch (error) {
        logger.error(error, 'Upsert SSO error');
        return reply.status(400).send({ error: 'Invalid request' });
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
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'SsoConfig')) return reply.status(403).send({ error: 'Forbidden' });

        const result = await repo.listActive();
        return reply.send({ items: result });
      } catch (error) {
        logger.error(error, 'List SSO error');
        return reply.status(400).send({ error: 'Invalid request' });
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
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'SsoConfig')) return reply.status(403).send({ error: 'Forbidden' });

        const record = await repo.deactivate((request.params as any).id);
        if (!record) return reply.status(404).send({ error: 'SSO config not found' });
        return reply.send(record);
      } catch (error) {
        logger.error(error, 'Deactivate SSO error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
