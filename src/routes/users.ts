import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createUserSchema, updateUserSchema, listUsersQuerySchema } from '@/schemas/user';
import { createUserRepository } from '@/db/repositories/user';
import { hashPassword } from '@/auth/password';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';
import { createRoleRepository } from '@/db/repositories/role';

const logger = createLogger('user-routes');
const { CREATED, FORBIDDEN, NOT_FOUND, OK, UNAUTHORIZED } = HTTP_STATUS;

export async function userRoutes(fastify: FastifyInstance) {
  const userRepo = createUserRepository();
  const roleRepo = createRoleRepository();

  // Create user (admin only)
  fastify.post<{ Body: typeof createUserSchema._type }>(
    apiEndpoints.users.create,
    {
      schema: {
        description: 'Create a new user (admin only)',
        tags: ['Users'],
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

        if (!ability.can('create', 'User')) {
          throw AppError.forbidden('Forbidden');
        }

        const data = createUserSchema.parse(request.body);
        const passwordHash = await hashPassword(data.password);

        const role = await roleRepo.findById(data.role_id);
        if (!role) {
          throw AppError.notFound('Role not found');
        }

        const user = await userRepo.create({
          email: data.email,
          password_hash: passwordHash,
          first_name: data.first_name,
          last_name: data.last_name,
          role_id: data.role_id,
          department_id: data.department_id,
        });

        return reply.status(CREATED).send({
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: role.name,
          role_id: user.role_id,
          department_id: user.department_id,
          is_active: user.is_active,
          created_at: user.created_at.toISOString(),
          updated_at: user.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Create user error');
        return respondWithError(reply, error);
      }
    }
  );

  // List users
  fastify.get<{ Querystring: typeof listUsersQuerySchema._type }>(
    apiEndpoints.users.list,
    {
      schema: {
        description: 'List users with pagination and filtering',
        tags: ['Users'],
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

        const query = listUsersQuerySchema.parse(request.query);
        const result = await userRepo.list({
          page: query.page,
          limit: query.limit,
          role_id: query.role_id,
          department_id: query.department_id,
          is_active: query.is_active === 'true' ? true : query.is_active === 'false' ? false : undefined,
        });

        const rolesById = new Map<string, any>();
        for (const item of result.items) {
          if (!rolesById.has(item.role_id)) {
            const role = await roleRepo.findById(item.role_id);
            rolesById.set(item.role_id, role);
          }
        }

        return reply.send({
          items: result.items.map((user) => ({
            id: user.id,
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            role: rolesById.get(user.role_id)?.name ?? null,
            role_id: user.role_id,
            department_id: user.department_id,
            is_active: user.is_active,
            created_at: user.created_at.toISOString(),
            updated_at: user.updated_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List users error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get user by ID
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.users.get,
    {
      schema: {
        description: 'Get user by ID',
        tags: ['Users'],
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

        const user = await userRepo.findById((request.params as any).id);
        if (!user) {
          throw AppError.notFound('User not found');
        }

        const role = await roleRepo.findById(user.role_id);

        return reply.send({
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: role?.name ?? null,
          role_id: user.role_id,
          department_id: user.department_id,
          is_active: user.is_active,
          created_at: user.created_at.toISOString(),
          updated_at: user.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get user error');
        return respondWithError(reply, error);
      }
    }
  );

  // Update user
  fastify.patch<{ Params: { id: string }; Body: typeof updateUserSchema._type }>(
    apiEndpoints.users.update,
    {
      schema: {
        description: 'Update user (admin only)',
        tags: ['Users'],
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

        if (!ability.can('update', 'User')) {
          throw AppError.forbidden('Forbidden');
        }

        const data = updateUserSchema.parse(request.body);
        if (data.role_id) {
          const role = await roleRepo.findById(data.role_id);
          if (!role) {
            throw AppError.notFound('Role not found');
          }
        }
        const user = await userRepo.update((request.params as any).id, data);

        if (!user) {
          throw AppError.notFound('User not found');
        }

        const role = await roleRepo.findById(user.role_id);

        return reply.send({
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: role?.name ?? null,
          role_id: user.role_id,
          department_id: user.department_id,
          is_active: user.is_active,
          created_at: user.created_at.toISOString(),
          updated_at: user.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Update user error');
        return respondWithError(reply, error);
      }
    }
  );

  // Delete user (admin only)
  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.users.delete,
    {
      schema: {
        description: 'Delete user (admin only)',
        tags: ['Users'],
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

        if (!ability.can('delete', 'User')) {
          throw AppError.forbidden('Forbidden');
        }

        const userId = (request.params as any).id;
        const user = await userRepo.findById(userId);
        if (!user) {
          throw AppError.notFound('User not found');
        }

        await userRepo.delete(userId);
        return reply.status(OK).send({ message: 'User deleted successfully', id: userId });
      } catch (error) {
        logger.error(error, 'Delete user error');
        return respondWithError(reply, error);
      }
    }
  );
}
