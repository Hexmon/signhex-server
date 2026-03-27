import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createAuditLogRepository } from '@/db/repositories/audit-log';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';
import { escapeHtml, renderPdfDocument } from '@/utils/pdf-render';

const logger = createLogger('audit-log-routes');
const { BAD_REQUEST, FORBIDDEN, NOT_FOUND, UNAUTHORIZED } = HTTP_STATUS;

const listAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  user_id: z.string().optional(),
  resource_type: z.string().optional(),
  action: z.string().optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
});

function formatDateTime(value?: Date | string | null) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export async function auditLogRoutes(fastify: FastifyInstance) {
  const auditRepo = createAuditLogRepository();

  // List audit logs
  fastify.get<{ Querystring: typeof listAuditLogsQuerySchema._type }>(
    apiEndpoints.auditLogs.list,
    {
      schema: {
        description: 'List audit logs (admin only)',
        tags: ['Audit Logs'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);

        if (!ability.can('read', 'AuditLog')) {
          throw AppError.forbidden('Forbidden');
        }

        const query = listAuditLogsQuerySchema.parse(request.query);
        const result = await auditRepo.list({
          page: query.page,
          limit: query.limit,
          user_id: query.user_id,
          resource_type: query.resource_type,
          action: query.action,
          startDate: query.start_date ? new Date(query.start_date) : undefined,
          endDate: query.end_date ? new Date(query.end_date) : undefined,
        });

        return reply.send({
          items: result.items.map((log) => ({
            id: log.id,
            user_id: log.user_id,
            action: log.action,
            resource_type: log.entity_type,
            resource_id: log.entity_id,
            changes: null,
            ip_address: log.ip_address,
            user_agent: null,
            created_at: log.created_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List audit logs error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Querystring: typeof listAuditLogsQuerySchema._type }>(
    apiEndpoints.auditLogs.export,
    {
      schema: {
        description: 'Export audit logs as PDF',
        tags: ['Audit Logs'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest<{ Querystring: typeof listAuditLogsQuerySchema._type }>, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);

        if (!ability.can('read', 'AuditLog')) {
          throw AppError.forbidden('Forbidden');
        }

        const query = listAuditLogsQuerySchema.parse(request.query);
        const items = await auditRepo.listAll({
          user_id: query.user_id,
          resource_type: query.resource_type,
          action: query.action,
          startDate: query.start_date ? new Date(query.start_date) : undefined,
          endDate: query.end_date ? new Date(query.end_date) : undefined,
        });
        const generatedAt = new Date();

        const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Audit Logs</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; font-size: 12px; margin: 0; }
      h1, h2, p { margin: 0; }
      .header { margin-bottom: 20px; }
      .subtitle { color: #6b7280; margin-top: 4px; }
      .filters { margin-top: 12px; }
      .pill { display: inline-block; border: 1px solid #d1d5db; border-radius: 999px; padding: 2px 8px; font-size: 10px; margin-right: 6px; margin-top: 6px; }
      table { width: 100%; border-collapse: collapse; margin-top: 14px; }
      th, td { border: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }
      th { background: #f9fafb; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
      .empty { color: #6b7280; margin-top: 14px; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>Audit Logs</h1>
      <p class="subtitle">Generated ${escapeHtml(formatDateTime(generatedAt))}</p>
      <div class="filters">
        <span class="pill">Resource: ${escapeHtml(query.resource_type || 'Any')}</span>
        <span class="pill">Action: ${escapeHtml(query.action || 'Any')}</span>
        <span class="pill">User: ${escapeHtml(query.user_id || 'Any')}</span>
        <span class="pill">Start: ${escapeHtml(formatDateTime(query.start_date || null))}</span>
        <span class="pill">End: ${escapeHtml(formatDateTime(query.end_date || null))}</span>
      </div>
    </div>
    ${
      items.length
        ? `
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Resource</th>
                <th>Resource ID</th>
                <th>User</th>
                <th>IP</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              ${items
                .map(
                  (log) => `
                    <tr>
                      <td>${escapeHtml(log.action)}</td>
                      <td>${escapeHtml(log.entity_type)}</td>
                      <td>${escapeHtml(log.entity_id || '—')}</td>
                      <td>${escapeHtml(log.user_id || 'system')}</td>
                      <td>${escapeHtml(log.ip_address || '—')}</td>
                      <td>${escapeHtml(formatDateTime(log.created_at))}</td>
                    </tr>
                  `
                )
                .join('')}
            </tbody>
          </table>
        `
        : '<p class="empty">No logs found for the selected filters.</p>'
    }
  </body>
</html>`;

        const pdf = await renderPdfDocument(html);
        reply.header('Content-Type', 'application/pdf');
        reply.header(
          'Content-Disposition',
          `attachment; filename="audit-logs-${generatedAt.toISOString().slice(0, 10)}.pdf"`
        );
        return reply.send(pdf);
      } catch (error) {
        logger.error(error, 'Export audit logs PDF error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get audit log by ID
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.auditLogs.get,
    {
      schema: {
        description: 'Get audit log by ID (admin only)',
        tags: ['Audit Logs'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);

        if (!ability.can('read', 'AuditLog')) {
          throw AppError.forbidden('Forbidden');
        }

        const log = await auditRepo.findById(request.params.id);
        if (!log) {
          throw AppError.notFound('Audit log not found');
        }

        return reply.send({
          id: log.id,
          user_id: log.user_id,
          action: log.action,
          resource_type: log.entity_type,
          resource_id: log.entity_id,
          changes: null,
          ip_address: log.ip_address,
          user_agent: null,
          created_at: log.created_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get audit log error');
        return respondWithError(reply, error);
      }
    }
  );
}
