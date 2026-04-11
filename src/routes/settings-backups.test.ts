import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';
import { HTTP_STATUS } from '@/http-status-codes';

const { deleteObjectMock } = vi.hoisted(() => ({
  deleteObjectMock: vi.fn(),
}));

vi.mock('@/s3', async () => {
  const actual = await vi.importActual<typeof import('@/s3')>('@/s3');
  return {
    ...actual,
    deleteObject: deleteObjectMock,
  };
});

async function issueSuperAdminToken() {
  const db = getDatabase();
  const [role] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'SUPER_ADMIN')).limit(1);
  if (!role) {
    throw new Error('SUPER_ADMIN role is required for settings backup route tests');
  }

  const token = await generateAccessToken(testUser.id, testUser.email, role.id, role.name);
  await createSessionRepository().create({
    user_id: testUser.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });
  return token.token;
}

describe('Settings routes - backup deletion', () => {
  let server: FastifyInstance;
  let adminToken: string;
  const createdBackupRunIds: string[] = [];
  const createdStorageObjectIds: string[] = [];

  beforeAll(async () => {
    server = await createTestServer();
    adminToken = await issueSuperAdminToken();
  });

  afterAll(async () => {
    const db = getDatabase();
    if (createdBackupRunIds.length > 0) {
      await db.delete(schema.backupRuns).where(inArray(schema.backupRuns.id, createdBackupRunIds));
    }
    if (createdStorageObjectIds.length > 0) {
      await db.delete(schema.storageObjects).where(inArray(schema.storageObjects.id, createdStorageObjectIds));
    }
    await closeTestServer(server);
  });

  beforeEach(() => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
  });

  const insertBackupRun = async (params: {
    status: 'COMPLETED' | 'FAILED' | 'PENDING' | 'RUNNING';
    withFiles?: boolean;
  }) => {
    const db = getDatabase();
    const files =
      params.withFiles === false
        ? []
        : [
            {
              id: randomUUID(),
              bucket: 'archives',
              object_key: `backups/${randomUUID()}/artifact.tar.gz`,
              content_type: 'application/gzip',
              size: 1024,
              sha256: randomUUID().replace(/-/g, ''),
            },
          ];

    if (files.length > 0) {
      const storageRows = await db
        .insert(schema.storageObjects)
        .values(
          files.map((file) => ({
            id: file.id,
            bucket: file.bucket,
            object_key: file.object_key,
            content_type: file.content_type,
            size: file.size,
            sha256: file.sha256,
          }))
        )
        .returning();
      createdStorageObjectIds.push(...storageRows.map((row) => row.id));
    }

    const [run] = await db
      .insert(schema.backupRuns)
      .values({
        id: randomUUID(),
        trigger_type: 'MANUAL',
        status: params.status,
        triggered_by: testUser.id,
        started_at: new Date(),
        completed_at: params.status === 'PENDING' || params.status === 'RUNNING' ? null : new Date(),
        files: files.map((file) => ({
          bucket: file.bucket,
          object_key: file.object_key,
          name: file.object_key.split('/').pop() ?? 'artifact.tar.gz',
          size: file.size,
          content_type: file.content_type,
          storage_object_id: file.id,
        })),
      })
      .returning();

    createdBackupRunIds.push(run.id);
    return run;
  };

  it('deletes completed backups and associated archive records', async () => {
    const run = await insertBackupRun({ status: 'COMPLETED', withFiles: true });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/settings/backups/${run.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    expect(JSON.parse(response.body)).toEqual({
      id: run.id,
      deleted: true,
    });
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);

    const db = getDatabase();
    const [deletedRun] = await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, run.id));
    expect(deletedRun).toBeUndefined();

    const storageObjectId = run.files?.[0]?.storage_object_id;
    expect(storageObjectId).toBeTruthy();
    const [deletedStorageObject] = await db
      .select()
      .from(schema.storageObjects)
      .where(eq(schema.storageObjects.id, storageObjectId!));
    expect(deletedStorageObject).toBeUndefined();
  });

  it('deletes failed backups even when they have no files', async () => {
    const run = await insertBackupRun({ status: 'FAILED', withFiles: false });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/settings/backups/${run.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    expect(deleteObjectMock).not.toHaveBeenCalled();

    const db = getDatabase();
    const [deletedRun] = await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, run.id));
    expect(deletedRun).toBeUndefined();
  });

  it('returns 404 for unknown backup runs', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/settings/backups/${randomUUID()}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    expect(JSON.parse(response.body).error.message).toBe('Backup run not found');
  });

  it('returns 409 when deleting pending backups', async () => {
    const run = await insertBackupRun({ status: 'PENDING', withFiles: false });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/settings/backups/${run.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CONFLICT);
    expect(JSON.parse(response.body).error.message).toBe('In-progress backups cannot be deleted');
  });

  it('returns 409 when deleting running backups', async () => {
    const run = await insertBackupRun({ status: 'RUNNING', withFiles: false });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/settings/backups/${run.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CONFLICT);
    expect(JSON.parse(response.body).error.message).toBe('In-progress backups cannot be deleted');
  });

  it('still deletes the backup row if an archive object is already missing', async () => {
    const run = await insertBackupRun({ status: 'COMPLETED', withFiles: true });
    deleteObjectMock.mockRejectedValueOnce({
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/settings/backups/${run.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);

    const db = getDatabase();
    const [deletedRun] = await db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, run.id));
    expect(deletedRun).toBeUndefined();
  });
});
