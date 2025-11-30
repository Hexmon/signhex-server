import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';

const logger = createLogger('reports-routes');
const { BAD_REQUEST, FORBIDDEN, UNAUTHORIZED } = HTTP_STATUS;

export async function reportsRoutes(fastify: FastifyInstance) {
  const db = getDatabase();

  fastify.get(
    apiEndpoints.reports.summary,
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
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Dashboard')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const [mediaCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.media);
        const [requestsOpen] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.requests)
          .where(sql`${schema.requests.status} = 'OPEN'`);
        const [screensActive] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.screens)
          .where(sql`${schema.screens.status} = 'ACTIVE'`);
        const [screensOffline] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.screens)
          .where(sql`${schema.screens.status} = 'OFFLINE'`);
        const [requestsCompleted] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.requests)
          .where(sql`${schema.requests.status} = 'COMPLETED'`);

        const totalScreens = Number(screensActive?.count || 0) + Number(screensOffline?.count || 0);
        const uptimePercent =
          totalScreens > 0 ? Number(((Number(screensActive?.count || 0) / totalScreens) * 100).toFixed(2)) : null;

        return reply.send({
          media_total: Number(mediaCount?.count || 0),
          requests_open: Number(requestsOpen?.count || 0),
          requests_completed: Number(requestsCompleted?.count || 0),
          screens_active: Number(screensActive?.count || 0),
          screens_offline: Number(screensOffline?.count || 0),
          screen_uptime_percent: uptimePercent,
        });
      } catch (error) {
        logger.error(error, 'Reports summary error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.reports.trends,
    {
      schema: {
        description: 'Reports trends for dashboards',
        tags: ['Reports'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Dashboard')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const popDaily = await db
          .select({
            day: sql<string>`date(${schema.proofOfPlay.created_at})`,
            count: sql<number>`count(*)`,
          })
          .from(schema.proofOfPlay)
          .where(sql`${schema.proofOfPlay.created_at} >= ${weekAgo}`)
          .groupBy(sql`date(${schema.proofOfPlay.created_at})`)
          .orderBy(sql`date(${schema.proofOfPlay.created_at})`);

        const mediaByType = await db
          .select({
            type: schema.media.type,
            count: sql<number>`count(*)`,
          })
          .from(schema.media)
          .groupBy(schema.media.type);

        const requestsByStatus = await db
          .select({
            status: schema.requests.status,
            count: sql<number>`count(*)`,
          })
          .from(schema.requests)
          .groupBy(schema.requests.status);

        return reply.send({
          proof_of_play_daily: popDaily,
          media_by_type: mediaByType,
          requests_by_status: requestsByStatus,
        });
      } catch (error) {
        logger.error(error, 'Reports trends error');
        return respondWithError(reply, error);
      }
    }
  );
}
