import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';

const logger = createLogger('reports-routes');

export async function reportsRoutes(fastify: FastifyInstance) {
  const db = getDatabase();

  fastify.get(
    '/v1/reports/summary',
    {
      schema: {
        description: 'Reports summary KPIs',
        tags: ['Reports'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Dashboard')) return reply.status(403).send({ error: 'Forbidden' });

        const [mediaCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.media);
        const [requestsOpen] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.requests)
          .where(sql`${schema.requests.status} = 'OPEN'`);
        const [screensActive] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.screens)
          .where(sql`${schema.screens.status} = 'ACTIVE'`);

        return reply.send({
          media_total: Number(mediaCount?.count || 0),
          requests_open: Number(requestsOpen?.count || 0),
          screens_active: Number(screensActive?.count || 0),
        });
      } catch (error) {
        logger.error(error, 'Reports summary error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
