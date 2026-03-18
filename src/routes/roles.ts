import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { createRoleRepository } from '@/db/repositories/role';
import { getDatabase, schema } from '@/db';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';
import { PERMISSION_ACTIONS } from '@/rbac/permissions';
import { canManageSystemRole, isSuperAdmin } from '@/rbac/policy';

const logger = createLogger('role-routes');
const { CREATED, FORBIDDEN, NOT_FOUND, OK, UNAUTHORIZED } = HTTP_STATUS;

const permissionGrantSchema = z.object({
  action: z.enum(PERMISSION_ACTIONS),
  subject: z.string().min(1),
  conditions: z.record(z.string()).optional(),
});

const permissionsSchema = z.object({
  inherits: z.array(z.string().uuid()).optional(),
  grants: z.array(permissionGrantSchema).default([]),
});

const createRoleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  permissions: permissionsSchema,
});

const updateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  permissions: permissionsSchema.optional(),
});

const listRolesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
});

export async function roleRoutes(fastify: FastifyInstance) {
  const roleRepo = createRoleRepository();
  const db = getDatabase();

  // Create role
  fastify.post<{ Body: typeof createRoleSchema._type }>(
    apiEndpoints.roles.create,
    {
      schema: {
        description: 'Create a new role (admin only)',
        tags: ['Roles'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('create', 'Role')) throw AppError.forbidden('Forbidden');

        const data = createRoleSchema.parse(request.body);
        if (!isSuperAdmin(payload.role)) {
          throw AppError.forbidden('Only Super Admin can create roles.');
        }
        const role = await roleRepo.create({
          name: data.name,
          description: data.description,
          permissions: data.permissions,
          is_system: false,
        });

        return reply.status(CREATED).send({
          id: role.id,
          name: role.name,
          description: role.description,
          permissions: role.permissions,
          is_system: role.is_system,
          created_at: role.created_at.toISOString(),
          updated_at: role.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Create role error');
        return respondWithError(reply, error);
      }
    }
  );

  // List roles
  fastify.get<{ Querystring: typeof listRolesQuerySchema._type }>(
    apiEndpoints.roles.list,
    {
      schema: {
        description: 'List roles with pagination',
        tags: ['Roles'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'Role')) throw AppError.forbidden('Forbidden');

        const query = listRolesQuerySchema.parse(request.query);
        const result = await roleRepo.list({
          page: query.page,
          limit: query.limit,
          search: query.search,
        });

        return reply.send({
          items: result.items.map((role) => ({
            id: role.id,
            name: role.name,
            description: role.description,
            permissions: role.permissions,
            is_system: role.is_system,
            created_at: role.created_at.toISOString(),
            updated_at: role.updated_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List roles error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get role by ID
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.roles.get,
    {
      schema: {
        description: 'Get role by ID',
        tags: ['Roles'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'Role')) throw AppError.forbidden('Forbidden');

        const role = await roleRepo.findById(request.params.id);
        if (!role) throw AppError.notFound('Role not found');

        return reply.send({
          id: role.id,
          name: role.name,
          description: role.description,
          permissions: role.permissions,
          is_system: role.is_system,
          created_at: role.created_at.toISOString(),
          updated_at: role.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get role error');
        return respondWithError(reply, error);
      }
    }
  );

  // Update role
  fastify.put<{ Params: { id: string }; Body: typeof updateRoleSchema._type }>(
    apiEndpoints.roles.update,
    {
      schema: {
        description: 'Update role (admin only)',
        tags: ['Roles'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: typeof updateRoleSchema._type }>,
      reply: FastifyReply
    ) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('update', 'Role')) throw AppError.forbidden('Forbidden');

        const data = updateRoleSchema.parse(request.body);
        const existingRole = await roleRepo.findById(request.params.id);
        if (!existingRole) throw AppError.notFound('Role not found');
        if (existingRole.is_system && !canManageSystemRole(payload.role, existingRole.name)) {
          throw AppError.forbidden('Forbidden');
        }
        const updated = await roleRepo.update(request.params.id, data);
        if (!updated) throw AppError.notFound('Role not found');

        return reply.status(OK).send({
          id: updated.id,
          name: updated.name,
          description: updated.description,
          permissions: updated.permissions,
          is_system: updated.is_system,
          created_at: updated.created_at.toISOString(),
          updated_at: updated.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Update role error');
        return respondWithError(reply, error);
      }
    }
  );

  // Delete role
  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.roles.delete,
    {
      schema: {
        description: 'Delete role (admin only)',
        tags: ['Roles'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('delete', 'Role')) throw AppError.forbidden('Forbidden');

        const role = await roleRepo.findById(request.params.id);
        if (!role) throw AppError.notFound('Role not found');
        if (role.is_system && !canManageSystemRole(payload.role, role.name)) {
          throw AppError.forbidden('Forbidden');
        }
        if (role.is_system) throw AppError.conflict('System roles cannot be deleted.');

        const [usage] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.users)
          .where(eq(schema.users.role_id, request.params.id));
        if (Number((usage as any)?.count || 0) > 0) {
          throw AppError.conflict('Role is assigned to users and cannot be deleted.');
        }

        await roleRepo.delete(request.params.id);
        return reply.status(OK).send({ success: true });
      } catch (error) {
        logger.error(error, 'Delete role error');
        return respondWithError(reply, error);
      }
    }
  );
}
