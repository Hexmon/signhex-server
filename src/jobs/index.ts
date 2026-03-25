import PgBoss from 'pg-boss';
import ffmpeg from 'fluent-ffmpeg';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { config as appConfig } from '@/config';
import { deleteObject, getObject, putObject } from '@/s3';
import { createLogger } from '@/utils/logger';
import { createMediaRepository } from '@/db/repositories/media';
import { createBackupRun, getLatestBackupRun, runFullBackup } from '@/utils/backup-runs';
import { getCachedSettings } from '@/utils/settings';

const logger = createLogger('jobs');

ffmpeg.setFfmpegPath(appConfig.FFMPEG_PATH);

const READY_BUCKET = 'media-ready';
const THUMBNAIL_BUCKET = 'media-thumbnails';
const ARCHIVE_BUCKET = 'archives';
const HLS_SEGMENT_CONTENT_TYPE = 'video/mp2t';
const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';
const NDJSON_CONTENT_TYPE = 'application/x-ndjson';

const QUALITY_OPTIONS: Record<FFmpegTranscodeJob['quality'], string[]> = {
  low: ['-preset', 'veryfast', '-crf', '30', '-b:a', '96k'],
  medium: ['-preset', 'fast', '-crf', '24', '-b:a', '128k'],
  high: ['-preset', 'slower', '-crf', '20', '-b:a', '192k'],
};

const FORMAT_CONTENT_TYPE: Record<FFmpegTranscodeJob['targetFormat'], string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  hls: 'application/vnd.apple.mpegurl',
};

async function runTranscode(
  inputPath: string,
  outputPath: string,
  job: FFmpegTranscodeJob,
  segmentTemplate: string
) {
  const qualityFlags = QUALITY_OPTIONS[job.quality] ?? QUALITY_OPTIONS.medium;

  return new Promise<void>((resolve, reject) => {
    const command = ffmpeg(inputPath).outputOptions([...qualityFlags]);

    if (job.targetFormat === 'hls') {
      command.videoCodec('libx264').audioCodec('aac').format('hls');
      command.outputOptions([
        '-hls_time',
        '6',
        '-hls_list_size',
        '0',
        '-hls_playlist_type',
        'vod',
        '-hls_segment_filename',
        segmentTemplate,
      ]);
    } else if (job.targetFormat === 'webm') {
      command.videoCodec('libvpx-vp9').audioCodec('libopus').format('webm');
    } else {
      command.videoCodec('libx264').audioCodec('aac').format('mp4');
      command.outputOptions(['-movflags', 'faststart']);
    }

    command
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (error) => reject(error))
      .run();
  });
}

async function cleanupTempDir(dir: string | null) {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn(error, 'Failed to clean up temp directory');
  }
}

let boss: PgBoss | null = null;

type PgBossError = Error & {
  code?: string;
};

const RECURRING_QUEUE_NAMES = ['cleanup', 'archive', 'chat:media-cleanup', 'backup', 'backup:check'] as const;

function getPgBossSchemaSql() {
  return `"${appConfig.PG_BOSS_SCHEMA.replace(/"/g, '""')}"`;
}

function getPgBossPartitionName(queueName: string) {
  return `j${createHash('sha224').update(queueName).digest('hex')}`;
}

