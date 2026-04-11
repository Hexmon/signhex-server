import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { createSessionRepository } from '@/db/repositories/session';
import { generateAccessToken } from '@/auth/jwt';
import { getDatabase, schema } from '@/db';

async function issueSuperAdminToken() {
  const db = getDatabase();
  const [role] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'SUPER_ADMIN')).limit(1);
  if (!role) {
    throw new Error('SUPER_ADMIN role is required for reports export tests');
  }

  const token = await generateAccessToken(testUser.id, testUser.email, role.id, role.name);
  await createSessionRepository().create({
    user_id: testUser.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });

  return token.token;
}

describe('Reports PDF exports', () => {
  let server: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    server = await createTestServer();
    token = await issueSuperAdminToken();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('exports the reports snapshot as a non-empty PDF', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const mediaId = randomUUID();

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Export Screen',
      status: 'ACTIVE',
    });
    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Export Media',
      type: 'IMAGE',
      status: 'READY',
      created_by: testUser.id,
    });
    await db.insert(schema.notifications).values({
      id: randomUUID(),
      user_id: testUser.id,
      title: 'Export Notification',
      message: 'Notification body',
      type: 'INFO',
      is_read: false,
    });
    await db.insert(schema.proofOfPlay).values({
      id: randomUUID(),
      screen_id: screenId,
      media_id: mediaId,
      started_at: new Date('2026-03-01T10:00:00.000Z'),
      ended_at: new Date('2026-03-01T10:05:00.000Z'),
      created_at: new Date('2026-03-01T10:05:30.000Z'),
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/reports/export',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/pdf',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('.pdf');
    expect(response.body.startsWith('%PDF')).toBe(true);
    expect(response.body.length).toBeGreaterThan(500);
  });

  it('exports filtered audit logs as a non-empty PDF', async () => {
    const db = getDatabase();

    await db.insert(schema.auditLogs).values({
      id: randomUUID(),
      user_id: testUser.id,
      action: 'SCREEN_UPDATE',
      entity_type: 'Screen',
      entity_id: randomUUID(),
      ip_address: '127.0.0.1',
      created_at: new Date('2026-03-02T09:00:00.000Z'),
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/audit-logs/export?action=SCREEN_UPDATE',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/pdf',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('.pdf');
    expect(response.body.startsWith('%PDF')).toBe(true);
    expect(response.body.length).toBeGreaterThan(500);
  });
});
