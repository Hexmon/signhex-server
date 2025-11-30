import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createAuditLogRepository } from '@/db/repositories/audit-log';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';

const logger = createLogger('audit-log-routes');

const listAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  user_id: z.string().optional(),
  resource_type: z.string().optional(),
  action: z.string().optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
});

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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('read', 'AuditLog')) {
          return reply.status(403).send({ error: 'Forbidden' });
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
        return reply.status(400).send({ error: 'Invalid request' });
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('read', 'AuditLog')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const log = await auditRepo.findById(request.params.id);
        if (!log) {
          return reply.status(404).send({ error: 'Audit log not found' });
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
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
