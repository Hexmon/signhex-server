import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createSessionRepository } from '@/db/repositories/session';
import { generateAccessToken } from '@/auth/jwt';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { HTTP_STATUS } from '@/http-status-codes';

async function issueAdminToken() {
  const db = getDatabase();
  const [adminRole] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'ADMIN')).limit(1);
  if (!adminRole) {
    throw new Error('ADMIN role is required for screen group route tests');
  }

  const currentPermissions =
    adminRole.permissions && typeof adminRole.permissions === 'object'
      ? (adminRole.permissions as { grants?: Array<{ action: string; subject: string }> })
      : {};
  const mergedGrants = [...(currentPermissions.grants || [])];
  for (const grant of [{ action: 'read', subject: 'ScreenGroup' }]) {
    if (!mergedGrants.some((current) => current.action === grant.action && current.subject === grant.subject)) {
      mergedGrants.push(grant);
    }
  }

  await db
    .update(schema.roles)
    .set({ permissions: { grants: mergedGrants } })
    .where(eq(schema.roles.id, adminRole.id));

  const token = await generateAccessToken(testUser.id, testUser.email, adminRole.id, adminRole.name);
  await createSessionRepository().create({
    user_id: testUser.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });
  return token.token;
}

describe('Screen group list summaries', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    adminToken = await issueAdminToken();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('returns paginated group summaries with server-side search', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const groupId = randomUUID();
    const searchToken = `group-${randomUUID().slice(0, 8)}`;

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Group Summary Screen',
      location: 'Group Summary Lobby',
      status: 'ACTIVE',
      last_heartbeat_at: new Date(),
    });

    await db.insert(schema.screenGroups).values({
      id: groupId,
      name: `North Group Summary ${searchToken}`,
      description: `North Group Summary Description ${searchToken}`,
    });

    await db.insert(schema.screenGroupMembers).values({
      group_id: groupId,
      screen_id: screenId,
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/screen-groups?include_summary=true&q=${encodeURIComponent(searchToken)}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body) as any;
    expect(typeof body.server_time).toBe('string');
    expect(body.pagination.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual(
      expect.objectContaining({
        id: groupId,
        name: `North Group Summary ${searchToken}`,
        screen_ids: [screenId],
      }),
    );
    expect(Array.isArray(body.items[0].active_items)).toBe(true);
    expect(Array.isArray(body.items[0].upcoming_items)).toBe(true);
  });
});
