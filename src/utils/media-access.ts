import { eq } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { getPresignedUrl, headObject } from '@/s3';
import { buildContentDisposition } from '@/utils/object-key';
import { createLogger } from '@/utils/logger';

const logger = createLogger('media-access');

type MediaRecord = typeof schema.media.$inferSelect;
type StorageObjectRecord = typeof schema.storageObjects.$inferSelect;

export type ResolvedMediaAccess = {
  media_url: string | null;
  is_object_missing: boolean;
  content_type: string | null;
  source_content_type: string | null;
  size: number | null;
};

type ResolveMediaAccessOptions = {
  readyObjectMap?: Map<string, StorageObjectRecord>;
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

const normalizeHeadSize = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

async function getReadyStorageObject(
  media: MediaRecord,
  options: ResolveMediaAccessOptions,
  db = getDatabase()
) {
  if (!media.ready_object_id) {
    return null;
  }

  const cached = options.readyObjectMap?.get(media.ready_object_id);
  if (cached) {
    return cached;
  }

  const [storageObject] = await db
    .select()
    .from(schema.storageObjects)
    .where(eq(schema.storageObjects.id, media.ready_object_id));

  return storageObject ?? null;
}

export async function resolveMediaAccess(
  media: MediaRecord,
  db = getDatabase(),
  options: ResolveMediaAccessOptions = {}
): Promise<ResolvedMediaAccess> {
  const filename = (media as { original_filename?: string | null }).original_filename ?? media.name ?? 'file';
  const contentDisposition = buildContentDisposition(filename, 'inline');

  let bucket: string | null = null;
  let objectKey: string | null = null;
  let resolvedContentType: string | null = null;
  let resolvedSize: number | null = null;

  if (media.ready_object_id) {
    const readyObject = await getReadyStorageObject(media, options, db);
    if (!readyObject) {
      return {
        media_url: null,
        is_object_missing: true,
        content_type: null,
        source_content_type: media.source_content_type ?? null,
        size: null,
      };
    }

    bucket = readyObject.bucket;
    objectKey = readyObject.object_key;
    resolvedContentType = readyObject.content_type ?? null;
    resolvedSize = readyObject.size ?? null;
  } else if (media.source_bucket && media.source_object_key) {
    bucket = media.source_bucket;
    objectKey = media.source_object_key;
    resolvedContentType = media.source_content_type ?? null;
    resolvedSize = media.source_size ?? null;
  }

  if (!bucket || !objectKey) {
    return {
      media_url: null,
      is_object_missing: media.status === 'READY',
      content_type: media.ready_object_id ? resolvedContentType : media.source_content_type ?? null,
      source_content_type: media.source_content_type ?? null,
      size: resolvedSize,
    };
  }

  try {
    const head = await headObject(bucket, objectKey);
    resolvedContentType =
      resolvedContentType ??
      (typeof head?.ContentType === 'string' ? head.ContentType : null) ??
      media.source_content_type ??
      null;
    resolvedSize = resolvedSize ?? normalizeHeadSize(head?.ContentLength) ?? null;
  } catch (error) {
    if (isObjectMissingError(error)) {
      return {
        media_url: null,
        is_object_missing: true,
        content_type: resolvedContentType,
        source_content_type: media.source_content_type ?? null,
        size: resolvedSize,
      };
    }

    logger.warn(error, 'Failed to verify media object before generating media URL');
    return {
      media_url: null,
      is_object_missing: false,
      content_type: resolvedContentType,
      source_content_type: media.source_content_type ?? null,
      size: resolvedSize,
    };
  }

  try {
    const mediaUrl = await getPresignedUrl(bucket, objectKey, {
      expiresIn: 3600,
      responseContentDisposition: contentDisposition,
      responseContentType: resolvedContentType ?? undefined,
    });

    return {
      media_url: mediaUrl,
      is_object_missing: false,
      content_type: resolvedContentType,
      source_content_type: media.source_content_type ?? null,
      size: resolvedSize,
    };
  } catch (error) {
    logger.warn(error, 'Failed to generate media URL');
    return {
      media_url: null,
      is_object_missing: false,
      content_type: resolvedContentType,
      source_content_type: media.source_content_type ?? null,
      size: resolvedSize,
    };
  }
}
