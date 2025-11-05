import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createDepartmentRepository } from '@/db/repositories/department';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';

const logger = createLogger('department-routes');

const createDepartmentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
});

const listDepartmentsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export async function departmentRoutes(fastify: FastifyInstance) {
  const deptRepo = createDepartmentRepository();

  // Create department
  fastify.post<{ Body: typeof createDepartmentSchema._type }>(
    '/v1/departments',
    {
      schema: {
        description: 'Create a new department (admin only)',
        tags: ['Departments'],
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

        if (!ability.can('create', 'Department')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const data = createDepartmentSchema.parse(request.body);
        const department = await deptRepo.create(data);

        return reply.status(201).send({
          id: department.id,
          name: department.name,
          description: department.description,
          created_at: department.created_at.toISOString(),
          updated_at: department.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Create department error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // List departments
  fastify.get<{ Querystring: typeof listDepartmentsQuerySchema._type }>(
    '/v1/departments',
    {
      schema: {
        description: 'List departments with pagination',
        tags: ['Departments'],
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

        const query = listDepartmentsQuerySchema.parse(request.query);
        const result = await deptRepo.list({
          page: query.page,
          limit: query.limit,
        });

        return reply.send({
          items: result.items.map((d) => ({
            id: d.id,
            name: d.name,
            description: d.description,
            created_at: d.created_at.toISOString(),
            updated_at: d.updated_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List departments error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Get department by ID
  fastify.get<{ Params: { id: string } }>(
    '/v1/departments/:id',
    {
      schema: {
        description: 'Get department by ID',
        tags: ['Departments'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        await verifyAccessToken(token);

        const department = await deptRepo.findById((request.params as any).id);
        if (!department) {
          return reply.status(404).send({ error: 'Department not found' });
        }

        return reply.send({
          id: department.id,
          name: department.name,
          description: department.description,
          created_at: department.created_at.toISOString(),
          updated_at: department.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get department error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Update department
  fastify.patch<{ Params: { id: string }; Body: Partial<typeof createDepartmentSchema._type> }>(
    '/v1/departments/:id',
    {
      schema: {
        description: 'Update department (admin only)',
        tags: ['Departments'],
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

        if (!ability.can('update', 'Department')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const data = createDepartmentSchema.partial().parse(request.body);
        const department = await deptRepo.update((request.params as any).id, data);

        if (!department) {
          return reply.status(404).send({ error: 'Department not found' });
        }

        return reply.send({
          id: department.id,
          name: department.name,
          description: department.description,
          created_at: department.created_at.toISOString(),
          updated_at: department.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Update department error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Delete department
  fastify.delete<{ Params: { id: string } }>(
    '/v1/departments/:id',
    {
      schema: {
        description: 'Delete department (admin only)',
        tags: ['Departments'],
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

        if (!ability.can('delete', 'Department')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        await deptRepo.delete((request.params as any).id);
        return reply.status(204).send();
      } catch (error) {
        logger.error(error, 'Delete department error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}

