import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { createSessionRepository } from '@/db/repositories/session';
import { generateAccessToken } from '@/auth/jwt';
import { getDatabase, schema } from '@/db';
import { HTTP_STATUS } from '@/http-status-codes';

async function issueAdminToken() {
  const db = getDatabase();
  const [adminRole] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'SUPER_ADMIN')).limit(1);
  if (!adminRole) {
    throw new Error('SUPER_ADMIN role is required for schedule publish tests');
  }

  const currentPermissions =
    adminRole.permissions && typeof adminRole.permissions === 'object'
      ? (adminRole.permissions as { grants?: Array<{ action: string; subject: string }> })
      : {};
  const mergedGrants = [...(currentPermissions.grants || [])];
  for (const grant of [
    { action: 'update', subject: 'Schedule' },
    { action: 'read', subject: 'Screen' },
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

describe('Schedule publish codec validation', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    adminToken = await issueAdminToken();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('blocks publish when a target screen does not support the required media codec', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const mediaId = randomUUID();
    const presentationId = randomUUID();
    const scheduleId = randomUUID();
    const scheduleItemId = randomUUID();
    const now = new Date();
    const startAt = new Date(now.getTime() + 5 * 60 * 1000);
    const endAt = new Date(now.getTime() + 30 * 60 * 1000);

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'VP9 Only Screen',
      status: 'OFFLINE',
      device_info: {
        codecs: ['vp9'],
      },
    });

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'H264 Video',
      type: 'VIDEO',
      status: 'READY',
      created_by: testUser.id,
      source_content_type: 'video/mp4',
    });

    await db.insert(schema.presentations).values({
      id: presentationId,
      name: 'Publish Validation Presentation',
      created_by: testUser.id,
    });

    await db.insert(schema.presentationItems).values({
      id: randomUUID(),
      presentation_id: presentationId,
      media_id: mediaId,
      order: 0,
      duration_seconds: 15,
    });

    await db.insert(schema.schedules).values({
      id: scheduleId,
      name: 'Codec Validation Schedule',
      start_at: startAt,
      end_at: endAt,
      is_active: true,
      created_by: testUser.id,
    });

    await db.insert(schema.scheduleItems).values({
      id: scheduleItemId,
      schedule_id: scheduleId,
      presentation_id: presentationId,
      start_at: startAt,
      end_at: endAt,
      priority: 0,
      screen_ids: [screenId],
      screen_group_ids: [],
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/schedules/${scheduleId}/publish`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        screen_ids: [screenId],
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CONFLICT);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('required media codec');
    expect(body.error.details?.reason).toBe('UNSUPPORTED_SCREEN_CODEC');
    expect(body.error.details?.unsupported_targets?.[0]?.screen_id).toBe(screenId);
    expect(body.error.details?.unsupported_targets?.[0]?.media_id).toBe(mediaId);
    expect(body.error.details?.unsupported_targets?.[0]?.required_codecs).toContain('h264');
  });

  it('blocks publish when a presentation references non-ready media', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const mediaId = randomUUID();
    const presentationId = randomUUID();
    const scheduleId = randomUUID();
    const now = new Date();
    const startAt = new Date(now.getTime() + 5 * 60 * 1000);
    const endAt = new Date(now.getTime() + 30 * 60 * 1000);

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Non Ready Media Screen',
      status: 'OFFLINE',
    });

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Processing Video',
      type: 'VIDEO',
      status: 'PROCESSING',
      created_by: testUser.id,
      source_content_type: 'video/mp4',
    });

    await db.insert(schema.presentations).values({
      id: presentationId,
      name: 'Non Ready Media Presentation',
      created_by: testUser.id,
    });

    await db.insert(schema.presentationItems).values({
      id: randomUUID(),
      presentation_id: presentationId,
      media_id: mediaId,
      order: 0,
      duration_seconds: 10,
    });

    await db.insert(schema.schedules).values({
      id: scheduleId,
      name: 'Non Ready Publish Schedule',
      timezone: 'UTC',
      start_at: startAt,
      end_at: endAt,
      is_active: true,
      created_by: testUser.id,
    } as any);

    await db.insert(schema.scheduleItems).values({
      id: randomUUID(),
      schedule_id: scheduleId,
      presentation_id: presentationId,
      start_at: startAt,
      end_at: endAt,
      priority: 0,
      screen_ids: [screenId],
      screen_group_ids: [],
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/schedules/${scheduleId}/publish`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        screen_ids: [screenId],
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.details?.reason).toBe('INVALID_PRESENTATION_ASSETS');
    expect(body.error.details?.invalid_references?.[0]?.issue).toBe('MEDIA_NOT_READY');
  });
});
