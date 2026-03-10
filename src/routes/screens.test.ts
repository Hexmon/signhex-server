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
    throw new Error('ADMIN role is required for screens route tests');
  }

  const token = await generateAccessToken(testUser.id, testUser.email, adminRole.id, adminRole.name);
  await createSessionRepository().create({
    user_id: testUser.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });
  return token.token;
}

function buildScheduleSnapshotPayload(params: {
  itemId: string;
  mediaId: string;
  scheduleId: string;
  screenId: string;
  startAt: string;
  endAt: string;
}) {
  return {
    schedule: {
      id: params.scheduleId,
      name: 'Realtime Schedule',
      start_at: params.startAt,
      end_at: params.endAt,
      items: [
        {
          id: params.itemId,
          presentation_id: randomUUID(),
          start_at: params.startAt,
          end_at: params.endAt,
          screen_ids: [params.screenId],
          screen_group_ids: [],
          presentation: {
            id: randomUUID(),
            name: 'Playback Presentation',
            items: [
              {
                id: randomUUID(),
                media_id: params.mediaId,
                order: 0,
                duration_seconds: 15,
                media: {
                  id: params.mediaId,
                  name: 'Playback Media',
                  type: 'VIDEO',
                  status: 'READY',
                },
              },
            ],
            slots: [],
          },
        },
      ],
    },
  };
}

describe('Screens routes realtime playback bootstrap', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    adminToken = await issueAdminToken();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('returns server_time and playback in screens overview while preserving existing fields', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const mediaId = randomUUID();
    const scheduleId = randomUUID();
    const snapshotId = randomUUID();
    const publishId = randomUUID();
    const itemId = randomUUID();
    const now = new Date();
    const startAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const endAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Overview Screen',
      status: 'ACTIVE',
      last_heartbeat_at: now,
      current_schedule_id: scheduleId,
      current_media_id: mediaId,
    });

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Overview Media',
      type: 'VIDEO',
      status: 'READY',
      created_by: testUser.id,
      duration_seconds: 15,
      width: 1920,
      height: 1080,
    });

    await db.insert(schema.schedules).values({
      id: scheduleId,
      name: 'Overview Schedule',
      start_at: new Date(startAt),
      end_at: new Date(endAt),
      is_active: true,
      created_by: testUser.id,
    });

    await db.insert(schema.scheduleSnapshots).values({
      id: snapshotId,
      schedule_id: scheduleId,
      payload: buildScheduleSnapshotPayload({
        itemId,
        mediaId,
        scheduleId,
        screenId,
        startAt,
        endAt,
      }),
    });

    await db.insert(schema.publishes).values({
      id: publishId,
      schedule_id: scheduleId,
      snapshot_id: snapshotId,
      published_by: testUser.id,
    });

    await db.insert(schema.publishTargets).values({
      publish_id: publishId,
      screen_id: screenId,
    });

    await db.insert(schema.proofOfPlay).values({
      screen_id: screenId,
      media_id: mediaId,
      presentation_id: scheduleId,
      started_at: new Date(startAt),
      ended_at: new Date(endAt),
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/screens/overview?include_media=true',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body) as any;
    expect(typeof body.server_time).toBe('string');

    const screen = body.screens.find((entry: any) => entry.id === screenId);
    expect(screen).toBeTruthy();
    expect(screen.current_media_id).toBe(mediaId);
    expect(screen.active_items).toHaveLength(1);
    expect(screen.playback.source).toBe('HEARTBEAT');
    expect(screen.playback.current_item_id).toBe(itemId);
    expect(screen.playback.current_media_id).toBe(mediaId);
    expect(screen.playback.current_media.id).toBe(mediaId);
    expect(typeof screen.playback.last_proof_of_play_at).toBe('string');
    expect(screen.publish.publish_id).toBe(publishId);
  });

  it('returns normalized playback fields from now-playing', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const mediaId = randomUUID();
    const scheduleId = randomUUID();
    const snapshotId = randomUUID();
    const publishId = randomUUID();
    const itemId = randomUUID();
    const now = new Date();
    const startAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const endAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Now Playing Screen',
      status: 'ACTIVE',
      last_heartbeat_at: now,
      current_schedule_id: scheduleId,
      current_media_id: mediaId,
    });

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Now Playing Media',
      type: 'VIDEO',
      status: 'READY',
      created_by: testUser.id,
      duration_seconds: 30,
    });

    await db.insert(schema.schedules).values({
      id: scheduleId,
      name: 'Now Playing Schedule',
      start_at: new Date(startAt),
      end_at: new Date(endAt),
      is_active: true,
      created_by: testUser.id,
    });

    await db.insert(schema.scheduleSnapshots).values({
      id: snapshotId,
      schedule_id: scheduleId,
      payload: buildScheduleSnapshotPayload({
        itemId,
        mediaId,
        scheduleId,
        screenId,
        startAt,
        endAt,
      }),
    });

    await db.insert(schema.publishes).values({
      id: publishId,
      schedule_id: scheduleId,
      snapshot_id: snapshotId,
      published_by: testUser.id,
    });

    await db.insert(schema.publishTargets).values({
      publish_id: publishId,
      screen_id: screenId,
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/screens/${screenId}/now-playing?include_media=true`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body) as any;
    expect(typeof body.server_time).toBe('string');
    expect(body.screen_id).toBe(screenId);
    expect(body.current_media_id).toBe(mediaId);
    expect(body.playback.current_item_id).toBe(itemId);
    expect(body.playback.current_media_id).toBe(mediaId);
    expect(body.playback.current_media.id).toBe(mediaId);
    expect(body.playback.started_at).toBe(startAt);
    expect(body.playback.ends_at).toBe(endAt);
    expect(body.active_items).toHaveLength(1);
    expect(body.publish.publish_id).toBe(publishId);
  });
});
