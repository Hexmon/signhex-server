import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { loginSchema } from '@/schemas/auth';
import { createUserRepository } from '@/db/repositories/user';
import { createSessionRepository } from '@/db/repositories/session';
import { verifyPassword } from '@/auth/password';
import { generateAccessToken, extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { config as appConfig } from '@/config';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { isLockedOut, recordFailedAttempt, resetAttempts } from '@/auth/login-throttle';
import { AppError } from '@/utils/app-error';

const logger = createLogger('auth-routes');
const { BAD_REQUEST, FORBIDDEN, NOT_FOUND, TOO_MANY_REQUESTS, UNAUTHORIZED } = HTTP_STATUS;

export async function authRoutes(fastify: FastifyInstance) {
  const userRepo = createUserRepository();
  const sessionRepo = createSessionRepository();

  // Login
  fastify.post<{ Body: typeof loginSchema._type }>(
    apiEndpoints.auth.login,
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
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { email, password } = loginSchema.parse(request.body);

        const throttleKey = `${email.toLowerCase()}:${request.ip}`;
        const locked = isLockedOut(throttleKey, appConfig.LOGIN_LOCKOUT_WINDOW_SECONDS * 1000);
        if (locked.locked) {
          throw new AppError({
            statusCode: TOO_MANY_REQUESTS,
            code: 'RATE_LIMITED',
            message: 'Too many failed attempts. Try again later.',
            details: { retry_after_seconds: locked.retryAfter },
          });
        }

        const user = await userRepo.findByEmail(email);
        if (!user) {
          recordFailedAttempt(throttleKey, appConfig.LOGIN_MAX_ATTEMPTS, appConfig.LOGIN_LOCKOUT_WINDOW_SECONDS * 1000);
          throw AppError.unauthorized('Invalid credentials');
        }

        const passwordValid = await verifyPassword(password, user.password_hash);
        if (!passwordValid) {
          recordFailedAttempt(throttleKey, appConfig.LOGIN_MAX_ATTEMPTS, appConfig.LOGIN_LOCKOUT_WINDOW_SECONDS * 1000);
          throw AppError.unauthorized('Invalid credentials');
        }
        resetAttempts(throttleKey);

        const { is_active, id, role, first_name, last_name } = user || {}

        if (!is_active) {
          throw AppError.forbidden('User account is inactive');
        }

        const { token, jti, expiresAt } = await generateAccessToken(id, email, role);
        const csrfToken = randomUUID();

        await sessionRepo.create({
          user_id: id,
          access_jti: jti,
          expires_at: expiresAt,
        });

        // Issue cookies (JWT as HttpOnly, CSRF as readable token)
        const secure = appConfig.NODE_ENV !== 'development';
        const maxAge = Math.max(Math.floor((expiresAt.getTime() - Date.now()) / 1000), 0);
        const accessCookie = [
          `access_token=${token}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Lax',
          `Max-Age=${maxAge}`,
          secure ? 'Secure' : '',
        ]
          .filter(Boolean)
          .join('; ');
        const csrfCookie = [
          `csrf_token=${csrfToken}`,
          'Path=/',
          'SameSite=Lax',
          `Max-Age=${maxAge}`,
          secure ? 'Secure' : '',
        ]
          .filter(Boolean)
          .join('; ');
        reply.header('Set-Cookie', [accessCookie, csrfCookie]);

        const includeTokensInBody = appConfig.NODE_ENV === 'development';
        const responseBody: any = {
          user: {
            id: id,
            email: email,
            first_name: first_name,
            last_name: last_name,
            role: role,
          },
          expiresAt: expiresAt.toISOString(),
        };
        if (includeTokensInBody) {
          responseBody.token = token;
          responseBody.csrf_token = csrfToken;
        }

        return reply.send(responseBody);
      } catch (error) {
        logger.error(error, 'Login error');
        return respondWithError(reply, error);
      }
    }
  );

  // Logout
  fastify.post(
    apiEndpoints.auth.logout,
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
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        await sessionRepo.revokeByJti(payload.jti);

        // Clear cookies
        const secure = appConfig.NODE_ENV !== 'development';
        const expired = 'Max-Age=0; Path=/; SameSite=Lax' + (secure ? '; Secure' : '');
        reply.header('Set-Cookie', [`access_token=; ${expired}; HttpOnly`, `csrf_token=; ${expired}`]);

        return reply.send({ message: 'Logged out successfully' });
      } catch (error) {
        logger.error(error, 'Logout error');
        throw AppError.unauthorized('Invalid token');
      }
    }
  );

  // Get current user
  fastify.get(
    apiEndpoints.auth.me,
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
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);

        // Check if token is revoked
        const session = await sessionRepo.findByJti(payload.jti);
        if (!session) {
          throw AppError.unauthorized('Token has been revoked');
        }

        const user = await userRepo.findById(payload.sub);
        if (!user) {
          throw AppError.notFound('User not found');
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
        throw AppError.unauthorized('Invalid token');
      }
    }
  );
}
