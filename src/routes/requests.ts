import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createRequestRepository } from '@/db/repositories/request';
import { createRequestMessageRepository } from '@/db/repositories/request-message';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';

const logger = createLogger('request-routes');

const createRequestSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  assigned_to: z.string().optional(),
});

const listRequestsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'CLOSED']).optional(),
});

const createMessageSchema = z.object({
  message: z.string().min(1),
  attachments: z.array(z.string()).optional(),
});

export async function requestRoutes(fastify: FastifyInstance) {
  const reqRepo = createRequestRepository();
  const msgRepo = createRequestMessageRepository();

  // Create request
  fastify.post<{ Body: typeof createRequestSchema._type }>(
    '/v1/requests',
    {
      schema: {
        description: 'Create a new request',
        tags: ['Requests'],
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
        const data = createRequestSchema.parse(request.body);

        const req = await reqRepo.create({
          ...data,
          status: 'OPEN',
          created_by: payload.sub,
        });

        return reply.status(201).send({
          id: req.id,
          title: req.title,
          description: req.description,
          status: req.status,
          priority: null,
          created_by: req.created_by,
          assigned_to: req.assigned_to,
          created_at: req.created_at.toISOString(),
          updated_at: req.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Create request error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // List requests
  fastify.get<{ Querystring: typeof listRequestsQuerySchema._type }>(
    '/v1/requests',
    {
      schema: {
        description: 'List requests with pagination',
        tags: ['Requests'],
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

        const query = listRequestsQuerySchema.parse(request.query);
        const result = await reqRepo.list({
          page: query.page,
          limit: query.limit,
          status: query.status,
        });

        return reply.send({
          items: result.items.map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description,
            status: r.status,
            priority: null,
            created_by: r.created_by,
            assigned_to: r.assigned_to,
            created_at: r.created_at.toISOString(),
            updated_at: r.updated_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List requests error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Get request by ID
  fastify.get<{ Params: { id: string } }>(
    '/v1/requests/:id',
    {
      schema: {
        description: 'Get request by ID',
        tags: ['Requests'],
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

        const req = await reqRepo.findById((request.params as any).id);
        if (!req) {
          return reply.status(404).send({ error: 'Request not found' });
        }

        return reply.send({
          id: req.id,
          title: req.title,
          description: req.description,
          status: req.status,
          priority: null,
          created_by: req.created_by,
          assigned_to: req.assigned_to,
          created_at: req.created_at.toISOString(),
          updated_at: req.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get request error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Update request
  fastify.patch<{ Params: { id: string }; Body: Partial<typeof createRequestSchema._type> }>(
    '/v1/requests/:id',
    {
      schema: {
        description: 'Update request',
        tags: ['Requests'],
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

        const data = createRequestSchema.partial().parse(request.body);
        const req = await reqRepo.update((request.params as any).id, data);

        if (!req) {
          return reply.status(404).send({ error: 'Request not found' });
        }

        return reply.send({
          id: req.id,
          title: req.title,
          description: req.description,
          status: req.status,
          priority: null,
          created_by: req.created_by,
          assigned_to: req.assigned_to,
          created_at: req.created_at.toISOString(),
          updated_at: req.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Update request error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Add message to request
  fastify.post<{ Params: { id: string }; Body: typeof createMessageSchema._type }>(
    '/v1/requests/:id/messages',
    {
      schema: {
        description: 'Add message to request',
        tags: ['Requests'],
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
        const data = createMessageSchema.parse(request.body);

        const message = await msgRepo.create({
          request_id: (request.params as any).id,
          user_id: payload.sub,
          message: data.message,
          attachments: data.attachments,
        });

        return reply.status(201).send({
          id: message.id,
          request_id: message.request_id,
          user_id: message.author_id,
          message: message.content,
          attachments: null,
          created_at: message.created_at.toISOString(),
          updated_at: null,
        });
      } catch (error) {
        logger.error(error, 'Add message error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // List messages for request
  fastify.get<{ Params: { id: string }; Querystring: { page?: number; limit?: number } }>(
    '/v1/requests/:id/messages',
    {
      schema: {
        description: 'List messages for request',
        tags: ['Requests'],
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

        const page = (request.query as any).page ? parseInt((request.query as any).page as string) : 1;
        const limit = (request.query as any).limit ? parseInt((request.query as any).limit as string) : 50;

        const result = await msgRepo.listByRequest((request.params as any).id, { page, limit });

        return reply.send({
          items: result.items.map((m) => ({
            id: m.id,
            request_id: m.request_id,
            user_id: m.author_id,
            message: m.content,
            attachments: null,
            created_at: m.created_at.toISOString(),
            updated_at: null,
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List messages error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}

