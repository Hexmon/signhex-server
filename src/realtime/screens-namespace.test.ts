import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { FastifyInstance } from 'fastify';
import { io as createClient, Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { createSessionRepository } from '@/db/repositories/session';
import { generateAccessToken } from '@/auth/jwt';
import { HTTP_STATUS } from '@/http-status-codes';
import * as s3 from '@/s3';

async function issueAdminTokenWithSession() {
  const db = getDatabase();
  const [adminRole] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'ADMIN')).limit(1);
  if (!adminRole) {
    throw new Error('ADMIN role is required for screens namespace tests');
  }

  const token = await generateAccessToken(testUser.id, testUser.email, adminRole.id, adminRole.name);
  await createSessionRepository().create({
    user_id: testUser.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });
  return token.token;
}

function waitForSocketConnect(socket: ClientSocket) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connect timeout')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForEvent<T>(socket: ClientSocket, event: string, predicate: (payload: T) => boolean, timeoutMs = 6000) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };

    socket.on(event, handler);
  });
}

describe('screens namespace realtime updates', () => {
  let server: FastifyInstance;
  let baseUrl: string;
  let adminToken: string;
  let socket: ClientSocket | null = null;

  beforeAll(async () => {
    vi.spyOn(s3, 'putObject').mockResolvedValue({ sha256: 'test-sha256' } as any);
    server = await createTestServer();
    adminToken = await issueAdminTokenWithSession();
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    vi.restoreAllMocks();
    await closeTestServer(server);
  });

  it('accepts token auth, subscribes to valid screens, and rejects missing ids', async () => {
    const db = getDatabase();
    const screenId = randomUUID();

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Socket Screen',
      status: 'ACTIVE',
    });

    socket = createClient(`${baseUrl}/screens`, {
      transports: ['websocket'],
      auth: { token: adminToken },
      reconnection: false,
      forceNew: true,
    });

    await waitForSocketConnect(socket);

    const subscribeResult = await new Promise<any>((resolve) => {
      socket!.emit(
        'screens:subscribe',
        { includeAll: true, screenIds: [screenId, randomUUID()] },
        (result: any) => resolve(result)
      );
    });

    expect(subscribeResult.subscribed_all).toBe(true);
    expect(subscribeResult.subscribed).toContain(screenId);
    expect(subscribeResult.rejected).toHaveLength(1);

    const syncResult = await new Promise<any>((resolve) => {
      socket!.emit('screens:sync', { screenIds: [screenId] }, (result: any) => resolve(result));
    });

    expect(Array.isArray(syncResult.screens)).toBe(true);
    expect(syncResult.screens[0].id).toBe(screenId);
  });

  it('rejects cookie websocket auth when origin is not allowlisted', async () => {
    const badSocket = createClient(`${baseUrl}/screens`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: {
        Cookie: `access_token=${adminToken}`,
        Origin: 'http://malicious.local',
      },
    });

    const error = await new Promise<Error>((resolve) => {
      badSocket.once('connect_error', resolve);
    });

    expect(error).toBeTruthy();
    badSocket.disconnect();
  });

  it('emits screen state updates on heartbeat and refresh events on emergency changes', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const mediaId = randomUUID();
    const deviceCertificateId = randomUUID();
    const serial = `serial-${Date.now()}`;

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Heartbeat Screen',
      status: 'OFFLINE',
    });

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Heartbeat Media',
      type: 'VIDEO',
      status: 'READY',
      created_by: testUser.id,
    });

    await db.insert(schema.deviceCertificates).values({
      id: deviceCertificateId,
      screen_id: screenId,
      serial,
      certificate_pem: 'test-cert',
      is_revoked: false,
      expires_at: new Date(Date.now() + 60_000),
    });

    if (socket) {
      socket.disconnect();
    }
    socket = createClient(`${baseUrl}/screens`, {
      transports: ['websocket'],
      auth: { token: adminToken },
      reconnection: false,
      forceNew: true,
    });
    await waitForSocketConnect(socket);

    await new Promise<void>((resolve) => {
      socket!.emit('screens:subscribe', { includeAll: true, screenIds: [screenId] }, () => resolve());
    });

    const stateUpdatePromise = waitForEvent<any>(
      socket,
      'screens:state:update',
      (payload) => payload?.screen?.id === screenId && payload?.screen?.current_media_id === mediaId
    );

    const heartbeatResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/device/heartbeat',
      headers: {
        'x-device-serial': serial,
      },
      payload: {
        device_id: screenId,
        status: 'ONLINE',
        uptime: 120,
        memory_usage: 30,
        cpu_usage: 20,
        current_media_id: mediaId,
      },
    });

    expect(heartbeatResponse.statusCode).toBe(HTTP_STATUS.OK);
    const stateUpdate = await stateUpdatePromise;
    expect(stateUpdate.screen.id).toBe(screenId);
    expect(stateUpdate.screen.current_media_id).toBe(mediaId);
    expect(stateUpdate.screen.playback.current_media_id).toBe(mediaId);

    const refreshPromise = waitForEvent<any>(
      socket,
      'screens:refresh:required',
      (payload) => payload?.reason === 'EMERGENCY' && payload?.screen_ids?.includes(screenId)
    );

    const emergencyResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/emergency/trigger',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        message: 'Emergency test',
        screen_ids: [screenId],
      },
    });

    expect(emergencyResponse.statusCode).toBe(HTTP_STATUS.CREATED);
    const refreshEvent = await refreshPromise;
    expect(refreshEvent.reason).toBe('EMERGENCY');
    expect(refreshEvent.screen_ids).toContain(screenId);

    const emergencyId = JSON.parse(emergencyResponse.body).id as string;
    const clearResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/emergency/${emergencyId}/clear`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(clearResponse.statusCode).toBe(HTTP_STATUS.OK);
  });
});
