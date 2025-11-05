import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loginSchema, meResponseSchema } from '@/schemas/auth';
import { createUserRepository } from '@/db/repositories/user';
import { createSessionRepository } from '@/db/repositories/session';
import { verifyPassword } from '@/auth/password';
import { generateAccessToken, extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { createLogger } from '@/utils/logger';

const logger = createLogger('auth-routes');

export async function authRoutes(fastify: FastifyInstance) {
  const userRepo = createUserRepository();
  const sessionRepo = createSessionRepository();

  // Login
  fastify.post<{ Body: typeof loginSchema._type }>(
    '/v1/auth/login',
    {
      schema: {
        description: 'Login with email and password',
        tags: ['Auth'],
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { email, password } = loginSchema.parse(request.body);

        const user = await userRepo.findByEmail(email);
        if (!user) {
          return reply.status(401).send({ error: 'Invalid credentials' });
        }

        const passwordValid = await verifyPassword(password, user.password_hash);
        if (!passwordValid) {
          return reply.status(401).send({ error: 'Invalid credentials' });
        }

        if (!user.is_active) {
          return reply.status(403).send({ error: 'User account is inactive' });
        }

        const { token, jti, expiresAt } = await generateAccessToken(user.id, user.email, user.role);

        await sessionRepo.create({
          user_id: user.id,
          access_jti: jti,
          expires_at: expiresAt,
        });

        return reply.send({
          token,
          user: {
            id: user.id,
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            role: user.role,
          },
          expiresAt: expiresAt.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Login error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Logout
  fastify.post(
    '/v1/auth/logout',
    {
      schema: {
        description: 'Logout and revoke token',
        tags: ['Auth'],
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
        await sessionRepo.revokeByJti(payload.jti);

        return reply.send({ message: 'Logged out successfully' });
      } catch (error) {
        logger.error(error, 'Logout error');
        return reply.status(401).send({ error: 'Invalid token' });
      }
    }
  );

  // Get current user
  fastify.get(
    '/v1/auth/me',
    {
      schema: {
        description: 'Get current authenticated user',
        tags: ['Auth'],
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

        // Check if token is revoked
        const session = await sessionRepo.findByJti(payload.jti);
        if (!session) {
          return reply.status(401).send({ error: 'Token has been revoked' });
        }

        const user = await userRepo.findById(payload.sub);
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
        logger.error(error, 'Get me error');
        return reply.status(401).send({ error: 'Invalid token' });
      }
    }
  );
}

