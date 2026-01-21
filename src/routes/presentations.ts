import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createPresentationRepository } from '@/db/repositories/presentation';
import { createPresentationItemRepository } from '@/db/repositories/presentation-item';
import { createMediaRepository } from '@/db/repositories/media';
import { createPresentationSlotItemRepository } from '@/db/repositories/presentation-slot-item';
import { createLayoutRepository } from '@/db/repositories/layout';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { getDatabase, schema } from '@/db';
import { inArray } from 'drizzle-orm';
import { AppError } from '@/utils/app-error';

const logger = createLogger('presentation-routes');
const { BAD_REQUEST, CREATED, FORBIDDEN, NOT_FOUND, NO_CONTENT, UNAUTHORIZED } = HTTP_STATUS;

const createPresentationSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  layout_id: z.string().uuid().optional(),
});

const listPresentationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const presentationItemSchema = z.object({
  media_id: z.string().uuid(),
  order: z.number().int().nonnegative().optional(),
  duration_seconds: z.number().int().positive().optional(),
});

const presentationSlotItemSchema = z.object({
  slot_id: z.string().min(1),
  media_id: z.string().uuid(),
  order: z.number().int().nonnegative().optional(),
  duration_seconds: z.number().int().positive().optional(),
  fit_mode: z.string().optional(),
  audio_enabled: z.boolean().optional(),
});

