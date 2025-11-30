import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createPresentationRepository } from '@/db/repositories/presentation';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';

const logger = createLogger('presentation-routes');

const createPresentationSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
});

const listPresentationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export async function presentationRoutes(fastify: FastifyInstance) {
  const presRepo = createPresentationRepository();

  // Create presentation
  fastify.post<{ Body: typeof createPresentationSchema._type }>(
    apiEndpoints.presentations.create,
    {
      schema: {
        description: 'Create a new presentation',
        tags: ['Presentations'],
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
        const data = createPresentationSchema.parse(request.body);

        const presentation = await presRepo.create({
          ...data,
          created_by: payload.sub,
        });

        return reply.status(201).send({
          id: presentation.id,
          name: presentation.name,
          description: presentation.description,
          created_by: presentation.created_by,
          created_at: presentation.created_at.toISOString(),
          updated_at: presentation.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Create presentation error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // List presentations
  fastify.get<{ Querystring: typeof listPresentationsQuerySchema._type }>(
    apiEndpoints.presentations.list,
    {
      schema: {
        description: 'List presentations with pagination',
        tags: ['Presentations'],
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

        const query = listPresentationsQuerySchema.parse(request.query);
        const result = await presRepo.list({
          page: query.page,
          limit: query.limit,
        });

        return reply.send({
          items: result.items.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            created_by: p.created_by,
            created_at: p.created_at.toISOString(),
            updated_at: p.updated_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List presentations error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Get presentation by ID
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.presentations.get,
    {
      schema: {
        description: 'Get presentation by ID',
        tags: ['Presentations'],
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

        const presentation = await presRepo.findById((request.params as any).id);
        if (!presentation) {
          return reply.status(404).send({ error: 'Presentation not found' });
        }

        return reply.send({
          id: presentation.id,
          name: presentation.name,
          description: presentation.description,
          created_by: presentation.created_by,
          created_at: presentation.created_at.toISOString(),
          updated_at: presentation.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get presentation error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Update presentation
  fastify.patch<{ Params: { id: string }; Body: Partial<typeof createPresentationSchema._type> }>(
    apiEndpoints.presentations.update,
    {
      schema: {
        description: 'Update presentation',
        tags: ['Presentations'],
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

        const data = createPresentationSchema.partial().parse(request.body);
        const presentation = await presRepo.update((request.params as any).id, data);

        if (!presentation) {
          return reply.status(404).send({ error: 'Presentation not found' });
        }

        return reply.send({
          id: presentation.id,
          name: presentation.name,
          description: presentation.description,
          created_by: presentation.created_by,
          created_at: presentation.created_at.toISOString(),
          updated_at: presentation.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Update presentation error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Delete presentation
  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.presentations.delete,
    {
      schema: {
        description: 'Delete presentation',
        tags: ['Presentations'],
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

        await presRepo.delete((request.params as any).id);
        return reply.status(204).send();
      } catch (error) {
        logger.error(error, 'Delete presentation error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
