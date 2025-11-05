// Increase max listeners FIRST to prevent warnings from multiple modules
// This must be before any imports that might add listeners
process.setMaxListeners(20);

import 'dotenv/config';
import { loadConfig, getConfig } from '@/config';
import { initializeDatabase } from '@/db';
import { initializeS3, createBucketIfNotExists } from '@/s3';
import { createServer } from '@/server';
import { createLogger } from '@/utils/logger';
import { initializeJobs, registerJobHandlers, scheduleRecurringJobs, stopJobs } from '@/jobs';

const logger = createLogger('main');

async function main() {
  try {
    // Load configuration
    logger.info('Loading configuration...');
    loadConfig();
    const config = getConfig();

    // Initialize database
    logger.info('Initializing database...');
    await initializeDatabase();

    // Initialize S3
    logger.info('Initializing S3/MinIO...');
    initializeS3();

    // Initialize jobs
    logger.info('Initializing background jobs...');
    await initializeJobs();
    await registerJobHandlers();
    await scheduleRecurringJobs();

    // Create required buckets
    const buckets = [
      'media-source',
      'media-ready',
      'media-thumbnails',
      'device-screenshots',
      'logs-audit',
      'logs-system',
      'logs-auth',
      'logs-heartbeats',
      'logs-pop',
      'archives',
    ];

    for (const bucket of buckets) {
      logger.info(`Creating bucket: ${bucket}`);
      await createBucketIfNotExists(bucket);
    }

    // Create Fastify server
    logger.info('Creating Fastify server...');
    const fastify = await createServer();

    // Start server
    await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info(`Server listening on port ${config.PORT}`);

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully...');
      await fastify.close();
      await stopJobs();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down gracefully...');
      await fastify.close();
      await stopJobs();
      process.exit(0);
    });
  } catch (error) {
    logger.error(error, 'Fatal error during startup');
    process.exit(1);
  }
}

main();

