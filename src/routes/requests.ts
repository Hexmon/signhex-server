import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { createRequestRepository } from '@/db/repositories/request';
import { createRequestMessageRepository } from '@/db/repositories/request-message';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { createUserRepository } from '@/db/repositories/user';
import { getDatabase, schema } from '@/db';
import { getPresignedUrl } from '@/s3';

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
  const userRepo = createUserRepository();
  const db = getDatabase();

  const resolveAttachments = async (storageIds: string[] | undefined) => {
    if (!storageIds || storageIds.length === 0) return [];
    const rows = await db
      .select()
      .from(schema.storageObjects)
      .where(inArray(schema.storageObjects.id, storageIds));
    const map = new Map(rows.map((r) => [r.id, r]));
    return Promise.all(
      storageIds.map(async (id) => {
        const r = map.get(id);
        if (!r) return { id, url: null };
        return { id: r.id, url: await getPresignedUrl(r.bucket, r.object_key, 3600) };
      })
    );
  };

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
          priority: req.priority,
          created_by: req.created_by,
          assigned_to: req.assigned_to,
          attachments: [],
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
            priority: r.priority,
            created_by: r.created_by,
            assigned_to: r.assigned_to,
            attachments: [],
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

        const attachments = await db
          .select()
          .from(schema.requestAttachments)
          .where(eq(schema.requestAttachments.request_id, req.id));
        const attachmentIds = attachments.map((a) => a.storage_object_id);
        const attachmentUrls = await resolveAttachments(attachmentIds);

        return reply.send({
          id: req.id,
          title: req.title,
          description: req.description,
          status: req.status,
          priority: req.priority,
          created_by: req.created_by,
          assigned_to: req.assigned_to,
          attachments: attachmentUrls,
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
          priority: req.priority,
          created_by: req.created_by,
          assigned_to: req.assigned_to,
          attachments: [],
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

        const author = await userRepo.findById(payload.sub);
        const attachmentUrls = await resolveAttachments(data.attachments);

        return reply.status(201).send({
          id: message.id,
          request_id: message.request_id,
          user_id: message.author_id,
          author: author
            ? {
                id: author.id,
                email: author.email,
                first_name: author.first_name,
                last_name: author.last_name,
              }
            : null,
          message: message.content,
          attachments: attachmentUrls,
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

        // Fetch authors for messages
        const authorIds = Array.from(new Set(result.items.map((m) => m.author_id))).filter(Boolean);
        const authors = authorIds.length
          ? await db.select().from(schema.users).where(inArray(schema.users.id, authorIds))
          : [];
        const authorMap = new Map(authors.map((a) => [a.id, a]));

        // Resolve attachments for all messages
        const allAttachmentIds = result.items.flatMap((m: any) => m.attachments || []);
        const attachmentUrlMap = new Map<string, { id: string; url: string }>();
        if (allAttachmentIds.length) {
          const attachmentRows = await db
            .select()
            .from(schema.storageObjects)
            .where(inArray(schema.storageObjects.id, allAttachmentIds));
          for (const row of attachmentRows) {
            attachmentUrlMap.set(row.id, {
              id: row.id,
              url: await getPresignedUrl(row.bucket, row.object_key, 3600),
            });
          }
        }

        return reply.send({
          items: result.items.map((m) => ({
            id: m.id,
            request_id: m.request_id,
            user_id: m.author_id,
            author: authorMap.get(m.author_id)
              ? {
                  id: authorMap.get(m.author_id)!.id,
                  email: authorMap.get(m.author_id)!.email,
                  first_name: authorMap.get(m.author_id)!.first_name,
                  last_name: authorMap.get(m.author_id)!.last_name,
                }
              : null,
            message: m.content,
            attachments: (m as any).attachments
              ? (m as any).attachments.map((id: string) => attachmentUrlMap.get(id) || { id, url: null })
              : [],
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
