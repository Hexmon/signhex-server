import { z } from 'zod';
import 'dotenv/config'; 

const optionalTrimmedString = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  z.string().optional()
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3000),
  DEVICE_PORT: z.coerce.number().default(8443),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY: z.coerce.number().default(900),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
  MINIO_USE_SSL: z.enum(['true', 'false']).transform((v) => v === 'true').default('false'),
  MINIO_REGION: z.string().default('us-east-1'),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(8),
  TLS_CERT_PATH: z.string().default('./certs/server.crt'),
  TLS_KEY_PATH: z.string().default('./certs/server.key'),
  CA_CERT_PATH: z.string().default('./certs/ca.crt'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  LIBREOFFICE_PATH: z.string().default('soffice'),
  PG_DUMP_PATH: z.string().default('pg_dump'),
  TAR_PATH: z.string().default('tar'),
  HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH: optionalTrimmedString,
  PG_BOSS_SCHEMA: z.string().default('pgboss'),
  RATE_LIMIT_ENABLED: z.enum(['true', 'false']).transform((v) => v === 'true').default('true'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1000),
  RATE_LIMIT_TIME_WINDOW: z.string().default('1 minute'),
  CORS_ORIGINS: z.string().default(''),
  SOCKET_ALLOWED_ORIGINS: z.string().default(''),
  APP_PUBLIC_BASE_URL: z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    },
    z.string().url().optional()
  ),
  CSRF_ENABLED: z.enum(['true', 'false']).transform((v) => v === 'true').default('true'),
  REDIS_URL: z.string().url().optional(),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(12),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_WINDOW_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(200),
  STORAGE_QUOTA_BYTES: z.coerce.number().int().nonnegative().default(0),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten());
  throw new Error('Invalid environment variables');
}

export const config = Object.freeze(parsed.data);
export type Config = typeof config;
