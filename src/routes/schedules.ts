import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createScheduleSchema,
  updateScheduleSchema,
  listSchedulesQuerySchema,
  publishScheduleSchema,
} from '@/schemas/schedule';
import { createScheduleRepository } from '@/db/repositories/schedule';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';

const logger = createLogger('schedule-routes');

export async function scheduleRoutes(fastify: FastifyInstance) {
  const scheduleRepo = createScheduleRepository();

  // Create schedule
  fastify.post<{ Body: typeof createScheduleSchema._type }>(
    '/v1/schedules',
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
        const schedule = await scheduleRepo.create({
          ...data,
          created_by: payload.sub,
        });

        return reply.status(201).send({
          id: schedule.id,
          name: schedule.name,
          description: schedule.description,
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

  // List schedules
  fastify.get<{ Querystring: typeof listSchedulesQuerySchema._type }>(
    '/v1/schedules',
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
    '/v1/schedules/:id',
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
    '/v1/schedules/:id',
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
        const schedule = await scheduleRepo.update((request.params as any).id, data);

        if (!schedule) {
          return reply.status(404).send({ error: 'Schedule not found' });
        }

        return reply.send({
          id: schedule.id,
          name: schedule.name,
          description: schedule.description,
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
    '/v1/schedules/:id/publish',
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

        // TODO: Implement schedule publishing logic
        // - Create schedule snapshot
        // - Create publish record
        // - Notify screens via WebSocket

        return reply.send({
          message: 'Schedule published successfully',
          schedule_id: (request.params as any).id,
        });
      } catch (error) {
        logger.error(error, 'Publish schedule error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}

