import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';

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

  async function expireLease(commandId: string) {
    const db = getDatabase();
    const staleClaimedAt = new Date(Date.now() - 61_000);

    await db
      .update(schema.deviceCommands)
      .set({
        status: 'SENT',
        claimed_at: staleClaimedAt,
        updated_at: staleClaimedAt,
        acknowledged_at: null,
      })
      .where(eq(schema.deviceCommands.id, commandId));
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

  it('does not double-claim a command when heartbeat and poll race each other', async () => {
    const { db, deviceId, serial, commandId } = await seedCommandTarget();

    const [heartbeatResponse, pollResponse] = await Promise.all([
      server.inject({
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
      }),
      server.inject({
        method: 'GET',
        url: `/api/v1/device/${deviceId}/commands`,
        headers: {
          'x-device-serial': serial,
        },
      }),
    ]);

    expect(heartbeatResponse.statusCode).toBe(HTTP_STATUS.OK);
    expect(pollResponse.statusCode).toBe(HTTP_STATUS.OK);

    const heartbeatCommands = JSON.parse(heartbeatResponse.body).commands ?? [];
    const polledCommands = JSON.parse(pollResponse.body).commands ?? [];
    const deliveredIds = [...heartbeatCommands, ...polledCommands].map((command: { id: string }) => command.id);

    expect(deliveredIds).toEqual([commandId]);

    const [stored] = await db
      .select()
      .from(schema.deviceCommands)
      .where(eq(schema.deviceCommands.id, commandId));
    expect(stored?.status).toBe('SENT');
    expect(stored?.delivery_token).toBeTruthy();
    expect(stored?.delivery_attempts).toBe(1);
  });

  it('requires the matching delivery token to acknowledge a leased command', async () => {
    const { db, deviceId, serial, commandId } = await seedCommandTarget();

    const pollResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${deviceId}/commands`,
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(pollResponse.statusCode).toBe(HTTP_STATUS.OK);
    const claimedCommand = JSON.parse(pollResponse.body).commands[0];
    expect(claimedCommand.delivery_token).toBeTruthy();

    const missingTokenAck = await server.inject({
      method: 'POST',
      url: `/api/v1/device/${deviceId}/commands/${commandId}/ack`,
      headers: {
        'x-device-serial': serial,
      },
      payload: {},
    });

    expect(missingTokenAck.statusCode).toBe(HTTP_STATUS.NOT_FOUND);

    const matchedAck = await server.inject({
      method: 'POST',
      url: `/api/v1/device/${deviceId}/commands/${commandId}/ack`,
      headers: {
        'x-device-serial': serial,
      },
      payload: {
        delivery_token: claimedCommand.delivery_token,
      },
    });

    expect(matchedAck.statusCode).toBe(HTTP_STATUS.OK);

    const [stored] = await db
      .select()
      .from(schema.deviceCommands)
      .where(eq(schema.deviceCommands.id, commandId));
    expect(stored?.status).toBe('ACKNOWLEDGED');
    expect(stored?.acknowledged_at).toBeTruthy();
  });

  it('reclaims stale leases and rejects stale or tokenless acknowledgements', async () => {
    const { db, deviceId, serial, commandId } = await seedCommandTarget();

    const initialClaim = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${deviceId}/commands`,
      headers: {
        'x-device-serial': serial,
      },
    });

    expect(initialClaim.statusCode).toBe(HTTP_STATUS.OK);
    const initiallyLeasedCommand = JSON.parse(initialClaim.body).commands[0];
    expect(initiallyLeasedCommand.delivery_token).toBeTruthy();

    await expireLease(commandId);

    const reclaimedClaim = await server.inject({
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

    expect(reclaimedClaim.statusCode).toBe(HTTP_STATUS.OK);
    const reclaimedCommand = JSON.parse(reclaimedClaim.body).commands[0];
    expect(reclaimedCommand.id).toBe(commandId);
    expect(reclaimedCommand.delivery_token).toBeTruthy();
    expect(reclaimedCommand.delivery_token).not.toBe(initiallyLeasedCommand.delivery_token);

    const tokenlessAck = await server.inject({
      method: 'POST',
      url: `/api/v1/device/${deviceId}/commands/${commandId}/ack`,
      headers: {
        'x-device-serial': serial,
      },
      payload: {},
    });
    expect(tokenlessAck.statusCode).toBe(HTTP_STATUS.NOT_FOUND);

    const staleTokenAck = await server.inject({
      method: 'POST',
      url: `/api/v1/device/${deviceId}/commands/${commandId}/ack`,
      headers: {
        'x-device-serial': serial,
      },
      payload: {
        delivery_token: initiallyLeasedCommand.delivery_token,
      },
    });
    expect(staleTokenAck.statusCode).toBe(HTTP_STATUS.NOT_FOUND);

    const matchingAck = await server.inject({
      method: 'POST',
      url: `/api/v1/device/${deviceId}/commands/${commandId}/ack`,
      headers: {
        'x-device-serial': serial,
      },
      payload: {
        delivery_token: reclaimedCommand.delivery_token,
      },
    });
    expect(matchingAck.statusCode).toBe(HTTP_STATUS.OK);

    const duplicateAck = await server.inject({
      method: 'POST',
      url: `/api/v1/device/${deviceId}/commands/${commandId}/ack`,
      headers: {
        'x-device-serial': serial,
      },
      payload: {
        delivery_token: reclaimedCommand.delivery_token,
      },
    });
    expect(duplicateAck.statusCode).toBe(HTTP_STATUS.NOT_FOUND);

    const [stored] = await db
      .select()
      .from(schema.deviceCommands)
      .where(eq(schema.deviceCommands.id, commandId));
    expect(stored?.status).toBe('ACKNOWLEDGED');
    expect(stored?.delivery_attempts).toBe(2);
    expect(stored?.acknowledged_at).toBeTruthy();
  });

  it('rolls back a leased update when the transaction fails before commit', async () => {
    const { db, deviceId, commandId } = await seedCommandTarget();
    const deliveryToken = randomUUID();
    const claimedAt = new Date();

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT id
          FROM device_commands
          WHERE screen_id = ${deviceId}
            AND status = 'PENDING'
          FOR UPDATE SKIP LOCKED
        `);

        await tx
          .update(schema.deviceCommands)
          .set({
            status: 'SENT',
            delivery_token: deliveryToken,
            claimed_at: claimedAt,
            updated_at: claimedAt,
            delivery_attempts: sql`${schema.deviceCommands.delivery_attempts} + 1`,
          })
          .where(eq(schema.deviceCommands.id, commandId));

        throw new Error('rollback-probe');
      })
    ).rejects.toThrow('rollback-probe');

    const [stored] = await db
      .select()
      .from(schema.deviceCommands)
      .where(eq(schema.deviceCommands.id, commandId));

    expect(stored?.status).toBe('PENDING');
    expect(stored?.delivery_token).toBeNull();
    expect(stored?.claimed_at).toBeNull();
    expect(stored?.delivery_attempts).toBe(0);
  });
});
