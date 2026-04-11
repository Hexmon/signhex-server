import { config as appConfig } from '@/config';
import { initializeDatabase } from '@/db';
import { initializeJobs, registerJobHandlers, scheduleRecurringJobs, stopJobs } from '@/jobs';
import { initializeS3, createBucketIfNotExists } from '@/s3';
import { createServer } from '@/server';
import { createLogger } from '@/utils/logger';
import { validateRuntimeDependencies } from '@/utils/runtime-dependencies';
import { type ProcessRole } from '@/runtime/process-role';
import { clearQueuedScreenStateRefreshes } from '@/services/screen-state-refresh';

const logger = createLogger('runtime-bootstrap');

const REQUIRED_BUCKETS = [
  'media-source',
  'media-ready',
  'media-thumbnails',
  'device-screenshots',
  'logs-audit',
  'logs-system',
  'logs-auth',
  'logs-heartbeats',
  'logs-proof-of-play',
  'archives',
] as const;

type FastifyInstance = Awaited<ReturnType<typeof createServer>>;

export interface RuntimeContext {
  role: ProcessRole;
  fastify?: FastifyInstance;
}

async function ensureBuckets() {
  for (const bucket of REQUIRED_BUCKETS) {
    logger.info({ bucket }, 'Ensuring runtime bucket exists');
    await createBucketIfNotExists(bucket);
  }
}

async function initializeSharedRuntime(role: ProcessRole) {
  logger.info({ role }, 'Validating runtime dependencies');
  await validateRuntimeDependencies(role);

  logger.info({ role }, 'Initializing database');
  await initializeDatabase();

  logger.info({ role }, 'Initializing S3/MinIO client');
  initializeS3();

  logger.info({ role }, 'Initializing pg-boss client');
  await initializeJobs();

  await ensureBuckets();
}

export async function startRuntime(role: ProcessRole): Promise<RuntimeContext> {
  await initializeSharedRuntime(role);

  if (role === 'worker' || role === 'all') {
    logger.info({ role }, 'Registering background job handlers');
    await registerJobHandlers();
    await scheduleRecurringJobs();
  }

  if (role === 'api' || role === 'all') {
    logger.info({ role }, 'Creating Fastify server');
    const fastify = await createServer();
    await fastify.listen({ port: appConfig.PORT, host: appConfig.HOST });
    logger.info({ role, host: appConfig.HOST, port: appConfig.PORT, env: appConfig.NODE_ENV }, 'API runtime listening');
    return { role, fastify };
  }

  logger.info({ role }, 'Worker runtime ready');
  return { role };
}

export async function stopRuntime(context: RuntimeContext): Promise<void> {
  clearQueuedScreenStateRefreshes();
  if (context.fastify) {
    await context.fastify.close();
  }
  await stopJobs();
}
