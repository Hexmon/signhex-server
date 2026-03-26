import { eq, inArray } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { resolveAspectRatio } from '@/utils/aspect-ratio';
import { resolveMediaAccess } from '@/utils/media-access';

export const DEFAULT_MEDIA_SETTING_KEY = 'default_media_id';
export const DEFAULT_MEDIA_VARIANTS_SETTING_KEY = 'default_media_variants';
export const DEFAULT_MEDIA_TARGETS_SETTING_KEY = 'default_media_targets';

export type DefaultMediaSource = 'SCREEN' | 'GROUP' | 'ASPECT_RATIO' | 'GLOBAL' | 'NONE';
export type DefaultMediaTargetType = 'SCREEN' | 'GROUP';

type MediaRecord = typeof schema.media.$inferSelect;

type DefaultMediaRecord = {
  media_id: string;
  media: MediaRecord | null;
  media_url: string | null;
};

type DefaultMediaVariantsMap = Record<string, string>;

export type DefaultMediaTargetAssignment = {
  target_type: DefaultMediaTargetType;
  target_id: string;
  media_id: string;
  aspect_ratio: string;
};

export type DefaultMediaTargetAssignmentRecord = DefaultMediaTargetAssignment & {
  media: MediaRecord | null;
  media_url: string | null;
};

export type ResolvedDefaultMedia = {
  source: DefaultMediaSource;
  aspect_ratio: string | null;
  media_id: string | null;
  media: MediaRecord | null;
  media_url: string | null;
};

const isUuidLike = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

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

const extractDefaultMediaTargets = (value: unknown): DefaultMediaTargetAssignment[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce<DefaultMediaTargetAssignment[]>((acc, entry) => {
    if (!entry || typeof entry !== 'object') {
      return acc;
    }

    const record = entry as Record<string, unknown>;
    const targetType = typeof record.target_type === 'string' ? record.target_type.trim().toUpperCase() : '';
    const targetId = typeof record.target_id === 'string' ? record.target_id.trim() : '';
    const aspectRatio = typeof record.aspect_ratio === 'string' ? record.aspect_ratio.trim() : '';
    const mediaId = extractDefaultMediaId(record.media_id ?? record);

    if (
      (targetType === 'SCREEN' || targetType === 'GROUP') &&
      targetId &&
      aspectRatio &&
      mediaId &&
      isUuidLike(targetId) &&
      isUuidLike(mediaId)
    ) {
      acc.push({
        target_type: targetType,
        target_id: targetId,
        media_id: mediaId,
        aspect_ratio: aspectRatio,
      });
    }

    return acc;
  }, []);
};

export async function resolveMediaUrl(media: any, db = getDatabase()): Promise<string | null> {
  const access = await resolveMediaAccess(media, db);
  return access.media_url;
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

export async function getDefaultMediaTargetAssignments(
  db = getDatabase()
): Promise<DefaultMediaTargetAssignmentRecord[]> {
  const [setting] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, DEFAULT_MEDIA_TARGETS_SETTING_KEY));

  const assignments = extractDefaultMediaTargets(setting?.value);
  if (assignments.length === 0) {
    return [];
  }

  const mediaIds = Array.from(new Set(assignments.map((assignment) => assignment.media_id)));
  const mediaRows = await db.select().from(schema.media).where(inArray(schema.media.id, mediaIds as any));
  const mediaById = new Map(mediaRows.map((media) => [media.id, media]));
  const urlsById = new Map<string, string | null>();

  await Promise.all(
    mediaRows.map(async (media) => {
      urlsById.set(media.id, await resolveMediaUrl(media, db));
    })
  );

  return assignments.map((assignment) => ({
    ...assignment,
    media: mediaById.get(assignment.media_id) ?? null,
    media_url: urlsById.get(assignment.media_id) ?? null,
  }));
}

export async function pruneDefaultMediaTargetsForScreen(
  screenId: string,
  db = getDatabase()
): Promise<number> {
  const [setting] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, DEFAULT_MEDIA_TARGETS_SETTING_KEY));

  if (!setting) {
    return 0;
  }

  const assignments = extractDefaultMediaTargets(setting.value);
  if (assignments.length === 0) {
    return 0;
  }

  const nextAssignments = assignments.filter(
    (assignment) => !(assignment.target_type === 'SCREEN' && assignment.target_id === screenId)
  );

  const removedCount = assignments.length - nextAssignments.length;
  if (removedCount === 0) {
    return 0;
  }

  await db
    .update(schema.settings)
    .set({
      value: nextAssignments,
      updated_at: new Date(),
    })
    .where(eq(schema.settings.key, DEFAULT_MEDIA_TARGETS_SETTING_KEY));

  return removedCount;
}

export async function resolveDefaultMediaForScreen(
  screen: {
    id?: string | null;
    aspect_ratio?: string | null;
    width?: number | null;
    height?: number | null;
  },
  db = getDatabase()
): Promise<ResolvedDefaultMedia> {
  const aspect_ratio = resolveAspectRatio(screen);
  const screenId = screen.id ?? null;

  if (screenId) {
    const assignments = await getDefaultMediaTargetAssignments(db);
    const matchingAssignments = assignments.filter(
      (assignment) => assignment.aspect_ratio === aspect_ratio && assignment.media
    );

    const screenAssignment = matchingAssignments.find(
      (assignment) => assignment.target_type === 'SCREEN' && assignment.target_id === screenId
    );
    if (screenAssignment?.media) {
      return {
        source: 'SCREEN',
        aspect_ratio,
        media_id: screenAssignment.media_id,
        media: screenAssignment.media,
        media_url: screenAssignment.media_url,
      };
    }

    const memberships = await db
      .select({ group_id: schema.screenGroupMembers.group_id })
      .from(schema.screenGroupMembers)
      .where(eq(schema.screenGroupMembers.screen_id, screenId));
    const groupIds = new Set(memberships.map((membership) => membership.group_id));

    const groupAssignment = matchingAssignments.find(
      (assignment) => assignment.target_type === 'GROUP' && groupIds.has(assignment.target_id)
    );
    if (groupAssignment?.media) {
      return {
        source: 'GROUP',
        aspect_ratio,
        media_id: groupAssignment.media_id,
        media: groupAssignment.media,
        media_url: groupAssignment.media_url,
      };
    }
  }

  if (aspect_ratio) {
    const variants = await getDefaultMediaVariantsMap(db);
    const aspectMediaId = variants[aspect_ratio];

    if (aspectMediaId) {
      const aspectMedia = await loadMediaRecord(aspectMediaId, db);
      if (aspectMedia.media) {
        return {
          source: 'ASPECT_RATIO',
          aspect_ratio,
          media_id: aspectMedia.media_id,
          media: aspectMedia.media,
          media_url: aspectMedia.media_url,
        };
      }
    }
  }

  const globalDefault = await getDefaultMedia(db);
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
    media_id: null,
    media: null,
    media_url: null,
  };
}
