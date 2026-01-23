import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createScheduleRequestRepository } from '@/db/repositories/schedule-request';
import { createScheduleRepository } from '@/db/repositories/schedule';
import { createScheduleItemRepository } from '@/db/repositories/schedule-item';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { getDatabase, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { publishScheduleSnapshot } from '@/routes/schedule-publish-helper';
import { AppError } from '@/utils/app-error';

const logger = createLogger('schedule-request-routes');
const { CREATED, FORBIDDEN, NOT_FOUND, UNAUTHORIZED, BAD_REQUEST } = HTTP_STATUS;

const createRequestSchema = z.object({
  schedule_id: z.string().uuid(),
  notes: z.string().optional(),
});

const updateRequestSchema = z.object({
  schedule_id: z.string().uuid().optional(),
  notes: z.string().optional(),
});

const listRequestQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
});

export async function scheduleRequestRoutes(fastify: FastifyInstance) {
  const repo = createScheduleRequestRepository();
  const scheduleRepo = createScheduleRepository();
  const scheduleItemRepo = createScheduleItemRepository();
  const db = getDatabase();

  // Create schedule request (draft)
  fastify.post<{ Body: typeof createRequestSchema._type }>(
    apiEndpoints.scheduleRequests.create,
    {
      schema: {
        description: 'Create a schedule publish request (draft)',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('create', 'ScheduleRequest')) throw AppError.forbidden('Forbidden');

        const data = createRequestSchema.parse(request.body);
        const created = await repo.create({
          schedule_id: data.schedule_id,
          notes: data.notes,
          requested_by: payload.sub,
        });

        return reply.status(CREATED).send({
          id: created.id,
          schedule_id: created.schedule_id,
          payload: (created as any).schedule_payload,
          status: created.status,
          notes: created.notes,
          requested_by: created.requested_by,
          review_notes: (created as any).review_notes ?? null,
          created_at: created.created_at.toISOString?.() ?? created.created_at,
        });
      } catch (error) {
        logger.error(error, 'Create schedule request error');
        return respondWithError(reply, error);
      }
    }
  );

  // List requests
  fastify.get<{ Querystring: typeof listRequestQuerySchema._type }>(
    apiEndpoints.scheduleRequests.list,
    {
      schema: {
        description: 'List schedule requests',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'ScheduleRequest')) throw AppError.forbidden('Forbidden');

        const query = listRequestQuerySchema.parse(request.query);
        const filter = {
          page: query.page,
          limit: query.limit,
          status: query.status,
          requested_by: ability.can('manage', 'all') ? undefined : payload.sub,
        };
        const result = await repo.list(filter);

        return reply.send({
          items: result.items.map((r: any) => ({
            id: r.id,
            schedule_id: r.schedule_id,
            payload: r.schedule_payload,
            status: r.status,
            notes: r.notes,
            requested_by: r.requested_by,
            reviewed_by: r.reviewed_by,
            reviewed_at: r.reviewed_at?.toISOString?.() ?? r.reviewed_at,
            review_notes: r.review_notes ?? null,
            created_at: r.created_at.toISOString?.() ?? r.created_at,
            updated_at: r.updated_at.toISOString?.() ?? r.updated_at,
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List schedule requests error');
        return respondWithError(reply, error);
      }
    }
  );

  // Update request (admin only, editable before publish)
  fastify.patch<{ Params: { id: string }; Body: typeof updateRequestSchema._type }>(
    apiEndpoints.scheduleRequests.update,
    {
      schema: {
        description: 'Update a schedule request (admin only)',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('manage', 'all')) throw AppError.forbidden('Forbidden');

        const data = updateRequestSchema.parse(request.body);
        const req = await repo.findById((request.params as any).id);
        if (!req) throw AppError.notFound('Schedule request not found');

        if (req.status === 'APPROVED') {
          throw AppError.badRequest('Cannot edit an approved request; reject or create new');
        }

        const [updated] = await db
          .update(schema.scheduleRequests)
          .set({
            schedule_id: data.schedule_id ?? req.schedule_id,
            notes: typeof data.notes === 'undefined' ? req.notes : data.notes,
            updated_at: new Date(),
          })
          .where(eq(schema.scheduleRequests.id, req.id))
          .returning();

        return reply.send({
          id: updated.id,
          schedule_id: updated.schedule_id,
          payload: (updated as any).schedule_payload,
          status: updated.status,
          notes: updated.notes,
          requested_by: updated.requested_by,
          review_notes: updated.review_notes ?? null,
          reviewed_by: updated.reviewed_by,
          reviewed_at: updated.reviewed_at?.toISOString?.() ?? updated.reviewed_at,
          created_at: updated.created_at.toISOString?.() ?? updated.created_at,
          updated_at: updated.updated_at.toISOString?.() ?? updated.updated_at,
        });
      } catch (error) {
        logger.error(error, 'Update schedule request error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get request
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.scheduleRequests.get,
    {
      schema: {
        description: 'Get schedule request by ID',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'ScheduleRequest')) throw AppError.forbidden('Forbidden');

        const req = await repo.findById((request.params as any).id);
        if (!req) throw AppError.notFound('Schedule request not found');
        if (!ability.can('manage', 'all') && req.requested_by !== payload.sub) {
          throw AppError.forbidden('Forbidden');
        }

        return reply.send({
          id: req.id,
          schedule_id: req.schedule_id,
          payload: (req as any).schedule_payload,
          status: req.status,
          notes: req.notes,
          requested_by: req.requested_by,
          reviewed_by: req.reviewed_by,
          reviewed_at: req.reviewed_at?.toISOString?.() ?? req.reviewed_at,
          review_notes: req.review_notes ?? null,
          created_at: req.created_at.toISOString?.() ?? req.created_at,
          updated_at: req.updated_at.toISOString?.() ?? req.updated_at,
        });
      } catch (error) {
        logger.error(error, 'Get schedule request error');
        return respondWithError(reply, error);
      }
    }
  );

  // Approve request (admin only)
  fastify.post<{ Params: { id: string }; Body: { comment?: string } }>(
    apiEndpoints.scheduleRequests.approve,
    {
      schema: {
        description: 'Approve a schedule request (admin only)',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('manage', 'all')) throw AppError.forbidden('Forbidden');

        const req = await repo.findById((request.params as any).id);
        if (!req) throw AppError.notFound('Schedule request not found');

        const updated = await repo.updateStatus(req.id, 'APPROVED', payload.sub, (request.body as any)?.comment);
        return reply.send({
          id: updated!.id,
          status: updated!.status,
          reviewed_by: updated!.reviewed_by,
          reviewed_at: updated!.reviewed_at?.toISOString?.() ?? updated!.reviewed_at,
          review_notes: (updated as any).review_notes ?? (request.body as any)?.comment ?? null,
        });
      } catch (error) {
        logger.error(error, 'Approve schedule request error');
        return respondWithError(reply, error);
      }
    }
  );

  // Publish an approved request (admin only)
  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.scheduleRequests.publish,
    {
      schema: {
        description: 'Publish a schedule based on an approved request',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('manage', 'all')) throw AppError.forbidden('Forbidden');

        const req = await repo.findById((request.params as any).id);
        if (!req) throw AppError.notFound('Schedule request not found');
        if (req.status !== 'APPROVED') {
          throw AppError.badRequest('Schedule request must be APPROVED to publish');
        }

        const publishResult = await publishScheduleSnapshot({
          scheduleId: req.schedule_id,
          screenIds: [],
          screenGroupIds: [],
          publishedBy: payload.sub,
          notes: req.notes ?? null,
          db,
          scheduleRepo,
          scheduleItemRepo,
        });

        await db
          .update(schema.scheduleRequests)
          .set({ updated_at: new Date() })
          .where(eq(schema.scheduleRequests.id, req.id));

        return reply.send({
          message: 'Schedule published from request',
          schedule_request_id: req.id,
          schedule_id: req.schedule_id,
          publish_id: publishResult.publish.id,
          snapshot_id: publishResult.snapshot.id,
          resolved_screen_ids: publishResult.resolvedScreenIds,
          targets: publishResult.targets.length,
        });
      } catch (error) {
        logger.error(error, 'Publish schedule request error');
        return respondWithError(reply, error);
      }
    }
  );

  // Reject request (admin only)
  fastify.post<{ Params: { id: string }; Body: { comment?: string } }>(
    apiEndpoints.scheduleRequests.reject,
    {
      schema: {
        description: 'Reject a schedule request (admin only)',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('manage', 'all')) throw AppError.forbidden('Forbidden');

        const req = await repo.findById((request.params as any).id);
        if (!req) throw AppError.notFound('Schedule request not found');

        const updated = await repo.updateStatus(req.id, 'REJECTED', payload.sub, (request.body as any)?.comment);
        return reply.send({
          id: updated!.id,
          status: updated!.status,
          reviewed_by: updated!.reviewed_by,
          reviewed_at: updated!.reviewed_at?.toISOString?.() ?? updated!.reviewed_at,
          review_notes: (updated as any).review_notes ?? (request.body as any)?.comment ?? null,
        });
      } catch (error) {
        logger.error(error, 'Reject schedule request error');
        return respondWithError(reply, error);
      }
    }
  );
}
