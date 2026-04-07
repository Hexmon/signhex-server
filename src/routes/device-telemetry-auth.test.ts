import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { createTestServer, closeTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { HTTP_STATUS } from '@/http-status-codes';
import * as s3 from '@/s3';
import * as jobs from '@/jobs';

describe('Device telemetry auth runtime validation', () => {
  let server: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createTestServer();
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('rejects heartbeat when device credentials are expired', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Expired Cert Screen',
      status: 'OFFLINE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() - 60_000),
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device/heartbeat',
      headers: {
        'x-device-serial': serial,
      },
      payload: {
        device_id: deviceId,
        status: 'ONLINE',
        uptime: 100,
        memory_usage: 10,
        cpu_usage: 5,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('Device credentials expired');
  });

  it('rejects snapshot when device cert exists but screen row is missing', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${deviceId}/snapshot`,
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Device not registered');
  });

  it('returns resolved screen-target default media for authenticated device fallback requests', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;
    const mediaId = randomUUID();

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Portrait Device Default',
      type: 'IMAGE',
      status: 'READY',
      created_by: testUser.id,
      width: 1080,
      height: 1920,
    });

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Portrait Device',
      status: 'OFFLINE',
      width: 1080,
      height: 1920,
    } as any);

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    await db
      .insert(schema.settings)
      .values({
        key: 'default_media_targets',
        value: [
          {
            target_type: 'SCREEN',
            target_id: deviceId,
            media_id: mediaId,
            aspect_ratio: '9:16',
          },
        ],
      })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: {
          value: [
            {
              target_type: 'SCREEN',
              target_id: deviceId,
              media_id: mediaId,
              aspect_ratio: '9:16',
            },
          ],
          updated_at: new Date(),
        },
      });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${deviceId}/default-media`,
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body).toEqual(
      expect.objectContaining({
        source: 'SCREEN',
        aspect_ratio: '9:16',
        media_id: mediaId,
      })
    );
  });

  it('returns screenshot policy for an authenticated device', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Policy Device',
      status: 'OFFLINE',
      screenshot_enabled: true,
      screenshot_interval_seconds: 45,
    } as any);

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${deviceId}/screenshot-policy`,
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    expect(JSON.parse(response.body)).toEqual({
      enabled: true,
      interval_seconds: 45,
    });
  });

  it('returns aspect-ratio and global default media for authenticated devices when no target assignment exists', async () => {
    const db = getDatabase();
    const aspectDeviceId = randomUUID();
    const globalDeviceId = randomUUID();
    const aspectSerial = `serial-${randomUUID()}`;
    const globalSerial = `serial-${randomUUID()}`;
    const aspectMediaId = randomUUID();
    const globalMediaId = randomUUID();

    await db.insert(schema.media).values([
      {
        id: aspectMediaId,
        name: 'Aspect Ratio Device Default',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
        width: 1920,
        height: 1080,
      },
      {
        id: globalMediaId,
        name: 'Global Device Default',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
        width: 1280,
        height: 720,
      },
    ]);

    await db.insert(schema.screens).values([
      {
        id: aspectDeviceId,
        name: 'Aspect Ratio Device',
        status: 'OFFLINE',
        aspect_ratio: '16:9',
      } as any,
      {
        id: globalDeviceId,
        name: 'Global Fallback Device',
        status: 'OFFLINE',
        aspect_ratio: '4:3',
      } as any,
    ]);

    await db.insert(schema.deviceCertificates).values([
      {
        screen_id: aspectDeviceId,
        serial: aspectSerial,
        certificate_pem: 'dummy-cert',
        expires_at: new Date(Date.now() + 60_000),
      },
      {
        screen_id: globalDeviceId,
        serial: globalSerial,
        certificate_pem: 'dummy-cert',
        expires_at: new Date(Date.now() + 60_000),
      },
    ]);

    await db
      .insert(schema.settings)
      .values({
        key: 'default_media_targets',
        value: [],
      })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: {
          value: [],
          updated_at: new Date(),
        },
      });

    await db
      .insert(schema.settings)
      .values({
        key: 'default_media_variants',
        value: { '16:9': aspectMediaId },
      })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: {
          value: { '16:9': aspectMediaId },
          updated_at: new Date(),
        },
      });

    await db
      .insert(schema.settings)
      .values({
        key: 'default_media_id',
        value: globalMediaId,
      })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: {
          value: globalMediaId,
          updated_at: new Date(),
        },
      });

    const aspectResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${aspectDeviceId}/default-media`,
      headers: {
        'x-device-serial': aspectSerial,
      },
    });

    expect(aspectResponse.statusCode).toBe(HTTP_STATUS.OK);
    expect(JSON.parse(aspectResponse.body)).toEqual(
      expect.objectContaining({
        source: 'ASPECT_RATIO',
        aspect_ratio: '16:9',
        media_id: aspectMediaId,
      })
    );

    const globalResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${globalDeviceId}/default-media`,
      headers: {
        'x-device-serial': globalSerial,
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
  });

  it('returns resolved target-based default media and resolution metadata in device snapshot fallback responses', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;
    const mediaId = randomUUID();

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Device Snapshot Default',
      type: 'IMAGE',
      status: 'READY',
      created_by: testUser.id,
      width: 1920,
      height: 1080,
    });

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Default Snapshot Device',
      status: 'OFFLINE',
      aspect_ratio: '16:9',
    } as any);

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    await db
      .insert(schema.settings)
      .values({
        key: 'default_media_targets',
        value: [
          {
            target_type: 'SCREEN',
            target_id: deviceId,
            media_id: mediaId,
            aspect_ratio: '16:9',
          },
        ],
      })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: {
          value: [
            {
              target_type: 'SCREEN',
              target_id: deviceId,
              media_id: mediaId,
              aspect_ratio: '16:9',
            },
          ],
          updated_at: new Date(),
        },
      });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${deviceId}/snapshot?include_urls=true`,
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.default_media).toEqual(
      expect.objectContaining({
        media_id: mediaId,
        id: mediaId,
        type: 'IMAGE',
      })
    );
    expect(body.default_media_resolution).toEqual({
      source: 'SCREEN',
      aspect_ratio: '16:9',
    });
  });

  it('returns an empty snapshot payload for a registered device with no publish or default media', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;

    await db.delete(schema.settings).where(eq(schema.settings.key, 'default_media_id'));
    await db.delete(schema.settings).where(eq(schema.settings.key, 'default_media_variants'));
    await db.delete(schema.settings).where(eq(schema.settings.key, 'default_media_targets'));
    await db
      .update(schema.emergencies)
      .set({
        is_active: false,
        cleared_at: new Date(),
        clear_reason: 'device-empty-snapshot-test-reset',
        updated_at: new Date(),
      })
      .where(eq(schema.emergencies.is_active, true));

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Empty Snapshot Device',
      status: 'ACTIVE',
      aspect_ratio: '16:9',
    } as any);

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${deviceId}/snapshot?include_urls=true`,
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.device_id).toBe(deviceId);
    expect(body.publish).toBeNull();
    expect(body.snapshot).toBeNull();
    expect(body.emergency).toBeNull();
    expect(body.default_media).toBeNull();
    expect(body.default_media_resolution).toEqual({
      source: 'NONE',
      aspect_ratio: '16:9',
    });
  });

  it('returns ETag for device snapshots and honors If-None-Match when no emergency is active', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;
    const scheduleId = randomUUID();
    const snapshotId = randomUUID();
    const publishId = randomUUID();
    const now = new Date();
    const startAt = new Date(now.getTime() - 5 * 60 * 1000);
    const endAt = new Date(now.getTime() + 25 * 60 * 1000);

    await db
      .update(schema.emergencies)
      .set({
        is_active: false,
        cleared_at: now,
        clear_reason: 'device-telemetry-etag-test-reset',
        updated_at: now,
      })
      .where(eq(schema.emergencies.is_active, true));

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'ETag Snapshot Device',
      status: 'ACTIVE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    await db.insert(schema.schedules).values({
      id: scheduleId,
      name: 'ETag Schedule',
      timezone: 'UTC',
      start_at: startAt,
      end_at: endAt,
      is_active: true,
      created_by: testUser.id,
    } as any);

    await db.insert(schema.scheduleSnapshots).values({
      id: snapshotId,
      schedule_id: scheduleId,
      payload: {
        schedule: {
          id: scheduleId,
          timezone: 'UTC',
          start_at: startAt.toISOString(),
          end_at: endAt.toISOString(),
          items: [],
        },
      },
    });

    await db.insert(schema.publishes).values({
      id: publishId,
      schedule_id: scheduleId,
      snapshot_id: snapshotId,
      published_by: testUser.id,
    });

    await db.insert(schema.publishTargets).values({
      publish_id: publishId,
      screen_id: deviceId,
    });

    const firstResponse = await fetch(`${baseUrl}/api/v1/device/${deviceId}/snapshot`, {
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(firstResponse.status).toBe(HTTP_STATUS.OK);
    expect(firstResponse.headers.get('etag')).toBe(`"${snapshotId}"`);

    const secondResponse = await fetch(`${baseUrl}/api/v1/device/${deviceId}/snapshot`, {
      headers: {
        'x-device-serial': serial,
        'if-none-match': `"${snapshotId}"`,
      },
    });

    expect(secondResponse.status).toBe(304);

    const weakEtagResponse = await fetch(`${baseUrl}/api/v1/device/${deviceId}/snapshot`, {
      headers: {
        'x-device-serial': serial,
        'if-none-match': `W/"stale-snapshot", "${snapshotId}"`,
      },
    });

    expect(weakEtagResponse.status).toBe(304);
  });

  it('resolves the winning emergency for a device using global over group over screen precedence', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;
    const groupId = randomUUID();
    const mediaGlobal = randomUUID();
    const mediaGroup = randomUUID();
    const mediaScreen = randomUUID();

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Emergency Priority Device',
      status: 'ACTIVE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    await db.insert(schema.screenGroups).values({
      id: groupId,
      name: 'Emergency Group',
    });
    await db.insert(schema.screenGroupMembers).values({
      group_id: groupId,
      screen_id: deviceId,
    });

    await db.insert(schema.media).values([
      {
        id: mediaGlobal,
        name: 'Global Emergency Media',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
      },
      {
        id: mediaGroup,
        name: 'Group Emergency Media',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
      },
      {
        id: mediaScreen,
        name: 'Screen Emergency Media',
        type: 'IMAGE',
        status: 'READY',
        created_by: testUser.id,
      },
    ]);

    await db.insert(schema.emergencies).values([
      {
        message: 'Screen emergency',
        priority: 'CRITICAL',
        media_id: mediaScreen,
        screen_ids: [deviceId],
        screen_group_ids: [],
        target_all: false,
        is_active: true,
        triggered_by: testUser.id,
      },
      {
        message: 'Group emergency',
        priority: 'LOW',
        media_id: mediaGroup,
        screen_ids: [],
        screen_group_ids: [groupId],
        target_all: false,
        is_active: true,
        triggered_by: testUser.id,
      },
      {
        message: 'Global emergency',
        priority: 'LOW',
        media_id: mediaGlobal,
        screen_ids: [],
        screen_group_ids: [],
        target_all: true,
        is_active: true,
        triggered_by: testUser.id,
      },
    ]);

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${deviceId}/snapshot`,
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.emergency).toEqual(
      expect.objectContaining({
        message: 'Global emergency',
        scope: 'GLOBAL',
        media_id: mediaGlobal,
      })
    );
  });

  it('returns the latest successful publish targeting a device when multiple publishes exist', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;
    const scheduleOneId = randomUUID();
    const scheduleTwoId = randomUUID();
    const snapshotOneId = randomUUID();
    const snapshotTwoId = randomUUID();
    const publishOneId = randomUUID();
    const publishTwoId = randomUUID();
    const now = new Date();

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Latest Publish Device',
      status: 'ACTIVE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    await db.insert(schema.schedules).values([
      {
        id: scheduleOneId,
        name: 'Old Schedule',
        timezone: 'UTC',
        start_at: new Date(now.getTime() - 60 * 60 * 1000),
        end_at: new Date(now.getTime() + 60 * 60 * 1000),
        is_active: true,
        created_by: testUser.id,
      },
      {
        id: scheduleTwoId,
        name: 'New Schedule',
        timezone: 'UTC',
        start_at: new Date(now.getTime() - 60 * 60 * 1000),
        end_at: new Date(now.getTime() + 60 * 60 * 1000),
        is_active: true,
        created_by: testUser.id,
      },
    ] as any);

    await db.insert(schema.scheduleSnapshots).values([
      {
        id: snapshotOneId,
        schedule_id: scheduleOneId,
        payload: {
          schedule: {
            id: scheduleOneId,
            timezone: 'UTC',
            items: [],
          },
        },
      },
      {
        id: snapshotTwoId,
        schedule_id: scheduleTwoId,
        payload: {
          schedule: {
            id: scheduleTwoId,
            timezone: 'UTC',
            items: [],
          },
        },
      },
    ]);

    await db.insert(schema.publishes).values([
      {
        id: publishOneId,
        schedule_id: scheduleOneId,
        snapshot_id: snapshotOneId,
        published_by: testUser.id,
        published_at: new Date(now.getTime() - 10 * 60 * 1000),
      },
      {
        id: publishTwoId,
        schedule_id: scheduleTwoId,
        snapshot_id: snapshotTwoId,
        published_by: testUser.id,
        published_at: new Date(now.getTime() - 1 * 60 * 1000),
      },
    ]);

    await db.insert(schema.publishTargets).values([
      {
        publish_id: publishOneId,
        screen_id: deviceId,
      },
      {
        publish_id: publishTwoId,
        screen_id: deviceId,
      },
    ]);

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${deviceId}/snapshot`,
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.publish).toEqual(
      expect.objectContaining({
        publish_id: publishTwoId,
        schedule_id: scheduleTwoId,
        snapshot_id: snapshotTwoId,
      })
    );
  });

  it('persists screenshot uploads as storage objects and screenshot rows', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;
    const putObjectSpy = vi.spyOn(s3, 'putObject').mockResolvedValue({ etag: 'etag-1', sha256: 'sha-1' });
    const presignedSpy = vi.spyOn(s3, 'getPresignedUrl').mockResolvedValue('https://cdn.example.com/screens/device.png');

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Screenshot Device',
      status: 'ACTIVE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    const timestamp = new Date().toISOString();
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device/screenshot',
      headers: {
        'x-device-serial': serial,
      },
      payload: {
        device_id: deviceId,
        timestamp,
        image_data: Buffer.from('fake-png-data').toString('base64'),
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CREATED);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(typeof body.storage_object_id).toBe('string');
    expect(body.timestamp).toBe(timestamp);
    expect(putObjectSpy).toHaveBeenCalledOnce();
    expect(presignedSpy).not.toHaveBeenCalled();

    const [storageObject] = await db
      .select()
      .from(schema.storageObjects)
      .where(eq(schema.storageObjects.id, body.storage_object_id))
      .limit(1);
    expect(storageObject).toBeTruthy();
    expect(storageObject.bucket).toBe('device-screenshots');
    expect(storageObject.content_type).toBe('image/png');

    const [screenshot] = await db
      .select()
      .from(schema.screenshots)
      .where(eq(schema.screenshots.storage_object_id, body.storage_object_id))
      .limit(1);
    expect(screenshot).toBeTruthy();
    expect(screenshot.screen_id).toBe(deviceId);

    putObjectSpy.mockRestore();
    presignedSpy.mockRestore();
  });

  it('falls back to inline screenshot persistence when queueing is unavailable', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;
    const queueSpy = vi.spyOn(jobs, 'queueScreenshotTelemetry').mockRejectedValueOnce(new Error('pg-boss down'));
    const putObjectSpy = vi.spyOn(s3, 'putObject').mockResolvedValue({ etag: 'etag-inline', sha256: 'sha-inline' });

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Inline Fallback Screenshot Device',
      status: 'ACTIVE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    const timestamp = new Date().toISOString();
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device/screenshot',
      headers: {
        'x-device-serial': serial,
      },
      payload: {
        device_id: deviceId,
        timestamp,
        image_data: Buffer.from('inline-fallback-png').toString('base64'),
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CREATED);
    expect(queueSpy).toHaveBeenCalledOnce();
    expect(putObjectSpy).toHaveBeenCalledOnce();

    const body = JSON.parse(response.body);
    const [screenshot] = await db
      .select()
      .from(schema.screenshots)
      .where(eq(schema.screenshots.storage_object_id, body.storage_object_id))
      .limit(1);

    expect(screenshot).toBeTruthy();

    queueSpy.mockRestore();
    putObjectSpy.mockRestore();
  });

  it('accepts screenshot uploads above the default Fastify body limit', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;
    const putObjectSpy = vi.spyOn(s3, 'putObject').mockResolvedValue({ etag: 'etag-large', sha256: 'sha-large' });
    const presignedSpy = vi.spyOn(s3, 'getPresignedUrl').mockResolvedValue('https://cdn.example.com/screens/device-large.png');

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Large Screenshot Device',
      status: 'ACTIVE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    const timestamp = new Date().toISOString();
    const imageData = Buffer.alloc(950_000, 1).toString('base64');
    expect(Buffer.byteLength(JSON.stringify({ device_id: deviceId, timestamp, image_data: imageData }), 'utf8')).toBeGreaterThan(
      1_048_576
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device/screenshot',
      headers: {
        'x-device-serial': serial,
      },
      payload: {
        device_id: deviceId,
        timestamp,
        image_data: imageData,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CREATED);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.timestamp).toBe(timestamp);
    expect(putObjectSpy).toHaveBeenCalledOnce();
    expect(presignedSpy).not.toHaveBeenCalled();

    putObjectSpy.mockRestore();
    presignedSpy.mockRestore();
  });

  it('keeps the default body limit for other telemetry routes', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Oversized Heartbeat Device',
      status: 'ACTIVE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    const oversizedBlob = 'x'.repeat(1_100_000);
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device/heartbeat',
      headers: {
        'x-device-serial': serial,
      },
      payload: {
        device_id: deviceId,
        status: 'ONLINE',
        uptime: 100,
        memory_usage: 10,
        cpu_usage: 5,
        metrics: {
          blob: oversizedBlob,
        },
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toBe('Request payload too large.');
  });
});
