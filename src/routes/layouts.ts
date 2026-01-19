import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createLayoutRepository } from '@/db/repositories/layout';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';

const logger = createLogger('layout-routes');
const { BAD_REQUEST, CREATED, FORBIDDEN, NOT_FOUND, UNAUTHORIZED } = HTTP_STATUS;

const layoutSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  aspect_ratio: z.string().min(1),
  spec: z.record(z.any()),
});

const listLayoutsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  aspect_ratio: z.string().optional(),
  search: z.string().min(1).optional(),
});

export async function layoutRoutes(fastify: FastifyInstance) {
  const repo = createLayoutRepository();
  const validateLayoutSpec = (spec: any) => {
    const slots = Array.isArray(spec) ? spec : spec?.slots;
    if (!Array.isArray(slots) || slots.length === 0) {
      throw new Error('spec must be an array of slot objects or { slots: [...] }');
    }

    const seenIds = new Set<string>();
    slots.forEach((slot: any, idx: number) => {
      const id = slot.id ?? slot.slot_id;
      const coords = ['x', 'y', 'w', 'h'];
      if (!id || typeof id !== 'string') {
        throw new Error(`slot[${idx}].id is required`);
      }
      if (seenIds.has(id)) throw new Error(`duplicate slot id "${id}"`);
      seenIds.add(id);
      coords.forEach((c) => {
        const v = slot[c];
        if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`slot[${idx}].${c} must be a number`);
        if (c === 'w' || c === 'h') {
          if (v <= 0 || v > 1) throw new Error(`slot[${idx}].${c} must be between 0 and 1`);
        } else {
          if (v < 0 || v >= 1) throw new Error(`slot[${idx}].${c} must be between 0 and 1`);
        }
      });
      if (typeof slot.z !== 'undefined' && (typeof slot.z !== 'number' || Number.isNaN(slot.z))) {
        throw new Error(`slot[${idx}].z must be a number when provided`);
      }
      if (
        typeof slot.audio_enabled !== 'undefined' &&
        typeof slot.audio_enabled !== 'boolean'
      ) {
        throw new Error(`slot[${idx}].audio_enabled must be boolean when provided`);
      }
      if (slot.fit && typeof slot.fit !== 'string') {
        throw new Error(`slot[${idx}].fit must be a string when provided`);
      }
    });
  };

  // Create layout
  fastify.post<{ Body: typeof layoutSchema._type }>(
    apiEndpoints.layouts.create,
    {
      schema: {
        description: 'Create a new layout (mosaic)',
        tags: ['Layouts'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('create', 'Layout')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const data = layoutSchema.parse(request.body);
        try {
          validateLayoutSpec((data as any).spec);
        } catch (err: any) {
          return reply.status(BAD_REQUEST).send({ error: err.message || 'Invalid layout spec' });
        }
        const layout = await repo.create(data);

        return reply.status(CREATED).send({
          id: layout.id,
          name: layout.name,
          description: layout.description,
          aspect_ratio: layout.aspect_ratio,
          spec: layout.spec,
          created_at: layout.created_at.toISOString?.() ?? layout.created_at,
          updated_at: layout.updated_at.toISOString?.() ?? layout.updated_at,
        });
      } catch (error) {
        logger.error(error, 'Create layout error');
        return respondWithError(reply, error);
      }
    }
  );

  // List layouts
  fastify.get<{ Querystring: typeof listLayoutsQuerySchema._type }>(
    apiEndpoints.layouts.list,
    {
      schema: {
        description: 'List layouts',
        tags: ['Layouts'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Layout')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const query = listLayoutsQuerySchema.parse(request.query);
        const result = await repo.list({
          page: query.page,
          limit: query.limit,
          aspect_ratio: query.aspect_ratio,
          search: query.search,
        });

        return reply.send({
          items: result.items.map((l: any) => ({
            id: l.id,
            name: l.name,
            description: l.description,
            aspect_ratio: l.aspect_ratio,
            spec: l.spec,
            created_at: l.created_at.toISOString?.() ?? l.created_at,
            updated_at: l.updated_at.toISOString?.() ?? l.updated_at,
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List layouts error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get layout by ID
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.layouts.get,
    {
      schema: {
        description: 'Get layout by ID',
        tags: ['Layouts'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Layout')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const layout = await repo.findById((request.params as any).id);
        if (!layout) return reply.status(NOT_FOUND).send({ error: 'Layout not found' });

        return reply.send({
          id: layout.id,
          name: layout.name,
          description: layout.description,
          aspect_ratio: layout.aspect_ratio,
          spec: layout.spec,
          created_at: layout.created_at.toISOString?.() ?? layout.created_at,
          updated_at: layout.updated_at.toISOString?.() ?? layout.updated_at,
        });
      } catch (error) {
        logger.error(error, 'Get layout error');
        return respondWithError(reply, error);
      }
    }
  );

  // Update layout
  fastify.patch<{ Params: { id: string }; Body: Partial<typeof layoutSchema._type> }>(
    apiEndpoints.layouts.update,
    {
      schema: {
        description: 'Update layout',
        tags: ['Layouts'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'Layout')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const data = layoutSchema.partial().parse(request.body);
        if (data.spec) {
          try {
            validateLayoutSpec((data as any).spec);
          } catch (err: any) {
            return reply.status(BAD_REQUEST).send({ error: err.message || 'Invalid layout spec' });
          }
        }
        const layout = await repo.update((request.params as any).id, data);
        if (!layout) return reply.status(NOT_FOUND).send({ error: 'Layout not found' });

        return reply.send({
          id: layout.id,
          name: layout.name,
          description: layout.description,
          aspect_ratio: layout.aspect_ratio,
          spec: layout.spec,
          created_at: layout.created_at.toISOString?.() ?? layout.created_at,
          updated_at: layout.updated_at.toISOString?.() ?? layout.updated_at,
        });
      } catch (error) {
        logger.error(error, 'Update layout error');
        return respondWithError(reply, error);
      }
    }
  );

  // Delete layout
  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.layouts.delete,
    {
      schema: {
        description: 'Delete layout',
        tags: ['Layouts'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('delete', 'Layout')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const layout = await repo.findById((request.params as any).id);
        if (!layout) return reply.status(NOT_FOUND).send({ error: 'Layout not found' });

        await repo.delete(layout.id);
        return reply.status(204).send();
      } catch (error) {
        logger.error(error, 'Delete layout error');
        return respondWithError(reply, error);
      }
    }
  );
}
