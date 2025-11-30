import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Server as SocketIOServer } from 'socket.io';
import { createEmergencyRepository } from '@/db/repositories/emergency';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';

const logger = createLogger('emergency-routes');
const { BAD_REQUEST, CONFLICT, CREATED, FORBIDDEN, NOT_FOUND, UNAUTHORIZED } = HTTP_STATUS;

const triggerEmergencySchema = z.object({
  message: z.string().min(1).max(1000),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH'),
});

export async function emergencyRoutes(fastify: FastifyInstance) {
  const emergencyRepo = createEmergencyRepository();
  const io: SocketIOServer =
    (fastify as any).io ??
    ((fastify as any).io = new SocketIOServer(fastify.server, {
      cors: {
        origin: true,
        credentials: true,
      },
    }));

  fastify.addHook('onClose', (_, done) => {
    io.close();
    done();
  });

  // Trigger emergency
  fastify.post<{ Body: typeof triggerEmergencySchema._type }>(
    apiEndpoints.emergency.trigger,
    {
      schema: {
        description: 'Trigger emergency alert (admin/operator only)',
        tags: ['Emergency'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('create', 'Emergency')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const data = triggerEmergencySchema.parse(request.body);

        // Check if there's already an active emergency
        const active = await emergencyRepo.getActive();
        if (active) {
          return reply.status(CONFLICT).send({ error: 'Emergency already active' });
        }

        const emergency = await emergencyRepo.create({
          triggered_by: payload.sub,
          message: data.message,
          severity: data.severity,
        });

        io.emit('emergency:triggered', {
          id: emergency.id,
          triggered_by: emergency.triggered_by,
          message: emergency.message,
          severity: emergency.priority,
          created_at: emergency.created_at.toISOString(),
        });
        logger.warn(
          {
            emergencyId: emergency.id,
            severity: emergency.priority,
            message: emergency.message,
          },
          'Emergency triggered'
        );

        return reply.status(CREATED).send({
          id: emergency.id,
          triggered_by: emergency.triggered_by,
          message: emergency.message,
          severity: emergency.priority,
          created_at: emergency.created_at.toISOString(),
          cleared_at: emergency.cleared_at?.toISOString() || null,
          cleared_by: emergency.cleared_by || null,
        });
      } catch (error) {
        logger.error(error, 'Trigger emergency error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get emergency status
  fastify.get(
    apiEndpoints.emergency.status,
    {
      schema: {
        description: 'Get current emergency status',
        tags: ['Emergency'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        await verifyAccessToken(token);

        const emergency = await emergencyRepo.getActive();

        if (!emergency) {
          return reply.send({
            active: false,
            emergency: null,
          });
        }

        return reply.send({
          active: true,
          emergency: {
            id: emergency.id,
            triggered_by: emergency.triggered_by,
            message: emergency.message,
            severity: emergency.priority,
            created_at: emergency.created_at.toISOString(),
          },
        });
      } catch (error) {
        logger.error(error, 'Get emergency status error');
        return respondWithError(reply, error);
      }
    }
  );

  // Clear emergency
  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.emergency.clear,
    {
      schema: {
        description: 'Clear emergency alert (admin only)',
        tags: ['Emergency'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('delete', 'Emergency')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const emergency = await emergencyRepo.clear((request.params as any).id, payload.sub);

        if (!emergency) {
          return reply.status(NOT_FOUND).send({ error: 'Emergency not found' });
        }

        io.emit('emergency:cleared', {
          id: emergency.id,
          triggered_by: emergency.triggered_by,
          message: emergency.message,
          severity: emergency.priority,
          created_at: emergency.created_at.toISOString(),
          cleared_at: emergency.cleared_at?.toISOString(),
          cleared_by: emergency.cleared_by,
        });
        logger.info(
          {
            emergencyId: emergency.id,
            clearedBy: payload.sub,
          },
          'Emergency cleared'
        );

        return reply.send({
          id: emergency.id,
          triggered_by: emergency.triggered_by,
          message: emergency.message,
          severity: emergency.priority,
          created_at: emergency.created_at.toISOString(),
          cleared_at: emergency.cleared_at?.toISOString(),
          cleared_by: emergency.cleared_by,
        });
      } catch (error) {
        logger.error(error, 'Clear emergency error');
        return respondWithError(reply, error);
      }
    }
  );

  // List emergency history
  fastify.get<{ Querystring: { page?: number; limit?: number } }>(
    apiEndpoints.emergency.history,
    {
      schema: {
        description: 'List emergency history (admin only)',
        tags: ['Emergency'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('read', 'Emergency')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const page = (request.query as any).page ? parseInt((request.query as any).page as string) : 1;
        const limit = (request.query as any).limit ? parseInt((request.query as any).limit as string) : 20;

        const result = await emergencyRepo.list({ page, limit });

        return reply.send({
          items: result.items.map((e) => ({
            id: e.id,
            triggered_by: e.triggered_by,
            message: e.message,
            severity: e.priority,
            created_at: e.created_at.toISOString(),
            cleared_at: e.cleared_at?.toISOString() || null,
            cleared_by: e.cleared_by || null,
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List emergency history error');
        return respondWithError(reply, error);
      }
    }
  );
}
