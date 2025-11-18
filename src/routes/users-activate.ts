import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createUserRepository } from '@/db/repositories/user';
import { hashPassword } from '@/auth/password';
import { createLogger } from '@/utils/logger';

const logger = createLogger('user-activate-route');

const activateSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export async function userActivateRoutes(fastify: FastifyInstance) {
  const userRepo = createUserRepository();

  fastify.post<{ Body: typeof activateSchema._type }>(
    '/v1/users/activate',
    {
      schema: {
        description: 'Activate invited user with token',
        tags: ['Users'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = activateSchema.parse(request.body);
        const user = await userRepo.findByInviteToken(data.token);
        if (!user) return reply.status(404).send({ error: 'Invalid or expired token' });

        const now = new Date();
        const expiresAt = user.ext?.invite_expires_at ? new Date(user.ext.invite_expires_at) : null;
        if (expiresAt && expiresAt < now) {
          return reply.status(400).send({ error: 'Invite token expired' });
        }

        const passwordHash = await hashPassword(data.password);
        const updated = await userRepo.update(user.id, {
          password_hash: passwordHash,
          ext: { ...user.ext, invite_token: null, invite_expires_at: null },
          is_active: true,
        });
        return reply.send({ success: true, user_id: updated!.id });
      } catch (error) {
        logger.error(error, 'Activate user error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
