import PgBoss from 'pg-boss';
import { getConfig } from '@/config';
import { createLogger } from '@/utils/logger';

const logger = createLogger('jobs');

let boss: PgBoss | null = null;

export async function initializeJobs(): Promise<PgBoss> {
  if (boss) {
    return boss;
  }

  const config = getConfig();

  boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: 'pgboss',
    archiveCompletedAfterSeconds: 60 * 60 * 24 * 7, // 7 days
    deleteAfterDays: 30, // 30 days
  });

  boss.on('error', (error) => {
    logger.error(error, 'pg-boss error');
  });

  await boss.start();
  logger.info('pg-boss initialized');

  return boss;
}

export function getJobs(): PgBoss {
  if (!boss) {
    throw new Error('Jobs not initialized. Call initializeJobs() first.');
  }
  return boss;
}

export async function stopJobs(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
    logger.info('pg-boss stopped');
  }
}

// Job types
export interface FFmpegTranscodeJob {
  mediaId: string;
  sourceObjectId: string;
  targetFormat: 'mp4' | 'webm' | 'hls';
  quality: 'low' | 'medium' | 'high';
}

export interface FFmpegThumbnailJob {
  mediaId: string;
  sourceObjectId: string;
  timestamp?: number; // seconds
}

export interface ArchiveJob {
  type: 'logs' | 'media' | 'full';
  startDate: string;
  endDate: string;
}

export interface CleanupJob {
  type: 'expired_sessions' | 'old_logs' | 'orphaned_objects';
}

// Job queue functions
export async function queueFFmpegTranscode(job: FFmpegTranscodeJob, options?: any) {
  const jobs = getJobs();
  return jobs.send('ffmpeg:transcode', job, {
    retryLimit: 3,
    retryDelay: 60,
    ...options,
  });
}

export async function queueFFmpegThumbnail(job: FFmpegThumbnailJob, options?: any) {
  const jobs = getJobs();
  return jobs.send('ffmpeg:thumbnail', job, {
    retryLimit: 3,
    retryDelay: 60,
    ...options,
  });
}

export async function queueArchive(job: ArchiveJob, options?: any) {
  const jobs = getJobs();
  return jobs.send('archive', job, {
    retryLimit: 2,
    retryDelay: 300,
    ...options,
  });
}

export async function queueCleanup(job: CleanupJob, options?: any) {
  const jobs = getJobs();
  return jobs.send('cleanup', job, {
    retryLimit: 1,
    ...options,
  });
}

// Job handlers registration
export async function registerJobHandlers() {
  const jobs = getJobs();

  // FFmpeg transcode handler
  await jobs.work<FFmpegTranscodeJob>('ffmpeg:transcode', async (jobBatch) => {
    for (const job of jobBatch) {
      logger.info(`Processing transcode job: ${job.data.mediaId}`);
      // TODO: Implement FFmpeg transcoding
      // - Download source from MinIO
      // - Run FFmpeg
      // - Upload result to MinIO
      // - Update media record
    }
  });

  // FFmpeg thumbnail handler
  await jobs.work<FFmpegThumbnailJob>('ffmpeg:thumbnail', async (jobBatch) => {
    for (const job of jobBatch) {
      logger.info(`Processing thumbnail job: ${job.data.mediaId}`);
      // TODO: Implement FFmpeg thumbnail generation
      // - Download source from MinIO
      // - Generate thumbnail
      // - Upload to MinIO
      // - Update media record
    }
  });

  // Archive handler
  await jobs.work<ArchiveJob>('archive', async (jobBatch) => {
    for (const job of jobBatch) {
      logger.info(`Processing archive job: ${job.data.type}`);
      // TODO: Implement archival
      // - Query data from database
      // - Generate Parquet/NDJSON
      // - Upload to MinIO
      // - Create archive record
    }
  });

  // Cleanup handler
  await jobs.work<CleanupJob>('cleanup', async (jobBatch) => {
    for (const job of jobBatch) {
      logger.info(`Processing cleanup job: ${job.data.type}`);
      // TODO: Implement cleanup
      // - Delete expired sessions
      // - Archive old logs
      // - Remove orphaned objects
    }
  });

  logger.info('Job handlers registered');
}

// Scheduled jobs
export async function scheduleRecurringJobs() {
  const jobs = getJobs();

  try {
    // pg-boss requires queues to exist in the database before scheduling
    // We need to create the queues first by sending a job to each queue
    // This will create the queue entry in pgboss.queue table

    // Create cleanup queue by sending a job (will be processed immediately or soon)
    const cleanupJobId = await jobs.send('cleanup', { type: 'expired_sessions' });
    logger.info(`Created cleanup queue with initial job: ${cleanupJobId}`);

    // Create archive queue by sending a job
    const archiveJobId = await jobs.send('archive', { type: 'logs', startDate: '', endDate: '' });
    logger.info(`Created archive queue with initial job: ${archiveJobId}`);

    // Wait a bit for pg-boss to process and create queue entries
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Now schedule recurring jobs (queues should exist now)
    // Daily cleanup at 2 AM
    await jobs.unschedule('cleanup').catch(() => {}); // Remove any existing schedule
    await jobs.schedule('cleanup', '0 2 * * *', { type: 'expired_sessions' });

    // Weekly archive at 3 AM on Sunday
    await jobs.unschedule('archive').catch(() => {}); // Remove any existing schedule
    await jobs.schedule('archive', '0 3 * * 0', { type: 'logs', startDate: '', endDate: '' });

    logger.info('Recurring jobs scheduled successfully');
  } catch (error) {
    logger.error(error, 'Failed to schedule recurring jobs');
    // Don't throw - allow server to start even if scheduling fails
    logger.warn('Server will continue without scheduled jobs');
  }
}

