import { promisify } from 'util';
import { execFile, spawn } from 'child_process';
import { promises as fs, createWriteStream } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { desc, eq, inArray } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { deleteObject, getPresignedUrl, getS3Client, putObject } from '@/s3';
import { AppError } from '@/utils/app-error';
import { getResolvedPgDumpPath, getResolvedTarPath } from '@/utils/runtime-dependencies';

const execFileAsync = promisify(execFile);
const ARCHIVE_BUCKET = 'archives';
const POSTGRES_BACKUP_CONTAINER = process.env.POSTGRES_BACKUP_CONTAINER?.trim() || 'hexmon-postgres';
const MINIO_BACKUP_BUCKETS = [
  'media-source',
  'media-ready',
  'media-thumbnails',
  'device-screenshots',
  'logs-audit',
  'logs-system',
  'logs-auth',
  'logs-heartbeats',
  'logs-proof-of-play',
] as const;

export type BackupRunRecord = typeof schema.backupRuns.$inferSelect;

async function ensureTempDir() {
  return fs.mkdtemp(join(tmpdir(), 'signhex-backup-'));
}

function formatBackupTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function normalizeErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, ' ').trim();
  }

  return String(error).replace(/\s+/g, ' ').trim();
}

function isCommandNotFound(error: unknown) {
  return (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
      error.message.toLowerCase().includes('not found') ||
      error.message.toLowerCase().includes('is not available'))
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getObjectString(value: Record<string, unknown>, key: string) {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function parseDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required for PostgreSQL backups.');
  }

  const parsed = new URL(databaseUrl);
  const database = parsed.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error('DATABASE_URL must include a database name for PostgreSQL backups.');
  }

  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname,
    port: parsed.port || '5432',
    database,
  };
}

