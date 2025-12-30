import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import { createMediaSchema, presignUploadSchema, listMediaQuerySchema } from '@/schemas/media';
import { createMediaRepository } from '@/db/repositories/media';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { getPresignedPutUrl, createBucketIfNotExists, headObject } from '@/s3';
import { createLogger } from '@/utils/logger';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { apiEndpoints, PENDINGSTATUS } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { deleteObject } from '@/s3';
import { getDatabase, schema } from '@/db';
import { eq } from 'drizzle-orm';

const logger = createLogger('media-routes');
const { BAD_REQUEST, CREATED, FORBIDDEN, NOT_FOUND, OK, UNAUTHORIZED } = HTTP_STATUS;

const completeUploadSchema = z.object({
  status: z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']).optional().default('READY'),
  content_type: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_seconds: z.number().int().positive().optional(),
});

export async function mediaRoutes(fastify: FastifyInstance) {
  const mediaRepo = createMediaRepository();

  // Presign upload URL
  fastify.post<{ Body: typeof presignUploadSchema._type }>(
    apiEndpoints.media.presignUpload,
    {
      schema: {
        description: 'Get presigned URL for direct media upload to MinIO',
        tags: ['Media'],
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

        if (!ability.can('create', 'Media')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const data = presignUploadSchema.parse(request.body);
        const mediaId = randomUUID();
        const safeFilename = path.basename(data.filename);
        const objectKey = `${mediaId}/${safeFilename}`;
        const bucket = 'media-source';

        const inferredType = data.content_type?.startsWith('video')
          ? 'VIDEO'
          : data.content_type?.startsWith('image')
          ? 'IMAGE'
          : 'DOCUMENT';

        // Ensure bucket exists
        await createBucketIfNotExists(bucket);

        // Generate presigned URL
        const uploadUrl = await getPresignedPutUrl(bucket, objectKey, 3600);

        // Create media record
        const media = await mediaRepo.create({
          id: mediaId,
          name: data.filename,
          type: inferredType as any,
          status: PENDINGSTATUS,
          source_bucket: bucket,
          source_object_key: objectKey,
          source_content_type: data.content_type,
          source_size: data.size,
          created_by: payload.sub,
        });

        return reply.send({
          upload_url: uploadUrl,
          media_id: media.id,
          bucket,
          object_key: objectKey,
          expires_in: 3600,
        });
      } catch (error) {
        logger.error(error, 'Presign upload error');
        return respondWithError(reply, error);
      }
    }
  );

  // Create media metadata
  fastify.post<{ Body: typeof createMediaSchema._type }>(
    apiEndpoints.media.create,
    {
      schema: {
        description: 'Create media metadata',
        tags: ['Media'],
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

        if (!ability.can('create', 'Media')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const data = createMediaSchema.parse(request.body);
        const media = await mediaRepo.create({
          name: data.name,
          type: data.type,
          status: 'PENDING',
          created_by: payload.sub,
        });

        return reply.status(CREATED).send({
          id: media.id,
          name: media.name,
          type: media.type,
          status: media.status,
          created_by: media.created_by,
          created_at: media.created_at.toISOString(),
          updated_at: media.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Create media error');
        return respondWithError(reply, error);
      }
    }
  );

  // List media
  fastify.get<{ Querystring: typeof listMediaQuerySchema._type }>(
    apiEndpoints.media.list,
    {
      schema: {
        description: 'List media with pagination and filtering',
        tags: ['Media'],
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

        const query = listMediaQuerySchema.parse(request.query);
        const result = await mediaRepo.list({
          page: query.page,
          limit: query.limit,
          type: query.type,
          status: query.status,
        });

        return reply.send({
          items: result.items.map((m) => ({
            id: m.id,
            name: m.name,
            type: m.type,
            status: m.status,
            source_bucket: m.source_bucket,
            source_object_key: m.source_object_key,
            source_content_type: m.source_content_type,
            source_size: m.source_size,
            ready_object_id: m.ready_object_id,
            thumbnail_object_id: m.thumbnail_object_id,
            duration_seconds: m.duration_seconds,
            width: m.width,
            height: m.height,
            created_by: m.created_by,
            created_at: m.created_at.toISOString(),
            updated_at: m.updated_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List media error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get media by ID
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.media.get,
    {
      schema: {
        description: 'Get media by ID',
        tags: ['Media'],
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

        const mediaId = (request.params as any).id;
        const media = await mediaRepo.findById(mediaId);
        if (!media) {
          return reply.status(NOT_FOUND).send({ error: 'Media not found' });
        }

        return reply.send({
          id: media.id,
          name: media.name,
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
          created_at: media.created_at.toISOString(),
          updated_at: media.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get media error');
        return respondWithError(reply, error);
      }
    }
  );

  // Finalize upload after client PUT
  fastify.post<{ Params: { id: string }; Body: typeof completeUploadSchema._type }>(
    apiEndpoints.media.complete,
    {
      schema: {
        description: 'Finalize media upload and verify object',
        tags: ['Media'],
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
        if (!ability.can('update', 'Media')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const data = completeUploadSchema.parse(request.body);
        const media = await mediaRepo.findById((request.params as any).id);
        if (!media) {
          return reply.status(NOT_FOUND).send({ error: 'Media not found' });
        }

        if (!media.source_bucket || !media.source_object_key) {
          return reply.status(BAD_REQUEST).send({ error: 'Media missing source object info' });
        }

        let head: any;
        try {
          head = await headObject(media.source_bucket, media.source_object_key);
        } catch (err) {
          logger.error(err, 'Head object failed');
          return reply.status(BAD_REQUEST).send({ error: 'Source object not found in storage' });
        }

        const updated = await mediaRepo.update(media.id, {
          status: data.status || 'READY',
          source_content_type: data.content_type || head?.ContentType,
          source_size: data.size ?? (head?.ContentLength as number | undefined),
          width: data.width ?? media.width,
          height: data.height ?? media.height,
          duration_seconds: data.duration_seconds ?? media.duration_seconds,
          updated_at: new Date(),
        });

        return reply.send({
          id: updated!.id,
          status: updated!.status,
          source_bucket: updated!.source_bucket,
          source_object_key: updated!.source_object_key,
          source_content_type: updated!.source_content_type,
          source_size: updated!.source_size,
          width: updated!.width,
          height: updated!.height,
          duration_seconds: updated!.duration_seconds,
          updated_at: updated!.updated_at.toISOString?.() ?? updated!.updated_at,
        });
      } catch (error) {
        logger.error(error, 'Complete upload error');
        return respondWithError(reply, error);
      }
    }
  );

  // Delete media (soft by default, hard with ?hard=true)
  fastify.delete<{ Params: { id: string }; Querystring: { hard?: string } }>(
    apiEndpoints.media.delete,
    {
      schema: {
        description: 'Delete media (soft delete by default, hard delete with ?hard=true)',
        tags: ['Media'],
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
        if (!ability.can('delete', 'Media')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const media = await mediaRepo.findById((request.params as any).id);
        if (!media) {
          return reply.status(NOT_FOUND).send({ error: 'Media not found' });
        }

        const hardDelete =
          typeof (request.query as any).hard === 'string' &&
          ((request.query as any).hard as string).toLowerCase() === 'true';

        const db = getDatabase();
        const storageObjects: { bucket: string; key: string; id?: string }[] = [];
        const deletedObjects: { bucket: string; key: string; success: boolean; error?: string }[] = [];

        if (media.source_bucket && media.source_object_key) {
          storageObjects.push({ bucket: media.source_bucket, key: media.source_object_key });
        }

        if (media.ready_object_id) {
          const [obj] = await db
            .select()
            .from(schema.storageObjects)
            .where(eq(schema.storageObjects.id, media.ready_object_id));
          if (obj) storageObjects.push({ bucket: obj.bucket, key: obj.object_key, id: obj.id });
        }

        if (media.thumbnail_object_id) {
          const [obj] = await db
            .select()
            .from(schema.storageObjects)
            .where(eq(schema.storageObjects.id, media.thumbnail_object_id));
          if (obj) storageObjects.push({ bucket: obj.bucket, key: obj.object_key, id: obj.id });
        }

        for (const obj of storageObjects) {
          try {
            await deleteObject(obj.bucket, obj.key);
            deletedObjects.push({ bucket: obj.bucket, key: obj.key, success: true });
          } catch (err) {
            logger.warn(err, 'Failed to delete media object from storage');
            deletedObjects.push({
              bucket: obj.bucket,
              key: obj.key,
              success: false,
              error: (err as Error).message,
            });
          }
        }

        // Remove storage object rows for ready/thumbnail if present
        for (const obj of storageObjects) {
          if (obj.id) {
            try {
              await db.delete(schema.storageObjects).where(eq(schema.storageObjects.id, obj.id));
            } catch (err) {
              logger.warn(err, 'Failed to delete storage object row');
            }
          }
        }

        if (hardDelete) {
          await mediaRepo.delete(media.id);
          return reply.status(OK).send({
            message: 'Media hard deleted (DB row removed, storage cleaned where possible)',
            id: media.id,
            storage_deleted: deletedObjects,
          });
        }

        await mediaRepo.update(media.id, {
          status: 'FAILED',
          source_bucket: null as any,
          source_object_key: null as any,
          ready_object_id: null as any,
          thumbnail_object_id: null as any,
        });

        return reply.status(OK).send({
          message: 'Media soft deleted (DB retained, storage cleaned where possible)',
          id: media.id,
          storage_deleted: deletedObjects,
        });
      } catch (error) {
        logger.error(error, 'Delete media error');
        return respondWithError(reply, error);
      }
    }
  );
}
