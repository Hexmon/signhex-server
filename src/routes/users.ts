import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createUserSchema, updateUserSchema, listUsersQuerySchema } from '@/schemas/user';
import { createUserRepository } from '@/db/repositories/user';
import { hashPassword } from '@/auth/password';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';

const logger = createLogger('user-routes');

export async function userRoutes(fastify: FastifyInstance) {
  const userRepo = createUserRepository();

  // Create user (admin only)
  fastify.post<{ Body: typeof createUserSchema._type }>(
    '/v1/users',
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('create', 'User')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const data = createUserSchema.parse(request.body);
        const passwordHash = await hashPassword(data.password);

        const user = await userRepo.create({
          email: data.email,
          password_hash: passwordHash,
          first_name: data.first_name,
          last_name: data.last_name,
          role: data.role,
          department_id: data.department_id,
        });

        return reply.status(201).send({
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: user.role,
          department_id: user.department_id,
          is_active: user.is_active,
          created_at: user.created_at.toISOString(),
          updated_at: user.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Create user error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // List users
  fastify.get<{ Querystring: typeof listUsersQuerySchema._type }>(
    '/v1/users',
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        await verifyAccessToken(token);

        const query = listUsersQuerySchema.parse(request.query);
        const result = await userRepo.list({
          page: query.page,
          limit: query.limit,
          role: query.role,
          department_id: query.department_id,
          is_active: query.is_active === 'true' ? true : query.is_active === 'false' ? false : undefined,
        });

        return reply.send({
          items: result.items.map((user) => ({
            id: user.id,
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            role: user.role,
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
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Get user by ID
  fastify.get<{ Params: { id: string } }>(
    '/v1/users/:id',
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        await verifyAccessToken(token);

        const user = await userRepo.findById((request.params as any).id);
        if (!user) {
          return reply.status(404).send({ error: 'User not found' });
        }

        return reply.send({
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: user.role,
          department_id: user.department_id,
          is_active: user.is_active,
          created_at: user.created_at.toISOString(),
          updated_at: user.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get user error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Update user
  fastify.patch<{ Params: { id: string }; Body: typeof updateUserSchema._type }>(
    '/v1/users/:id',
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('update', 'User')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const data = updateUserSchema.parse(request.body);
        const user = await userRepo.update((request.params as any).id, data);

        if (!user) {
          return reply.status(404).send({ error: 'User not found' });
        }

        return reply.send({
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: user.role,
          department_id: user.department_id,
          is_active: user.is_active,
          created_at: user.created_at.toISOString(),
          updated_at: user.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Update user error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Delete user (admin only)
  fastify.delete<{ Params: { id: string } }>(
    '/v1/users/:id',
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('delete', 'User')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        await userRepo.delete((request.params as any).id);
        return reply.status(204).send();
      } catch (error) {
        logger.error(error, 'Delete user error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}

