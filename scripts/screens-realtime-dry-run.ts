#!/usr/bin/env tsx

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { io as createSocketClient, type Socket } from 'socket.io-client';
import { AddressInfo } from 'net';
import { initializeDatabase, closeDatabase, getDatabase, schema } from '../src/db/index.js';
import { createServer } from '../src/server/index.js';
import { initializeS3, createBucketIfNotExists, putObject } from '../src/s3/index.js';
import { createSessionRepository } from '../src/db/repositories/session.js';
import { generateAccessToken } from '../src/auth/jwt.js';
import { hashPassword } from '../src/auth/password.js';

type Step = { name: string; ok: boolean; details?: string };
type RoleRecord = typeof schema.roles.$inferSelect;
type UserRecord = typeof schema.users.$inferSelect;

const steps: Step[] = [];

function recordStep(name: string, ok: boolean, details?: string) {
  steps.push({ name, ok, details });
  const status = ok ? 'OK' : 'FAIL';
  const suffix = details ? ` - ${details}` : '';
  console.log(`[${status}] ${name}${suffix}`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} returned invalid payload`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length) {
    throw new Error(`Expected string field for ${label}`);
  }
  return value;
}

async function ensureRole(name: string, grants: Array<{ action: string; subject: string }> = []): Promise<RoleRecord> {
  const db = getDatabase();
  const [existing] = await db.select().from(schema.roles).where(eq(schema.roles.name, name)).limit(1);

  if (existing) {
    const currentPermissions =
      existing.permissions && typeof existing.permissions === 'object'
        ? (existing.permissions as { grants?: Array<{ action: string; subject: string }> })
        : {};
    const mergedGrants = [...(currentPermissions.grants || [])];
    for (const grant of grants) {
      if (!mergedGrants.some((current) => current.action === grant.action && current.subject === grant.subject)) {
        mergedGrants.push(grant);
      }
    }

    const [updated] = await db
      .update(schema.roles)
      .set({ permissions: { grants: mergedGrants } })
      .where(eq(schema.roles.id, existing.id))
      .returning();

    return updated ?? existing;
  }

  const [created] = await db
    .insert(schema.roles)
    .values({
      id: randomUUID(),
      name,
      permissions: { grants },
      is_system: true,
    })
    .returning();

  return created;
}

async function createUser(email: string, roleId: string): Promise<UserRecord> {
  const db = getDatabase();
  const [created] = await db
    .insert(schema.users)
    .values({
      id: randomUUID(),
      email,
      password_hash: await hashPassword('Password123!'),
      first_name: 'Screens',
      last_name: 'DryRun',
      role_id: roleId,
      is_active: true,
    })
    .returning();

  return created;
}

async function issueToken(user: UserRecord, role: RoleRecord): Promise<string> {
  const issued = await generateAccessToken(user.id, user.email, role.id, role.name);
  await createSessionRepository().create({
    user_id: user.id,
    access_jti: issued.jti,
    expires_at: issued.expiresAt,
  });
  return issued.token;
}

async function apiRequest(baseUrl: string, token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  const contentType = response.headers.get('content-type') || '';
  let data: unknown = raw;
  if (raw && contentType.includes('application/json')) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  } else if (!raw) {
    data = null;
  }

  return { status: response.status, data };
}

function connectScreensSocket(baseUrl: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocketClient(`${baseUrl}/screens`, {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      timeout: 8000,
    });

    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };

    const onConnect = () => {
      cleanup();
      resolve(socket);
    };

    const onError = (error: Error) => {
      cleanup();
      socket.close();
      reject(error);
    };

    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
  });
}

function waitForEvent(
  socket: Socket,
  event: string,
  predicate: (payload: Record<string, unknown>) => boolean,
  timeoutMs = 8000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    const onEvent = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const value = payload as Record<string, unknown>;
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(value);
    };

    socket.on(event, onEvent);
  });
}

async function run() {
  let server: Awaited<ReturnType<typeof createServer>> | null = null;
  let socket: Socket | null = null;

  await initializeDatabase();
  initializeS3();
  await createBucketIfNotExists('logs-heartbeats');
  await createBucketIfNotExists('logs-proof-of-play');
  await createBucketIfNotExists('device-screenshots');
  await createBucketIfNotExists('media-source');

  try {
    server = await createServer();
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    recordStep('Server boot', true, baseUrl);

    const adminRole = await ensureRole('ADMIN', [
      { action: 'read', subject: 'Screen' },
      { action: 'delete', subject: 'Screen' },
    ]);
    const adminUser = await createUser(`screens-dry-run-${Date.now()}@example.com`, adminRole.id);
    const adminToken = await issueToken(adminUser, adminRole);
    recordStep('Admin token issued', true);

    const screenId = randomUUID();
    const mediaId = randomUUID();
    const scheduleId = randomUUID();
    const snapshotId = randomUUID();
    const publishId = randomUUID();
    const itemId = randomUUID();
    const now = new Date();
    const startAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const endAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const serial = `dry-run-${Date.now()}`;
    const mediaObjectKey = `${mediaId}/realtime-dry-run.mp4`;

    const db = getDatabase();
    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Realtime Dry Run Screen',
      status: 'OFFLINE',
    });
    await putObject('media-source', mediaObjectKey, Buffer.from('dry-run-video-payload'), 'video/mp4');
    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Realtime Dry Run Media',
      type: 'VIDEO',
      status: 'READY',
      created_by: adminUser.id,
      source_bucket: 'media-source',
      source_object_key: mediaObjectKey,
      source_content_type: 'video/mp4',
      source_size: Buffer.byteLength('dry-run-video-payload'),
      duration_seconds: 15,
    });
    await db.insert(schema.schedules).values({
      id: scheduleId,
      name: 'Realtime Dry Run Schedule',
      start_at: new Date(startAt),
      end_at: new Date(endAt),
      is_active: true,
      created_by: adminUser.id,
    });
    await db.insert(schema.scheduleSnapshots).values({
      id: snapshotId,
      schedule_id: scheduleId,
      payload: {
        schedule: {
          id: scheduleId,
          name: 'Realtime Dry Run Schedule',
          start_at: startAt,
          end_at: endAt,
          items: [
            {
              id: itemId,
              presentation_id: randomUUID(),
              start_at: startAt,
              end_at: endAt,
              screen_ids: [screenId],
              screen_group_ids: [],
              presentation: {
                id: randomUUID(),
                name: 'Realtime Dry Run Presentation',
                items: [
                  {
                    id: randomUUID(),
                    media_id: mediaId,
                    order: 0,
                    duration_seconds: 15,
                    media: {
                      id: mediaId,
                      name: 'Realtime Dry Run Media',
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
      },
    });
    await db.insert(schema.publishes).values({
      id: publishId,
      schedule_id: scheduleId,
      snapshot_id: snapshotId,
      published_by: adminUser.id,
    });
    await db.insert(schema.publishTargets).values({
      publish_id: publishId,
      screen_id: screenId,
    });
    await db.insert(schema.deviceCertificates).values({
      id: randomUUID(),
      screen_id: screenId,
      serial,
      certificate_pem: 'dry-run-cert',
      is_revoked: false,
      expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    });
    recordStep('Seed screen/playback data', true, screenId);

    const overview = await apiRequest(baseUrl, adminToken, 'GET', '/api/v1/screens/overview?include_media=true');
    if (overview.status !== 200) {
      throw new Error(`Overview bootstrap failed: ${overview.status} ${JSON.stringify(overview.data)}`);
    }
    const overviewBody = requireObject(overview.data, 'overview');
    const overviewScreens = Array.isArray(overviewBody.screens) ? (overviewBody.screens as Record<string, unknown>[]) : [];
    const overviewScreen = overviewScreens.find((screen) => screen.id === screenId);
    if (!overviewScreen) {
      throw new Error('Seeded screen not present in overview bootstrap');
    }
    recordStep('Dashboard bootstrap', true);

    const detail = await apiRequest(
      baseUrl,
      adminToken,
      'GET',
      `/api/v1/screens/${screenId}/now-playing?include_media=true`
    );
    if (detail.status !== 200) {
      throw new Error(`Detail bootstrap failed: ${detail.status} ${JSON.stringify(detail.data)}`);
    }
    const detailBody = requireObject(detail.data, 'detail');
    if (detailBody.screen_id !== screenId) {
      throw new Error('Detail bootstrap returned wrong screen');
    }
    recordStep('Detail bootstrap', true);

    socket = await connectScreensSocket(baseUrl, adminToken);
    recordStep('Socket connect', true);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('screens:subscribe ack timed out')), 8000);
      socket!.emit('screens:subscribe', { includeAll: true, screenIds: [screenId] }, (result: unknown) => {
        clearTimeout(timer);
        const payload = requireObject(result, 'screens subscribe');
        const subscribed = Array.isArray(payload.subscribed) ? (payload.subscribed as string[]) : [];
        if (!subscribed.includes(screenId)) {
          reject(new Error(`screens:subscribe rejected target screen: ${JSON.stringify(payload)}`));
          return;
        }
        resolve();
      });
    });
    recordStep('Socket subscribe', true);

    const stateUpdatePromise = waitForEvent(
      socket,
      'screens:state:update',
      (payload) => {
        const screen = payload.screen as Record<string, unknown> | undefined;
        return screen?.id === screenId && screen?.current_media_id === mediaId;
      }
    );

    const heartbeat = await fetch(`${baseUrl}/api/v1/device/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-serial': serial,
      },
      body: JSON.stringify({
        device_id: screenId,
        status: 'ONLINE',
        uptime: 120,
        memory_usage: 30,
        cpu_usage: 20,
        current_schedule_id: scheduleId,
        current_media_id: mediaId,
      }),
    });
    if (heartbeat.status !== 200) {
      throw new Error(`Heartbeat failed: ${heartbeat.status} ${await heartbeat.text()}`);
    }

    const stateUpdate = await stateUpdatePromise;
    const stateScreen = requireObject(stateUpdate.screen, 'state update screen');
    if (stateScreen.id !== screenId) {
      throw new Error('State update delivered wrong screen');
    }
    recordStep('screens:state:update from heartbeat', true);

    const refreshPromise = waitForEvent(
      socket,
      'screens:refresh:required',
      (payload) =>
        payload.reason === 'EMERGENCY' &&
        Array.isArray(payload.screen_ids) &&
        (payload.screen_ids as string[]).includes(screenId)
    );

    const emergency = await apiRequest(baseUrl, adminToken, 'POST', '/api/v1/emergency/trigger', {
      message: 'Realtime dry run emergency',
      screen_ids: [screenId],
    });
    if (emergency.status !== 201) {
      throw new Error(`Emergency trigger failed: ${emergency.status} ${JSON.stringify(emergency.data)}`);
    }
    const refreshEvent = await refreshPromise;
    if (refreshEvent.reason !== 'EMERGENCY') {
      throw new Error('Refresh event reason mismatch');
    }
    recordStep('screens:refresh:required from emergency', true);

    const emergencyBody = requireObject(emergency.data, 'emergency trigger');
    const emergencyId = requireString(emergencyBody.id, 'emergency.id');
    const clearEmergency = await apiRequest(baseUrl, adminToken, 'POST', `/api/v1/emergency/${emergencyId}/clear`);
    if (clearEmergency.status !== 200) {
      throw new Error(`Emergency clear failed: ${clearEmergency.status} ${JSON.stringify(clearEmergency.data)}`);
    }

    const deleteRefreshPromise = waitForEvent(
      socket,
      'screens:refresh:required',
      (payload) =>
        payload.reason === 'GROUP_MEMBERSHIP' &&
        Array.isArray(payload.screen_ids) &&
        (payload.screen_ids as string[]).includes(screenId)
    );

    const deleteResult = await apiRequest(baseUrl, adminToken, 'DELETE', `/api/v1/screens/${screenId}`);
    if (deleteResult.status !== 200) {
      throw new Error(`Screen delete failed: ${deleteResult.status} ${JSON.stringify(deleteResult.data)}`);
    }
    await deleteRefreshPromise;
    recordStep('screens:refresh:required from screen delete', true);

    const overviewAfterDelete = await apiRequest(baseUrl, adminToken, 'GET', '/api/v1/screens/overview?include_media=true');
    if (overviewAfterDelete.status !== 200) {
      throw new Error(`Overview after delete failed: ${overviewAfterDelete.status} ${JSON.stringify(overviewAfterDelete.data)}`);
    }
    const overviewAfterDeleteBody = requireObject(overviewAfterDelete.data, 'overview after delete');
    const screensAfterDelete = Array.isArray(overviewAfterDeleteBody.screens)
      ? (overviewAfterDeleteBody.screens as Record<string, unknown>[])
      : [];
    if (screensAfterDelete.some((screen) => screen.id === screenId)) {
      throw new Error('Deleted screen still appears in overview');
    }
    recordStep('Dashboard/detail behavior verified end-to-end', true);
  } finally {
    if (socket) {
      socket.disconnect();
    }
    if (server) {
      await server.close();
    }
    await closeDatabase();
  }

  const failed = steps.filter((step) => !step.ok);
  console.log('\nSummary');
  console.log(`Total steps: ${steps.length}`);
  console.log(`Passed: ${steps.length - failed.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[FAIL] screens realtime dry run', error);
  process.exitCode = 1;
});