function resolveBackupPath(rootDir: string, objectKey: string) {
  const rootPath = resolve(rootDir);
  const targetPath = resolve(rootDir, objectKey);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Unsafe backup object key encountered: ${objectKey}`);
  }

  return targetPath;
}

async function runCommandToGzipFile(params: {
  command: string;
  args: string[];
  outputPath: string;
  env?: NodeJS.ProcessEnv;
  label: string;
}) {
  const child = spawn(params.command, params.args, {
    env: params.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', () => resolveSpawn());
      child.once('error', (error) => rejectSpawn(error));
    });
  } catch (error) {
    const message = isCommandNotFound(error)
      ? `${params.label} is not available on this machine.`
      : `${params.label} failed to start: ${normalizeErrorMessage(error)}`;
    throw Object.assign(new Error(message), {
      cause: error,
      code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
    });
  }

  await Promise.all([
    pipeline(child.stdout as NodeJS.ReadableStream, createGzip(), createWriteStream(params.outputPath)),
    new Promise<void>((resolveExit, rejectExit) => {
      child.once('close', (code) => {
        if (code === 0) {
          resolveExit();
          return;
        }

        rejectExit(new Error(stderr.trim() || `${params.label} exited with code ${code}`));
      });
      child.once('error', (error) => {
        rejectExit(error);
      });
    }),
  ]);
}

async function createPostgresArchive(backupDir: string) {
  const connection = parseDatabaseUrl();
  const timestamp = formatBackupTimestamp();
  const outputPath = join(backupDir, `hexmon_postgres_${timestamp}.sql.gz`);
  const pgDumpCommand = getResolvedPgDumpPath();
  const baseArgs = [
    '-h',
    connection.host,
    '-p',
    connection.port,
    '-U',
    connection.user,
    '-d',
    connection.database,
    '--verbose',
  ];

  if (pgDumpCommand) {
    try {
      await runCommandToGzipFile({
        command: pgDumpCommand,
        args: baseArgs,
        outputPath,
        env: { ...process.env, PGPASSWORD: connection.password },
        label: 'pg_dump',
      });
      return outputPath;
    } catch (error) {
      if (!isCommandNotFound(error)) {
        throw new Error(`PostgreSQL backup failed: ${normalizeErrorMessage(error)}`);
      }
    }
  }

  try {
    await runCommandToGzipFile({
      command: 'docker',
      args: [
        'exec',
        '-i',
        '-e',
        `PGPASSWORD=${connection.password}`,
        POSTGRES_BACKUP_CONTAINER,
        'pg_dump',
        '-h',
        'localhost',
        '-p',
        connection.port,
        '-U',
        connection.user,
        '-d',
        connection.database,
        '--verbose',
      ],
      outputPath,
      env: process.env,
      label: `docker exec ${POSTGRES_BACKUP_CONTAINER} pg_dump`,
    });
    return outputPath;
  } catch (error) {
    throw new Error(
      `PostgreSQL backup failed: pg_dump is not installed or could not be executed from PG_DUMP_PATH/PATH, and docker fallback via "${POSTGRES_BACKUP_CONTAINER}" could not run. ${normalizeErrorMessage(error)}`
    );
  }
}

async function downloadBucketObjects(bucket: string, destinationDir: string) {
  const client = getS3Client();
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );

    for (const object of response.Contents ?? []) {
      if (!object.Key) continue;

      if (object.Key.endsWith('/')) {
        await fs.mkdir(resolveBackupPath(destinationDir, object.Key), { recursive: true });
        continue;
      }

      const targetPath = resolveBackupPath(destinationDir, object.Key);
      await fs.mkdir(dirname(targetPath), { recursive: true });

      const objectResponse = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: object.Key,
        })
      );

      if (!objectResponse.Body) {
        throw new Error(`Received empty body while backing up ${bucket}/${object.Key}`);
      }

      await pipeline(objectResponse.Body as NodeJS.ReadableStream, createWriteStream(targetPath));
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function createObjectStorageArchive(backupDir: string) {
  const timestamp = formatBackupTimestamp();
  const mirrorRoot = join(backupDir, 'minio-export');
  const outputPath = join(backupDir, `hexmon_minio_${timestamp}.tar.gz`);
  const tarCommand = getResolvedTarPath();

  await fs.mkdir(mirrorRoot, { recursive: true });

  for (const bucket of MINIO_BACKUP_BUCKETS) {
    const bucketDir = join(mirrorRoot, bucket);
    await fs.mkdir(bucketDir, { recursive: true });
    await downloadBucketObjects(bucket, bucketDir);
  }

  if (!tarCommand) {
    throw new Error('Object storage backup failed: tar is not available. Install tar or set TAR_PATH to the executable.');
  }

  try {
    await execFileAsync(tarCommand, ['-czf', outputPath, '-C', mirrorRoot, '.']);
  } catch (error) {
    if (isCommandNotFound(error)) {
      throw new Error('Object storage backup failed: tar is not available. Install tar or set TAR_PATH to the executable.');
    }

    throw new Error(`Object storage backup failed: ${normalizeErrorMessage(error)}`);
  }

  return outputPath;
}

export async function createBackupRun(triggerType: 'MANUAL' | 'AUTOMATIC', triggeredBy?: string | null) {
  const db = getDatabase();
  const [run] = await db
    .insert(schema.backupRuns)
    .values({
      trigger_type: triggerType,
      status: 'PENDING',
      triggered_by: triggeredBy ?? null,
    })
    .returning();
  return run;
}

export async function markBackupRunRunning(runId: string) {
  const db = getDatabase();
  await db
    .update(schema.backupRuns)
    .set({
      status: 'RUNNING',
      started_at: new Date(),
      updated_at: new Date(),
      error_message: null,
    })
    .where(eq(schema.backupRuns.id, runId));
}

export async function markBackupRunCompleted(
  runId: string,
  files: Array<{
    bucket: string;
    object_key: string;
    name: string;
    size: number;
    content_type: string;
    storage_object_id: string;
  }>
) {
  const db = getDatabase();
  await db
    .update(schema.backupRuns)
    .set({
      status: 'COMPLETED',
      completed_at: new Date(),
      updated_at: new Date(),
      files,
      error_message: null,
    })
    .where(eq(schema.backupRuns.id, runId));
}

export async function markBackupRunFailed(runId: string, message: string) {
  const db = getDatabase();
  await db
    .update(schema.backupRuns)
    .set({
      status: 'FAILED',
      completed_at: new Date(),
      updated_at: new Date(),
      error_message: message.slice(0, 1000),
    })
    .where(eq(schema.backupRuns.id, runId));
}

export async function listBackupRuns(limit = 20) {
  const db = getDatabase();
  const rows = await db
    .select()
    .from(schema.backupRuns)
    .orderBy(desc(schema.backupRuns.created_at))
    .limit(limit);

  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      downloads: await Promise.all(
        (row.files ?? []).map(async (file) => ({
          ...file,
          url: await getPresignedUrl(file.bucket, file.object_key),
        }))
      ),
    }))
  );
}

export async function getLatestBackupRun() {
  const db = getDatabase();
  const [row] = await db
    .select()
    .from(schema.backupRuns)
    .orderBy(desc(schema.backupRuns.created_at))
    .limit(1);
  return row ?? null;
}

function isStorageMissingError(error: unknown) {
  if (!isObjectRecord(error)) return false;
  const metadata = isObjectRecord(error.$metadata) ? error.$metadata : undefined;

  return (
    getObjectString(error, 'name') === 'NoSuchKey' ||
    getObjectString(error, 'name') === 'NotFound' ||
    getObjectString(error, 'Code') === 'NoSuchKey' ||
    getObjectString(error, 'code') === 'NoSuchKey' ||
    metadata?.httpStatusCode === 404
  );
}

export async function deleteBackupRun(runId: string) {
  const db = getDatabase();
  const [run] = await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, runId)).limit(1);

  if (!run) {
    throw AppError.notFound('Backup run not found');
  }

  if (run.status === 'PENDING' || run.status === 'RUNNING') {
    throw AppError.conflict('In-progress backups cannot be deleted');
  }

  const files = run.files ?? [];

  for (const file of files) {
    try {
      await deleteObject(file.bucket, file.object_key);
    } catch (error) {
      if (!isStorageMissingError(error)) {
        throw error;
      }
    }
  }

  const storageObjectIds = Array.from(
    new Set(files.map((file) => file.storage_object_id).filter((value): value is string => Boolean(value)))
  );

  if (storageObjectIds.length > 0) {
    await db.delete(schema.storageObjects).where(inArray(schema.storageObjects.id, storageObjectIds));
  }

  await db.delete(schema.backupRuns).where(eq(schema.backupRuns.id, runId));

  return {
    id: run.id,
    deleted: true,
  };
}

export async function runFullBackup(runId: string) {
  const db = getDatabase();
  const backupDir = await ensureTempDir();

  try {
    await markBackupRunRunning(runId);
    await createPostgresArchive(backupDir);
    await createObjectStorageArchive(backupDir);

    const entries = await fs.readdir(backupDir);
    const files = [] as Array<{
      bucket: string;
      object_key: string;
      name: string;
      size: number;
      content_type: string;
      storage_object_id: string;
    }>;

    for (const entry of entries) {
      const filePath = join(backupDir, entry);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;

      const buffer = await fs.readFile(filePath);
      const objectKey = `backups/${runId}/${basename(filePath)}`;
      const upload = await putObject(ARCHIVE_BUCKET, objectKey, buffer, 'application/gzip');
      const [storageObject] = await db
        .insert(schema.storageObjects)
        .values({
          bucket: ARCHIVE_BUCKET,
          object_key: objectKey,
          content_type: 'application/gzip',
          size: buffer.byteLength,
          sha256: upload.sha256,
        })
        .returning();

      files.push({
        bucket: ARCHIVE_BUCKET,
        object_key: objectKey,
        name: basename(filePath),
        size: buffer.byteLength,
        content_type: 'application/gzip',
        storage_object_id: storageObject.id,
      });
    }

    await markBackupRunCompleted(runId, files);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup failed';
    await markBackupRunFailed(runId, message);
    throw error;
  } finally {
    await fs.rm(backupDir, { recursive: true, force: true });
  }
}
