import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';

const logger = createLogger('metrics-routes');
const { BAD_REQUEST, FORBIDDEN, UNAUTHORIZED } = HTTP_STATUS;

export async function metricsRoutes(fastify: FastifyInstance) {
  const db = getDatabase();

  fastify.get(
    apiEndpoints.metrics.overview,
    {
      schema: {
        description: 'Dashboard metrics overview',
        tags: ['Metrics'],
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

        const [usersCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.users);
        const [mediaCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.media);
        const [screensCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.screens);
        const [requestsCount] = await db.select({ count: sql<number>`count(*)` }).from(schema.requests);

        const now = new Date();
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
        const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        const [popDay] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.proofOfPlay)
          .where(sql`${schema.proofOfPlay.created_at} >= ${dayAgo}`);

        const [popWeek] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.proofOfPlay)
          .where(sql`${schema.proofOfPlay.created_at} >= ${weekAgo}`);

        const [onlineScreensCount] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.screens)
          .where(
            sql`${schema.screens.status} = 'ACTIVE' AND ${schema.screens.last_heartbeat_at} IS NOT NULL AND ${schema.screens.last_heartbeat_at} >= ${fiveMinutesAgo}`
          );

        const [mediaStorageBytes] = await db
          .select({ total: sql<number>`COALESCE(SUM(${schema.media.source_size}), 0)` })
          .from(schema.media);

        const [activeSchedulesCount] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.schedules)
          .where(
            sql`${schema.schedules.is_active} = true AND ${schema.schedules.start_at} <= ${now} AND ${schema.schedules.end_at} >= ${now}`
          );

        const [heartbeatsLast5m] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.heartbeats)
          .where(sql`${schema.heartbeats.created_at} >= ${fiveMinutesAgo}`);

        const [heartbeatsLast1h] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.heartbeats)
          .where(sql`${schema.heartbeats.created_at} >= ${hourAgo}`);

        const [latestHeartbeat] = await db
          .select({ timestamp: sql<Date | null>`max(${schema.heartbeats.created_at})` })
          .from(schema.heartbeats);

        const totalScreens = Number(screensCount?.count || 0);
        const onlineScreens = Number(onlineScreensCount?.count || 0);
        const mediaStorageTotal = Number(mediaStorageBytes?.total || 0);
        const activeSchedules = Number(activeSchedulesCount?.count || 0);
        const lastHeartbeatAt = latestHeartbeat?.timestamp ? new Date(latestHeartbeat.timestamp) : null;
        const systemStatus =
          !lastHeartbeatAt ? 'unknown' : lastHeartbeatAt >= fiveMinutesAgo ? 'healthy' : 'degraded';
        const healthResponse = { status: 'ok', timestamp: now.toISOString() };

        return reply.send({
          totals: {
            users: Number(usersCount?.count || 0),
            media: Number(mediaCount?.count || 0),
            screens: totalScreens,
            requests: Number(requestsCount?.count || 0),
          },
          screens: {
            total: totalScreens,
            online: onlineScreens,
          },
          storage: {
            media_bytes: mediaStorageTotal,
          },
          schedules: {
            active: activeSchedules,
          },
          proof_of_play: {
            last_24h: Number(popDay?.count || 0),
            last_7d: Number(popWeek?.count || 0),
          },
          system_health: {
            status: systemStatus,
            last_heartbeat_at: lastHeartbeatAt?.toISOString() ?? null,
            heartbeats: {
              last_5m: Number(heartbeatsLast5m?.count || 0),
              last_1h: Number(heartbeatsLast1h?.count || 0),
            },
            health_endpoint: healthResponse,
          },
        });
      } catch (error) {
        logger.error(error, 'Metrics error');
        return respondWithError(reply, error);
      }
    }
  );
}
