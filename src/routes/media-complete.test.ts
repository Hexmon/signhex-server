import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDatabase, initializeDatabase, schema } from '@/db';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';
import { hashPassword } from '@/auth/password';
import { HTTP_STATUS } from '@/http-status-codes';

const {
  headObjectMock,
  getPresignedUrlMock,
  queueFFmpegTranscodeMock,
  queueFFmpegThumbnailMock,
} = vi.hoisted(() => ({
  headObjectMock: vi.fn(),
  getPresignedUrlMock: vi.fn(),
  queueFFmpegTranscodeMock: vi.fn(),
  queueFFmpegThumbnailMock: vi.fn(),
}));

vi.mock('@/s3', async () => {
  const actual = await vi.importActual<typeof import('@/s3')>('@/s3');
  return {
    ...actual,
    headObject: headObjectMock,
    getPresignedUrl: getPresignedUrlMock,
  };
});

vi.mock('@/jobs', async () => {
  const actual = await vi.importActual<typeof import('@/jobs')>('@/jobs');
  return {
    ...actual,
    queueFFmpegTranscode: queueFFmpegTranscodeMock,
    queueFFmpegThumbnail: queueFFmpegThumbnailMock,
  };
});

const { createServer } = await import('@/server');

type RolePermissions = {
  grants: Array<{ action: string; subject: string }>;
};

