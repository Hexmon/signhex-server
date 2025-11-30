import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createUserRepository } from '@/db/repositories/user';
import { hashPassword } from '@/auth/password';
import { randomBytes } from 'crypto';
import { createLogger } from '@/utils/logger';
import { getDatabase, schema } from '@/db';
import { apiEndpoints } from '@/config/apiEndpoints';

const logger = createLogger('users-invite-routes');

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'OPERATOR', 'DEPARTMENT']).default('OPERATOR'),
  department_id: z.string().uuid().optional(),
});

export async function userInviteRoutes(fastify: FastifyInstance) {
  const userRepo = createUserRepository();
  const db = getDatabase();

  fastify.post<{ Body: typeof inviteSchema._type }>(
    apiEndpoints.userInvite.invite,
    {
      schema: {
        description: 'Invite user (admin only)',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('create', 'User')) return reply.status(403).send({ error: 'Forbidden' });

        const data = inviteSchema.parse(request.body);
        const tempPassword = randomBytes(6).toString('hex');
        const inviteToken = randomBytes(16).toString('hex');
        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const passwordHash = await hashPassword(tempPassword);
        const user = await userRepo.create({
          email: data.email,
          password_hash: passwordHash,
          role: data.role,
          department_id: data.department_id,
        });

        // Update with invite metadata using SQL
        await db
          .update(schema.users)
          .set({
            ext: {
              invite_token: inviteToken,
              invite_expires_at: expires.toISOString(),
            },
          })
          .where(eq(schema.users.id, user.id));

        return reply.status(201).send({
          id: user.id,
          email: user.email,
          role: user.role,
          department_id: user.department_id,
          invite_token: inviteToken,
          invite_expires_at: expires.toISOString(),
          temp_password: tempPassword,
        });
      } catch (error) {
        logger.error(error, 'Invite user error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.userInvite.resetPassword,
    {
      schema: {
        description: 'Reset user password (admin only)',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(401).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'User')) return reply.status(403).send({ error: 'Forbidden' });

        const tempPassword = randomBytes(6).toString('hex');
        const inviteToken = randomBytes(16).toString('hex');
        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const passwordHash = await hashPassword(tempPassword);
        const user = await userRepo.update((request.params as any).id, {
          password_hash: passwordHash,
          ext: {
            invite_token: inviteToken,
            invite_expires_at: expires.toISOString(),
          },
        });
        if (!user) return reply.status(404).send({ error: 'User not found' });

        return reply.send({
          id: user.id,
          email: user.email,
          temp_password: tempPassword,
        });
      } catch (error) {
        logger.error(error, 'Reset password error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
