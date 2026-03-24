import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { respondWithError } from '@/utils/errors';
import { createScheduleReservationService } from '@/services/scheduling/reservation-service';
import { AppError } from '@/utils/app-error';
import { isAdminLike } from '@/rbac/policy';

const logger = createLogger('schedule-reservation-routes');

const previewSchema = z
  .object({
    schedule_id: z.string().uuid().optional(),
    start_at: z.string().datetime().optional(),
    end_at: z.string().datetime().optional(),
    screen_ids: z.array(z.string().uuid()).default([]),
    screen_group_ids: z.array(z.string().uuid()).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.schedule_id) return;
    if (!value.start_at) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['start_at'], message: 'start_at is required' });
    }
    if (!value.end_at) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end_at'], message: 'end_at is required' });
    }
    if (value.start_at && value.end_at && new Date(value.end_at) <= new Date(value.start_at)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end_at'], message: 'end_at must be after start_at' });
    }
  });

export async function scheduleReservationRoutes(fastify: FastifyInstance) {
  const reservationService = createScheduleReservationService();

  fastify.post<{ Body: typeof previewSchema._type }>(
    apiEndpoints.scheduleReservations.preview,
    {
      schema: {
        description: 'Preview authoritative scheduling conflicts and active reservations',
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
        if (!ability.can('read', 'ScheduleRequest') && !ability.can('create', 'ScheduleRequest')) {
          throw AppError.forbidden('Forbidden');
        }

        const body = previewSchema.parse(request.body);
        const result = await reservationService.previewConflicts({
          scheduleId: body.schedule_id,
          startAt: body.start_at ? new Date(body.start_at) : undefined,
          endAt: body.end_at ? new Date(body.end_at) : undefined,
          screenIds: body.screen_ids,
          screenGroupIds: body.screen_group_ids,
          currentUserId: payload.sub,
          allowPrivateRefs: isAdminLike(payload.role),
        });

        return reply.send(result);
      } catch (error) {
        logger.error(error, 'Preview schedule reservations error');
        return respondWithError(reply, error);
      }
    }
  );
}
