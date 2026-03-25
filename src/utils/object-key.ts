import path from 'path';
import { randomUUID } from 'crypto';

const CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/g;
const ZERO_WIDTH_REGEX = /[\u200b-\u200d\ufeff]/g;
const SAFE_EXT_REGEX = /^[a-z0-9]{1,10}$/;
const DEFAULT_FILENAME = 'file';

export const MAX_ORIGINAL_FILENAME_LENGTH = 512;
export const MAX_DISPLAY_NAME_LENGTH = 255;
export const MAX_HINT_LENGTH = 60;
export const MAX_OBJECT_KEY_LENGTH = 512;

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const stripPathSegments = (value: string) => path.posix.basename(value.replace(/\\/g, '/'));

const stripUnsafeChars = (value: string) =>
  value.replace(CONTROL_CHARS_REGEX, '').replace(ZERO_WIDTH_REGEX, '');

const truncateFilename = (name: string, maxLength: number) => {
  if (name.length <= maxLength) return name;

  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  const maxBase = Math.max(1, maxLength - ext.length);

  if (maxBase <= 1) {
    return name.slice(0, maxLength);
  }

  return `${base.slice(0, maxBase)}${ext}`;
};

export function normalizeOriginalFilename(originalName: string): string {
  const raw = typeof originalName === 'string' ? originalName : String(originalName ?? '');
  const stripped = stripPathSegments(raw);
  const normalized = stripUnsafeChars(stripped.normalize('NFKC')).replace(/[\\/]/g, '').trim();
  const value = normalized || DEFAULT_FILENAME;
  return truncateFilename(value, MAX_ORIGINAL_FILENAME_LENGTH);
}

export function normalizeDisplayName(originalName: string): string {
  const normalized = normalizeOriginalFilename(originalName);
  return truncateFilename(normalized, MAX_DISPLAY_NAME_LENGTH);
}

const safeExtensionFromName = (filename: string): string => {
  const ext = path.extname(filename).toLowerCase().replace(/^\./, '');
  return SAFE_EXT_REGEX.test(ext) ? ext : '';
};

export function inferExtensionFromMime(mimeType?: string | null): string {
  if (!mimeType) return '';
  return MIME_EXTENSION_MAP[mimeType.toLowerCase()] ?? '';
}

export function sanitizeFilenameHint(originalName: string): { hint: string; ext: string } {
  const normalized = normalizeOriginalFilename(originalName);
  const ext = safeExtensionFromName(normalized);
  const base = ext ? normalized.slice(0, -(ext.length + 1)) : normalized;

  let hint = stripUnsafeChars(base.normalize('NFKD'))
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

  if (!hint) {
    hint = DEFAULT_FILENAME;
  }

  if (hint.length > MAX_HINT_LENGTH) {
    hint = hint.slice(0, MAX_HINT_LENGTH).replace(/[-_]+$/g, '');
  }

  return { hint: hint || DEFAULT_FILENAME, ext };
}

export interface BuildObjectKeyParams {
  originalFilename: string;
  mimeType?: string | null;
  id?: string;
  now?: Date;
  prefix?: string;
}

export function buildObjectKey(params: BuildObjectKeyParams): {
  objectKey: string;
  hint: string;
  ext: string;
} {
  const date = params.now ?? new Date();
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const prefix = (params.prefix ?? `uploads/${year}/${month}/${day}`).replace(/\/+$/g, '');
  const id = params.id ?? randomUUID();
  const { hint: rawHint, ext: nameExt } = sanitizeFilenameHint(params.originalFilename);
  const inferred = inferExtensionFromMime(params.mimeType);
  const ext = nameExt || inferred || 'bin';
  const extWithDot = ext ? `.${ext}` : '';

  const basePrefixLength = prefix.length + 1 + id.length + extWithDot.length;
  let hint = rawHint;

  const maxHintLength = MAX_OBJECT_KEY_LENGTH - basePrefixLength - 1;
  if (maxHintLength < 1) {
    hint = DEFAULT_FILENAME;
  } else if (hint.length > maxHintLength) {
    hint = hint.slice(0, maxHintLength).replace(/[-_]+$/g, '') || DEFAULT_FILENAME;
  }

  const objectKey = `${prefix}/${id}_${hint}${extWithDot}`;

  if (objectKey.length > MAX_OBJECT_KEY_LENGTH) {
    return {
      objectKey: `${prefix}/${id}${extWithDot}`,
      hint,
      ext,
    };
  }

  return { objectKey, hint, ext };
}

const encodeRFC5987ValueChars = (value: string) =>
  encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function buildContentDisposition(
  originalFilename: string,
  mode: 'inline' | 'attachment' = 'inline'
): string {
  const normalized = normalizeOriginalFilename(originalFilename);
  const asciiFallback = stripUnsafeChars(
    normalized
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\x20-\x7e]/g, '')
  )
    .replace(/["\\]/g, '_')
    .trim();

  const fallback = asciiFallback || DEFAULT_FILENAME;
  const encoded = encodeRFC5987ValueChars(normalized);
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
