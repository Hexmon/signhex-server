import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { createTestServer, closeTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { HTTP_STATUS } from '@/http-status-codes';

describe('Device telemetry auth runtime validation', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createTestServer();
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

  it('returns resolved aspect-ratio default media for authenticated device fallback requests', async () => {
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
      .values({ key: 'default_media_variants', value: { '9:16': mediaId } })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: { '9:16': mediaId }, updated_at: new Date() },
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
        source: 'ASPECT_RATIO',
        aspect_ratio: '9:16',
        media_id: mediaId,
      })
    );
  });

  it('returns resolved default media and resolution metadata in device snapshot fallback responses', async () => {
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
      .values({ key: 'default_media_variants', value: { '16:9': mediaId } })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: { '16:9': mediaId }, updated_at: new Date() },
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
      source: 'ASPECT_RATIO',
      aspect_ratio: '16:9',
    });
  });
});
