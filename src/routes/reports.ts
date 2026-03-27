import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { config as appConfig } from '@/config';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';
import { isDepartmentScopedRole } from '@/rbac/policy';
import { createEmergencyRepository } from '@/db/repositories/emergency';
import { escapeHtml, renderPdfDocument } from '@/utils/pdf-render';

const logger = createLogger('reports-routes');
const { BAD_REQUEST, FORBIDDEN, UNAUTHORIZED } = HTTP_STATUS;

function formatDateTime(value?: Date | string | null) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function toIsoOrNull(value?: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function formatCount(value: number | null | undefined) {
  if (value === null || typeof value === 'undefined') return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

function buildPdfHtml(title: string, sectionsHtml: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #111827;
        font-size: 12px;
        margin: 0;
      }
      h1, h2, h3, p {
        margin: 0;
      }
      .header {
        margin-bottom: 20px;
      }
      .subtitle {
        color: #6b7280;
        margin-top: 4px;
      }
      .section {
        margin-top: 20px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 12px;
      }
      .card {
        border: 1px solid #d1d5db;
        border-radius: 10px;
        padding: 12px;
      }
      .label {
        color: #6b7280;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .value {
        font-size: 20px;
        font-weight: 700;
        margin-top: 6px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 12px;
      }
      th, td {
        border: 1px solid #e5e7eb;
        padding: 8px;
        text-align: left;
        vertical-align: top;
      }
      th {
        background: #f9fafb;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .muted {
        color: #6b7280;
      }
      .pill {
        display: inline-block;
        border: 1px solid #d1d5db;
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 10px;
        margin-right: 6px;
      }
      .empty {
        margin-top: 12px;
        color: #6b7280;
      }
    </style>
  </head>
  <body>
    ${sectionsHtml}
  </body>
</html>`;
}

export async function reportsRoutes(fastify: FastifyInstance) {
  const db = getDatabase();
  const emergencyRepo = createEmergencyRepository();

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
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
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

  fastify.get(
    apiEndpoints.reports.export,
    {
      schema: {
        description: 'Export current reports snapshot as PDF',
        tags: ['Reports'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
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
        const notifications = await db
          .select({
            id: schema.notifications.id,
            title: schema.notifications.title,
            message: schema.notifications.message,
            is_read: schema.notifications.is_read,
            created_at: schema.notifications.created_at,
          })
          .from(schema.notifications)
          .where(eq(schema.notifications.user_id, payload.sub))
          .orderBy(desc(schema.notifications.created_at))
          .limit(5);
        const recentProofOfPlay = await db
          .select({
            id: schema.proofOfPlay.id,
            created_at: schema.proofOfPlay.created_at,
            started_at: schema.proofOfPlay.started_at,
            ended_at: schema.proofOfPlay.ended_at,
            screen_id: schema.proofOfPlay.screen_id,
            media_id: schema.proofOfPlay.media_id,
            screen_name: schema.screens.name,
            media_name: schema.media.name,
          })
          .from(schema.proofOfPlay)
          .leftJoin(schema.screens, eq(schema.screens.id, schema.proofOfPlay.screen_id))
          .leftJoin(schema.media, eq(schema.media.id, schema.proofOfPlay.media_id))
          .orderBy(desc(schema.proofOfPlay.created_at))
          .limit(10);

        const activeEmergencies = await emergencyRepo.listActive();
        const primaryEmergency = activeEmergencies[0] ?? null;
        const generatedAt = new Date();
        const html = buildPdfHtml(
          'Reports Snapshot',
          `
            <div class="header">
              <h1>Reports Snapshot</h1>
              <p class="subtitle">Generated ${escapeHtml(formatDateTime(generatedAt))}</p>
            </div>
            <div class="section">
              <h2>Summary</h2>
              <div class="grid">
                <div class="card">
                  <div class="label">Total Media</div>
                  <div class="value">${escapeHtml(formatCount(Number(mediaCount?.count || 0)))}</div>
                </div>
                <div class="card">
                  <div class="label">Open Requests</div>
                  <div class="value">${escapeHtml(formatCount(Number(requestsOpen?.count || 0)))}</div>
                </div>
                <div class="card">
                  <div class="label">Completed Requests</div>
                  <div class="value">${escapeHtml(formatCount(Number(requestsCompleted?.count || 0)))}</div>
                </div>
                <div class="card">
                  <div class="label">Active Screens</div>
                  <div class="value">${escapeHtml(formatCount(Number(screensActive?.count || 0)))}</div>
                </div>
                <div class="card">
                  <div class="label">Offline Screens</div>
                  <div class="value">${escapeHtml(formatCount(Number(screensOffline?.count || 0)))}</div>
                </div>
                <div class="card">
                  <div class="label">Report Owner</div>
                  <div class="value" style="font-size: 14px;">${escapeHtml(payload.email)}</div>
                </div>
              </div>
            </div>
            <div class="section">
              <h2>Emergency Status</h2>
              ${
                primaryEmergency
                  ? `
                    <p><span class="pill">ACTIVE</span><span class="pill">${escapeHtml(primaryEmergency.priority)}</span></p>
                    <p class="subtitle" style="margin-top: 8px;">${escapeHtml(primaryEmergency.message)}</p>
                    <p class="subtitle" style="margin-top: 4px;">Triggered ${escapeHtml(formatDateTime(primaryEmergency.created_at))}</p>
                  `
                  : `<p class="empty">No active emergency.</p>`
              }
            </div>
            <div class="section">
              <h2>Latest Notifications</h2>
              ${
                notifications.length
                  ? `
                    <table>
                      <thead>
                        <tr>
                          <th>Title</th>
                          <th>Message</th>
                          <th>Status</th>
                          <th>Created</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${notifications
                          .map(
                            (item) => `
                              <tr>
                                <td>${escapeHtml(item.title)}</td>
                                <td>${escapeHtml(item.message)}</td>
                                <td>${item.is_read ? 'Read' : 'New'}</td>
                                <td>${escapeHtml(formatDateTime(item.created_at))}</td>
                              </tr>
                            `
                          )
                          .join('')}
                      </tbody>
                    </table>
                  `
                  : `<p class="empty">No notifications available.</p>`
              }
            </div>
            <div class="section">
              <h2>Recent Proof of Play</h2>
              ${
                recentProofOfPlay.length
                  ? `
                    <table>
                      <thead>
                        <tr>
                          <th>Screen</th>
                          <th>Media</th>
                          <th>Started</th>
                          <th>Ended</th>
                          <th>Reported</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${recentProofOfPlay
                          .map(
                            (item) => `
                              <tr>
                                <td>${escapeHtml(item.screen_name || item.screen_id)}</td>
                                <td>${escapeHtml(item.media_name || item.media_id)}</td>
                                <td>${escapeHtml(formatDateTime(item.started_at))}</td>
                                <td>${escapeHtml(formatDateTime(item.ended_at))}</td>
                                <td>${escapeHtml(formatDateTime(item.created_at))}</td>
                              </tr>
                            `
                          )
                          .join('')}
                      </tbody>
                    </table>
                  `
                  : `<p class="empty">No proof-of-play events recorded yet.</p>`
              }
            </div>
          `
        );

        const pdf = await renderPdfDocument(html);
        reply.header('Content-Type', 'application/pdf');
        reply.header(
          'Content-Disposition',
          `attachment; filename="reports-${generatedAt.toISOString().slice(0, 10)}.pdf"`
        );
        return reply.send(pdf);
      } catch (error) {
        logger.error(error, 'Report PDF export error');
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
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'Dashboard')) throw AppError.forbidden('Forbidden');

        const rowsWhere =
          isDepartmentScopedRole(payload.role) && payload.department_id
            ? sql`${schema.requests.status} != 'COMPLETED'
                AND ${schema.requests.status} != 'REJECTED'
                AND ${schema.users.department_id} = ${payload.department_id}`
            : sql`${schema.requests.status} != 'COMPLETED'
                AND ${schema.requests.status} != 'REJECTED'`;

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
          .where(rowsWhere);

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
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
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
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
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
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
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
          .innerJoin(schema.roles, eq(schema.users.role_id, schema.roles.id))
          .where(sql`${schema.roles.name} = 'OPERATOR' AND ${schema.users.is_active} = true`);

        return reply.send({
          transcode_queue: {
            pending: transcodeQueue,
          },
          publishes: {
            last_published_at: toIsoOrNull(lastPublish?.lastPublishedAt),
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
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
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
