import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
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
    throw new Error('ADMIN role is required for emergency route tests');
  }

  const currentPermissions =
    adminRole.permissions && typeof adminRole.permissions === 'object'
      ? (adminRole.permissions as { grants?: Array<{ action: string; subject: string }> })
      : {};
  const mergedGrants = [...(currentPermissions.grants || [])];
  for (const grant of [{ action: 'update', subject: 'Screen' }]) {
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

describe('Emergency routes production contract', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    adminToken = await issueAdminToken();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('allows multiple concurrent active emergencies and exposes sorted status details', async () => {
    const db = getDatabase();
    const groupId = randomUUID();
    const screenId = randomUUID();
    const mediaGlobal = randomUUID();
    const mediaGroup = randomUUID();

    await db.insert(schema.screenGroups).values({
      id: groupId,
      name: 'Emergency Status Group',
    });
    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Emergency Status Screen',
      status: 'ACTIVE',
    });
    await db.insert(schema.screenGroupMembers).values({
      group_id: groupId,
      screen_id: screenId,
    });
    await db.insert(schema.media).values([
      {
        id: mediaGlobal,
        name: 'Global Banner',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
      },
      {
        id: mediaGroup,
        name: 'Group Banner',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
      },
    ]);

    const globalResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/emergency/trigger',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        message: 'Global emergency',
        severity: 'LOW',
        media_id: mediaGlobal,
        target_all: true,
        audit_note: 'Global notice',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    expect(globalResponse.statusCode).toBe(HTTP_STATUS.CREATED);

    const groupResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/emergency/trigger',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        message: 'Group emergency',
        severity: 'CRITICAL',
        media_id: mediaGroup,
        screen_group_ids: [groupId],
        audit_note: 'Group notice',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    expect(groupResponse.statusCode).toBe(HTTP_STATUS.CREATED);

    const statusResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/emergency/status',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(statusResponse.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(statusResponse.body);
    expect(body.active).toBe(true);
    expect(body.active_count).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.active_emergencies)).toBe(true);
    expect(body.active_emergencies.length).toBeGreaterThanOrEqual(2);
    expect(body.emergency.scope).toBe('GLOBAL');
    expect(body.active_emergencies[0]).toEqual(
      expect.objectContaining({
        message: 'Global emergency',
        audit_note: 'Global notice',
      })
    );

    const refreshCommands = await db
      .select()
      .from(schema.deviceCommands)
      .where(eq(schema.deviceCommands.screen_id, screenId));
    const pendingRefreshCommands = refreshCommands.filter((command) => command.type === 'REFRESH' && command.status === 'PENDING');
    expect(pendingRefreshCommands).toHaveLength(1);
    expect((pendingRefreshCommands[0]?.payload as { reason?: string } | null)?.reason).toBe('EMERGENCY');
  });

  it('requires exactly one target scope and persists clear_reason on clear', async () => {
    const mixedScopeResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/emergency/trigger',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        message: 'Invalid mixed scope',
        target_all: true,
        screen_ids: [randomUUID()],
      },
    });

    expect(mixedScopeResponse.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);

    const triggerResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/emergency/trigger',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        message: 'Clearable emergency',
        target_all: true,
        audit_note: 'Need to clear later',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });

    expect(triggerResponse.statusCode).toBe(HTTP_STATUS.CREATED);
    const triggered = JSON.parse(triggerResponse.body);

    const clearResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/emergency/${triggered.id}/clear`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        clear_reason: 'Incident resolved',
      },
    });

    expect(clearResponse.statusCode).toBe(HTTP_STATUS.OK);
    const cleared = JSON.parse(clearResponse.body);
    expect(cleared.clear_reason).toBe('Incident resolved');
    expect(cleared.cleared_by).toBe(testUser.id);

    const db = getDatabase();
    const [stored] = await db.select().from(schema.emergencies).where(eq(schema.emergencies.id, triggered.id)).limit(1);
    expect(stored?.clear_reason).toBe('Incident resolved');
  });
});
