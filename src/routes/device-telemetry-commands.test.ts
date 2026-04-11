import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

const { queueHeartbeatTelemetryMock } = vi.hoisted(() => ({
  queueHeartbeatTelemetryMock: vi.fn(),
}));

vi.mock('@/jobs', async () => {
  const actual = await vi.importActual<typeof import('@/jobs')>('@/jobs');
  return {
    ...actual,
    queueHeartbeatTelemetry: queueHeartbeatTelemetryMock,
  };
});

import { createTestServer, closeTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { HTTP_STATUS } from '@/http-status-codes';

describe('device telemetry command claiming', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createTestServer();
  });

  beforeEach(() => {
    queueHeartbeatTelemetryMock.mockReset();
    queueHeartbeatTelemetryMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  async function seedCommandTarget() {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Command Claim Screen',
      status: 'OFFLINE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    const [command] = await db
      .insert(schema.deviceCommands)
      .values({
        screen_id: deviceId,
        type: 'REFRESH',
        status: 'PENDING',
        payload: { reason: 'claim-test' },
        created_by: testUser.id,
      })
      .returning();

    return { db, deviceId, serial, commandId: command.id };
  }

  it('claims commands from heartbeat so a follow-up poll does not redeliver them', async () => {
    const { db, deviceId, serial, commandId } = await seedCommandTarget();

    const heartbeatResponse = await server.inject({
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

    expect(heartbeatResponse.statusCode).toBe(HTTP_STATUS.OK);
    const heartbeatBody = JSON.parse(heartbeatResponse.body);
    expect(heartbeatBody.commands).toHaveLength(1);
    expect(heartbeatBody.commands[0].id).toBe(commandId);

    const followUpPoll = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${deviceId}/commands`,
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(followUpPoll.statusCode).toBe(HTTP_STATUS.OK);
    expect(JSON.parse(followUpPoll.body)).toEqual({ commands: [] });

    const [stored] = await db
      .select()
      .from(schema.deviceCommands)
      .where(eq(schema.deviceCommands.id, commandId));
    expect(stored?.status).toBe('SENT');
  });

  it('claims commands from polling so a follow-up heartbeat does not redeliver them', async () => {
    const { db, deviceId, serial, commandId } = await seedCommandTarget();

    const pollResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${deviceId}/commands`,
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(pollResponse.statusCode).toBe(HTTP_STATUS.OK);
    const pollBody = JSON.parse(pollResponse.body);
    expect(pollBody.commands).toHaveLength(1);
    expect(pollBody.commands[0].id).toBe(commandId);

    const followUpHeartbeat = await server.inject({
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

    expect(followUpHeartbeat.statusCode).toBe(HTTP_STATUS.OK);
    expect(JSON.parse(followUpHeartbeat.body).commands).toEqual([]);

    const [stored] = await db
      .select()
      .from(schema.deviceCommands)
      .where(eq(schema.deviceCommands.id, commandId));
    expect(stored?.status).toBe('SENT');
  });
});
