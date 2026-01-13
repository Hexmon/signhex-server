import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { getDatabase, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { DEFAULT_MEDIA_SETTING_KEY, getDefaultMedia, resolveMediaUrl } from '@/utils/default-media';

const logger = createLogger('settings-routes');
const { CREATED, FORBIDDEN, NOT_FOUND, OK, UNAUTHORIZED } = HTTP_STATUS;

const upsertSettingSchema = z.object({
  key: z.string().min(1),
  value: z.any(),
});

const defaultMediaUpdateSchema = z.object({
  media_id: z.string().uuid().nullable(),
});

export async function settingsRoutes(fastify: FastifyInstance) {
  const db = getDatabase();

  const serializeMedia = (media: any, media_url: string | null) => ({
    id: media.id,
    name: media.name,
    original_filename: (media as any).original_filename ?? media.name,
    type: media.type,
    status: media.status,
    source_bucket: media.source_bucket,
    source_object_key: media.source_object_key,
    source_content_type: media.source_content_type,
    source_size: media.source_size,
    ready_object_id: media.ready_object_id,
    thumbnail_object_id: media.thumbnail_object_id,
    duration_seconds: media.duration_seconds,
    width: media.width,
    height: media.height,
    created_by: media.created_by,
    created_at: media.created_at.toISOString?.() ?? media.created_at,
    updated_at: media.updated_at.toISOString?.() ?? media.updated_at,
    media_url,
  });

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
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'OrgSettings')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

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
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'OrgSettings')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

        const data = defaultMediaUpdateSchema.parse(request.body);
        if (data.media_id === null) {
          await db.delete(schema.settings).where(eq(schema.settings.key, DEFAULT_MEDIA_SETTING_KEY));
          return reply.status(OK).send({ media_id: null, media: null });
        }

        const [media] = await db.select().from(schema.media).where(eq(schema.media.id, data.media_id));
        if (!media) {
          return reply.status(NOT_FOUND).send({ error: 'Media not found' });
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
        if (!token) return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'OrgSettings')) return reply.status(FORBIDDEN).send({ error: 'Forbidden' });

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
