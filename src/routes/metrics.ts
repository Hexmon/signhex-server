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

        const [popDay] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.proofOfPlay)
          .where(sql`${schema.proofOfPlay.created_at} >= ${dayAgo}`);

        const [popWeek] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.proofOfPlay)
          .where(sql`${schema.proofOfPlay.created_at} >= ${weekAgo}`);

        return reply.send({
          totals: {
            users: Number(usersCount?.count || 0),
            media: Number(mediaCount?.count || 0),
            screens: Number(screensCount?.count || 0),
            requests: Number(requestsCount?.count || 0),
          },
          proof_of_play: {
            last_24h: Number(popDay?.count || 0),
            last_7d: Number(popWeek?.count || 0),
          },
        });
      } catch (error) {
        logger.error(error, 'Metrics error');
        return respondWithError(reply, error);
      }
    }
  );
}
