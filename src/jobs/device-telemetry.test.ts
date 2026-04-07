import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDatabase, getDatabase, initializeDatabase, schema } from '@/db';

const putObjectMock = vi.fn();

vi.mock('@/s3', async () => {
  const actual = await vi.importActual<typeof import('@/s3')>('@/s3');
  return {
    ...actual,
    putObject: putObjectMock,
  };
});

const {
  buildHeartbeatObjectKey,
  buildProofOfPlayIdempotencyKey,
  buildProofOfPlayObjectKey,
  processHeartbeatTelemetry,
  processProofOfPlayTelemetry,
  processScreenshotTelemetry,
} = await import('@/jobs/device-telemetry');

async function applyMigrationFile(filename: string) {
  const db = getDatabase();
  const migrationPath = path.resolve(process.cwd(), 'drizzle', 'migrations', filename);
  const content = await readFile(migrationPath, 'utf8');
  const statements = content
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function proofOfPlayIdempotencyColumnExists() {
  const db = getDatabase();
  const result = await db.execute<{ exists: boolean }>(
    sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'proof_of_play'
          AND column_name = 'idempotency_key'
      ) AS exists
    `
  );
  return Boolean((result.rows[0] as { exists?: boolean } | undefined)?.exists);
}

describe('device telemetry persistence workers', () => {
  beforeAll(async () => {
    await initializeDatabase();
    if (!(await proofOfPlayIdempotencyColumnExists())) {
      await applyMigrationFile('0026_telemetry_async_persistence.sql');
    }
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(() => {
    putObjectMock.mockReset();
    putObjectMock.mockResolvedValue({ etag: 'etag-test', sha256: 'sha-test' });
  });

  it('deduplicates proof-of-play duplicate delivery by idempotency key', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const mediaId = randomUUID();
    const scheduleId = randomUUID();
    const startTime = new Date(Date.now() - 15_000).toISOString();
    const endTime = new Date().toISOString();
    const idempotencyKey = buildProofOfPlayIdempotencyKey({
      deviceId,
      mediaId,
      scheduleId,
      startTime,
      endTime,
      duration: 15,
      completed: true,
    });

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'PoP Worker Device',
      status: 'ACTIVE',
    });

    const job = {
      deviceId,
      mediaId,
      scheduleId,
      startTime,
      endTime,
      duration: 15,
      completed: true,
      receivedAt: new Date().toISOString(),
      idempotencyKey,
      objectKey: buildProofOfPlayObjectKey(deviceId, idempotencyKey),
    };

    await processProofOfPlayTelemetry(job);
    await processProofOfPlayTelemetry(job);

    const rows = await db
      .select()
      .from(schema.proofOfPlay)
      .where(eq(schema.proofOfPlay.idempotency_key, idempotencyKey));

    expect(rows).toHaveLength(1);
    expect(putObjectMock).toHaveBeenCalledOnce();
  });

  it('treats heartbeat worker retries as idempotent for a queued event', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const receivedAt = new Date().toISOString();
    const storageObjectId = randomUUID();

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Heartbeat Worker Device',
      status: 'ACTIVE',
    });

    const payload = {
      device_id: deviceId,
      status: 'ONLINE',
      uptime: 120,
      memory_usage: 20,
      cpu_usage: 10,
    };
    const job = {
      deviceId,
      status: 'ONLINE' as const,
      payload,
      receivedAt,
      objectKey: buildHeartbeatObjectKey(deviceId, receivedAt, payload),
      storageObjectId,
    };

    await processHeartbeatTelemetry(job);
    await processHeartbeatTelemetry(job);

    const rows = await db
      .select()
      .from(schema.heartbeats)
      .where(eq(schema.heartbeats.storage_object_id, storageObjectId));

    expect(rows).toHaveLength(1);
    expect(putObjectMock).toHaveBeenCalledOnce();
  });

  it('treats screenshot worker retries as idempotent for a queued event', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const storageObjectId = randomUUID();
    const timestamp = new Date().toISOString();
    const objectKey = `device-screenshots/${deviceId}/${Date.parse(timestamp)}-${storageObjectId}.png`;

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Screenshot Worker Device',
      status: 'ACTIVE',
    });

    const job = {
      deviceId,
      timestamp,
      imageData: Buffer.from('retry-safe-image').toString('base64'),
      objectKey,
      storageObjectId,
    };

    await processScreenshotTelemetry(job);
    await processScreenshotTelemetry(job);

    const rows = await db
      .select()
      .from(schema.screenshots)
      .where(eq(schema.screenshots.storage_object_id, storageObjectId));

    expect(rows).toHaveLength(1);
    expect(putObjectMock).toHaveBeenCalledOnce();
  });
});
