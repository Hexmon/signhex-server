import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createNotificationRepository } from '@/db/repositories/notification';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';

const logger = createLogger('notification-routes');

const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  read: z.enum(['true', 'false']).optional(),
});

export async function notificationRoutes(fastify: FastifyInstance) {
  const notifRepo = createNotificationRepository();

  // List notifications for current user
  fastify.get<{ Querystring: typeof listNotificationsQuerySchema._type }>(
    apiEndpoints.notifications.list,
    {
      schema: {
        description: 'List notifications for current user',
        tags: ['Notifications'],
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
        const query = listNotificationsQuerySchema.parse(request.query);

        const result = await notifRepo.listByUser(payload.sub, {
          page: query.page,
          limit: query.limit,
          read: query.read === 'true' ? true : query.read === 'false' ? false : undefined,
        });

        return reply.send({
          items: result.items.map((n) => ({
            id: n.id,
            title: n.title,
            message: n.message,
            type: null,
            data: null,
            read: n.is_read,
            read_at: null,
            created_at: n.created_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List notifications error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Get notification by ID
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.notifications.get,
    {
      schema: {
        description: 'Get notification by ID',
        tags: ['Notifications'],
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
        const notification = await notifRepo.findById((request.params as any).id);

        if (!notification) {
          return reply.status(404).send({ error: 'Notification not found' });
        }

        // Check ownership
        if (notification.user_id !== payload.sub) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        return reply.send({
          id: notification.id,
          title: notification.title,
          message: notification.message,
          type: null,
          data: null,
          read: notification.is_read,
          read_at: null,
          created_at: notification.created_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get notification error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Mark notification as read
  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.notifications.markRead,
    {
      schema: {
        description: 'Mark notification as read',
        tags: ['Notifications'],
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
        const notification = await notifRepo.findById((request.params as any).id);

        if (!notification) {
          return reply.status(404).send({ error: 'Notification not found' });
        }

        // Check ownership
        if (notification.user_id !== payload.sub) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const updated = await notifRepo.markAsRead((request.params as any).id);

        return reply.send({
          id: updated!.id,
          title: updated!.title,
          message: updated!.message,
          type: null,
          data: null,
          read: updated!.is_read,
          read_at: null,
          created_at: updated!.created_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Mark notification as read error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Mark all notifications as read
  fastify.post(
    apiEndpoints.notifications.markAllRead,
    {
      schema: {
        description: 'Mark all notifications as read',
        tags: ['Notifications'],
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
        await notifRepo.markAllAsRead(payload.sub);

        return reply.send({ success: true });
      } catch (error) {
        logger.error(error, 'Mark all notifications as read error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Delete notification
  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.notifications.delete,
    {
      schema: {
        description: 'Delete notification',
        tags: ['Notifications'],
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
        const notification = await notifRepo.findById((request.params as any).id);

        if (!notification) {
          return reply.status(404).send({ error: 'Notification not found' });
        }

        // Check ownership
        if (notification.user_id !== payload.sub) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        await notifRepo.delete((request.params as any).id);
        return reply.status(204).send();
      } catch (error) {
        logger.error(error, 'Delete notification error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
