import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createUserSchema, updateUserSchema, listUsersQuerySchema } from '@/schemas/user';
import { createUserRepository, type UserRepository } from '@/db/repositories/user';
import { hashPassword } from '@/auth/password';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';
import { createRoleRepository } from '@/db/repositories/role';
import { canManageUserRecord, canManageUserRoleTarget, canReadUserRecord } from '@/rbac/policy';

const logger = createLogger('user-routes');
const { CREATED, FORBIDDEN, NOT_FOUND, OK, UNAUTHORIZED } = HTTP_STATUS;

export async function userRoutes(fastify: FastifyInstance) {
  const userRepo = createUserRepository();
  const roleRepo = createRoleRepository();
  const resolveUserLabel = (user: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
  }) => {
    const fullName = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim();
    if (fullName.length > 0) return fullName;
    if (user.email) return user.email;
    return 'this user';
  };

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
      let user:
        | {
            id: string;
            email: string;
            first_name: string | null;
            last_name: string | null;
            role_id: string;
            department_id: string | null;
            is_active: boolean;
            created_at: Date;
            updated_at: Date;
          }
        | null = null;

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
        if (!canManageUserRoleTarget(payload.role, role.name)) {
          throw AppError.forbidden('Forbidden');
        }
        if (payload.role === 'DEPARTMENT' && data.department_id !== payload.department_id) {
          throw AppError.forbidden('Department users can only manage operators in their own department.');
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
      let user:
        | {
            id: string;
            email: string;
            first_name: string | null;
            last_name: string | null;
            role_id: string;
            department_id: string | null;
            is_active: boolean;
            created_at: Date;
            updated_at: Date;
          }
        | null = null;

      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'User')) {
          throw AppError.forbidden('Forbidden');
        }

        const query = listUsersQuerySchema.parse(request.query);
        const effectiveRole =
          payload.role === 'OPERATOR'
            ? 'OPERATOR'
            : payload.role === 'DEPARTMENT'
              ? 'OPERATOR'
              : query.role;
        const effectiveDepartmentId =
          payload.role === 'DEPARTMENT' ? payload.department_id : query.department_id;
        const result = await userRepo.list({
          page: query.page,
          limit: query.limit,
          role: effectiveRole,
          role_id: query.role_id,
          department_id: effectiveDepartmentId,
          is_active: query.is_active === 'true' ? true : query.is_active === 'false' ? false : undefined,
        });

        const items = result.items.filter((user) =>
          canReadUserRecord(
            { userId: payload.sub, roleName: payload.role, departmentId: payload.department_id },
            { roleName: (user as any).role ?? '', departmentId: user.department_id }
          )
        );

        return reply.send({
          items: items.map((user) => ({
            id: user.id,
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            role: (user as any).role ?? null,
            role_id: user.role_id,
            department_id: user.department_id,
            is_active: user.is_active,
            created_at: user.created_at.toISOString(),
            updated_at: user.updated_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: items.length,
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

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'User')) {
          throw AppError.forbidden('Forbidden');
        }

        const user = await userRepo.findById((request.params as any).id);
        if (!user) {
          throw AppError.notFound('User not found');
        }

        const role = await roleRepo.findById(user.role_id);
        if (
          !canReadUserRecord(
            { userId: payload.sub, roleName: payload.role, departmentId: payload.department_id },
            { roleName: role?.name ?? '', departmentId: user.department_id }
          )
        ) {
          throw AppError.forbidden('Forbidden');
        }

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
          if (!canManageUserRoleTarget(payload.role, role.name)) {
            throw AppError.forbidden('Forbidden');
          }
          if (payload.role === 'DEPARTMENT' && data.department_id !== payload.department_id) {
            throw AppError.forbidden('Department users can only manage operators in their own department.');
          }
        }
        const existingUser = await userRepo.findById((request.params as any).id);
        if (!existingUser) {
          throw AppError.notFound('User not found');
        }
        if (
          payload.role === 'DEPARTMENT' &&
          Object.prototype.hasOwnProperty.call(data, 'department_id') &&
          data.department_id !== payload.department_id
        ) {
          throw AppError.forbidden('Department users can only manage operators in their own department.');
        }
        const existingRole = await roleRepo.findById(existingUser.role_id);
        if (
          !canManageUserRecord(
            { userId: payload.sub, roleName: payload.role, departmentId: payload.department_id },
            {
              id: existingUser.id,
              roleName: existingRole?.name ?? '',
              departmentId: existingUser.department_id,
            }
          )
        ) {
          throw AppError.forbidden('Forbidden');
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
      let user: {
        first_name?: string | null;
        last_name?: string | null;
        email?: string | null;
        role_id?: string;
        department_id?: string | null;
      } | null = null;

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
        user = await userRepo.findById(userId);
        if (!user) {
          throw AppError.notFound('User not found');
        }
        const targetRole = user.role_id ? await roleRepo.findById(user.role_id) : null;
        if (
          !canManageUserRecord(
            { userId: payload.sub, roleName: payload.role, departmentId: payload.department_id },
            {
              id: userId,
              roleName: targetRole?.name ?? '',
              departmentId: (user as any).department_id,
            }
          )
        ) {
          throw AppError.forbidden('Forbidden');
        }

        await userRepo.delete(userId);
        return reply.status(OK).send({ message: 'User deleted successfully', id: userId });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23503') {
          const usageSummary = user
            ? await userRepo.getDeleteUsageSummary((request.params as any).id)
            : { inUse: false, primaryReason: null, references: [] as Array<{ key: string; label: string; count: number }> };
          const primaryLabel = usageSummary.references[0]?.label ?? 'existing records';
          const hasMore = usageSummary.references.length > 1;
          const conflictError = new AppError({
            statusCode: 409,
            code: 'CONFLICT',
            message: `${resolveUserLabel(user ?? {})} cannot be deleted because they are still linked to ${primaryLabel}${hasMore ? ' and other records' : ''}. Reassign or remove those records first, or deactivate the user instead.`,
            details:
              usageSummary.references.length > 0
                ? {
                    references: usageSummary.references,
                  }
                : null,
          });
          logger.error(conflictError, 'Delete user error');
          return respondWithError(reply, conflictError);
        }

        logger.error(error, 'Delete user error');
        return respondWithError(reply, error);
      }
    }
  );
}
