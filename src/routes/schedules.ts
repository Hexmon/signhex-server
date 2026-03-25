import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { desc, eq, inArray, and } from 'drizzle-orm';
import {
  createScheduleSchema,
  updateScheduleSchema,
  listSchedulesQuerySchema,
  publishScheduleSchema,
} from '@/schemas/schedule';
import { apiEndpoints } from '@/config/apiEndpoints';
import { createScheduleRepository } from '@/db/repositories/schedule';
import { createScheduleItemRepository } from '@/db/repositories/schedule-item';
import { createPresentationRepository } from '@/db/repositories/presentation';
import { getDatabase, schema } from '@/db';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { publishScheduleSnapshot, resolvePresentations } from '@/routes/schedule-publish-helper';
import z from 'zod';
import { AppError } from '@/utils/app-error';

const logger = createLogger('schedule-routes');
const { BAD_REQUEST, CREATED, FORBIDDEN, NOT_FOUND, UNAUTHORIZED } = HTTP_STATUS;

const scheduleItemSchema = z.object({
  presentation_id: z.string().uuid(),
  start_at: z.string().datetime(),
  end_at: z.string().datetime(),
  priority: z.number().int().default(0),
  screen_ids: z.array(z.string().uuid()).default([]),
  screen_group_ids: z.array(z.string().uuid()).default([]),
});

