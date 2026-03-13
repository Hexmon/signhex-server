import { eq, inArray } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { getPresignedUrl } from '@/s3';
import { resolveAspectRatio } from '@/utils/aspect-ratio';

export const DEFAULT_MEDIA_SETTING_KEY = 'default_media_id';
export const DEFAULT_MEDIA_VARIANTS_SETTING_KEY = 'default_media_variants';

export type DefaultMediaSource = 'ASPECT_RATIO' | 'GLOBAL' | 'NONE';

type MediaRecord = typeof schema.media.$inferSelect;

type DefaultMediaRecord = {
  media_id: string;
  media: MediaRecord | null;
  media_url: string | null;
};

type DefaultMediaVariantsMap = Record<string, string>;

export type ResolvedDefaultMedia = {
  source: DefaultMediaSource;
  aspect_ratio: string | null;
  media_id: string | null;
  media: MediaRecord | null;
  media_url: string | null;
};

const extractDefaultMediaId = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && 'media_id' in value) {
    const candidate = (value as { media_id?: unknown }).media_id;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return null;
};

const extractDefaultMediaVariants = (value: unknown): DefaultMediaVariantsMap => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>);
  return entries.reduce<DefaultMediaVariantsMap>((acc, [aspectRatio, candidate]) => {
    const mediaId = extractDefaultMediaId(candidate);
    if (aspectRatio.trim() && mediaId) {
      acc[aspectRatio.trim()] = mediaId;
    }
    return acc;
  }, {});
};

export async function resolveMediaUrl(media: any, db = getDatabase()): Promise<string | null> {
  try {
    if (media.ready_object_id) {
      const [obj] = await db
        .select()
        .from(schema.storageObjects)
        .where(eq(schema.storageObjects.id, media.ready_object_id));
      if (obj) {
        return await getPresignedUrl(obj.bucket, obj.object_key, 3600);
      }
    }

    if (media.source_bucket && media.source_object_key) {
      return await getPresignedUrl(media.source_bucket, media.source_object_key, 3600);
    }
  } catch {
    return null;
  }

  return null;
}

async function loadMediaRecord(mediaId: string, db = getDatabase()): Promise<DefaultMediaRecord> {
  const [media] = await db.select().from(schema.media).where(eq(schema.media.id, mediaId));
  if (!media) {
    return { media_id: mediaId, media: null, media_url: null };
  }

  const media_url = await resolveMediaUrl(media, db);
  return { media_id: mediaId, media, media_url };
}

export async function getDefaultMedia(db = getDatabase()): Promise<DefaultMediaRecord | null> {
  const [setting] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, DEFAULT_MEDIA_SETTING_KEY));

  const mediaId = extractDefaultMediaId(setting?.value);
  if (!mediaId) return null;

  return await loadMediaRecord(mediaId, db);
}

export async function getDefaultMediaVariantsMap(db = getDatabase()): Promise<DefaultMediaVariantsMap> {
  const [setting] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, DEFAULT_MEDIA_VARIANTS_SETTING_KEY));

  return extractDefaultMediaVariants(setting?.value);
}

export async function getDefaultMediaVariants(db = getDatabase()): Promise<{
  global_media_id: string | null;
  global_media: MediaRecord | null;
  global_media_url: string | null;
  variants: Array<{
    aspect_ratio: string;
    media_id: string | null;
    media: MediaRecord | null;
    media_url: string | null;
  }>;
}> {
  const [globalDefault, variantsMap] = await Promise.all([
    getDefaultMedia(db),
    getDefaultMediaVariantsMap(db),
  ]);

  const variantEntries = Object.entries(variantsMap);
  if (variantEntries.length === 0) {
    return {
      global_media_id: globalDefault?.media_id ?? null,
      global_media: globalDefault?.media ?? null,
      global_media_url: globalDefault?.media_url ?? null,
      variants: [],
    };
  }

  const mediaIds = Array.from(new Set(variantEntries.map(([, mediaId]) => mediaId)));
  const mediaRows = mediaIds.length
    ? await db.select().from(schema.media).where(inArray(schema.media.id, mediaIds as any))
    : [];
  const mediaById = new Map(mediaRows.map((media) => [media.id, media]));
  const urlsById = new Map<string, string | null>();

  await Promise.all(
    mediaRows.map(async (media) => {
      urlsById.set(media.id, await resolveMediaUrl(media, db));
    })
  );

  return {
    global_media_id: globalDefault?.media_id ?? null,
    global_media: globalDefault?.media ?? null,
    global_media_url: globalDefault?.media_url ?? null,
    variants: variantEntries.map(([aspect_ratio, media_id]) => ({
      aspect_ratio,
      media_id,
      media: mediaById.get(media_id) ?? null,
      media_url: urlsById.get(media_id) ?? null,
    })),
  };
}

export async function resolveDefaultMediaForScreen(
  screen: {
    aspect_ratio?: string | null;
    width?: number | null;
    height?: number | null;
  },
  db = getDatabase()
): Promise<ResolvedDefaultMedia> {
  const aspect_ratio = resolveAspectRatio(screen);
  const [variantsMap, globalDefault] = await Promise.all([
    getDefaultMediaVariantsMap(db),
    getDefaultMedia(db),
  ]);

  const variantMediaId = aspect_ratio ? variantsMap[aspect_ratio] ?? null : null;
  if (variantMediaId) {
    const variantDefault = await loadMediaRecord(variantMediaId, db);
    if (variantDefault.media) {
      return {
        source: 'ASPECT_RATIO',
        aspect_ratio,
        media_id: variantDefault.media_id,
        media: variantDefault.media,
        media_url: variantDefault.media_url,
      };
    }
  }

  if (globalDefault?.media) {
    return {
      source: 'GLOBAL',
      aspect_ratio,
      media_id: globalDefault.media_id,
      media: globalDefault.media,
      media_url: globalDefault.media_url,
    };
  }

  return {
    source: 'NONE',
    aspect_ratio,
    media_id: globalDefault?.media_id ?? null,
    media: null,
    media_url: null,
  };
}
