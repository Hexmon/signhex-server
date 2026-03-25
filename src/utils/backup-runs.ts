import { promisify } from 'util';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { desc, eq } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { putObject, getPresignedUrl } from '@/s3';

const execFileAsync = promisify(execFile);
const ARCHIVE_BUCKET = 'archives';

export type BackupRunRecord = typeof schema.backupRuns.$inferSelect;

async function ensureTempDir() {
  return fs.mkdtemp(join(tmpdir(), 'signhex-backup-'));
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

export async function runFullBackup(runId: string) {
  const db = getDatabase();
  const backupDir = await ensureTempDir();

  try {
    await markBackupRunRunning(runId);

    await execFileAsync('bash', ['scripts/backup_postgres.sh', backupDir], {
      cwd: process.cwd(),
      env: process.env,
    });
    await execFileAsync('bash', ['scripts/backup_minio.sh', backupDir], {
      cwd: process.cwd(),
      env: { ...process.env, BACKUP_SKIP_ARCHIVES: 'true' },
    });

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