async function queuePartitionExists(queueName: string) {
  const db = getDatabase();
  const partitionName = getPgBossPartitionName(queueName);
  const result = await db.execute(sql.raw(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_tables
      WHERE schemaname = '${appConfig.PG_BOSS_SCHEMA.replace(/'/g, "''")}'
        AND tablename = '${partitionName}'
    ) AS exists
  `));

  return Boolean((result as { rows?: Array<{ exists?: boolean }> }).rows?.[0]?.exists);
}

async function repairQueueMetadata(queueName: string) {
  const db = getDatabase();
  const schemaSql = getPgBossSchemaSql();
  const partitionName = getPgBossPartitionName(queueName);

  await db.execute(sql.raw(`
    INSERT INTO ${schemaSql}.queue (
      name,
      policy,
      partition_name
    )
    VALUES (
      '${queueName.replace(/'/g, "''")}',
      'standard',
      '${partitionName}'
    )
    ON CONFLICT (name) DO NOTHING
  `));
}

async function ensureQueueExists(jobs: PgBoss, queueName: string) {
  try {
    await jobs.createQueue(queueName);
    return;
  } catch (error) {
    const pgBossError = error as PgBossError;
    const partitionAlreadyExists = pgBossError.code === '42P07' && await queuePartitionExists(queueName);

    if (!partitionAlreadyExists) {
      logger.error({ err: error, queueName }, 'Failed to create pg-boss queue');
      throw error;
    }

    logger.warn({ queueName }, 'Detected orphaned pg-boss queue metadata. Repairing queue row.');
    await repairQueueMetadata(queueName);

    const queue = await jobs.getQueue(queueName);
    if (!queue) {
      throw new Error(`Failed to repair pg-boss queue metadata for ${queueName}`);
    }

    logger.info({ queueName }, 'Repaired orphaned pg-boss queue metadata');
  }
}

export async function initializeJobs(): Promise<PgBoss> {
  if (boss) {
    return boss;
  }

  boss = new PgBoss({
    connectionString: appConfig.DATABASE_URL,
    schema: appConfig.PG_BOSS_SCHEMA,
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
  type: 'expired_sessions' | 'old_logs' | 'orphaned_objects' | 'chat_orphaned_media';
  mediaAssetIds?: string[];
  conversationId?: string;
  messageId?: string;
}

export interface ChatMediaCleanupJob {
  conversationId: string;
  mediaAssetIds: string[];
  source?: 'message-delete' | 'conversation-delete' | 'fallback-reconcile';
  messageId?: string;
}

export interface BackupJob {
  runId: string;
}

export interface BackupCheckJob {
  trigger: 'scheduled-check';
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

export async function queueBackup(job: BackupJob, options?: any) {
  const jobs = getJobs();
  return jobs.send('backup', job, {
    retryLimit: 1,
    retryDelay: 60,
    ...options,
  });
}

export async function queueChatMediaCleanup(job: ChatMediaCleanupJob, options?: any) {
  const jobs = getJobs();
  return jobs.send('chat:media-cleanup', job, {
    retryLimit: 3,
    retryDelay: 60,
    ...options,
  });
}

export async function cleanupChatMediaAssets(input: {
  mediaAssetIds: string[];
  conversationId?: string;
  source?: 'message-delete' | 'conversation-delete' | 'fallback-reconcile';
  messageId?: string;
}) {
  const db = getDatabase();
  const mediaRepo = createMediaRepository();
  const mediaIds = Array.from(new Set(input.mediaAssetIds || []));
  if (!mediaIds.length) return;

  logger.info(
    {
      conversationId: input.conversationId,
      messageId: input.messageId,
      source: input.source,
      mediaCount: mediaIds.length,
    },
    'Processing chat media cleanup'
  );

  for (const mediaId of mediaIds) {
    try {
      const [media] = await db.select().from(schema.media).where(eq(schema.media.id, mediaId));
      if (!media) continue;

      const usageSummary = await mediaRepo.getUsageSummary(mediaId);
      if (usageSummary.inUse) {
        logger.info(
          { mediaId, references: usageSummary.references },
          'Skipping chat media cleanup because references still exist'
        );
        continue;
      }

      const storageTargets = new Map<string, { id?: string; bucket: string; object_key: string }>();
      if (media.source_object_id) {
        const [row] = await db
          .select()
          .from(schema.storageObjects)
          .where(eq(schema.storageObjects.id, media.source_object_id));
        if (row) storageTargets.set(`${row.bucket}/${row.object_key}`, row);
      }
      if (media.ready_object_id) {
        const [row] = await db
          .select()
          .from(schema.storageObjects)
          .where(eq(schema.storageObjects.id, media.ready_object_id));
        if (row) storageTargets.set(`${row.bucket}/${row.object_key}`, row);
      }
      if (media.thumbnail_object_id) {
        const [row] = await db
          .select()
          .from(schema.storageObjects)
          .where(eq(schema.storageObjects.id, media.thumbnail_object_id));
        if (row) storageTargets.set(`${row.bucket}/${row.object_key}`, row);
      }
      if (media.source_bucket && media.source_object_key) {
        storageTargets.set(`${media.source_bucket}/${media.source_object_key}`, {
          bucket: media.source_bucket,
          object_key: media.source_object_key,
        });
      }

      let deletionFailed = false;
      for (const storage of storageTargets.values()) {
        try {
          await deleteObject(storage.bucket, storage.object_key);
        } catch (error) {
          deletionFailed = true;
          logger.warn(
            error,
            `Failed to delete chat media object ${storage.bucket}/${storage.object_key}`
          );
        }
      }

      if (deletionFailed) {
        logger.warn({ mediaId }, 'Skipping media row deletion because object cleanup was incomplete');
        continue;
      }

      const storageObjectIds = Array.from(storageTargets.values())
        .map((row) => row.id)
        .filter((id): id is string => Boolean(id));
      if (storageObjectIds.length > 0) {
        await db
          .delete(schema.storageObjects)
          .where(inArray(schema.storageObjects.id, storageObjectIds));
      }

      await db.delete(schema.media).where(eq(schema.media.id, mediaId));
    } catch (error) {
      logger.error(error, `Failed chat media cleanup for media ${mediaId}`);
    }
  }
}

// Job handlers registration
export async function registerJobHandlers() {
  const jobs = getJobs();

  // FFmpeg transcode handler
  await jobs.work<FFmpegTranscodeJob>('ffmpeg:transcode', async (jobBatch) => {
    const db = getDatabase();
    const batch = Array.isArray(jobBatch) ? jobBatch : [jobBatch];

    for (const job of batch) {
      const { mediaId, sourceObjectId, targetFormat, quality } = job.data;
      let tempDir: string | null = null;

      logger.info(`Processing transcode job: ${mediaId}`);

      try {
        const [media] = await db.select().from(schema.media).where(eq(schema.media.id, mediaId));
        if (!media) {
          logger.warn(`Media not found for transcode job: ${mediaId}`);
          continue;
        }

        const [sourceObject] =
          sourceObjectId && !media.source_bucket
            ? await db
                .select()
                .from(schema.storageObjects)
                .where(eq(schema.storageObjects.id, sourceObjectId))
            : [];

        const sourceBucket = media.source_bucket ?? sourceObject?.bucket;
        const sourceKey = media.source_object_key ?? sourceObject?.object_key;

        if (!sourceBucket || !sourceKey) {
          logger.warn(`Missing source object info for media ${mediaId}`);
          await db
            .update(schema.media)
            .set({ status: 'FAILED', updated_at: new Date() })
            .where(eq(schema.media.id, mediaId));
          continue;
        }

        await db
          .update(schema.media)
          .set({ status: 'PROCESSING', updated_at: new Date() })
          .where(eq(schema.media.id, mediaId));

        const sourceBuffer = await getObject(sourceBucket, sourceKey);
        tempDir = await fs.mkdtemp(join(tmpdir(), 'ffmpeg-'));
        const workDir = tempDir;
        const inputPath = join(workDir, 'input');
        await fs.writeFile(inputPath, sourceBuffer);

        const outputExt = targetFormat === 'hls' ? 'm3u8' : targetFormat;
        const outputPath = join(workDir, `output.${outputExt}`);
        const segmentTemplate = join(workDir, 'segment_%03d.ts');

        await runTranscode(inputPath, outputPath, { mediaId, sourceObjectId, targetFormat, quality }, segmentTemplate);

        if (targetFormat === 'hls') {
          const playlistBuffer = await fs.readFile(outputPath);
          const playlistKey = `${mediaId}/hls/playlist.m3u8`;
          const playlistUpload = await putObject(
            READY_BUCKET,
            playlistKey,
            playlistBuffer,
            FORMAT_CONTENT_TYPE.hls
          );

          const [readyObject] = await db
            .insert(schema.storageObjects)
            .values({
              bucket: READY_BUCKET,
              object_key: playlistKey,
              content_type: FORMAT_CONTENT_TYPE.hls,
              size: playlistBuffer.length,
              sha256: playlistUpload.sha256,
            })
            .returning();

          const files = await fs.readdir(workDir);
          const segments = files.filter((file) => file.startsWith('segment_') && file.endsWith('.ts'));

          await Promise.all(
            segments.map(async (file) => {
              const buffer = await fs.readFile(join(workDir, file));
              const key = `${mediaId}/hls/${file}`;
              await putObject(READY_BUCKET, key, buffer, HLS_SEGMENT_CONTENT_TYPE);
            })
          );

          await db
            .update(schema.media)
            .set({
              ready_object_id: readyObject?.id,
              status: 'READY',
              updated_at: new Date(),
            })
            .where(eq(schema.media.id, mediaId));
        } else {
          const outputBuffer = await fs.readFile(outputPath);
          const readyKey = `${mediaId}/ready.${outputExt}`;
          const upload = await putObject(
            READY_BUCKET,
            readyKey,
            outputBuffer,
            FORMAT_CONTENT_TYPE[targetFormat] ?? 'application/octet-stream'
          );

          const [readyObject] = await db
            .insert(schema.storageObjects)
            .values({
              bucket: READY_BUCKET,
              object_key: readyKey,
              content_type: FORMAT_CONTENT_TYPE[targetFormat],
              size: outputBuffer.length,
              sha256: upload.sha256,
            })
            .returning();

          await db
            .update(schema.media)
            .set({
              ready_object_id: readyObject?.id,
              status: 'READY',
              updated_at: new Date(),
            })
            .where(eq(schema.media.id, mediaId));
        }
      } catch (error) {
        logger.error(error, `Transcode failed for media ${mediaId}`);
        try {
          await db
            .update(schema.media)
            .set({ status: 'FAILED', updated_at: new Date() })
            .where(eq(schema.media.id, mediaId));
        } catch (updateError) {
          logger.error(updateError, `Failed to mark media ${mediaId} as failed`);
        }
      } finally {
        await cleanupTempDir(tempDir);
      }
    }
  });

  // FFmpeg thumbnail handler
  await jobs.work<FFmpegThumbnailJob>('ffmpeg:thumbnail', async (jobBatch) => {
    const db = getDatabase();
    const batch = Array.isArray(jobBatch) ? jobBatch : [jobBatch];

    for (const job of batch) {
      const { mediaId, sourceObjectId, timestamp } = job.data;
      let tempDir: string | null = null;

      logger.info(`Processing thumbnail job: ${mediaId}`);

      try {
        const [media] = await db.select().from(schema.media).where(eq(schema.media.id, mediaId));
        if (!media) {
          logger.warn(`Media not found for thumbnail job: ${mediaId}`);
          continue;
        }

        const [sourceObject] =
          sourceObjectId && !media.source_bucket
            ? await db
                .select()
                .from(schema.storageObjects)
                .where(eq(schema.storageObjects.id, sourceObjectId))
            : [];

        const sourceBucket = media.source_bucket ?? sourceObject?.bucket;
        const sourceKey = media.source_object_key ?? sourceObject?.object_key;

        if (!sourceBucket || !sourceKey) {
          logger.warn(`Missing source object info for media ${mediaId}`);
          continue;
        }

        const sourceBuffer = await getObject(sourceBucket, sourceKey);
        tempDir = await fs.mkdtemp(join(tmpdir(), 'thumb-'));
        const inputPath = join(tempDir, 'input');
        await fs.writeFile(inputPath, sourceBuffer);

        const outputPath = join(tempDir, 'thumbnail.jpg');
        const seekTime = Math.max(0, timestamp ?? 1);

        await new Promise<void>((resolve, reject) => {
          ffmpeg(inputPath)
            .seekInput(seekTime)
            .frames(1)
            .outputOptions(['-q:v', '2'])
            .output(outputPath)
            .on('end', () => resolve())
            .on('error', (error) => reject(error))
            .run();
        });

        const thumbnailBuffer = await fs.readFile(outputPath);
        const thumbnailKey = `${mediaId}/thumbnail.jpg`;
        const upload = await putObject(THUMBNAIL_BUCKET, thumbnailKey, thumbnailBuffer, THUMBNAIL_CONTENT_TYPE);

        const [thumbnailObject] = await db
          .insert(schema.storageObjects)
          .values({
            bucket: THUMBNAIL_BUCKET,
            object_key: thumbnailKey,
            content_type: THUMBNAIL_CONTENT_TYPE,
            size: thumbnailBuffer.length,
            sha256: upload.sha256,
          })
          .returning();

        await db
          .update(schema.media)
          .set({ thumbnail_object_id: thumbnailObject?.id, updated_at: new Date() })
          .where(eq(schema.media.id, mediaId));
      } catch (error) {
        logger.error(error, `Thumbnail generation failed for media ${mediaId}`);
      } finally {
        await cleanupTempDir(tempDir);
      }
    }
  });

  // Archive handler
  await jobs.work<ArchiveJob>('archive', async (jobBatch) => {
    const db = getDatabase();
    const batch = Array.isArray(jobBatch) ? jobBatch : [jobBatch];
    const sources = [
      { logType: 'audit', table: schema.auditLogs },
      { logType: 'system', table: schema.systemLogs },
      { logType: 'auth', table: schema.loginAttempts },
      { logType: 'heartbeats', table: schema.heartbeats },
      { logType: 'pop', table: schema.proofOfPlay },
    ];

    for (const job of batch) {
      logger.info(`Processing archive job: ${job.data.type}`);

      if (job.data.type !== 'logs') {
        logger.warn(`Archive type not implemented: ${job.data.type}`);
        continue;
      }

      const windowStart = job.data.startDate ? new Date(job.data.startDate) : new Date(0);
      const windowEnd = job.data.endDate ? new Date(job.data.endDate) : new Date();

      if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime())) {
        logger.warn(`Invalid archive window: ${job.data.startDate} - ${job.data.endDate}`);
        continue;
      }

      for (const source of sources) {
        try {
          const rows = await db
            .select()
            .from(source.table)
            .where(and(gte(source.table.created_at, windowStart), lte(source.table.created_at, windowEnd)));

          if (!rows.length) {
            continue;
          }

          const payload = rows.map((row) => JSON.stringify(row)).join('\n');
          const objectKey = `logs/${source.logType}/${windowStart.toISOString()}_${windowEnd.toISOString()}.ndjson`;
          const upload = await putObject(ARCHIVE_BUCKET, objectKey, payload, NDJSON_CONTENT_TYPE);

          const [storageObject] = await db
            .insert(schema.storageObjects)
            .values({
              bucket: ARCHIVE_BUCKET,
              object_key: objectKey,
              content_type: NDJSON_CONTENT_TYPE,
              size: Buffer.byteLength(payload),
              sha256: upload.sha256,
            })
            .returning();

          await db.insert(schema.logArchives).values({
            log_type: source.logType,
            window_start: windowStart,
            window_end: windowEnd,
            record_count: rows.length,
            storage_object_id: storageObject.id,
          });
        } catch (error) {
          logger.error(error, `Failed to archive ${source.logType} logs`);
        }
      }
    }
  });

  // Cleanup handler
  await jobs.work<CleanupJob>('cleanup', async (jobBatch) => {
    const db = getDatabase();
    const batch = Array.isArray(jobBatch) ? jobBatch : [jobBatch];

    for (const job of batch) {
      const type = job.data.type;
      logger.info(`Processing cleanup job: ${type}`);

      try {
        switch (type) {
          case 'expired_sessions': {
            const deleted = await db
              .delete(schema.sessions)
              .where(lte(schema.sessions.expires_at, new Date()))
              .returning({ id: schema.sessions.id });
            logger.info(`Deleted ${deleted.length} expired sessions`);
            break;
          }
          case 'old_logs': {
            const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const sources = [
              { logType: 'audit', table: schema.auditLogs },
              { logType: 'system', table: schema.systemLogs },
              { logType: 'auth', table: schema.loginAttempts },
              { logType: 'heartbeats', table: schema.heartbeats },
              { logType: 'pop', table: schema.proofOfPlay },
            ];

            for (const source of sources) {
              const rows = await db
                .select()
                .from(source.table)
                .where(lte(source.table.created_at, cutoff));

              if (!rows.length) continue;

              const timestamps = rows
                .map((row: any) => new Date(row.created_at).getTime())
                .filter((value) => Number.isFinite(value));
              if (!timestamps.length) continue;

              const payload = rows.map((row) => JSON.stringify(row)).join('\n');
              const objectKey = `logs/${source.logType}/cleanup_${cutoff.toISOString()}_${Date.now()}.ndjson`;
              const upload = await putObject(ARCHIVE_BUCKET, objectKey, payload, NDJSON_CONTENT_TYPE);

              const windowStart = new Date(Math.min(...timestamps));
              const windowEnd = new Date(Math.max(...timestamps));

              const [storageObject] = await db
                .insert(schema.storageObjects)
                .values({
                  bucket: ARCHIVE_BUCKET,
                  object_key: objectKey,
                  content_type: NDJSON_CONTENT_TYPE,
                  size: Buffer.byteLength(payload),
                  sha256: upload.sha256,
                })
                .returning();

              await db.insert(schema.logArchives).values({
                log_type: source.logType,
                window_start: windowStart,
                window_end: windowEnd,
                record_count: rows.length,
                storage_object_id: storageObject.id,
              });

              await db.delete(source.table).where(lte(source.table.created_at, cutoff));
            }
            break;
          }
          case 'orphaned_objects': {
            const orphansResult = await db.execute(
              sql`
                SELECT id, bucket, object_key
                FROM storage_objects so
                WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.source_object_id = so.id OR m.ready_object_id = so.id OR m.thumbnail_object_id = so.id)
                  AND NOT EXISTS (SELECT 1 FROM schedule_snapshots ss WHERE ss.storage_object_id = so.id)
                  AND NOT EXISTS (SELECT 1 FROM heartbeats h WHERE h.storage_object_id = so.id)
                  AND NOT EXISTS (SELECT 1 FROM proof_of_play pop WHERE pop.storage_object_id = so.id)
                  AND NOT EXISTS (SELECT 1 FROM screenshots s WHERE s.storage_object_id = so.id)
                  AND NOT EXISTS (SELECT 1 FROM request_attachments ra WHERE ra.storage_object_id = so.id)
                  AND NOT EXISTS (SELECT 1 FROM audit_logs al WHERE al.storage_object_id = so.id)
                  AND NOT EXISTS (SELECT 1 FROM system_logs sl WHERE sl.storage_object_id = so.id)
                  AND NOT EXISTS (SELECT 1 FROM login_attempts la WHERE la.storage_object_id = so.id)
                  AND NOT EXISTS (SELECT 1 FROM log_archives lga WHERE lga.storage_object_id = so.id)
              `
            );

            const orphans = (orphansResult as { rows?: any[] }).rows ?? [];
            if (!orphans.length) {
              logger.info('No orphaned storage objects found');
              break;
            }

            const orphanIds: string[] = [];
            for (const orphan of orphans) {
              const { id, bucket, object_key: objectKey } = orphan as any;
              try {
                await deleteObject(bucket, objectKey);
                orphanIds.push(id);
              } catch (error) {
                logger.warn(error, `Failed to delete object ${bucket}/${objectKey}`);
              }
            }

            if (orphanIds.length) {
              await db.delete(schema.storageObjects).where(inArray(schema.storageObjects.id, orphanIds));
              logger.info(`Removed ${orphanIds.length} orphaned storage objects`);
            }
            break;
          }
          case 'chat_orphaned_media': {
            const mediaAssetIds = Array.from(new Set(job.data.mediaAssetIds || []));
            if (!mediaAssetIds.length) {
              logger.info('No chat media ids provided for fallback cleanup');
              break;
            }

            await cleanupChatMediaAssets({
              mediaAssetIds,
              conversationId: job.data.conversationId,
              messageId: job.data.messageId,
              source: 'fallback-reconcile',
            });
            break;
          }
          default:
            logger.warn(`Unknown cleanup type: ${type}`);
        }
      } catch (error) {
        logger.error(error, `Cleanup failed for type ${type}`);
      }
    }
  });

  await jobs.work<ChatMediaCleanupJob>('chat:media-cleanup', async (jobBatch) => {
    const batch = Array.isArray(jobBatch) ? jobBatch : [jobBatch];

    for (const job of batch) {
      await cleanupChatMediaAssets({
        mediaAssetIds: job.data.mediaAssetIds,
        conversationId: job.data.conversationId,
        source: job.data.source,
        messageId: job.data.messageId,
      });
    }
  });

  await jobs.work<BackupJob>('backup', async (jobBatch) => {
    const batch = Array.isArray(jobBatch) ? jobBatch : [jobBatch];

    for (const job of batch) {
      logger.info({ runId: job.data.runId }, 'Processing backup job');
      await runFullBackup(job.data.runId);
    }
  });

  await jobs.work<BackupCheckJob>('backup:check', async () => {
    const backupsSettings = getCachedSettings('org.backups');
    if (!backupsSettings.automatic_enabled) {
      return;
    }

    const latestRun = await getLatestBackupRun();
    const now = Date.now();
    const latestTimestamp = latestRun?.created_at ? new Date(latestRun.created_at).getTime() : 0;
    const intervalMs = backupsSettings.interval_hours * 60 * 60 * 1000;

    if (latestRun && ['PENDING', 'RUNNING'].includes(latestRun.status)) {
      return;
    }

    if (latestTimestamp && now - latestTimestamp < intervalMs) {
      return;
    }

    const run = await createBackupRun('AUTOMATIC');
    await queueBackup({ runId: run.id });
  });

  logger.info('Job handlers registered');
}

// Scheduled jobs
// export async function scheduleRecurringJobs() {
//   const jobs = getJobs();

//   try {
//     // pg-boss requires queues to exist in the database before scheduling
//     // We need to create the queues first by sending a job to each queue
//     // This will create the queue entry in pgboss.queue table

//     // Create cleanup queue by sending a job (will be processed immediately or soon)
//     const cleanupJobId = await jobs.send('cleanup', { type: 'expired_sessions' });
//     logger.info(`Created cleanup queue with initial job: ${cleanupJobId}`);

//     // Create archive queue by sending a job
//     const archiveJobId = await jobs.send('archive', { type: 'logs', startDate: '', endDate: '' });
//     logger.info(`Created archive queue with initial job: ${archiveJobId}`);

//     // Wait a bit for pg-boss to process and create queue entries
//     await new Promise(resolve => setTimeout(resolve, 1000));

//     // Now schedule recurring jobs (queues should exist now)
//     // Daily cleanup at 2 AM
//     await jobs.unschedule('cleanup').catch(() => {}); // Remove any existing schedule
//     await jobs.schedule('cleanup', '0 2 * * *', { type: 'expired_sessions' });

//     // Weekly archive at 3 AM on Sunday
//     await jobs.unschedule('archive').catch(() => {}); // Remove any existing schedule
//     await jobs.schedule('archive', '0 3 * * 0', { type: 'logs', startDate: '', endDate: '' });

//     logger.info('Recurring jobs scheduled successfully');
//   } catch (error) {
//     logger.error(error, 'Failed to schedule recurring jobs');
//     // Don't throw - allow server to start even if scheduling fails
//     logger.warn('Server will continue without scheduled jobs');
//   }
// }
export async function scheduleRecurringJobs() {
  const jobs = getJobs();

  try {
    for (const queueName of RECURRING_QUEUE_NAMES) {
      await ensureQueueExists(jobs, queueName);
    }

    // Clean any prior schedules
    await jobs.unschedule('cleanup').catch(() => { });
    await jobs.unschedule('archive').catch(() => { });
    await jobs.unschedule('backup:check').catch(() => { });

    // Now schedule safely (queues exist)
    await jobs.schedule('cleanup', '0 2 * * *', { type: 'expired_sessions' });      // daily 2 AM
    await jobs.schedule('archive', '0 3 * * 0', { type: 'logs', startDate: '', endDate: '' }); // Sun 3 AM
    await jobs.schedule('backup:check', '0 * * * *', { trigger: 'scheduled-check' }); // hourly

    logger.info('Recurring jobs scheduled successfully');
  } catch (error) {
    logger.error(error, 'Failed to schedule recurring jobs');
    logger.warn('Server will continue without scheduled jobs');
  }
}
