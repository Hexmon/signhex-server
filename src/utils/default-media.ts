import { eq } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { getPresignedUrl } from '@/s3';
import { buildContentDisposition } from '@/utils/object-key';

export const DEFAULT_MEDIA_SETTING_KEY = 'default_media_id';

const extractDefaultMediaId = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && 'media_id' in value) {
    const candidate = (value as { media_id?: unknown }).media_id;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return null;
};

export async function resolveMediaUrl(media: any, db = getDatabase()): Promise<string | null> {
  const filename = media?.original_filename ?? media?.name ?? 'file';
  const contentDisposition = buildContentDisposition(filename, 'inline');
  try {
    if (media.ready_object_id) {
      const [obj] = await db
        .select()
        .from(schema.storageObjects)
        .where(eq(schema.storageObjects.id, media.ready_object_id));
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
  } catch {
    return null;
  }

  return null;
}

export async function getDefaultMedia(db = getDatabase()): Promise<{
  media_id: string;
  media: any | null;
  media_url: string | null;
} | null> {
  const [setting] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, DEFAULT_MEDIA_SETTING_KEY));

  const mediaId = extractDefaultMediaId(setting?.value);
  if (!mediaId) return null;

  const [media] = await db.select().from(schema.media).where(eq(schema.media.id, mediaId));
  if (!media) {
    return { media_id: mediaId, media: null, media_url: null };
  }

  const media_url = await resolveMediaUrl(media, db);
  return { media_id: mediaId, media, media_url };
}
