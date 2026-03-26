import path from 'path';

type MediaRecord = {
  id: string;
  name: string;
  display_name?: string | null;
  type?: string | null;
  status?: string | null;
  status_reason?: string | null;
  source_bucket?: string | null;
  source_object_key?: string | null;
  source_content_type?: string | null;
  source_size?: number | null;
  source_url?: string | null;
  ready_object_id?: string | null;
  thumbnail_object_id?: string | null;
  duration_seconds?: number | null;
  width?: number | null;
  height?: number | null;
  created_by?: string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
};

type SerializeMediaOptions = {
  status?: string | null;
  status_reason?: string | null;
  content_type?: string | null;
  size?: number | null;
};

const trimToUndefined = (value?: string | null) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const humanizeMediaFilename = (filename: string) => {
  const basename = path.basename(filename).replace(/\.[^.]+$/, '');
  const normalized = basename
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || path.basename(filename);
};

export const deriveMediaDisplayName = (displayName: string | undefined | null, filename: string) =>
  trimToUndefined(displayName) ?? humanizeMediaFilename(filename);

export const sanitizeStorageFilename = (filename: string) =>
  path
    .basename(filename)
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_');

const toIso = (value?: Date | string | null) => {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
};

export const serializeMediaRecord = (
  media: MediaRecord,
  mediaUrl?: string | null,
  options?: SerializeMediaOptions
) => {
  const displayName = trimToUndefined(media.display_name) ?? media.name;
  const contentType = options?.content_type ?? media.source_content_type;
  const size = options?.size ?? media.source_size;
  const isWebpage = (media.type ?? '').toUpperCase() === 'WEBPAGE';
  const sourceUrl = trimToUndefined(media.source_url) ?? undefined;
  const fallbackMediaUrl = mediaUrl ?? null;

  return {
    id: media.id,
    name: displayName,
    display_name: displayName,
    filename: media.name,
    type: media.type ?? undefined,
    status: options?.status ?? media.status ?? undefined,
    status_reason: options?.status_reason ?? media.status_reason ?? undefined,
    content_type: contentType ?? undefined,
    source_bucket: media.source_bucket ?? undefined,
    source_object_key: media.source_object_key ?? undefined,
    source_content_type: contentType ?? undefined,
    source_size: size ?? undefined,
    source_url: sourceUrl ?? null,
    size: size ?? undefined,
    ready_object_id: media.ready_object_id ?? undefined,
    thumbnail_object_id: media.thumbnail_object_id ?? undefined,
    duration_seconds: media.duration_seconds ?? undefined,
    width: media.width ?? undefined,
    height: media.height ?? undefined,
    created_by: media.created_by ?? undefined,
    created_at: toIso(media.created_at),
    updated_at: toIso(media.updated_at),
    media_url: fallbackMediaUrl,
    fallback_media_url: isWebpage ? fallbackMediaUrl : null,
  };
};
