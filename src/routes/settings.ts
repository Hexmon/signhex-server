import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { getDatabase, schema } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import {
  DEFAULT_MEDIA_SETTING_KEY,
  DEFAULT_MEDIA_VARIANTS_SETTING_KEY,
  getDefaultMedia,
  getDefaultMediaVariants,
  resolveMediaUrl,
} from '@/utils/default-media';
import { AppError } from '@/utils/app-error';
import { serializeMediaRecord } from '@/utils/media';

const logger = createLogger('settings-routes');
const { CREATED, FORBIDDEN, NOT_FOUND, OK, UNAUTHORIZED } = HTTP_STATUS;

const upsertSettingSchema = z.object({
  key: z.string().min(1),
  value: z.any(),
});

const defaultMediaUpdateSchema = z.object({
  media_id: z.string().uuid().nullable(),
});

const defaultMediaVariantsUpdateSchema = z.object({
  variants: z.record(z.string().uuid().nullable()),
});

export async function settingsRoutes(fastify: FastifyInstance) {
  const db = getDatabase();

  const serializeMedia = (media: any, media_url: string | null) => serializeMediaRecord(media, media_url);

  const serializeDefaultMediaVariants = async () => {
    const payload = await getDefaultMediaVariants(db);
    return {
      global_media_id: payload.global_media_id,
      global_media: payload.global_media
        ? serializeMedia(payload.global_media, payload.global_media_url)
        : null,
      variants: payload.variants.map((entry) => ({
        aspect_ratio: entry.aspect_ratio,
        media_id: entry.media_id,
        media: entry.media ? serializeMedia(entry.media, entry.media_url) : null,
      })),
    };
  };

  fastify.get(
    apiEndpoints.settings.list,
    {
      schema: {
        description: 'List org settings (admin only)',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'OrgSettings')) throw AppError.forbidden('Forbidden');

        const items = await db.select().from(schema.settings);
        return reply.send({ items });
      } catch (error) {
        logger.error(error, 'List settings error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.settings.defaultMedia,
    {
      schema: {
        description: 'Get default media setting (admin only)',
        tags: ['Settings'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const defaultMedia = await getDefaultMedia(db);
        if (!defaultMedia || !defaultMedia.media) {
          return reply.send({
            media_id: defaultMedia?.media_id ?? null,
            media: null,
          });
        }

        return reply.send({
          media_id: defaultMedia.media_id,
          media: serializeMedia(defaultMedia.media, defaultMedia.media_url),
        });
      } catch (error) {
        logger.error(error, 'Get default media setting error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.put<{ Body: typeof defaultMediaUpdateSchema._type }>(
    apiEndpoints.settings.defaultMedia,
    {
      schema: {
        description: 'Update default media setting (admin only)',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('update', 'OrgSettings')) throw AppError.forbidden('Forbidden');

        const data = defaultMediaUpdateSchema.parse(request.body);
        if (data.media_id === null) {
          await db.delete(schema.settings).where(eq(schema.settings.key, DEFAULT_MEDIA_SETTING_KEY));
          return reply.status(OK).send({ media_id: null, media: null });
        }

        const [media] = await db.select().from(schema.media).where(eq(schema.media.id, data.media_id));
        if (!media) {
          throw AppError.notFound('Media not found');
        }

        await db
          .insert(schema.settings)
          .values({ key: DEFAULT_MEDIA_SETTING_KEY, value: data.media_id })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: data.media_id, updated_at: new Date() },
          });

        const media_url = await resolveMediaUrl(media, db);
        return reply.status(OK).send({
          media_id: media.id,
          media: serializeMedia(media, media_url),
        });
      } catch (error) {
        logger.error(error, 'Update default media setting error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.settings.defaultMediaVariants,
    {
      schema: {
        description: 'Get default media variants by aspect ratio (admin only)',
        tags: ['Settings'],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send(await serializeDefaultMediaVariants());
      } catch (error) {
        logger.error(error, 'Get default media variants error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.put<{ Body: typeof defaultMediaVariantsUpdateSchema._type }>(
    apiEndpoints.settings.defaultMediaVariants,
    {
      schema: {
        description: 'Update default media variants by aspect ratio (admin only)',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('update', 'OrgSettings')) throw AppError.forbidden('Forbidden');

        const data = defaultMediaVariantsUpdateSchema.parse(request.body);
        const requestedIds = Array.from(
          new Set(Object.values(data.variants).filter((value): value is string => typeof value === 'string' && value.length > 0))
        );

        if (requestedIds.length > 0) {
          const medias = await db.select({ id: schema.media.id }).from(schema.media).where(inArray(schema.media.id, requestedIds as any));
          const found = new Set(medias.map((media) => media.id));
          const missing = requestedIds.find((mediaId) => !found.has(mediaId));
          if (missing) {
            throw AppError.notFound('Media not found');
          }
        }

        const normalized = Object.entries(data.variants).reduce<Record<string, string>>((acc, [aspectRatio, mediaId]) => {
          if (mediaId) {
            acc[aspectRatio.trim()] = mediaId;
          }
          return acc;
        }, {});

        if (Object.keys(normalized).length === 0) {
          await db.delete(schema.settings).where(eq(schema.settings.key, DEFAULT_MEDIA_VARIANTS_SETTING_KEY));
        } else {
          await db
            .insert(schema.settings)
            .values({ key: DEFAULT_MEDIA_VARIANTS_SETTING_KEY, value: normalized })
            .onConflictDoUpdate({
              target: schema.settings.key,
              set: { value: normalized, updated_at: new Date() },
            });
        }

        return reply.status(OK).send(await serializeDefaultMediaVariants());
      } catch (error) {
        logger.error(error, 'Update default media variants error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Body: typeof upsertSettingSchema._type }>(
    apiEndpoints.settings.upsert,
    {
      schema: {
        description: 'Upsert org setting (admin only)',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('update', 'OrgSettings')) throw AppError.forbidden('Forbidden');

        const data = upsertSettingSchema.parse(request.body);
        const [record] = await db
          .insert(schema.settings)
          .values({ key: data.key, value: data.value })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: data.value, updated_at: new Date() },
          })
          .returning();
        return reply.status(CREATED).send(record);
      } catch (error) {
        logger.error(error, 'Upsert setting error');
        return respondWithError(reply, error);
      }
    }
  );
}
