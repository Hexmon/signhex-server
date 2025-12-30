import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createDepartmentRepository } from '@/db/repositories/department';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';

const logger = createLogger('department-routes');
const { CREATED, FORBIDDEN, NOT_FOUND, OK, UNAUTHORIZED } = HTTP_STATUS;

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
    apiEndpoints.departments.create,
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('create', 'Department')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const data = createDepartmentSchema.parse(request.body);
        const department = await deptRepo.create(data);

        return reply.status(CREATED).send({
          id: department.id,
          name: department.name,
          description: department.description,
          created_at: department.created_at.toISOString(),
          updated_at: department.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Create department error');
        return respondWithError(reply, error);
      }
    }
  );

  // List departments
  fastify.get<{ Querystring: typeof listDepartmentsQuerySchema._type }>(
    apiEndpoints.departments.list,
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
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
        return respondWithError(reply, error);
      }
    }
  );

  // Get department by ID
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.departments.get,
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        await verifyAccessToken(token);

        const department = await deptRepo.findById((request.params as any).id);
        if (!department) {
          return reply.status(NOT_FOUND).send({ error: 'Department not found' });
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
        return respondWithError(reply, error);
      }
    }
  );

  // Update department
  fastify.patch<{ Params: { id: string }; Body: Partial<typeof createDepartmentSchema._type> }>(
    apiEndpoints.departments.update,
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('update', 'Department')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const data = createDepartmentSchema.partial().parse(request.body);
        const department = await deptRepo.update((request.params as any).id, data);

        if (!department) {
          return reply.status(NOT_FOUND).send({ error: 'Department not found' });
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
        return respondWithError(reply, error);
      }
    }
  );

  // Delete department
  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.departments.delete,
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('delete', 'Department')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const departmentId = (request.params as any).id;
        const exists = await deptRepo.findById(departmentId);
        if (!exists) {
          return reply.status(NOT_FOUND).send({ error: 'Department not found' });
        }

        await deptRepo.delete(departmentId);
        return reply.status(OK).send({ message: 'Department deleted successfully', id: departmentId });
      } catch (error) {
        logger.error(error, 'Delete department error');
        return respondWithError(reply, error);
      }
    }
  );
}
