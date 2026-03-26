import { eq, inArray } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { resolveMediaUrl } from '@/utils/default-media';
import { serializeMediaRecord } from '@/utils/media';

export async function buildResolvedMediaMap(
  mediaIds: string[],
  db = getDatabase()
): Promise<Map<string, ReturnType<typeof serializeMediaRecord>>> {
  const uniqueIds = Array.from(new Set(mediaIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const mediaRows = await db.select().from(schema.media).where(inArray(schema.media.id, uniqueIds as any));
  const resolvedEntries = await Promise.all(
    mediaRows.map(async (media) => [media.id, serializeMediaRecord(media, await resolveMediaUrl(media, db))] as const)
  );

  return new Map(resolvedEntries);
}

function hydratePresentationEntry(entry: any, mediaMap: Map<string, ReturnType<typeof serializeMediaRecord>>) {
  if (!entry || typeof entry !== 'object') {
    return entry;
  }

  const mediaId = typeof entry.media_id === 'string' ? entry.media_id : undefined;
  const resolvedMedia = mediaId ? mediaMap.get(mediaId) : undefined;

  if (!resolvedMedia) {
    return entry;
  }

  return {
    ...entry,
    media: {
      ...(entry.media && typeof entry.media === 'object' ? entry.media : {}),
      ...resolvedMedia,
      url:
        resolvedMedia.type === 'WEBPAGE'
          ? resolvedMedia.source_url ?? null
          : resolvedMedia.media_url ?? null,
      fallback_url: resolvedMedia.fallback_media_url ?? null,
      media_type: resolvedMedia.type,
    },
  };
}

export function attachResolvedMediaToScheduleSnapshot(
  snapshot: any,
  mediaMap: Map<string, ReturnType<typeof serializeMediaRecord>>
) {
  if (!snapshot || typeof snapshot !== 'object') {
    return snapshot;
  }

  const schedule = snapshot.schedule;
  if (!schedule || typeof schedule !== 'object' || !Array.isArray(schedule.items)) {
    return snapshot;
  }

  return {
    ...snapshot,
    schedule: {
      ...schedule,
      items: schedule.items.map((item: any) => {
        if (!item || typeof item !== 'object' || !item.presentation || typeof item.presentation !== 'object') {
          return item;
        }

        return {
          ...item,
          presentation: {
            ...item.presentation,
            items: Array.isArray(item.presentation.items)
              ? item.presentation.items.map((entry: any) => hydratePresentationEntry(entry, mediaMap))
              : item.presentation.items,
            slots: Array.isArray(item.presentation.slots)
              ? item.presentation.slots.map((entry: any) => hydratePresentationEntry(entry, mediaMap))
              : item.presentation.slots,
          },
        };
      }),
    },
  };
}

export async function buildResolvedMediaUrls(
  mediaIds: string[],
  db = getDatabase()
): Promise<Record<string, string>> {
  const mediaMap = await buildResolvedMediaMap(mediaIds, db);
  const result: Record<string, string> = {};

  for (const [mediaId, media] of mediaMap.entries()) {
    const url = media.type === 'WEBPAGE' ? media.source_url : media.media_url;
    if (typeof url === 'string' && url.length > 0) {
      result[mediaId] = url;
    }
  }

  return result;
}

export async function buildResolvedMediaRecord(
  mediaId?: string | null,
  db = getDatabase()
) {
  if (!mediaId) return null;
  const [media] = await db.select().from(schema.media).where(eq(schema.media.id, mediaId)).limit(1);
  if (!media) return null;

  const serialized = serializeMediaRecord(media, await resolveMediaUrl(media, db));
  return {
    ...serialized,
    url: serialized.type === 'WEBPAGE' ? serialized.source_url ?? null : serialized.media_url ?? null,
    fallback_url: serialized.fallback_media_url ?? null,
    media_type: serialized.type,
  };
}