export async function scheduleRoutes(fastify: FastifyInstance) {
  const scheduleRepo = createScheduleRepository();
  const scheduleItemRepo = createScheduleItemRepository();
  const presentationRepo = createPresentationRepository();
  const db = getDatabase();

  const validateStartEnd = (start: string, end: string) => {
    const now = new Date();
    const startAt = new Date(start);
    const endAt = new Date(end);
    const bufferMs = 60_000; // allow slight clock drift when defaulting to "now"

    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) {
      throw AppError.badRequest('Invalid date format');
    }
    if (startAt.getTime() < now.getTime() - bufferMs) {
      throw AppError.badRequest('start_at cannot be in the past');
    }
    if (endAt.getTime() < now.getTime() - bufferMs) {
      throw AppError.badRequest('end_at cannot be in the past');
    }
    if (startAt >= endAt) {
      throw AppError.badRequest('start_at must be before end_at');
    }
    return { startAt, endAt };
  };

  const targetsIntersect = (
    existing: { screen_ids?: string[]; screen_group_ids?: string[] },
    incoming: { screen_ids?: string[]; screen_group_ids?: string[] }
  ) => {
    const existingScreens = existing.screen_ids || [];
    const existingGroups = existing.screen_group_ids || [];
    const incomingScreens = incoming.screen_ids || [];
    const incomingGroups = incoming.screen_group_ids || [];

    const existingHasTargets = existingScreens.length > 0 || existingGroups.length > 0;
    const incomingHasTargets = incomingScreens.length > 0 || incomingGroups.length > 0;

    if (!existingHasTargets && !incomingHasTargets) return true; // both global
    if (!existingHasTargets) return true; // existing applies to all
    if (!incomingHasTargets) return true; // new applies to all

    const screenOverlap = existingScreens.some((sid) => incomingScreens.includes(sid));
    const groupOverlap = existingGroups.some((gid) => incomingGroups.includes(gid));
    return screenOverlap || groupOverlap;
  };

  const hasOverlap = (items: any[], startAt: Date, endAt: Date, incomingTargets: { screen_ids?: string[]; screen_group_ids?: string[] }) => {
    return items.some((i) => {
      const existingStart = new Date(i.start_at);
      const existingEnd = new Date(i.end_at);
      if (!targetsIntersect(i, incomingTargets)) return false;
      return startAt < existingEnd && endAt > existingStart;
    });
  };


  // Create schedule
  fastify.post<{ Body: typeof createScheduleSchema._type }>(
    apiEndpoints.schedules.create,
    {
      schema: {
        description: 'Create a new schedule',
        tags: ['Schedules'],
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

        if (!ability.can('create', 'Schedule')) {
          throw AppError.forbidden('Forbidden');
        }

        const data = createScheduleSchema.parse(request.body);
        const startIso = data.start_at ?? new Date().toISOString();
        const endIso =
          data.end_at ?? new Date(new Date(startIso).getTime() + 24 * 60 * 60 * 1000).toISOString();
        const { startAt, endAt } = validateStartEnd(startIso, endIso);
        const schedule = await scheduleRepo.create({
          ...data,
          start_at: startAt,
          end_at: endAt,
          created_by: payload.sub,
        });

        return reply.status(CREATED).send({
          id: schedule.id,
          name: schedule.name,
          description: schedule.description,
          start_at: schedule.start_at.toISOString(),
          end_at: schedule.end_at.toISOString(),
          is_active: schedule.is_active,
          created_by: schedule.created_by,
          created_at: schedule.created_at.toISOString(),
          updated_at: schedule.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Create schedule error');
        return respondWithError(reply, error);
      }
    }
  );

  // Publish status and history
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.schedules.publishes,
    {
      schema: {
        description: 'Get publish history and target status for a schedule',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);

        const publishes = await db
          .select()
          .from(schema.publishes)
          .where(eq(schema.publishes.schedule_id, (request.params as any).id))
          .orderBy(desc(schema.publishes.published_at));

        const publishIds = publishes.map((p) => p.id);
        const targets = publishIds.length
          ? await db.select().from(schema.publishTargets).where(inArray(schema.publishTargets.publish_id, publishIds))
          : [];
        const targetsByPublish = new Map<string, any[]>();
        targets.forEach((t) => {
          const arr = targetsByPublish.get(t.publish_id) || [];
          arr.push(t);
          targetsByPublish.set(t.publish_id, arr);
        });

        return reply.send({
          items: publishes.map((p) => ({
            ...p,
            published_at: p.published_at.toISOString?.() ?? p.published_at,
            targets: targetsByPublish.get(p.id) || [],
          })),
        });
      } catch (error) {
        logger.error(error, 'List publishes error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.patch<{ Params: { publishId: string; targetId: string }; Body: { status: string; error?: string } }>(
    apiEndpoints.schedules.updatePublishTarget,
    {
      schema: {
        description: 'Update publish target status',
        tags: ['Schedules'],
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
        if (!ability.can('update', 'Schedule')) {
          throw AppError.forbidden('Forbidden');
        }

        const body = request.body as any;
        const [target] = await db
          .update(schema.publishTargets)
          .set({ status: body.status, error: body.error, updated_at: new Date() })
          .where(eq(schema.publishTargets.id, (request.params as any).targetId))
          .returning();

        if (!target) throw AppError.notFound('Target not found');
        return reply.send(target);
      } catch (error) {
        logger.error(error, 'Update publish target error');
        return respondWithError(reply, error);
      }
    }
  );

  // List schedules
  fastify.get<{ Querystring: typeof listSchedulesQuerySchema._type }>(
    apiEndpoints.schedules.list,
    {
      schema: {
        description: 'List schedules with pagination',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);

        const query = listSchedulesQuerySchema.parse(request.query);
        const result = await scheduleRepo.list({
          page: query.page,
          limit: query.limit,
          is_active: query.is_active === 'true' ? true : query.is_active === 'false' ? false : undefined,
        });

        return reply.send({
          items: result.items.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            start_at: s.start_at?.toISOString(),
            end_at: s.end_at?.toISOString(),
            is_active: s.is_active,
            created_by: s.created_by,
            created_at: s.created_at.toISOString(),
            updated_at: s.updated_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List schedules error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get schedule by ID
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.schedules.get,
    {
      schema: {
        description: 'Get schedule by ID',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);

        const schedule = await scheduleRepo.findById((request.params as any).id);
        if (!schedule) {
          throw AppError.notFound('Schedule not found');
        }

        return reply.send({
          id: schedule.id,
          name: schedule.name,
          description: schedule.description,
          start_at: schedule.start_at?.toISOString(),
          end_at: schedule.end_at?.toISOString(),
          is_active: schedule.is_active,
          created_by: schedule.created_by,
          created_at: schedule.created_at.toISOString(),
          updated_at: schedule.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get schedule error');
        return respondWithError(reply, error);
      }
    }
  );

  // List schedule items (with resolved presentations/media for preview)
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.schedules.items,
    {
      schema: {
        description: 'List schedule items (presentation slots)',
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
        if (!ability.can('read', 'Schedule')) throw AppError.forbidden('Forbidden');

        const schedule = await scheduleRepo.findById((request.params as any).id);
        if (!schedule) throw AppError.notFound('Schedule not found');

        const items = await scheduleItemRepo.listBySchedule(schedule.id);
        const presMap = await resolvePresentations(items.map((i: any) => i.presentation_id));

        return reply.send({
          items: items.map((i: any) => {
            const pres = presMap.get(i.presentation_id);
            return {
              id: i.id,
              presentation_id: i.presentation_id,
              start_at: i.start_at.toISOString?.() ?? i.start_at,
              end_at: i.end_at.toISOString?.() ?? i.end_at,
              priority: i.priority,
              screen_ids: i.screen_ids || [],
              screen_group_ids: i.screen_group_ids || [],
              created_at: i.created_at.toISOString?.() ?? i.created_at,
              presentation: pres
                ? {
                    id: pres.id,
                    name: pres.name,
                    description: pres.description,
                    layout: pres.layout
                      ? {
                          id: pres.layout.id,
                          name: pres.layout.name,
                          description: pres.layout.description,
                          aspect_ratio: pres.layout.aspect_ratio,
                          spec: pres.layout.spec,
                        }
                      : null,
                    items: (pres.items || []).map((pi: any) => ({
                      id: pi.id,
                      media_id: pi.media_id,
                      order: pi.order,
                      duration_seconds: pi.duration_seconds,
                      media: pi.media
                        ? {
                            id: pi.media.id,
                            name: pi.media.name,
                            original_filename: (pi.media as any).original_filename ?? pi.media.name,
                            type: pi.media.type,
                            status: pi.media.status,
                            source_bucket: pi.media.source_bucket,
                            source_object_key: pi.media.source_object_key,
                            ready_object_id: pi.media.ready_object_id,
                            thumbnail_object_id: pi.media.thumbnail_object_id,
                          }
                        : null,
                    })),
                    slots: (pres.slots || []).map((si: any) => ({
                      id: si.id,
                      slot_id: si.slot_id,
                      media_id: si.media_id,
                      order: si.order,
                      duration_seconds: si.duration_seconds,
                      fit_mode: si.fit_mode,
                      audio_enabled: si.audio_enabled,
                      media: si.media
                        ? {
                            id: si.media.id,
                            name: si.media.name,
                            original_filename: (si.media as any).original_filename ?? si.media.name,
                            type: si.media.type,
                            status: si.media.status,
                            source_bucket: si.media.source_bucket,
                            source_object_key: si.media.source_object_key,
                            ready_object_id: si.media.ready_object_id,
                            thumbnail_object_id: si.media.thumbnail_object_id,
                          }
                        : null,
                    })),
                  }
                : null,
            };
          }),
        });
      } catch (error) {
        logger.error(error, 'List schedule items error');
        return respondWithError(reply, error);
      }
    }
  );

  // Add schedule item
  fastify.post<{ Params: { id: string }; Body: typeof scheduleItemSchema._type }>(
    apiEndpoints.schedules.items,
    {
      schema: {
        description: 'Add a presentation to a schedule time window',
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
        if (!ability.can('update', 'Schedule')) throw AppError.forbidden('Forbidden');

        const schedule = await scheduleRepo.findById((request.params as any).id);
        if (!schedule) throw AppError.notFound('Schedule not found');

        const data = scheduleItemSchema.parse(request.body);
        const pres = await presentationRepo.findById(data.presentation_id);
        if (!pres) throw AppError.notFound('Presentation not found');

        const { startAt, endAt } = validateStartEnd(data.start_at, data.end_at);

        const uniqueScreenIds = Array.from(new Set(data.screen_ids || []));
        if (uniqueScreenIds.length) {
          const screens = await db
            .select({ id: schema.screens.id })
            .from(schema.screens)
            .where(inArray(schema.screens.id, uniqueScreenIds as any));
          if (screens.length !== uniqueScreenIds.length) {
            throw AppError.badRequest('One or more screen_ids are invalid');
          }
        }

        const uniqueGroupIds = Array.from(new Set(data.screen_group_ids || []));
        if (uniqueGroupIds.length) {
          const groups = await db
            .select({ id: schema.screenGroups.id })
            .from(schema.screenGroups)
            .where(inArray(schema.screenGroups.id, uniqueGroupIds as any));
          if (groups.length !== uniqueGroupIds.length) {
            throw AppError.badRequest('One or more screen_group_ids are invalid');
          }
        }

        if (startAt < new Date(schedule.start_at) || endAt > new Date(schedule.end_at)) {
          throw AppError.badRequest('Item window must be within the schedule start/end window');
        }

        const existing = await scheduleItemRepo.listBySchedule(schedule.id);
        if (hasOverlap(existing, startAt, endAt, { screen_ids: uniqueScreenIds, screen_group_ids: uniqueGroupIds })) {
          throw AppError.badRequest('Schedule item overlaps with an existing item for the same targets');
        }

        const item = await scheduleItemRepo.create({
          schedule_id: schedule.id,
          presentation_id: data.presentation_id,
          start_at: startAt,
          end_at: endAt,
          priority: data.priority ?? 0,
          screen_ids: uniqueScreenIds,
          screen_group_ids: uniqueGroupIds,
        });

        return reply.status(CREATED).send({
          id: item.id,
          schedule_id: schedule.id,
          presentation_id: item.presentation_id,
          start_at: item.start_at.toISOString?.() ?? item.start_at,
          end_at: item.end_at.toISOString?.() ?? item.end_at,
          priority: item.priority,
          screen_ids: item.screen_ids || [],
          screen_group_ids: item.screen_group_ids || [],
        });
      } catch (error) {
        logger.error(error, 'Add schedule item error');
        return respondWithError(reply, error);
      }
    }
  );

  // Delete schedule item
  fastify.delete<{ Params: { id: string; itemId: string } }>(
    apiEndpoints.schedules.item,
    {
      schema: {
        description: 'Delete a schedule item',
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
        if (!ability.can('update', 'Schedule')) throw AppError.forbidden('Forbidden');

        const schedule = await scheduleRepo.findById((request.params as any).id);
        if (!schedule) throw AppError.notFound('Schedule not found');

        const [item] = await db
          .select()
          .from(schema.scheduleItems)
          .where(
            and(eq(schema.scheduleItems.id, (request.params as any).itemId), eq(schema.scheduleItems.schedule_id, schedule.id))
          );
        if (!item) throw AppError.notFound('Schedule item not found');

        await scheduleItemRepo.delete(item.id);
        return reply.status(204).send();
      } catch (error) {
        logger.error(error, 'Delete schedule item error');
        return respondWithError(reply, error);
      }
    }
  );

  // Update schedule
  fastify.patch<{ Params: { id: string }; Body: typeof updateScheduleSchema._type }>(
    apiEndpoints.schedules.update,
    {
      schema: {
        description: 'Update schedule',
        tags: ['Schedules'],
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

        if (!ability.can('update', 'Schedule')) {
          throw AppError.forbidden('Forbidden');
        }

        const data = updateScheduleSchema.parse(request.body);

        let startAt: Date | undefined;
        let endAt: Date | undefined;
        if (data.start_at) startAt = new Date(data.start_at);
        if (data.end_at) endAt = new Date(data.end_at);

        // Validate provided dates
        if (startAt || endAt) {
          const now = new Date();
          if (startAt && isNaN(startAt.getTime())) throw AppError.badRequest('Invalid start_at');
          if (endAt && isNaN(endAt.getTime())) throw AppError.badRequest('Invalid end_at');
          if (startAt && startAt < now) throw AppError.badRequest('start_at cannot be in the past');
          if (endAt && endAt < now) throw AppError.badRequest('end_at cannot be in the past');
          if (startAt && endAt && startAt >= endAt) throw AppError.badRequest('start_at must be before end_at');
        }

        const schedule = await scheduleRepo.update((request.params as any).id, {
          ...data,
          start_at: startAt,
          end_at: endAt,
        });

        if (!schedule) {
          throw AppError.notFound('Schedule not found');
        }

        return reply.send({
          id: schedule.id,
          name: schedule.name,
          description: schedule.description,
          start_at: schedule.start_at?.toISOString(),
          end_at: schedule.end_at?.toISOString(),
          is_active: schedule.is_active,
          created_by: schedule.created_by,
          created_at: schedule.created_at.toISOString(),
          updated_at: schedule.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Update schedule error');
        return respondWithError(reply, error);
      }
    }
  );

  // Publish schedule
  fastify.post<{ Params: { id: string }; Body: typeof publishScheduleSchema._type }>(
    apiEndpoints.schedules.publish,
    {
      schema: {
        description: 'Publish schedule to screens',
        tags: ['Schedules'],
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

        if (!ability.can('update', 'Schedule')) {
          throw AppError.forbidden('Forbidden');
        }

        const data = publishScheduleSchema.parse(request.body);
        const uniqueScreens = Array.from(new Set(data.screen_ids || []));
        if (uniqueScreens.length) {
          const screens = await db
            .select({ id: schema.screens.id })
            .from(schema.screens)
            .where(inArray(schema.screens.id, uniqueScreens as any));
          if (screens.length !== uniqueScreens.length) {
            throw AppError.badRequest('One or more screen_ids are invalid');
          }
        }

        const uniqueGroups = Array.from(new Set(data.screen_group_ids || []));
        if (uniqueGroups.length) {
          const groups = await db
            .select({ id: schema.screenGroups.id })
            .from(schema.screenGroups)
            .where(inArray(schema.screenGroups.id, uniqueGroups as any));
          if (groups.length !== uniqueGroups.length) {
            throw AppError.badRequest('One or more screen_group_ids are invalid');
          }
        }

        let scheduleRequest: any = null;
        if ((data as any).schedule_request_id) {
          const [req] = await db
            .select()
            .from(schema.scheduleRequests)
            .where(eq(schema.scheduleRequests.id, (data as any).schedule_request_id));
          if (!req) throw AppError.notFound('Schedule request not found');
          if (req.schedule_id && req.schedule_id !== (request.params as any).id) {
            throw AppError.badRequest('Schedule request does not match this schedule');
          }
          if (req.status !== 'APPROVED') {
            throw AppError.badRequest('Schedule request must be APPROVED before publish');
          }
          scheduleRequest = req;
        }

        const publishResult = await publishScheduleSnapshot({
          scheduleId: (request.params as any).id,
          screenIds: uniqueScreens,
          screenGroupIds: uniqueGroups,
          publishedBy: payload.sub,
          notes: (data as any).notes,
          db,
          scheduleRepo,
          scheduleItemRepo,
        });

        if (scheduleRequest) {
          await db
            .update(schema.scheduleRequests)
            .set({ updated_at: new Date() })
            .where(eq(schema.scheduleRequests.id, scheduleRequest.id));
        }

        return reply.send({
          message: 'Schedule published successfully',
          schedule_id: (request.params as any).id,
          publish_id: publishResult.publish.id,
          snapshot_id: publishResult.snapshot.id,
          targets: publishResult.targets.length,
          resolved_screen_ids: publishResult.resolvedScreenIds,
        });
      } catch (error) {
        logger.error(error, 'Publish schedule error');
        return respondWithError(reply, error);
      }
    }
  );

  // Poll single publish
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.schedules.publishStatus,
    {
      schema: {
        description: 'Get publish record and target statuses',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        await verifyAccessToken(token);

        const [publish] = await db
          .select()
          .from(schema.publishes)
          .where(eq(schema.publishes.id, (request.params as any).id));
        if (!publish) throw AppError.notFound('Publish not found');

        const targets = await db
          .select()
          .from(schema.publishTargets)
          .where(eq(schema.publishTargets.publish_id, publish.id));

        return reply.send({
          ...publish,
          published_at: publish.published_at.toISOString?.() ?? publish.published_at,
          targets,
        });
      } catch (error) {
        logger.error(error, 'Get publish error');
        return respondWithError(reply, error);
      }
    }
  );
}
