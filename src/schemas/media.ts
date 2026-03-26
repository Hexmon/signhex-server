import { z } from 'zod';
import { config as appConfig } from '@/config';

const sharedMediaCreateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  display_name: z
    .string()
    .trim()
    .min(1, 'Display name is required')
    .max(255)
    .optional(),
});

export const createMediaSchema = z.union([
  sharedMediaCreateSchema.extend({
    type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
  }),
  sharedMediaCreateSchema.extend({
    type: z.literal('WEBPAGE'),
    source_url: z.string().url('A valid webpage URL is required'),
  }),
]);

export type CreateMediaRequest = z.infer<typeof createMediaSchema>;

const allowedContentTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export const presignUploadSchema = z.object({
  filename: z
    .string()
    .min(1)
    .transform((val) => val.replace(/[^\\w.\\-]+/g, '_')),
  content_type: z.enum(allowedContentTypes),
  size: z
    .number()
    .positive()
    .max(appConfig.MAX_UPLOAD_MB * 1024 * 1024, `File too large (max ${appConfig.MAX_UPLOAD_MB} MB)`),
});

export type PresignUploadRequest = z.infer<typeof presignUploadSchema>;

export const presignUploadResponseSchema = z.object({
  upload_url: z.string().url(),
  media_id: z.string().uuid(),
  expires_in: z.number(),
  bucket: z.string().optional(),
  object_key: z.string().optional(),
  original_filename: z.string().optional(),
});

export type PresignUploadResponse = z.infer<typeof presignUploadResponseSchema>;

export const completeUploadSchema = z.object({
  content_type: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_seconds: z.number().int().positive().optional(),
});

export type CompleteUploadRequest = z.infer<typeof completeUploadSchema>;

export const processMediaSchema = z.object({
  quality: z.enum(['low', 'medium', 'high']).optional().default('medium'),
});

export type ProcessMediaRequest = z.infer<typeof processMediaSchema>;

export const mediaResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT', 'WEBPAGE']),
  status: z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']),
  duration_seconds: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  created_by: z.string().uuid(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type MediaResponse = z.infer<typeof mediaResponseSchema>;

export const listMediaQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  type: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.enum(['IMAGE', 'VIDEO', 'DOCUMENT', 'WEBPAGE']).optional()
  ),
  status: z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']).optional(),
});

export type ListMediaQuery = z.infer<typeof listMediaQuerySchema>;
