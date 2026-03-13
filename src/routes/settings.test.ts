import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { HTTP_STATUS } from '@/http-status-codes';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';

async function issueSuperAdminToken() {
  const db = getDatabase();
  const [role] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'SUPER_ADMIN')).limit(1);
  if (!role) {
    throw new Error('SUPER_ADMIN role is required for settings route tests');
  }

  const token = await generateAccessToken(testUser.id, testUser.email, role.id, role.name);
  await createSessionRepository().create({
    user_id: testUser.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });
  return token.token;
}

describe('Settings routes - dimension-wise default media', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    adminToken = await issueSuperAdminToken();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('stores and returns default media variants with embedded media details', async () => {
    const db = getDatabase();
    const globalMediaId = randomUUID();
    const landscapeMediaId = randomUUID();
    const portraitMediaId = randomUUID();
    const landscapeRatio = '101:99';
    const portraitRatio = '77:123';

    await db.insert(schema.media).values([
      {
        id: globalMediaId,
        name: 'Global Fallback',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
        width: 1280,
        height: 720,
      },
      {
        id: landscapeMediaId,
        name: 'Landscape Fallback',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
        width: 1920,
        height: 1080,
      },
      {
        id: portraitMediaId,
        name: 'Portrait Fallback',
        type: 'VIDEO',
        status: 'READY',
        created_by: testUser.id,
        width: 1080,
        height: 1920,
        duration_seconds: 15,
      },
    ]);

    const globalResponse = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/default-media',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        media_id: globalMediaId,
      },
    });

    expect(globalResponse.statusCode).toBe(HTTP_STATUS.OK);

    const variantsResponse = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/default-media/variants',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        variants: {
          [landscapeRatio]: landscapeMediaId,
          [portraitRatio]: portraitMediaId,
          '4:3': null,
        },
      },
    });

    expect(variantsResponse.statusCode).toBe(HTTP_STATUS.OK);
    const variantsBody = JSON.parse(variantsResponse.body);
    expect(variantsBody.global_media_id).toBe(globalMediaId);
    expect(variantsBody.global_media?.id).toBe(globalMediaId);
    expect(variantsBody.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aspect_ratio: landscapeRatio,
          media_id: landscapeMediaId,
          media: expect.objectContaining({ id: landscapeMediaId, name: 'Landscape Fallback' }),
        }),
        expect.objectContaining({
          aspect_ratio: portraitRatio,
          media_id: portraitMediaId,
          media: expect.objectContaining({ id: portraitMediaId, name: 'Portrait Fallback' }),
        }),
      ])
    );

    expect(variantsBody.variants).toHaveLength(2);
  });

  it('rejects unknown media ids in default media variants payload', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/default-media/variants',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        variants: {
          '16:9': randomUUID(),
        },
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.message).toBe('Media not found');
  });
});
