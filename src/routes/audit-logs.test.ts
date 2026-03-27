import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';

async function issueSuperAdminToken() {
  const db = getDatabase();
  const [role] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'SUPER_ADMIN')).limit(1);
  if (!role) {
    throw new Error('SUPER_ADMIN role is required for audit log route tests');
  }

  const token = await generateAccessToken(testUser.id, testUser.email, role.id, role.name);
  await createSessionRepository().create({
    user_id: testUser.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });

  return token.token;
}

describe('Audit log routes', () => {
  let server: FastifyInstance;
  let token: string;
  const createdAuditLogIds: string[] = [];

  beforeAll(async () => {
    server = await createTestServer();
    token = await issueSuperAdminToken();
  });

  afterAll(async () => {
    const db = getDatabase();
    if (createdAuditLogIds.length > 0) {
      await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.id, createdAuditLogIds));
    }
    await closeTestServer(server);
  });

  it('returns stored audit log fields plus resolved user details in list and get responses', async () => {
    const db = getDatabase();
    const auditLogId = randomUUID();
    createdAuditLogIds.push(auditLogId);

    await db.insert(schema.auditLogs).values({
      id: auditLogId,
      user_id: testUser.id,
      action: 'SCREEN_UPDATE',
      entity_type: 'SCREEN',
      entity_id: randomUUID(),
      ip_address: '127.0.0.1',
      storage_object_id: randomUUID(),
    });

    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/audit-logs?page=1&limit=10&action=SCREEN_UPDATE',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(listResponse.statusCode).toBe(200);
    const listBody = JSON.parse(listResponse.body);
    const listed = listBody.items.find((item: any) => item.id === auditLogId);
    expect(listed).toBeTruthy();
    expect(listed.user_id).toBe(testUser.id);
    expect(listed.user).toMatchObject({
      id: testUser.id,
      email: testUser.email,
    });
    expect(listed.storage_object_id).toBeTruthy();
    expect(listed.ip_address).toBe('127.0.0.1');

    const getResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/audit-logs/${auditLogId}`,
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(getResponse.statusCode).toBe(200);
    const getBody = JSON.parse(getResponse.body);
    expect(getBody.id).toBe(auditLogId);
    expect(getBody.user).toMatchObject({
      id: testUser.id,
      email: testUser.email,
    });
    expect(getBody.storage_object_id).toBeTruthy();
  });
});
