import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createUserRepository } from '@/db/repositories/user';
import { hashPassword, validatePasswordStrength } from '@/auth/password';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';

const logger = createLogger('user-activate-route');
const { BAD_REQUEST, NOT_FOUND } = HTTP_STATUS;

const activateSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export async function userActivateRoutes(fastify: FastifyInstance) {
  const userRepo = createUserRepository();

  fastify.post<{ Body: typeof activateSchema._type }>(
    apiEndpoints.userActivate.activate,
    {
      schema: {
        description: 'Activate invited user with token',
        tags: ['Users'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = activateSchema.parse(request.body);
        const token = data.token.trim().toLowerCase();
        const user = await userRepo.findByInviteToken(token);
        if (!user) throw AppError.notFound('Invalid or expired token');

        const now = new Date();
        const expiresAt = user.ext?.invite_expires_at ? new Date(user.ext.invite_expires_at) : null;
        if (expiresAt && expiresAt < now) {
          throw AppError.badRequest('Invite token expired');
        }

        validatePasswordStrength(data.password);
        const passwordHash = await hashPassword(data.password);
        const updated = await userRepo.update(user.id, {
          password_hash: passwordHash,
          ext: {
            ...user.ext,
            invite_token: null,
            invite_expires_at: null,
            invite_status: 'ACTIVATED',
            activated_at: new Date().toISOString(),
          },
          is_active: true,
        });
        return reply.send({ success: true, user_id: updated!.id });
      } catch (error) {
        logger.error(error, 'Activate user error');
        return respondWithError(reply, error);
      }
    }
  );
}