describe('Media Routes - authoritative upload finalization', () => {
  let server: FastifyInstance;
  let ownerUserId: string;
  let ownerToken: string;

  beforeAll(async () => {
    await initializeDatabase();
    server = await createServer();

    const db = getDatabase();
    const ensureRole = async (name: string, permissions: RolePermissions) => {
      const [existing] = await db
        .select()
        .from(schema.roles)
        .where(eq(schema.roles.name, name))
        .limit(1);

      if (existing) {
        return existing;
      }

      const [created] = await db
        .insert(schema.roles)
        .values({
          id: randomUUID(),
          name,
          permissions,
          is_system: true,
        })
        .returning();

      return created;
    };

    const uploaderRole = await ensureRole('SUPER_ADMIN', { grants: [] });

    ownerUserId = randomUUID();
    await db.insert(schema.users).values({
      id: ownerUserId,
      email: `media-complete-${Date.now()}@example.com`,
      password_hash: await hashPassword('Password123!'),
      first_name: 'Media',
      last_name: 'Owner',
      role_id: uploaderRole.id,
      is_active: true,
    });

    const access = await generateAccessToken(
      ownerUserId,
      `media-complete-${ownerUserId}@example.com`,
      uploaderRole.id,
      uploaderRole.name
    );
    await createSessionRepository().create({
      user_id: ownerUserId,
      access_jti: access.jti,
      expires_at: access.expiresAt,
    });
    ownerToken = access.token;
  });

  afterAll(async () => {
    await server.close();
    await closeDatabase();
  });

  beforeEach(() => {
    headObjectMock.mockReset();
    getPresignedUrlMock.mockReset();
    queueFFmpegTranscodeMock.mockReset();
    queueFFmpegThumbnailMock.mockReset();
    getPresignedUrlMock.mockResolvedValue('http://signed.test/object');
    queueFFmpegTranscodeMock.mockResolvedValue(undefined);
    queueFFmpegThumbnailMock.mockResolvedValue(undefined);
  });

  const insertMedia = async (params: {
    type: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
    status?: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
    sourceSize?: number;
    sourceObjectId?: string | null;
  }) => {
    const db = getDatabase();
    const [media] = await db
      .insert(schema.media)
      .values({
        id: randomUUID(),
        name: `${params.type.toLowerCase()}-${Date.now()}`,
        type: params.type,
        status: params.status ?? 'PENDING',
        created_by: ownerUserId,
        source_bucket: 'media-source',
        source_object_key: `${randomUUID()}/upload.bin`,
        source_size: params.sourceSize ?? 1024,
        source_object_id: params.sourceObjectId ?? null,
      })
      .returning();

    return media;
  };

  it('marks image uploads READY only after server-side storage verification', async () => {
    const media = await insertMedia({ type: 'IMAGE', sourceSize: 2048 });
    headObjectMock.mockResolvedValue({
      ContentLength: 2048,
      ContentType: 'image/png',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/media/${media.id}/complete`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
      },
      payload: {
        status: 'FAILED',
        content_type: 'image/png',
        size: 2048,
        width: 1920,
        height: 1080,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('READY');
    expect(body.status_reason).toBeUndefined();
    expect(body.media_url).toBe('http://signed.test/object');
    expect(body.content_type).toBe('image/png');
    expect(body.size).toBe(2048);
    expect(queueFFmpegTranscodeMock).not.toHaveBeenCalled();
    expect(queueFFmpegThumbnailMock).not.toHaveBeenCalled();

    const db = getDatabase();
    const [updated] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, media.id));
    expect(updated?.status).toBe('READY');
    expect(updated?.source_object_id).toBeTruthy();

    const [storageObject] = await db
      .select()
      .from(schema.storageObjects)
      .where(eq(schema.storageObjects.id, updated!.source_object_id!));
    expect(storageObject.bucket).toBe('media-source');
    expect(storageObject.object_key).toBe(media.source_object_key);
    expect(storageObject.content_type).toBe('image/png');
    expect(storageObject.size).toBe(2048);
  });

  it('returns PROCESSING for video uploads and queues backend jobs', async () => {
    const media = await insertMedia({ type: 'VIDEO', sourceSize: 4096 });
    headObjectMock.mockResolvedValue({
      ContentLength: 4096,
      ContentType: 'video/mp4',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/media/${media.id}/complete`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
      },
      payload: {
        content_type: 'video/mp4',
        size: 4096,
        width: 1280,
        height: 720,
        duration_seconds: 42,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('PROCESSING');
    expect(body.media_url).toBeNull();
    expect(queueFFmpegTranscodeMock).toHaveBeenCalledTimes(1);
    expect(queueFFmpegThumbnailMock).toHaveBeenCalledTimes(1);

    const db = getDatabase();
    const [updated] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, media.id));
    expect(updated?.status).toBe('PROCESSING');
    expect(updated?.source_object_id).toBeTruthy();
  });

  it('rejects completion when the storage object is missing', async () => {
    const media = await insertMedia({ type: 'DOCUMENT', sourceSize: 1024 });
    headObjectMock.mockRejectedValue({
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/media/${media.id}/complete`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
      },
      payload: {
        content_type: 'application/pdf',
        size: 1024,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    const body = JSON.parse(response.body);
    expect(body.error.message).toBe('Source object not found in storage');
    expect(queueFFmpegTranscodeMock).not.toHaveBeenCalled();
  });

  it('rejects completion when the uploaded size does not match the presigned expectation', async () => {
    const media = await insertMedia({ type: 'DOCUMENT', sourceSize: 1024 });
    headObjectMock.mockResolvedValue({
      ContentLength: 2048,
      ContentType: 'application/pdf',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/media/${media.id}/complete`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
      },
      payload: {
        content_type: 'application/pdf',
        size: 2048,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    const body = JSON.parse(response.body);
    expect(body.error.message).toBe('Uploaded object size does not match expected size');
    expect(body.error.details.expected_size).toBe(1024);
    expect(body.error.details.actual_size).toBe(2048);
  });

  it('is idempotent for items already in PROCESSING', async () => {
    const sourceObjectId = randomUUID();
    const db = getDatabase();
    await db.insert(schema.storageObjects).values({
      id: sourceObjectId,
      bucket: 'media-source',
      object_key: `source/${sourceObjectId}.mp4`,
      content_type: 'video/mp4',
      size: 4096,
    });

    const media = await insertMedia({
      type: 'VIDEO',
      status: 'PROCESSING',
      sourceSize: 4096,
      sourceObjectId,
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/media/${media.id}/complete`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
      },
      payload: {
        content_type: 'video/mp4',
        size: 4096,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('PROCESSING');
    expect(queueFFmpegTranscodeMock).not.toHaveBeenCalled();
    expect(queueFFmpegThumbnailMock).not.toHaveBeenCalled();
  });
});
