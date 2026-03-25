import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import { createMediaSchema, presignUploadSchema, listMediaQuerySchema } from '@/schemas/media';
import { createMediaRepository } from '@/db/repositories/media';
import type { MediaUsageReference } from '@/db/repositories/media';
import { createUserRepository } from '@/db/repositories/user';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import {
  canAccessOwnedResource,
  canReadAdminSharedResource,
  getAdminUserIds,
  getDepartmentUserIds,
  isDepartmentScopedRole,
} from '@/rbac/policy';
import { getPresignedPutUrl, createBucketIfNotExists, headObject, getPresignedUrl } from '@/s3';
import { createLogger } from '@/utils/logger';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { apiEndpoints, PENDINGSTATUS } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { deleteObject } from '@/s3';
import { getDatabase, schema } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { AppError } from '@/utils/app-error';
import {
  buildContentDisposition,
  buildObjectKey,
  normalizeDisplayName,
  normalizeOriginalFilename,
  sanitizeFilenameHint,
} from '@/utils/object-key';
import { serializeMediaRecord } from '@/utils/media';

const logger = createLogger('media-routes');
const { CREATED, FORBIDDEN, OK } = HTTP_STATUS;

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
  const userRepo = createUserRepository();
  const db = getDatabase();

  const isDeleteBypassRole = (roleName?: string) =>
    roleName === 'ADMIN' || roleName === 'SUPER_ADMIN';

  const resolveOwnerDisplayName = (user: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
  } | null) => {
    if (!user) return 'another user';
    const fullName = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim();
    if (fullName.length > 0) return fullName;
    if (user.email) return user.email;
    return 'another user';
  };

  const mediaUsageMessageByReference: Record<MediaUsageReference, string> = {
    chat_attachments: 'Media cannot be deleted because it is still used by chat messages.',
    chat_bookmarks: 'Media cannot be deleted because it is still bookmarked in chat.',
    presentations: 'Media cannot be deleted because it is still used in presentations.',
    screens: 'Media cannot be deleted because it is currently assigned to a screen.',
    emergencies: 'Media cannot be deleted because it is used by emergency content.',
    settings: 'Media cannot be deleted because it is configured as the default media.',
    proof_of_play: 'Media cannot be deleted because it is referenced by playback history.',
  };

  const resolveApiStatus = (
    media: { status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' },
    mediaUrl: string | null
  ) => {
    if (media.status === 'READY' && !mediaUrl) {
      return {
        status: 'FAILED' as const,
        status_reason: 'MEDIA_OBJECT_MISSING' as const,
      };
    }

    return {
      status: media.status,
      status_reason: null,
    };
  };

  const resolveMediaUrl = async (media: any, readyMap?: Map<string, any>) => {
    const filename = (media as any).original_filename ?? media.name ?? 'file';
    const contentDisposition = buildContentDisposition(filename, 'inline');
    try {
      if (media.ready_object_id) {
        const obj = readyMap?.get(media.ready_object_id) ||
          (await db
            .select()
            .from(schema.storageObjects)
            .where(eq(schema.storageObjects.id, media.ready_object_id)))[0];
        if (obj) {
          return await getPresignedUrl(obj.bucket, obj.object_key, {
            expiresIn: 3600,
            responseContentDisposition: contentDisposition,
          });
        }
      }

      if (media.source_bucket && media.source_object_key) {
        return await getPresignedUrl(media.source_bucket, media.source_object_key, {
          expiresIn: 3600,
          responseContentDisposition: contentDisposition,
        });
      }
    } catch (err) {
      logger.warn(err, 'Failed to generate media URL');
    }
    return null;
  };

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
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);

        if (!ability.can('create', 'Media')) {
          throw AppError.forbidden('Forbidden');
        }

        const data = presignUploadSchema.parse(request.body);
        const mediaId = randomUUID();
        const originalFilename = normalizeOriginalFilename(data.filename);
        const displayName = normalizeDisplayName(originalFilename);
        const { objectKey, hint } = buildObjectKey({
          originalFilename,
          mimeType: data.content_type,
          id: mediaId,
        });
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
          name: displayName,
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
          original_filename: originalFilename,
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
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);

        if (!ability.can('create', 'Media')) {
          throw AppError.forbidden('Forbidden');
        }

        const data = createMediaSchema.parse(request.body);
        const originalFilename = normalizeOriginalFilename(data.name);
        const displayName = normalizeDisplayName(originalFilename);
        const { hint } = sanitizeFilenameHint(originalFilename);
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
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);

        const query = listMediaQuerySchema.parse(request.query);
        const createdByIds = isDepartmentScopedRole(payload.role)
          ? Array.from(new Set([...(await getDepartmentUserIds(payload.department_id)), ...(await getAdminUserIds())]))
          : undefined;
        const result = await mediaRepo.list({
          page: query.page,
          limit: query.limit,
          type: query.type,
          status: query.status,
          created_by_ids: createdByIds,
        });

        const readyIds = result.items.map((m: any) => m.ready_object_id).filter(Boolean) as string[];
        const readyObjects = readyIds.length
          ? await db.select().from(schema.storageObjects).where(inArray(schema.storageObjects.id, readyIds as any))
          : [];
        const readyMap = new Map(readyObjects.map((o: any) => [o.id, o]));

        const rawItems = await Promise.all(
          result.items.map(async (m) => {
            const media_url = await resolveMediaUrl(m, readyMap);
            const statusState = resolveApiStatus(m, media_url);
            return {
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
              media_url,
            };
          })
        );

        const items =
          query.status === 'READY'
            ? rawItems.filter((item) => item.status === 'READY')
            : rawItems;

        return reply.send({
          items,
          pagination: {
            page: result.page,
            limit: result.limit,
            total: query.status === 'READY' ? items.length : result.total,
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
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);

        const mediaId = (request.params as any).id;
        const media = await mediaRepo.findById(mediaId);
        if (!media) {
          throw AppError.notFound('Media not found');
        }
        const canReadMedia = await canReadAdminSharedResource(
          { userId: payload.sub, roleName: payload.role, departmentId: payload.department_id },
          media.created_by
        );
        if (!canReadMedia) throw AppError.forbidden('Forbidden');

        const media_url = await resolveMediaUrl(media);
        const statusState = resolveApiStatus(media, media_url);

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
          media_url,
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
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('update', 'Media')) {
          throw AppError.forbidden('Forbidden');
        }

        const data = completeUploadSchema.parse(request.body);
        const media = await mediaRepo.findById((request.params as any).id);
        if (!media) {
          throw AppError.notFound('Media not found');
        }
        const canUpdateMedia = await canAccessOwnedResource(
          { userId: payload.sub, roleName: payload.role, departmentId: payload.department_id },
          media.created_by
        );
        if (!canUpdateMedia) throw AppError.forbidden('Forbidden');

        if (!media.source_bucket || !media.source_object_key) {
          throw AppError.badRequest('Media missing source object info');
        }

        let head: any;
        try {
          head = await headObject(media.source_bucket, media.source_object_key);
        } catch (err) {
          logger.error(err, 'Head object failed');
          throw AppError.badRequest('Source object not found in storage');
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

        return reply.send(serializeMediaRecord(updated!));
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
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('delete', 'Media')) {
          throw AppError.forbidden('Forbidden');
        }

        const media = await mediaRepo.findById((request.params as any).id);
        if (!media) {
          throw AppError.notFound('Media not found');
        }

        const owner = media.created_by ? await userRepo.findById(media.created_by) : null;
        const canDeleteThisMedia =
          media.created_by === payload.sub || isDeleteBypassRole(payload.role);
        if (!canDeleteThisMedia) {
          throw new AppError({
            statusCode: FORBIDDEN,
            code: 'MEDIA_DELETE_FORBIDDEN_OWNER',
            message: `You can only delete media you uploaded. This media was uploaded by ${resolveOwnerDisplayName(owner)}.`,
            details: {
              owner_user_id: media.created_by,
              owner_display_name: resolveOwnerDisplayName(owner),
            },
          });
        }

        const hardDelete =
          typeof (request.query as any).hard === 'string' &&
          ((request.query as any).hard as string).toLowerCase() === 'true';

        const usageSummary = await mediaRepo.getUsageSummary(media.id);
        if (usageSummary.inUse) {
          throw new AppError({
            statusCode: 409,
            code: 'MEDIA_IN_USE',
            message:
              mediaUsageMessageByReference[usageSummary.primaryReason ?? 'chat_attachments'],
            details: {
              references: usageSummary.references,
            },
          });
        }

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
