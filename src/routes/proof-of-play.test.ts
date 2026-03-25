import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { createSessionRepository } from '@/db/repositories/session';
import { getDatabase, schema } from '@/db';
import { generateAccessToken } from '@/auth/jwt';

describe('Proof of play export', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    const db = getDatabase();
    const [role] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'SUPER_ADMIN')).limit(1);
    if (!role) {
      throw new Error('SUPER_ADMIN role is required for proof-of-play export tests');
    }

    const issued = await generateAccessToken(testUser.id, testUser.email, role.id, role.name);
    await createSessionRepository().create({
      user_id: testUser.id,
      access_jti: issued.jti,
      expires_at: issued.expiresAt,
    });
    adminToken = issued.token;
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('returns CSV headers even when there are no proof-of-play rows', async () => {
    const db = getDatabase();
    await db.delete(schema.proofOfPlay);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/proof-of-play/export',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body.trim()).toBe('id,screen_id,media_id,presentation_id,started_at,ended_at,created_at');
  });
});
