import path from 'path';

type MediaRecord = {
  id: string;
  name: string;
  display_name?: string | null;
  type?: string | null;
  status?: string | null;
  source_bucket?: string | null;
  source_object_key?: string | null;
  source_content_type?: string | null;
  source_size?: number | null;
  ready_object_id?: string | null;
  thumbnail_object_id?: string | null;
  duration_seconds?: number | null;
  width?: number | null;
  height?: number | null;
  created_by?: string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
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

export const serializeMediaRecord = (media: MediaRecord, mediaUrl?: string | null) => {
  const displayName = trimToUndefined(media.display_name) ?? media.name;

  return {
    id: media.id,
    name: displayName,
    display_name: displayName,
    filename: media.name,
    type: media.type ?? undefined,
    status: media.status ?? undefined,
    source_bucket: media.source_bucket ?? undefined,
    source_object_key: media.source_object_key ?? undefined,
    source_content_type: media.source_content_type ?? undefined,
    source_size: media.source_size ?? undefined,
    ready_object_id: media.ready_object_id ?? undefined,
    thumbnail_object_id: media.thumbnail_object_id ?? undefined,
    duration_seconds: media.duration_seconds ?? undefined,
    width: media.width ?? undefined,
    height: media.height ?? undefined,
    created_by: media.created_by ?? undefined,
    created_at: toIso(media.created_at),
    updated_at: toIso(media.updated_at),
    media_url: mediaUrl ?? undefined,
  };
};
