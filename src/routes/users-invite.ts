import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createUserRepository } from '@/db/repositories/user';
import { hashPassword, validatePasswordStrength, verifyPassword } from '@/auth/password';
import { randomBytes } from 'crypto';
import { createLogger } from '@/utils/logger';
import { getDatabase, schema } from '@/db';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';

const logger = createLogger('users-invite-routes');
const { BAD_REQUEST, CREATED, FORBIDDEN, NOT_FOUND, OK, UNAUTHORIZED } = HTTP_STATUS;

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'OPERATOR', 'DEPARTMENT']).default('OPERATOR'),
  department_id: z.string().uuid().optional(),
});

const listInvitesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(), // comma-separated: pending,expired,activated
  email: z.string().optional(),
  role: z.enum(['ADMIN', 'OPERATOR', 'DEPARTMENT']).optional(),
  department_id: z.string().uuid().optional(),
  invited_before: z.coerce.date().optional(),
  invited_after: z.coerce.date().optional(),
});

const resetPasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

const createInviteSerializer =
  (referenceDate: Date) =>
    (user: any) => {
      const ext = user.ext || {};
      const expiresAt = ext.invite_expires_at ? new Date(ext.invite_expires_at) : null;
      let derivedStatus: string | null = null;
      if (ext.invite_status) {
        derivedStatus = ext.invite_status;
      } else if (ext.invite_token) {
        derivedStatus = expiresAt && expiresAt < referenceDate ? 'EXPIRED' : 'PENDING';
      }

      return {
        id: user.id,
        email: user.email,
        role: user.role,
        department_id: user.department_id,
        invite_token: ext.invite_token ?? null,
        invite_expires_at: ext.invite_expires_at ?? null,
        invite_status: derivedStatus,
        invited_at: ext.invited_at ?? null,
        is_active: user.is_active,
        created_at: user.created_at.toISOString(),
        updated_at: user.updated_at.toISOString(),
      };
    };

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
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('create', 'User')) throw AppError.forbidden('Forbidden');

        const data = inviteSchema.parse(request.body);

        const [targetRole] = await db
          .select()
          .from(schema.roles)
          .where(eq(schema.roles.name, data.role));

        if (!targetRole) {
          throw AppError.badRequest(`Role '${data.role}' not found`);
        }

        const tempPassword = randomBytes(6).toString('hex');
        const inviteToken = randomBytes(16).toString('hex');
        const now = new Date();
        const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const passwordHash = await hashPassword(tempPassword);
        const user = await userRepo.create({
          email: data.email,
          password_hash: passwordHash,
          role_id: targetRole.id,
          department_id: data.department_id,
        });

        // Update with invite metadata using SQL
        await db
          .update(schema.users)
          .set({
            ext: {
              ...((user as any).ext || {}),
              invite_token: inviteToken,
              invite_expires_at: expires.toISOString(),
              invite_status: 'PENDING',
              invited_at: now.toISOString(),
            },
          })
          .where(eq(schema.users.id, user.id));

        return reply.status(CREATED).send({
          id: user.id,
          email: user.email,
          role: data.role,
          department_id: user.department_id,
          invite_token: inviteToken,
          invite_expires_at: expires.toISOString(),
          invite_status: 'PENDING',
          invited_at: now.toISOString(),
          temp_password: tempPassword,
        });
      } catch (error) {
        logger.error(error, 'Invite user error');
        return respondWithError(reply, error);
      }
    }
  );

  // List user invites with filters (admin only)
  fastify.get<{ Querystring: typeof listInvitesQuerySchema._type }>(
    apiEndpoints.userInvite.list,
    {
      schema: {
        description: 'List user invites with filters (admin only)',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'User')) throw AppError.forbidden('Forbidden');

        const query = listInvitesQuerySchema.parse(request.query);
        const statusLookup: Record<string, 'pending' | 'expired' | 'activated'> = {
          pending: 'pending',
          expired: 'expired',
          activated: 'activated',
          approved: 'activated',
          active: 'activated',
        };
        const statuses =
          query.status
            ?.split(',')
            .map((s) => statusLookup[s.trim().toLowerCase()])
            .filter(Boolean) as ('pending' | 'expired' | 'activated')[] | undefined;

        let roleId: string | undefined;
        if (query.role) {
          const [targetRole] = await db
            .select()
            .from(schema.roles)
            .where(eq(schema.roles.name, query.role));
          if (targetRole) {
            roleId = targetRole.id;
          } else {
            // If filter by role but role not found, return empty
            return reply.send({
              items: [],
              pagination: {
                page: query.page,
                limit: query.limit,
                total: 0,
              },
            });
          }
        }

        const result = await userRepo.listInvites({
          page: query.page,
          limit: query.limit,
          statuses,
          invited_before: query.invited_before,
          invited_after: query.invited_after,
          email: query.email,
          role_id: roleId,
          department_id: query.department_id,
        });

        const serializeInvite = createInviteSerializer(new Date());

        return reply.status(OK).send({
          items: result.items.map(serializeInvite),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List invites error');
        return respondWithError(reply, error);
      }
    }
  );

  // Legacy: list only pending user invites
  fastify.get(
    apiEndpoints.userInvite.pending,
    {
      schema: {
        description: 'List pending user invites (admin only)',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'User')) throw AppError.forbidden('Forbidden');

        const result = await userRepo.listInvites({
          page: 1,
          limit: 100,
          statuses: ['pending'],
        });
        const serializeInvite = createInviteSerializer(new Date());

        return reply.status(OK).send({
          items: result.items.map(serializeInvite),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List pending invites error');
        return respondWithError(reply, error);
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
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('update', 'User')) throw AppError.forbidden('Forbidden');

        const data = resetPasswordSchema.parse(request.body);
        const current = await userRepo.findById((request.params as any).id);
        if (!current) throw AppError.notFound('User not found');

        const currentMatches = await verifyPassword(data.current_password, current.password_hash);
        if (!currentMatches) {
          throw AppError.badRequest('Current password is incorrect');
        }

        validatePasswordStrength(data.new_password);
        const passwordHash = await hashPassword(data.new_password);

        const user = await userRepo.update((request.params as any).id, {
          password_hash: passwordHash,
          ext: current.ext,
        });
        if (!user) throw AppError.notFound('User not found');

        return reply.send({
          id: user.id,
          email: user.email,
          message: 'Password updated successfully',
        });
      } catch (error) {
        logger.error(error, 'Reset password error');
        return respondWithError(reply, error);
      }
    }
  );
}
