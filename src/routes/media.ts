import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import {
  completeUploadSchema,
  createMediaSchema,
  presignUploadSchema,
  listMediaQuerySchema,
} from '@/schemas/media';
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
import { apiEndpoints, PENDINGSTATUS } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { deleteObject } from '@/s3';
import { getDatabase, schema } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { AppError } from '@/utils/app-error';
import { config as appConfig } from '@/config';
import {
  buildContentDisposition,
  buildObjectKey,
  normalizeDisplayName,
  normalizeOriginalFilename,
} from '@/utils/object-key';
import { serializeMediaRecord } from '@/utils/media';
import {
  inferUploadMediaType,
  normalizeWebpageUrl,
  requiresDocumentConversion,
} from '@/utils/media-processing';
import {
  queueDocumentConvert,
  queueFFmpegThumbnail,
  queueFFmpegTranscode,
  queueWebpageVerifyCapture,
} from '@/jobs';

const logger = createLogger('media-routes');
const { CREATED, FORBIDDEN, OK } = HTTP_STATUS;

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

  const isObjectMissingError = (error: unknown) => {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as {
      name?: string;
      Code?: string;
      code?: string;
      $metadata?: { httpStatusCode?: number };
    };

    return (
      candidate.name === 'NotFound' ||
      candidate.Code === 'NotFound' ||
      candidate.code === 'NotFound' ||
      candidate.code === 'NoSuchKey' ||
      candidate.$metadata?.httpStatusCode === 404
    );
  };

  const resolveApiStatus = (
    media: { status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' },
    isObjectMissing: boolean
  ) => {
    if (media.status === 'READY' && isObjectMissing) {
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

  const normalizeHeadSize = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  };

  const ensureSourceStorageObject = async (params: {
    bucket: string;
    objectKey: string;
    contentType?: string | null;
    size?: number | null;
  }) => {
    const [storageObject] = await db
      .insert(schema.storageObjects)
      .values({
        bucket: params.bucket,
        object_key: params.objectKey,
        content_type: params.contentType ?? null,
        size: params.size ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.storageObjects.bucket, schema.storageObjects.object_key],
        set: {
          content_type: params.contentType ?? null,
          size: params.size ?? null,
        },
      })
      .returning();

    return storageObject;
  };

  const resolveMediaAccess = async (media: any, readyMap?: Map<string, any>) => {
    const filename = (media as any).original_filename ?? media.name ?? 'file';
    const contentDisposition = buildContentDisposition(filename, 'inline');
    let bucket: string | null = null;
    let objectKey: string | null = null;

    if (media.ready_object_id) {
      const obj =
        readyMap?.get(media.ready_object_id) ||
        (
          await db
            .select()
            .from(schema.storageObjects)
            .where(eq(schema.storageObjects.id, media.ready_object_id))
        )[0];

      if (!obj) {
        return { media_url: null, is_object_missing: true };
      }

      bucket = obj.bucket;
      objectKey = obj.object_key;
    } else if (media.source_bucket && media.source_object_key) {
      bucket = media.source_bucket;
      objectKey = media.source_object_key;
    }

    if (!bucket || !objectKey) {
      return { media_url: null, is_object_missing: media.status === 'READY' };
    }

    try {
      await headObject(bucket, objectKey);
    } catch (error) {
      if (isObjectMissingError(error)) {
        return { media_url: null, is_object_missing: true };
      }

      logger.warn(error, 'Failed to verify media object before generating media URL');
      return { media_url: null, is_object_missing: false };
    }

    try {
      return {
        media_url: await getPresignedUrl(bucket, objectKey, {
          expiresIn: 3600,
          responseContentDisposition: contentDisposition,
        }),
        is_object_missing: false,
      };
    } catch (error) {
      logger.warn(error, 'Failed to generate media URL');
      return { media_url: null, is_object_missing: false };
    }
  };

  const serializeMediaWithResolvedState = async (media: any, readyMap?: Map<string, any>) => {
    const mediaAccess = await resolveMediaAccess(media, readyMap);
    const statusState = resolveApiStatus(media, mediaAccess.is_object_missing);
    return serializeMediaRecord(media, mediaAccess.media_url, {
      status: statusState.status,
      status_reason: statusState.status_reason,
    });
  };

  const serializeCurrentMediaState = async (media: any) => {
    if (media.status !== 'READY') {
      return serializeMediaRecord(media, null, {
        status: media.status,
        status_reason: media.status_reason ?? undefined,
      });
    }

    return serializeMediaWithResolvedState(media);
  };

  const queueVideoFinalization = async (mediaId: string, sourceObjectId: string) => {
    try {
      await Promise.all([
        queueFFmpegTranscode({
          mediaId,
          sourceObjectId,
          targetFormat: 'mp4',
          quality: 'high',
        }),
        queueFFmpegThumbnail({
          mediaId,
          sourceObjectId,
        }),
      ]);
    } catch (error) {
      await mediaRepo.update(mediaId, { status: 'FAILED', status_reason: 'VIDEO_PROCESSING_QUEUE_FAILED' });
      throw AppError.internal('Failed to queue video processing jobs', {
        media_id: mediaId,
        source_object_id: sourceObjectId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const queueDocumentFinalization = async (mediaId: string, sourceObjectId: string) => {
    try {
      await queueDocumentConvert({ mediaId, sourceObjectId });
    } catch (error) {
      await mediaRepo.update(mediaId, {
        status: 'FAILED',
        status_reason: 'DOCUMENT_CONVERSION_QUEUE_FAILED',
      });
      throw AppError.internal('Failed to queue document conversion job', {
        media_id: mediaId,
        source_object_id: sourceObjectId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const queueWebpageVerification = async (mediaId: string, sourceUrl: string) => {
    try {
      await queueWebpageVerifyCapture({ mediaId, sourceUrl });
    } catch (error) {
      await mediaRepo.update(mediaId, {
        status: 'FAILED',
        status_reason: 'WEBPAGE_CAPTURE_QUEUE_FAILED',
      });
      throw AppError.internal('Failed to queue webpage verification job', {
        media_id: mediaId,
        source_url: sourceUrl,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const finalizeVerifiedUpload = async (media: any, data: typeof completeUploadSchema._type) => {
    if (!media.source_bucket || !media.source_object_key) {
      throw AppError.badRequest('Media missing source object info');
    }

    let head: any;
    try {
      head = await headObject(media.source_bucket, media.source_object_key);
    } catch (error) {
      logger.error(error, 'Head object failed');
      throw AppError.badRequest('Source object not found in storage');
    }

    const storageSize = normalizeHeadSize(head?.ContentLength);
    if (
      typeof media.source_size === 'number' &&
      typeof storageSize === 'number' &&
      media.source_size !== storageSize
    ) {
      throw AppError.badRequest('Uploaded object size does not match expected size', {
        expected_size: media.source_size,
        actual_size: storageSize,
      });
    }

    const sourceContentType = head?.ContentType ?? media.source_content_type ?? data.content_type;
    const sourceSize = storageSize ?? media.source_size ?? data.size;
    const sourceObject = await ensureSourceStorageObject({
      bucket: media.source_bucket,
      objectKey: media.source_object_key,
      contentType: sourceContentType,
      size: sourceSize,
    });

    const updateBase = {
      source_object_id: sourceObject.id,
      source_content_type: sourceContentType,
      source_size: sourceSize,
      status_reason: null,
      width: data.width ?? media.width,
      height: data.height ?? media.height,
      duration_seconds: data.duration_seconds ?? media.duration_seconds,
    };

    if (media.type === 'VIDEO') {
      const processingMedia = await mediaRepo.update(media.id, {
        ...updateBase,
        status: 'PROCESSING',
      });

      if (!processingMedia) {
        throw AppError.internal('Failed to update media processing state');
      }

      await queueVideoFinalization(processingMedia.id, sourceObject.id);
      return processingMedia;
    }

    if (
      requiresDocumentConversion({
        type: media.type,
        sourceContentType,
        filename: media.name,
        objectKey: media.source_object_key,
      })
    ) {
      const processingMedia = await mediaRepo.update(media.id, {
        ...updateBase,
        status: 'PROCESSING',
      });

      if (!processingMedia) {
        throw AppError.internal('Failed to update media processing state');
      }

      await queueDocumentFinalization(processingMedia.id, sourceObject.id);
      return processingMedia;
    }

    const readyMedia = await mediaRepo.update(media.id, {
      ...updateBase,
      status: 'READY',
    });

    if (!readyMedia) {
      throw AppError.internal('Failed to finalize media upload');
    }

    return readyMedia;
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
        const { objectKey } = buildObjectKey({
          originalFilename,
          mimeType: data.content_type,
          id: mediaId,
        });
        const bucket = 'media-source';

        const inferredType = inferUploadMediaType(data.content_type);

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
          status_reason: null,
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
        if (data.type === 'WEBPAGE') {
          const normalizedUrl = normalizeWebpageUrl(data.source_url, appConfig.NODE_ENV);
          const media = await mediaRepo.create({
            name: normalizeDisplayName(data.display_name || data.name),
            type: 'WEBPAGE',
            status: 'PROCESSING',
            status_reason: null,
            source_url: normalizedUrl,
            created_by: payload.sub,
          });

          await queueWebpageVerification(media.id, normalizedUrl);
          return reply.status(CREATED).send(await serializeCurrentMediaState(media));
        }

        const originalFilename = normalizeOriginalFilename(data.name);
        const displayName = normalizeDisplayName(originalFilename);
        const media = await mediaRepo.create({
          name: displayName,
          type: data.type,
          status: 'PENDING',
          status_reason: null,
          created_by: payload.sub,
        });

        return reply.status(CREATED).send(await serializeCurrentMediaState(media));
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
        if (query.status === 'READY') {
          const requestedOffset = (query.page - 1) * query.limit;
          const batchSize = Math.max(query.limit, 100);
          const collected: any[] = [];
          let validTotal = 0;
          let scanPage = 1;
          let hasMore = true;

          while (hasMore) {
            const batch = await mediaRepo.list({
              page: scanPage,
              limit: batchSize,
              type: query.type,
              status: query.status,
              created_by_ids: createdByIds,
            });

            hasMore = batch.items.length === batchSize;
            if (batch.items.length === 0) {
              break;
            }

            const readyIds = batch.items
              .map((m: any) => m.ready_object_id)
              .filter(Boolean) as string[];
            const readyObjects = readyIds.length
              ? await db
                  .select()
                  .from(schema.storageObjects)
                  .where(inArray(schema.storageObjects.id, readyIds as any))
              : [];
            const readyMap = new Map(readyObjects.map((o: any) => [o.id, o]));

            const resolvedBatch = await Promise.all(
              batch.items.map((m) => serializeMediaWithResolvedState(m, readyMap))
            );

            for (const item of resolvedBatch) {
              if (item.status !== 'READY') continue;

              if (validTotal >= requestedOffset && collected.length < query.limit) {
                collected.push(item);
              }
              validTotal += 1;
            }

            scanPage += 1;
          }

          return reply.send({
            items: collected,
            pagination: {
              page: query.page,
              limit: query.limit,
              total: validTotal,
            },
          });
        }

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

        const items = await Promise.all(result.items.map((m) => serializeMediaWithResolvedState(m, readyMap)));

        return reply.send({
          items,
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

        return reply.send(await serializeMediaWithResolvedState(media));
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

        if (media.status === 'READY' || media.status === 'PROCESSING') {
          return reply.send(await serializeCurrentMediaState(media));
        }

        const updated = await finalizeVerifiedUpload(media, data);
        return reply.send(await serializeCurrentMediaState(updated));
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
        const storageObjects = new Map<string, { bucket: string; key: string; id?: string }>();
        const deletedObjects: { bucket: string; key: string; success: boolean; error?: string }[] = [];

        const addStorageObject = (obj: { bucket: string; key: string; id?: string }) => {
          const mapKey = obj.id ?? `${obj.bucket}:${obj.key}`;
          storageObjects.set(mapKey, obj);
        };

        if (media.source_bucket && media.source_object_key) {
          addStorageObject({ bucket: media.source_bucket, key: media.source_object_key });
        }

        if (media.source_object_id) {
          const [obj] = await db
            .select()
            .from(schema.storageObjects)
            .where(eq(schema.storageObjects.id, media.source_object_id));
          if (obj) addStorageObject({ bucket: obj.bucket, key: obj.object_key, id: obj.id });
        }

        if (media.ready_object_id) {
          const [obj] = await db
            .select()
            .from(schema.storageObjects)
            .where(eq(schema.storageObjects.id, media.ready_object_id));
          if (obj) addStorageObject({ bucket: obj.bucket, key: obj.object_key, id: obj.id });
        }

        if (media.thumbnail_object_id) {
          const [obj] = await db
            .select()
            .from(schema.storageObjects)
            .where(eq(schema.storageObjects.id, media.thumbnail_object_id));
          if (obj) addStorageObject({ bucket: obj.bucket, key: obj.object_key, id: obj.id });
        }

        for (const obj of storageObjects.values()) {
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
        for (const obj of storageObjects.values()) {
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
          source_object_id: null as any,
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