export async function presentationRoutes(fastify: FastifyInstance) {
  const presRepo = createPresentationRepository();
  const presItemRepo = createPresentationItemRepository();
  const mediaRepo = createMediaRepository();
  const slotItemRepo = createPresentationSlotItemRepository();
  const layoutRepo = createLayoutRepository();
  const db = getDatabase();

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
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const data = createPresentationSchema.parse(request.body);

        if (data.layout_id) {
          const layout = await layoutRepo.findById(data.layout_id);
          if (!layout) throw AppError.notFound('Layout not found');
        }

        const presentation = await presRepo.create({
          ...data,
          created_by: payload.sub,
        });

        return reply.status(CREATED).send({
          id: presentation.id,
          name: presentation.name,
          description: presentation.description,
          layout_id: (presentation as any).layout_id ?? null,
          created_by: presentation.created_by,
          created_at: presentation.created_at.toISOString(),
          updated_at: presentation.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Create presentation error');
        return respondWithError(reply, error);
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
          throw AppError.unauthorized('Missing authorization header');
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
        return respondWithError(reply, error);
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
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);

        const presentation = await presRepo.findById((request.params as any).id);
        if (!presentation) {
          throw AppError.notFound('Presentation not found');
        }

        let layout: any = null;
        if ((presentation as any).layout_id) {
          layout = await layoutRepo.findById((presentation as any).layout_id);
        }

        const slotItems = await slotItemRepo.listByPresentation(presentation.id);
        const mediaIds = slotItems.map((i: any) => i.media_id);
        const mediaRows = mediaIds.length
          ? await db.select().from(schema.media).where(inArray(schema.media.id, mediaIds as any))
          : [];
        const mediaMap = new Map(mediaRows.map((m) => [m.id, m]));

        return reply.send({
          id: presentation.id,
          name: presentation.name,
          description: presentation.description,
          layout: layout
            ? {
                id: layout.id,
                name: layout.name,
                description: layout.description,
                aspect_ratio: layout.aspect_ratio,
                spec: layout.spec,
              }
            : null,
          slots: slotItems.map((i: any) => ({
            id: i.id,
            slot_id: i.slot_id,
            media_id: i.media_id,
            order: i.order,
            duration_seconds: i.duration_seconds,
            fit_mode: i.fit_mode,
            audio_enabled: i.audio_enabled,
            created_at: i.created_at.toISOString?.() ?? i.created_at,
            media: mediaMap.get(i.media_id) || null,
          })),
          created_by: presentation.created_by,
          created_at: presentation.created_at.toISOString(),
          updated_at: presentation.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get presentation error');
        return respondWithError(reply, error);
      }
    }
  );

  // List presentation items
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.presentations.items,
    {
      schema: {
        description: 'List media items within a presentation',
        tags: ['Presentations'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Presentation')) throw AppError.forbidden('Forbidden');

        const presentation = await presRepo.findById((request.params as any).id);
        if (!presentation) throw AppError.notFound('Presentation not found');

        const items = await presItemRepo.listByPresentation(presentation.id);
        const mediaIds = items.map((i: any) => i.media_id);
        const db = getDatabase();
        const mediaRows = mediaIds.length
          ? await db.select().from(schema.media).where(inArray(schema.media.id, mediaIds as any))
          : [];
        const mediaMap = new Map(mediaRows.map((m) => [m.id, m]));

        return reply.send({
          items: items.map((i: any) => {
            const media = mediaMap.get(i.media_id);
            return {
              id: i.id,
              media_id: i.media_id,
              order: i.order,
              duration_seconds: i.duration_seconds,
              created_at: i.created_at.toISOString?.() ?? i.created_at,
              media: media
                ? {
                    id: media.id,
                    name: media.name,
                    type: media.type,
                    status: media.status,
                    source_bucket: media.source_bucket,
                    source_object_key: media.source_object_key,
                    ready_object_id: media.ready_object_id,
                    thumbnail_object_id: media.thumbnail_object_id,
                  }
                : null,
            };
          }),
        });
      } catch (error) {
        logger.error(error, 'List presentation items error');
        return respondWithError(reply, error);
      }
    }
  );

  // Add presentation item
  fastify.post<{ Params: { id: string }; Body: typeof presentationItemSchema._type }>(
    apiEndpoints.presentations.items,
    {
      schema: {
        description: 'Add media to a presentation playlist',
        tags: ['Presentations'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'Presentation')) throw AppError.forbidden('Forbidden');

        const presentation = await presRepo.findById((request.params as any).id);
        if (!presentation) throw AppError.notFound('Presentation not found');

        const data = presentationItemSchema.parse(request.body);

        const media = await mediaRepo.findById(data.media_id);
        if (!media) throw AppError.notFound('Media not found');

        const existing = await presItemRepo.listByPresentation(presentation.id);
        const desiredOrder =
          data.order ?? (existing.length ? Math.max(...existing.map((i: any) => i.order)) + 1 : 0);
        if (data.order !== undefined && existing.some((i: any) => i.order === desiredOrder)) {
          throw AppError.badRequest('Order already used in this presentation');
        }

        const item = await presItemRepo.create({
          presentation_id: presentation.id,
          media_id: data.media_id,
          order: desiredOrder,
          duration_seconds: data.duration_seconds,
        });

        return reply.status(CREATED).send({
          id: item.id,
          presentation_id: presentation.id,
          media_id: item.media_id,
          order: item.order,
          duration_seconds: item.duration_seconds,
          created_at: item.created_at.toISOString?.() ?? item.created_at,
          media: {
            id: media.id,
            name: media.name,
            type: media.type,
            status: media.status,
            source_bucket: media.source_bucket,
            source_object_key: media.source_object_key,
            ready_object_id: media.ready_object_id,
            thumbnail_object_id: media.thumbnail_object_id,
          },
        });
      } catch (error) {
        logger.error(error, 'Add presentation item error');
        return respondWithError(reply, error);
      }
    }
  );

  // Delete presentation item
  fastify.delete<{ Params: { id: string; itemId: string } }>(
    apiEndpoints.presentations.item,
    {
      schema: {
        description: 'Delete a media item from a presentation',
        tags: ['Presentations'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'Presentation')) throw AppError.forbidden('Forbidden');

        const presentation = await presRepo.findById((request.params as any).id);
        if (!presentation) throw AppError.notFound('Presentation not found');

        const item = await presItemRepo.findById((request.params as any).itemId);
        if (!item || item.presentation_id !== presentation.id) {
          throw AppError.notFound('Presentation item not found');
        }

        await presItemRepo.delete(item.id);
        return reply.status(NO_CONTENT).send();
      } catch (error) {
        logger.error(error, 'Delete presentation item error');
        return respondWithError(reply, error);
      }
    }
  );

  // List presentation slot items
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.presentations.slotItems,
    {
      schema: {
        description: 'List slot media items for a presentation layout',
        tags: ['Presentations'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'Presentation')) throw AppError.forbidden('Forbidden');

        const presentation = await presRepo.findById((request.params as any).id);
        if (!presentation) throw AppError.notFound('Presentation not found');

        const slots = await slotItemRepo.listByPresentation(presentation.id);
        const mediaIds = slots.map((i: any) => i.media_id);
        const mediaRows = mediaIds.length
          ? await db.select().from(schema.media).where(inArray(schema.media.id, mediaIds as any))
          : [];
        const mediaMap = new Map(mediaRows.map((m) => [m.id, m]));

        return reply.send({
          items: slots.map((i: any) => ({
            id: i.id,
            slot_id: i.slot_id,
            media_id: i.media_id,
            order: i.order,
            duration_seconds: i.duration_seconds,
            fit_mode: i.fit_mode,
            audio_enabled: i.audio_enabled,
            created_at: i.created_at.toISOString?.() ?? i.created_at,
            media: mediaMap.get(i.media_id) || null,
          })),
        });
      } catch (error) {
        logger.error(error, 'List presentation slot items error');
        return respondWithError(reply, error);
      }
    }
  );

  // Add presentation slot item
  fastify.post<{ Params: { id: string }; Body: typeof presentationSlotItemSchema._type }>(
    apiEndpoints.presentations.slotItems,
    {
      schema: {
        description: 'Add media to a presentation slot',
        tags: ['Presentations'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'Presentation')) throw AppError.forbidden('Forbidden');

        const presentation = await presRepo.findById((request.params as any).id);
        if (!presentation) throw AppError.notFound('Presentation not found');

        if (!(presentation as any).layout_id) {
          throw AppError.badRequest('Presentation has no layout assigned');
        }

        const data = presentationSlotItemSchema.parse(request.body);
        const media = await mediaRepo.findById(data.media_id);
        if (!media) throw AppError.notFound('Media not found');

        const existing = await slotItemRepo.listByPresentation(presentation.id);
        const order =
          data.order ??
          (existing.length
            ? Math.max(...existing.filter((i: any) => i.slot_id === data.slot_id).map((i: any) => i.order || 0)) + 1
            : 0);

        const item = await slotItemRepo.create({
          presentation_id: presentation.id,
          slot_id: data.slot_id,
          media_id: data.media_id,
          order,
          duration_seconds: data.duration_seconds,
          fit_mode: data.fit_mode,
          audio_enabled: data.audio_enabled,
        });

        return reply.status(CREATED).send({
          id: item.id,
          presentation_id: presentation.id,
          slot_id: item.slot_id,
          media_id: item.media_id,
          order: item.order,
          duration_seconds: item.duration_seconds,
          fit_mode: item.fit_mode,
          audio_enabled: item.audio_enabled,
          created_at: item.created_at.toISOString?.() ?? item.created_at,
          media: {
            id: media.id,
            name: media.name,
            type: media.type,
            status: media.status,
            source_bucket: media.source_bucket,
            source_object_key: media.source_object_key,
            ready_object_id: media.ready_object_id,
            thumbnail_object_id: media.thumbnail_object_id,
          },
        });
      } catch (error) {
        logger.error(error, 'Add presentation slot item error');
        return respondWithError(reply, error);
      }
    }
  );

  // Delete presentation slot item
  fastify.delete<{ Params: { id: string; slotItemId: string } }>(
    apiEndpoints.presentations.slotItem,
    {
      schema: {
        description: 'Delete a slot media item from a presentation',
        tags: ['Presentations'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'Presentation')) throw AppError.forbidden('Forbidden');

        const presentation = await presRepo.findById((request.params as any).id);
        if (!presentation) throw AppError.notFound('Presentation not found');

        const item = await slotItemRepo.findById((request.params as any).slotItemId);
        if (!item || item.presentation_id !== presentation.id) {
          throw AppError.notFound('Presentation slot item not found');
        }

        await slotItemRepo.delete(item.id);
        return reply.status(NO_CONTENT).send();
      } catch (error) {
        logger.error(error, 'Delete presentation slot item error');
        return respondWithError(reply, error);
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
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);

        const data = createPresentationSchema.partial().parse(request.body);
        if (data.layout_id) {
          const layout = await layoutRepo.findById(data.layout_id);
          if (!layout) throw AppError.notFound('Layout not found');
        }

        const presentation = await presRepo.update((request.params as any).id, data);

        if (!presentation) {
          throw AppError.notFound('Presentation not found');
        }

        return reply.send({
          id: presentation.id,
          name: presentation.name,
          description: presentation.description,
          layout_id: (presentation as any).layout_id ?? null,
          created_by: presentation.created_by,
          created_at: presentation.created_at.toISOString(),
          updated_at: presentation.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Update presentation error');
        return respondWithError(reply, error);
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
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);

        await presRepo.delete((request.params as any).id);
        return reply.status(NO_CONTENT).send();
      } catch (error) {
        logger.error(error, 'Delete presentation error');
        return respondWithError(reply, error);
      }
    }
  );
}
