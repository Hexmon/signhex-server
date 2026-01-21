import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, eq } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { config as appConfig } from '@/config';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';

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
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Dashboard')) throw AppError.forbidden('Forbidden');

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

  // Pending requests grouped by department
  fastify.get(
    apiEndpoints.reports.requestsByDepartment,
    {
      schema: {
        description: 'Pending requests grouped by department',
        tags: ['Reports'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Dashboard')) throw AppError.forbidden('Forbidden');

        const rows = await db
          .select({
            requestId: schema.requests.id,
            title: schema.requests.title,
            status: schema.requests.status,
            createdAt: schema.requests.created_at,
            departmentId: schema.departments.id,
            departmentName: schema.departments.name,
          })
          .from(schema.requests)
          .leftJoin(schema.users, eq(schema.requests.created_by, schema.users.id))
          .leftJoin(schema.departments, eq(schema.users.department_id, schema.departments.id))
          .where(sql`${schema.requests.status} != 'COMPLETED' AND ${schema.requests.status} != 'REJECTED'`);

        const grouped = new Map<
          string,
          {
            department_id: string | null;
            department_name: string;
            requests: { id: string; title: string; status: string; created_at: string }[];
          }
        >();

        for (const row of rows) {
          const key = row.departmentId ?? 'unassigned';
          if (!grouped.has(key)) {
            grouped.set(key, {
              department_id: row.departmentId ?? null,
              department_name: row.departmentName ?? 'Unassigned',
              requests: [],
            });
          }
          grouped.get(key)!.requests.push({
            id: row.requestId,
            title: row.title,
            status: row.status,
            created_at: row.createdAt.toISOString(),
          });
        }

        return reply.send({
          departments: Array.from(grouped.values()),
        });
      } catch (error) {
        logger.error(error, 'Requests by department error');
        return respondWithError(reply, error);
      }
    }
  );

  // Offline screens older than 24h
  fastify.get(
    apiEndpoints.reports.offlineScreens,
    {
      schema: {
        description: 'Screens offline for more than 24 hours',
        tags: ['Reports'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Dashboard')) throw AppError.forbidden('Forbidden');

        const now = new Date();
        const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const offline = await db
          .select({
            id: schema.screens.id,
            name: schema.screens.name,
            location: schema.screens.location,
            status: schema.screens.status,
            lastHeartbeatAt: schema.screens.last_heartbeat_at,
          })
          .from(schema.screens)
          .where(
            sql`${schema.screens.status} = 'OFFLINE' AND (${schema.screens.last_heartbeat_at} IS NULL OR ${schema.screens.last_heartbeat_at} < ${cutoff})`
          );

        const items = offline.map((s) => ({
          id: s.id,
          name: s.name,
          location: s.location,
          status: s.status,
          last_heartbeat_at: s.lastHeartbeatAt?.toISOString() ?? null,
          offline_hours: s.lastHeartbeatAt ? Math.floor((now.getTime() - s.lastHeartbeatAt.getTime()) / 3600000) : null,
        }));

        return reply.send({
          count: items.length,
          screens: items,
        });
      } catch (error) {
        logger.error(error, 'Offline screens report error');
        return respondWithError(reply, error);
      }
    }
  );

  // Storage and media expiry notice
  fastify.get(
    apiEndpoints.reports.storage,
    {
      schema: {
        description: 'Storage usage and media expiry notice',
        tags: ['Reports'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Dashboard')) throw AppError.forbidden('Forbidden');

        const [mediaStorage] = await db
          .select({ total: sql<number>`COALESCE(SUM(${schema.media.source_size}), 0)` })
          .from(schema.media);

        const mediaBytes = Number(mediaStorage?.total || 0);
        const quotaBytes = appConfig.STORAGE_QUOTA_BYTES;
        const quotaPercent = quotaBytes > 0 ? Number(((mediaBytes / quotaBytes) * 100).toFixed(2)) : null;

        return reply.send({
          storage: {
            media_bytes: mediaBytes,
            quota_bytes: quotaBytes || null,
            quota_percent: quotaPercent,
          },
          expiring_media: {
            supported: false,
            items: [],
          },
        });
      } catch (error) {
        logger.error(error, 'Storage report error');
        return respondWithError(reply, error);
      }
    }
  );

  // System health extras (jobs + publishes + operators)
  fastify.get(
    apiEndpoints.reports.systemHealth,
    {
      schema: {
        description: 'System health extras (jobs, publishes, operators)',
        tags: ['Reports'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Dashboard')) throw AppError.forbidden('Forbidden');

        const bossSchema = (appConfig.PG_BOSS_SCHEMA || 'pgboss').replace(/"/g, '');

        const transcodeQueueResult = await db.execute(
          sql.raw(`
            SELECT count(*)::int AS count
            FROM "${bossSchema}".job
            WHERE name = 'ffmpeg:transcode'
              AND state IN ('created', 'retry', 'active')
          `)
        );
        const transcodeQueue = Number((transcodeQueueResult as any)?.rows?.[0]?.count || 0);

        const failedJobsResult = await db.execute(
          sql.raw(`
            SELECT count(*)::int AS count
            FROM "${bossSchema}".job
            WHERE state = 'failed' AND created_on >= NOW() - INTERVAL '24 hours'
          `)
        );
        const failedJobs24h = Number((failedJobsResult as any)?.rows?.[0]?.count || 0);

        const [lastPublish] = await db
          .select({ lastPublishedAt: sql<Date | null>`max(${schema.publishes.published_at})` })
          .from(schema.publishes);

        const [activeOperators] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.users)
          .where(sql`${schema.users.role} = 'OPERATOR' AND ${schema.users.is_active} = true`);

        return reply.send({
          transcode_queue: {
            pending: transcodeQueue,
          },
          publishes: {
            last_published_at: lastPublish?.lastPublishedAt?.toISOString() ?? null,
          },
          jobs: {
            failed_last_24h: failedJobs24h,
          },
          operators: {
            active: Number(activeOperators?.count || 0),
          },
        });
      } catch (error) {
        logger.error(error, 'System health report error');
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
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Dashboard')) throw AppError.forbidden('Forbidden');

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
