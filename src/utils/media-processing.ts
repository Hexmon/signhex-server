import path from 'path';

export type MediaAssetType = 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'WEBPAGE';

const PDF_MIME_TYPES = new Set(['application/pdf']);

const CONVERTIBLE_DOCUMENT_MIME_TYPES = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const CONVERTIBLE_DOCUMENT_EXTENSIONS = new Set(['ppt', 'pptx', 'csv', 'doc', 'docx', 'xls', 'xlsx']);

const IMAGE_MIME_PREFIX = 'image/';
const VIDEO_MIME_PREFIX = 'video/';

const normalizeMime = (value?: string | null) => value?.split(';')[0]?.trim().toLowerCase() || null;

const getExtension = (value?: string | null) => {
  if (!value) return null;
  const base = value.split(/[\\/]/).pop() || value;
  const clean = base.split('?')[0]?.split('#')[0] || base;
  const ext = path.extname(clean).replace(/^\./, '').trim().toLowerCase();
  return ext.length > 0 ? ext : null;
};

export function inferUploadMediaType(contentType?: string | null): Exclude<MediaAssetType, 'WEBPAGE'> {
  const normalizedMime = normalizeMime(contentType);
  if (normalizedMime?.startsWith(VIDEO_MIME_PREFIX)) return 'VIDEO';
  if (normalizedMime?.startsWith(IMAGE_MIME_PREFIX)) return 'IMAGE';
  return 'DOCUMENT';
}

export function isPdfDocument(input: {
  sourceContentType?: string | null;
  filename?: string | null;
  objectKey?: string | null;
}) {
  const normalizedMime = normalizeMime(input.sourceContentType);
  if (normalizedMime && PDF_MIME_TYPES.has(normalizedMime)) {
    return true;
  }

  const extension = getExtension(input.filename) || getExtension(input.objectKey);
  return extension === 'pdf';
}

export function requiresDocumentConversion(input: {
  type?: string | null;
  sourceContentType?: string | null;
  filename?: string | null;
  objectKey?: string | null;
}) {
  if ((input.type || '').toUpperCase() !== 'DOCUMENT') {
    return false;
  }

  if (isPdfDocument(input)) {
    return false;
  }

  const normalizedMime = normalizeMime(input.sourceContentType);
  if (normalizedMime && CONVERTIBLE_DOCUMENT_MIME_TYPES.has(normalizedMime)) {
    return true;
  }

  const extension = getExtension(input.filename) || getExtension(input.objectKey);
  return extension ? CONVERTIBLE_DOCUMENT_EXTENSIONS.has(extension) : false;
}

export function isWebpageMedia(input: { type?: string | null }) {
  return (input.type || '').toUpperCase() === 'WEBPAGE';
}

export function normalizeWebpageUrl(url: string, nodeEnv: 'development' | 'production' | 'test') {
  const parsed = new URL(url);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Webpage media only supports http and https URLs.');
  }

  if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
    throw new Error('Webpage media must use https in production.');
  }

  parsed.hash = '';
  return parsed.toString();
}

export function buildSourceFilename(input: {
  fallbackName?: string | null;
  sourceObjectKey?: string | null;
  sourceContentType?: string | null;
}) {
  const objectKeyExt = getExtension(input.sourceObjectKey);
  if (objectKeyExt) {
    return `source.${objectKeyExt}`;
  }

  const normalizedMime = normalizeMime(input.sourceContentType);
  const extFromMime =
    normalizedMime === 'application/pdf'
      ? 'pdf'
      : normalizedMime === 'text/csv'
      ? 'csv'
      : normalizedMime === 'application/msword'
      ? 'doc'
      : normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ? 'docx'
      : normalizedMime === 'application/vnd.ms-powerpoint'
      ? 'ppt'
      : normalizedMime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ? 'pptx'
      : normalizedMime === 'application/vnd.ms-excel'
      ? 'xls'
      : normalizedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ? 'xlsx'
      : null;

  if (extFromMime) {
    return `source.${extFromMime}`;
  }

  const fallbackExt = getExtension(input.fallbackName);
  return fallbackExt ? `source.${fallbackExt}` : 'source.bin';
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildWebpageFallbackSvg(input: {
  sourceUrl: string;
  title?: string | null;
  statusLabel?: string | null;
}) {
  const parsed = new URL(input.sourceUrl);
  const title = (input.title?.trim() || parsed.hostname).slice(0, 120);
  const subtitle = input.statusLabel?.trim() || parsed.hostname;
  const footer = parsed.toString().slice(0, 180);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-label="Webpage preview">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#bg)"/>
  <rect x="72" y="72" width="1456" height="756" rx="32" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.16)" stroke-width="2"/>
  <circle cx="132" cy="132" r="10" fill="#fb7185"/>
  <circle cx="168" cy="132" r="10" fill="#fbbf24"/>
  <circle cx="204" cy="132" r="10" fill="#34d399"/>
  <text x="256" y="142" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="rgba(255,255,255,0.9)">${escapeXml(parsed.hostname)}</text>
  <text x="128" y="290" font-family="Helvetica, Arial, sans-serif" font-size="78" font-weight="700" fill="#ffffff">${escapeXml(title)}</text>
  <text x="128" y="372" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="rgba(255,255,255,0.75)">${escapeXml(subtitle)}</text>
  <foreignObject x="128" y="438" width="1344" height="220">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Helvetica, Arial, sans-serif; color: rgba(255,255,255,0.76); font-size: 28px; line-height: 1.45;">
      Live webpage playback uses the remote URL. This fallback preview was generated by the server so screens can still show a safe placeholder when the page cannot load.
    </div>
  </foreignObject>
  <text x="128" y="760" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="rgba(255,255,255,0.62)">${escapeXml(footer)}</text>
</svg>`;

  return Buffer.from(svg, 'utf8');
}
