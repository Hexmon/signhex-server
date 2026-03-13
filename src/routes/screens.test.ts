import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createSessionRepository } from '@/db/repositories/session';
import { generateAccessToken } from '@/auth/jwt';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { HTTP_STATUS } from '@/http-status-codes';
import * as s3 from '@/s3';

async function issueAdminToken() {
  const db = getDatabase();
  const [adminRole] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'ADMIN')).limit(1);
  if (!adminRole) {
    throw new Error('ADMIN role is required for screens route tests');
  }

  const currentPermissions =
    adminRole.permissions && typeof adminRole.permissions === 'object'
      ? (adminRole.permissions as { grants?: Array<{ action: string; subject: string }> })
      : {};
  const mergedGrants = [...(currentPermissions.grants || [])];
  for (const grant of [
    { action: 'create', subject: 'Screen' },
    { action: 'read', subject: 'Screen' },
    { action: 'delete', subject: 'Screen' },
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
    vi.restoreAllMocks();
    await closeTestServer(server);
  });

  it('blocks manual screen creation and requires device pairing flow', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/screens',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        name: 'Manual Screen',
        location: 'Lobby',
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CONFLICT);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('device completes pairing');
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

  it('returns 404 when deleting a missing screen', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/screens/${randomUUID()}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    const body = JSON.parse(response.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Screen not found');
  });

  it('deletes related screen storage objects and removes storage rows on screen delete', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const heartbeatStorageId = randomUUID();
    const popStorageId = randomUUID();
    const screenshotStorageId = randomUUID();

    const deleteObjectSpy = vi.spyOn(s3, 'deleteObject').mockResolvedValue(undefined);

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Delete Screen',
      status: 'ACTIVE',
    });

    await db.insert(schema.storageObjects).values([
      {
        id: heartbeatStorageId,
        bucket: 'logs-heartbeats',
        object_key: `heartbeats/${screenId}/1.json`,
        content_type: 'application/json',
        size: 10,
      },
      {
        id: popStorageId,
        bucket: 'logs-proof-of-play',
        object_key: `proof-of-play/${screenId}/1.json`,
        content_type: 'application/json',
        size: 10,
      },
      {
        id: screenshotStorageId,
        bucket: 'device-screenshots',
        object_key: `screenshots/${screenId}/1.png`,
        content_type: 'image/png',
        size: 10,
      },
    ]);

    await db.insert(schema.heartbeats).values({
      screen_id: screenId,
      status: 'ONLINE',
      storage_object_id: heartbeatStorageId,
    });
    await db.insert(schema.proofOfPlay).values({
      screen_id: screenId,
      storage_object_id: popStorageId,
      started_at: new Date(),
    });
    await db.insert(schema.screenshots).values({
      screen_id: screenId,
      storage_object_id: screenshotStorageId,
    });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/screens/${screenId}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body) as {
      id: string;
      message: string;
      storage_cleanup: {
        deleted: Array<{ id: string }>;
        failed: Array<{ id: string }>;
      };
    };
    expect(body.id).toBe(screenId);
    expect(body.message).toContain('Screen deleted');
    expect(body.storage_cleanup.deleted).toHaveLength(3);
    expect(body.storage_cleanup.failed).toHaveLength(0);
    expect(deleteObjectSpy).toHaveBeenCalledTimes(3);

    const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, screenId));
    expect(screen).toBeUndefined();

    const storageRows = await db
      .select()
      .from(schema.storageObjects)
      .where(eq(schema.storageObjects.bucket, 'logs-heartbeats'));
    expect(storageRows.some((row) => row.id === heartbeatStorageId)).toBe(false);
  });

  it('returns resolved aspect ratios with defaults catalog', async () => {
    const db = getDatabase();
    const explicitScreenId = randomUUID();
    const derivedScreenId = randomUUID();
    const unresolvedScreenId = randomUUID();

    await db.insert(schema.screens).values([
      {
        id: explicitScreenId,
        name: 'Explicit Ratio Screen',
        aspect_ratio: '21:9',
        status: 'ACTIVE',
      },
      {
        id: derivedScreenId,
        name: 'Derived Ratio Screen',
        width: 1920,
        height: 1080,
        status: 'ACTIVE',
      },
      {
        id: unresolvedScreenId,
        name: 'Unresolved Ratio Screen',
        status: 'OFFLINE',
      },
    ]);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/screens/aspect-ratios',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body) as any;
    expect(Array.isArray(body.items)).toBe(true);
    expect(Array.isArray(body.defaults)).toBe(true);

    const explicit = body.items.find((entry: any) => entry.id === explicitScreenId);
    expect(explicit.aspect_ratio).toBe('21:9');
    expect(explicit.aspect_ratio_name).toBe('Ultrawide');
    expect(explicit.is_fallback).toBe(false);

    const derived = body.items.find((entry: any) => entry.id === derivedScreenId);
    expect(derived.aspect_ratio).toBe('16:9');
    expect(derived.aspect_ratio_name).toBe('Widescreen');

    const unresolved = body.items.find((entry: any) => entry.id === unresolvedScreenId);
    expect(unresolved.aspect_ratio).toBeNull();
    expect(unresolved.aspect_ratio_name).toBeNull();

    expect(body.defaults.some((entry: any) => entry.aspect_ratio === '16:9')).toBe(true);
    expect(body.defaults.some((entry: any) => entry.aspect_ratio === '1:1')).toBe(true);
    expect(body.defaults.every((entry: any) => entry.id === null && entry.is_fallback === true)).toBe(true);
  });

  it('filters unresolved aspect ratios when configured_only=true', async () => {
    const db = getDatabase();
    const derivedScreenId = randomUUID();
    const unresolvedScreenId = randomUUID();

    await db.insert(schema.screens).values([
      {
        id: derivedScreenId,
        name: 'Configured Ratio Screen',
        width: 1080,
        height: 1920,
        status: 'ACTIVE',
      },
      {
        id: unresolvedScreenId,
        name: 'No Ratio Screen',
        status: 'OFFLINE',
      },
    ]);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/screens/aspect-ratios?configured_only=true',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body) as any;
    expect(body.items.some((entry: any) => entry.id === derivedScreenId && entry.aspect_ratio === '9:16')).toBe(true);
    expect(body.items.some((entry: any) => entry.id === unresolvedScreenId)).toBe(false);
  });

  it('derives canonical health states across overview responses', async () => {
    const db = getDatabase();
    const recentHeartbeat = new Date();
    const staleHeartbeat = new Date(Date.now() - 10 * 60 * 1000);

    const onlineScreenId = randomUUID();
    const offlineScreenId = randomUUID();
    const staleScreenId = randomUUID();
    const errorScreenId = randomUUID();
    const recoveryScreenId = randomUUID();

    await db.insert(schema.screens).values([
      {
        id: onlineScreenId,
        name: 'Online Screen',
        status: 'ACTIVE',
        last_heartbeat_at: recentHeartbeat,
      },
      {
        id: offlineScreenId,
        name: 'Offline Screen',
        status: 'OFFLINE',
        last_heartbeat_at: recentHeartbeat,
      },
      {
        id: staleScreenId,
        name: 'Stale Screen',
        status: 'ACTIVE',
        last_heartbeat_at: staleHeartbeat,
      },
      {
        id: errorScreenId,
        name: 'Error Screen',
        status: 'INACTIVE',
        last_heartbeat_at: recentHeartbeat,
      },
      {
        id: recoveryScreenId,
        name: 'Recovery Screen',
        status: 'ACTIVE',
        last_heartbeat_at: recentHeartbeat,
      },
    ]);

    await db.insert(schema.deviceCertificates).values([
      {
        screen_id: onlineScreenId,
        serial: `serial-${onlineScreenId}`,
        certificate_pem: 'online-cert',
        expires_at: new Date(Date.now() + 60_000),
      },
      {
        screen_id: offlineScreenId,
        serial: `serial-${offlineScreenId}`,
        certificate_pem: 'offline-cert',
        expires_at: new Date(Date.now() + 60_000),
      },
      {
        screen_id: staleScreenId,
        serial: `serial-${staleScreenId}`,
        certificate_pem: 'stale-cert',
        expires_at: new Date(Date.now() + 60_000),
      },
      {
        screen_id: errorScreenId,
        serial: `serial-${errorScreenId}`,
        certificate_pem: 'error-cert',
        expires_at: new Date(Date.now() + 60_000),
      },
      {
        screen_id: recoveryScreenId,
        serial: `serial-${recoveryScreenId}`,
        certificate_pem: 'recovery-cert',
        expires_at: new Date(Date.now() - 60_000),
      },
    ]);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/screens/overview',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body) as {
      screens: Array<{
        id: string;
        health_state: string;
        health_reason: string | null;
        auth_diagnostics?: { state?: string; reason?: string } | null;
      }>;
    };

    const getScreen = (id: string) => body.screens.find((screen) => screen.id === id);

    expect(getScreen(onlineScreenId)?.health_state).toBe('ONLINE');
    expect(getScreen(onlineScreenId)?.health_reason).toContain('healthy');

    expect(getScreen(offlineScreenId)?.health_state).toBe('OFFLINE');
    expect(getScreen(offlineScreenId)?.health_reason).toContain('offline');

    expect(getScreen(staleScreenId)?.health_state).toBe('STALE');
    expect(getScreen(staleScreenId)?.health_reason).toContain('heartbeat is older');

    expect(getScreen(errorScreenId)?.health_state).toBe('ERROR');
    expect(getScreen(errorScreenId)?.health_reason).toContain('error or inactive');

    expect(getScreen(recoveryScreenId)?.health_state).toBe('RECOVERY_REQUIRED');
    expect(getScreen(recoveryScreenId)?.auth_diagnostics?.state).toBe('EXPIRED_CERTIFICATE');
  });

  it('resolves screen default media by exact aspect ratio, derived aspect ratio, global fallback, and none', async () => {
    const db = getDatabase();
    const exactScreenId = randomUUID();
    const derivedScreenId = randomUUID();
    const globalScreenId = randomUUID();
    const noneScreenId = randomUUID();
    const exactMediaId = randomUUID();
    const derivedMediaId = randomUUID();
    const globalMediaId = randomUUID();

    await db.insert(schema.media).values([
      {
        id: exactMediaId,
        name: 'Landscape Default',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
        width: 1920,
        height: 1080,
      },
      {
        id: derivedMediaId,
        name: 'Portrait Default',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
        width: 1080,
        height: 1920,
      },
      {
        id: globalMediaId,
        name: 'Global Default',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
        width: 1280,
        height: 720,
      },
    ]);

    await db.insert(schema.screens).values([
      {
        id: exactScreenId,
        name: 'Exact Ratio Screen',
        status: 'OFFLINE',
        aspect_ratio: '16:9',
      } as any,
      {
        id: derivedScreenId,
        name: 'Derived Ratio Screen',
        status: 'OFFLINE',
        width: 1080,
        height: 1920,
      } as any,
      {
        id: globalScreenId,
        name: 'Global Ratio Screen',
        status: 'OFFLINE',
        aspect_ratio: '4:3',
      } as any,
      {
        id: noneScreenId,
        name: 'No Default Screen',
        status: 'OFFLINE',
        aspect_ratio: '32:9',
      } as any,
    ]);

    await db
      .insert(schema.settings)
      .values({ key: 'default_media_id', value: globalMediaId })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: globalMediaId, updated_at: new Date() },
      });
    await db
      .insert(schema.settings)
      .values({
        key: 'default_media_variants',
        value: {
          '16:9': exactMediaId,
          '9:16': derivedMediaId,
        },
      })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: {
          value: {
            '16:9': exactMediaId,
            '9:16': derivedMediaId,
          },
          updated_at: new Date(),
        },
      });

    const exactResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/screens/${exactScreenId}/default-media`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(exactResponse.statusCode).toBe(HTTP_STATUS.OK);
    expect(JSON.parse(exactResponse.body)).toEqual(
      expect.objectContaining({
        source: 'ASPECT_RATIO',
        aspect_ratio: '16:9',
        media_id: exactMediaId,
      })
    );

    const derivedResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/screens/${derivedScreenId}/default-media`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(derivedResponse.statusCode).toBe(HTTP_STATUS.OK);
    expect(JSON.parse(derivedResponse.body)).toEqual(
      expect.objectContaining({
        source: 'ASPECT_RATIO',
        aspect_ratio: '9:16',
        media_id: derivedMediaId,
      })
    );

    const globalResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/screens/${globalScreenId}/default-media`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(globalResponse.statusCode).toBe(HTTP_STATUS.OK);
    expect(JSON.parse(globalResponse.body)).toEqual(
      expect.objectContaining({
        source: 'GLOBAL',
        aspect_ratio: '4:3',
        media_id: globalMediaId,
      })
    );

    await db.delete(schema.settings).where(eq(schema.settings.key, 'default_media_id'));
    const noneResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/screens/${noneScreenId}/default-media`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(noneResponse.statusCode).toBe(HTTP_STATUS.OK);
    expect(JSON.parse(noneResponse.body)).toEqual(
      expect.objectContaining({
        source: 'NONE',
        aspect_ratio: '32:9',
        media_id: null,
        media: null,
      })
    );
  });

  it('returns resolved default media and resolution metadata in screen snapshot responses', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const fallbackMediaId = randomUUID();

    await db.insert(schema.media).values({
      id: fallbackMediaId,
      name: 'Screen Snapshot Default',
      type: 'IMAGE',
      status: 'READY',
      created_by: testUser.id,
      width: 1920,
      height: 1080,
    });

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Snapshot Fallback Screen',
      status: 'OFFLINE',
      aspect_ratio: '16:9',
    } as any);

    await db
      .insert(schema.settings)
      .values({ key: 'default_media_variants', value: { '16:9': fallbackMediaId } })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: { '16:9': fallbackMediaId }, updated_at: new Date() },
      });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/screens/${screenId}/snapshot?include_urls=true`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.default_media).toEqual(
      expect.objectContaining({
        media_id: fallbackMediaId,
        id: fallbackMediaId,
        type: 'IMAGE',
      })
    );
    expect(body.default_media_resolution).toEqual({
      source: 'ASPECT_RATIO',
      aspect_ratio: '16:9',
    });
  });
});
