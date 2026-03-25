import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';
import { PERMISSION_ACTIONS, PERMISSION_SUBJECTS } from '@/rbac/permissions';

const logger = createLogger('permission-routes');

export async function permissionRoutes(fastify: FastifyInstance) {
  fastify.get(
    apiEndpoints.permissions.metadata,
    {
      schema: {
        description: 'Get permissions metadata (actions + subjects)',
        tags: ['Permissions'],
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

        return reply.send({
          actions: PERMISSION_ACTIONS,
          subjects: PERMISSION_SUBJECTS,
        });
      } catch (error) {
        logger.error(error, 'Get permissions metadata error');
        return respondWithError(reply, error);
      }
    }
  );
}
