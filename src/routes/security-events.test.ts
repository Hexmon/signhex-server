import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { createSessionRepository } from '@/db/repositories/session';
import { generateAccessToken } from '@/auth/jwt';
import { getDatabase, schema } from '@/db';

async function issueSuperAdminToken() {
  const db = getDatabase();
  const [role] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'SUPER_ADMIN')).limit(1);
  if (!role) {
    throw new Error('SUPER_ADMIN role is required for security event route tests');
  }

  const token = await generateAccessToken(testUser.id, testUser.email, role.id, role.name);
  await createSessionRepository().create({
    user_id: testUser.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });

  return token.token;
}

describe('Security event routes', () => {
  let server: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    server = await createTestServer();
    token = await issueSuperAdminToken();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('records authenticated CMS client security events in the audit log', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/security/client-events',
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'Vitest Browser',
      },
      payload: {
        event: 'CMS_DEVTOOLS_ATTEMPT',
        context: {
          route: '/reports',
          trigger: 'shortcut',
          detected_at: '2026-03-29T12:00:00.000Z',
        },
      },
    });

    expect(response.statusCode).toBe(204);

    const db = getDatabase();
    const [auditLog] = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, 'CMS_DEVTOOLS_ATTEMPT'))
      .orderBy(desc(schema.auditLogs.created_at));

    expect(auditLog).toBeTruthy();
    expect(auditLog?.user_id).toBe(testUser.id);
    expect(auditLog?.entity_type).toBe('SECURITY_EVENT');
    expect(auditLog?.ip_address).toBeTruthy();
  });
});
