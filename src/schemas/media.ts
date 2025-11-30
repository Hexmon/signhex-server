import { z } from 'zod';
import { config as appConfig } from '@/config';

export const createMediaSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
});

export type CreateMediaRequest = z.infer<typeof createMediaSchema>;

const allowedContentTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
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
});

export type PresignUploadResponse = z.infer<typeof presignUploadResponseSchema>;

export const processMediaSchema = z.object({
  quality: z.enum(['low', 'medium', 'high']).optional().default('medium'),
});

export type ProcessMediaRequest = z.infer<typeof processMediaSchema>;

export const mediaResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
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
  type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']).optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']).optional(),
});

export type ListMediaQuery = z.infer<typeof listMediaQuerySchema>;
