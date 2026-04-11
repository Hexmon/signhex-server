import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';

const { queueHeartbeatTelemetryMock, queueScreenStateRefreshMock } = vi.hoisted(() => ({
  queueHeartbeatTelemetryMock: vi.fn(),
  queueScreenStateRefreshMock: vi.fn(),
}));

vi.mock('@/jobs', async () => {
  const actual = await vi.importActual<typeof import('@/jobs')>('@/jobs');
  return {
    ...actual,
    queueHeartbeatTelemetry: queueHeartbeatTelemetryMock,
  };
});

vi.mock('@/services/screen-state-refresh', () => ({
  queueScreenStateRefresh: queueScreenStateRefreshMock,
}));

import { createTestServer, closeTestServer } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { HTTP_STATUS } from '@/http-status-codes';

describe('device telemetry screen refresh scheduling', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createTestServer();
  });

  beforeEach(() => {
    queueHeartbeatTelemetryMock.mockReset();
    queueScreenStateRefreshMock.mockReset();
    queueHeartbeatTelemetryMock.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('queues a debounced screen refresh after a heartbeat', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const serial = `serial-${randomUUID()}`;

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Heartbeat Refresh Screen',
      status: 'OFFLINE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'dummy-cert',
      expires_at: new Date(Date.now() + 60_000),
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

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    expect(queueScreenStateRefreshMock).toHaveBeenCalledTimes(1);
    expect(queueScreenStateRefreshMock).toHaveBeenCalledWith(deviceId);
  });
});
