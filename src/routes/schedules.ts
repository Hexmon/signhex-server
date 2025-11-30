import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { desc, eq, inArray } from 'drizzle-orm';
import {
  createScheduleSchema,
  updateScheduleSchema,
  listSchedulesQuerySchema,
  publishScheduleSchema,
} from '@/schemas/schedule';
import { apiEndpoints } from '@/config/apiEndpoints';
import { createScheduleRepository } from '@/db/repositories/schedule';
import { getDatabase, schema } from '@/db';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';

const logger = createLogger('schedule-routes');

export async function scheduleRoutes(fastify: FastifyInstance) {
  const scheduleRepo = createScheduleRepository();
  const db = getDatabase();

  const validateStartEnd = (start: string, end: string) => {
    const now = new Date();
    const startAt = new Date(start);
    const endAt = new Date(end);

    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) {
      throw new Error('Invalid date format');
    }
    if (startAt < now) {
      throw new Error('start_at cannot be in the past');
    }
    if (endAt < now) {
      throw new Error('end_at cannot be in the past');
    }
    if (startAt >= endAt) {
      throw new Error('start_at must be before end_at');
    }
    return { startAt, endAt };
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('create', 'Schedule')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const data = createScheduleSchema.parse(request.body);
        const { startAt, endAt } = validateStartEnd(data.start_at, data.end_at);
        const schedule = await scheduleRepo.create({
          ...data,
          start_at: startAt,
          end_at: endAt,
          created_by: payload.sub,
        });

        return reply.status(201).send({
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
        return reply.status(400).send({ error: 'Invalid request' });
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
          return reply.status(401).send({ error: 'Missing authorization header' });
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
        return reply.status(400).send({ error: 'Invalid request' });
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'Schedule')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const body = request.body as any;
        const [target] = await db
          .update(schema.publishTargets)
          .set({ status: body.status, error: body.error, updated_at: new Date() })
          .where(eq(schema.publishTargets.id, (request.params as any).targetId))
          .returning();

        if (!target) return reply.status(404).send({ error: 'Target not found' });
        return reply.send(target);
      } catch (error) {
        logger.error(error, 'Update publish target error');
        return reply.status(400).send({ error: 'Invalid request' });
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
          return reply.status(401).send({ error: 'Missing authorization header' });
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
        return reply.status(400).send({ error: 'Invalid request' });
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        await verifyAccessToken(token);

        const schedule = await scheduleRepo.findById((request.params as any).id);
        if (!schedule) {
          return reply.status(404).send({ error: 'Schedule not found' });
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
        return reply.status(400).send({ error: 'Invalid request' });
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('update', 'Schedule')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const data = updateScheduleSchema.parse(request.body);

        let startAt: Date | undefined;
        let endAt: Date | undefined;
        if (data.start_at) startAt = new Date(data.start_at);
        if (data.end_at) endAt = new Date(data.end_at);

        // Validate provided dates
        if (startAt || endAt) {
          const now = new Date();
          if (startAt && isNaN(startAt.getTime())) throw new Error('Invalid start_at');
          if (endAt && isNaN(endAt.getTime())) throw new Error('Invalid end_at');
          if (startAt && startAt < now) throw new Error('start_at cannot be in the past');
          if (endAt && endAt < now) throw new Error('end_at cannot be in the past');
          if (startAt && endAt && startAt >= endAt) throw new Error('start_at must be before end_at');
        }

        const schedule = await scheduleRepo.update((request.params as any).id, {
          ...data,
          start_at: startAt,
          end_at: endAt,
        });

        if (!schedule) {
          return reply.status(404).send({ error: 'Schedule not found' });
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
        return reply.status(400).send({ error: 'Invalid request' });
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('update', 'Schedule')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const data = publishScheduleSchema.parse(request.body);

        // Create snapshot (minimal payload for now)
        const [snapshot] = await db
          .insert(schema.scheduleSnapshots)
          .values({
            schedule_id: (request.params as any).id,
            payload: {
              schedule_id: (request.params as any).id,
              screen_ids: data.screen_ids || [],
              screen_group_ids: data.screen_group_ids || [],
              published_at: new Date().toISOString(),
            },
          })
          .returning();

        const [publish] = await db
          .insert(schema.publishes)
          .values({
            schedule_id: (request.params as any).id,
            snapshot_id: snapshot.id,
            published_by: payload.sub,
          })
          .returning();

        const targets: { screen_id?: string; screen_group_id?: string }[] = [];
        (data.screen_ids || []).forEach((sid) => targets.push({ screen_id: sid }));
        (data.screen_group_ids || []).forEach((gid) => targets.push({ screen_group_id: gid }));

        if (targets.length > 0) {
          await db
            .insert(schema.publishTargets)
            .values(
              targets.map((t) => ({
                publish_id: publish.id,
                screen_id: t.screen_id,
                screen_group_id: t.screen_group_id,
              }))
            );
        }

        return reply.send({
          message: 'Schedule published successfully',
          schedule_id: (request.params as any).id,
          publish_id: publish.id,
          snapshot_id: snapshot.id,
          targets: targets.length,
        });
      } catch (error) {
        logger.error(error, 'Publish schedule error');
        return reply.status(400).send({ error: 'Invalid request' });
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
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        await verifyAccessToken(token);

        const [publish] = await db
          .select()
          .from(schema.publishes)
          .where(eq(schema.publishes.id, (request.params as any).id));
        if (!publish) return reply.status(404).send({ error: 'Publish not found' });

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
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
