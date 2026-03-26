import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDatabase, initializeDatabase, schema } from '@/db';
import { createServer } from '@/server';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';
import { hashPassword } from '@/auth/password';
import { HTTP_STATUS } from '@/http-status-codes';

const { headObjectMock, getPresignedUrlMock } = vi.hoisted(() => ({
  headObjectMock: vi.fn(),
  getPresignedUrlMock: vi.fn(),
}));

vi.mock('@/s3', async () => {
  const actual = await vi.importActual<typeof import('@/s3')>('@/s3');
  return {
    ...actual,
    headObject: headObjectMock,
    getPresignedUrl: getPresignedUrlMock,
  };
});

type RolePermissions = {
  grants: Array<{ action: string; subject: string }>;
};

describe('Media Routes - READY list pagination', () => {
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

    const superAdminRole = await ensureRole('SUPER_ADMIN', { grants: [] });

    ownerUserId = randomUUID();
    await db.insert(schema.users).values({
      id: ownerUserId,
      email: `media-ready-list-${Date.now()}@example.com`,
      password_hash: await hashPassword('Password123!'),
      first_name: 'Ready',
      last_name: 'List',
      role_id: superAdminRole.id,
      is_active: true,
    });

    const access = await generateAccessToken(
      ownerUserId,
      `media-ready-list-${ownerUserId}@example.com`,
      superAdminRole.id,
      superAdminRole.name
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
    getPresignedUrlMock.mockResolvedValue('http://signed.test/valid');
  });

  it('returns valid READY media even when newer broken READY rows fill the first raw page', async () => {
    const db = getDatabase();
    const validId = randomUUID();
    const validKey = `${validId}/valid.png`;

    headObjectMock.mockImplementation(async (bucket: string, key: string) => {
      if (bucket === 'media-source' && key === validKey) {
        return { ContentLength: 1024, ContentType: 'image/png' };
      }
      const error = new Error('NotFound') as Error & {
        name: string;
        $metadata: { httpStatusCode: number };
      };
      error.name = 'NotFound';
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    });

    const brokenRows = Array.from({ length: 100 }).map((_, index) => ({
      id: randomUUID(),
      name: `broken-${index}-${Date.now()}`,
      type: 'IMAGE' as const,
      status: 'READY' as const,
      created_by: ownerUserId,
      created_at: new Date(Date.now() + index),
      updated_at: new Date(Date.now() + index),
    }));

    await db.insert(schema.media).values(brokenRows);

    await db.insert(schema.media).values({
      id: validId,
      name: `valid-${Date.now()}`,
      type: 'IMAGE',
      status: 'READY',
      created_by: ownerUserId,
      source_bucket: 'media-source',
      source_object_key: validKey,
      created_at: new Date(Date.now() - 60_000),
      updated_at: new Date(Date.now() - 60_000),
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/media?limit=20&page=1&status=READY',
      headers: {
        authorization: `Bearer ${ownerToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: validId,
          status: 'READY',
          media_url: 'http://signed.test/valid',
        }),
      ])
    );
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
  });
});
