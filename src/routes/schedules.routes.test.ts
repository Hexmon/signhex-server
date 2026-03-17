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
    throw new Error('ADMIN role is required for schedule route tests');
  }

  const currentPermissions =
    adminRole.permissions && typeof adminRole.permissions === 'object'
      ? (adminRole.permissions as { grants?: Array<{ action: string; subject: string }> })
      : {};
  const mergedGrants = [...(currentPermissions.grants || [])];
  for (const grant of [
    { action: 'create', subject: 'Schedule' },
    { action: 'read', subject: 'Schedule' },
    { action: 'update', subject: 'Schedule' },
  ]) {
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

describe('Schedule routes contract hardening', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    adminToken = await issueAdminToken();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('creates and returns timezone-aware schedules without changing UTC execution fields', async () => {
    const now = new Date();
    const startAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    const endAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        name: `Timezone Schedule ${randomUUID()}`,
        description: 'Contract test schedule',
        timezone: 'Asia/Kolkata',
        start_at: startAt,
        end_at: endAt,
      },
    });

    expect(createResponse.statusCode).toBe(HTTP_STATUS.CREATED);
    const createBody = JSON.parse(createResponse.body);
    expect(createBody.timezone).toBe('Asia/Kolkata');
    expect(createBody.start_at).toBe(startAt);
    expect(createBody.end_at).toBe(endAt);

    const getResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/schedules/${createBody.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(getResponse.statusCode).toBe(HTTP_STATUS.OK);
    const getBody = JSON.parse(getResponse.body);
    expect(getBody.timezone).toBe('Asia/Kolkata');

    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/schedules?page=1&limit=10',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(listResponse.statusCode).toBe(HTTP_STATUS.OK);
    const listBody = JSON.parse(listResponse.body);
    const listed = listBody.items.find((entry: any) => entry.id === createBody.id);
    expect(listed?.timezone).toBe('Asia/Kolkata');
  });

  it('rejects overlapping schedule items for the same effective targets', async () => {
    const db = getDatabase();
    const scheduleId = randomUUID();
    const presentationA = randomUUID();
    const presentationB = randomUUID();
    const screenId = randomUUID();
    const now = new Date();
    const scheduleStart = new Date(now.getTime() + 5 * 60 * 1000);
    const scheduleEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Overlap Screen',
      status: 'OFFLINE',
    });

    await db.insert(schema.presentations).values([
      {
        id: presentationA,
        name: 'Presentation A',
        created_by: testUser.id,
      },
      {
        id: presentationB,
        name: 'Presentation B',
        created_by: testUser.id,
      },
    ]);

    await db.insert(schema.schedules).values({
      id: scheduleId,
      name: 'Overlap Schedule',
      timezone: 'UTC',
      start_at: scheduleStart,
      end_at: scheduleEnd,
      is_active: true,
      created_by: testUser.id,
    } as any);

    const firstStart = new Date(scheduleStart.getTime() + 10 * 60 * 1000).toISOString();
    const firstEnd = new Date(scheduleStart.getTime() + 30 * 60 * 1000).toISOString();
    const overlapStart = new Date(scheduleStart.getTime() + 20 * 60 * 1000).toISOString();
    const overlapEnd = new Date(scheduleStart.getTime() + 40 * 60 * 1000).toISOString();

    const firstItem = await server.inject({
      method: 'POST',
      url: `/api/v1/schedules/${scheduleId}/items`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        presentation_id: presentationA,
        start_at: firstStart,
        end_at: firstEnd,
        screen_ids: [screenId],
      },
    });
    expect(firstItem.statusCode).toBe(HTTP_STATUS.CREATED);

    const overlapResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/schedules/${scheduleId}/items`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        presentation_id: presentationB,
        start_at: overlapStart,
        end_at: overlapEnd,
        screen_ids: [screenId],
      },
    });

    expect(overlapResponse.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    const body = JSON.parse(overlapResponse.body);
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('overlaps');
  });
});
