import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { getDatabase, schema } from '@/db';
import { createLogger } from '@/utils/logger';

const logger = createLogger('settings-routes');

const upsertSettingSchema = z.object({
  key: z.string().min(1),
  value: z.any(),
});

export async function settingsRoutes(fastify: FastifyInstance) {
  const db = getDatabase();

  fastify.get(
    '/v1/settings',
    {
      schema: {
        description: 'List org settings (admin only)',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'OrgSettings')) return reply.status(403).send({ error: 'Forbidden' });

        const items = await db.select().from(schema.settings);
        return reply.send({ items });
      } catch (error) {
        logger.error(error, 'List settings error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  fastify.post<{ Body: typeof upsertSettingSchema._type }>(
    '/v1/settings',
    {
      schema: {
        description: 'Upsert org setting (admin only)',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'OrgSettings')) return reply.status(403).send({ error: 'Forbidden' });

        const data = upsertSettingSchema.parse(request.body);
        const [record] = await db
          .insert(schema.settings)
          .values({ key: data.key, value: data.value })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: data.value, updated_at: new Date() },
          })
          .returning();
        return reply.status(201).send(record);
      } catch (error) {
        logger.error(error, 'Upsert setting error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
