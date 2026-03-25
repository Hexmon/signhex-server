#!/usr/bin/env tsx

import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { initializeDatabase, closeDatabase, getDatabase, schema } from '../src/db/index.js';
import { createServer } from '../src/server/index.js';
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
  console.log(`[${status}] ${name}${details ? ` - ${details}` : ''}`);
}

async function ensureRole(name: string, grants: Array<{ action: string; subject: string }>) {
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
      first_name: 'Schedule',
      last_name: 'DryRun',
      role_id: roleId,
      is_active: true,
    })
    .returning();
  return created;
}

async function issueToken(user: UserRecord, role: RoleRecord) {
  const issued = await generateAccessToken(user.id, user.email, role.id, role.name);
  await createSessionRepository().create({
    user_id: user.id,
    access_jti: issued.jti,
    expires_at: issued.expiresAt,
  });
  return issued.token;
}

async function apiRequest(baseUrl: string, token: string | null, method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(extraHeaders || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data, headers: response.headers };
}

async function run() {
  let server: Awaited<ReturnType<typeof createServer>> | null = null;
  try {
    await initializeDatabase();
    server = await createServer();
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    recordStep('Server boot', true, baseUrl);

    const adminRole = await ensureRole('ADMIN', [
      { action: 'create', subject: 'Schedule' },
      { action: 'read', subject: 'Schedule' },
      { action: 'update', subject: 'Schedule' },
      { action: 'read', subject: 'Screen' },
    ]);
    const adminUser = await createUser(`schedule-dry-run-${Date.now()}@example.com`, adminRole.id);
    const adminToken = await issueToken(adminUser, adminRole);
    recordStep('Admin token issued', true);

    const db = getDatabase();
    await db
      .update(schema.emergencies)
      .set({ is_active: false, cleared_at: new Date(), clear_reason: 'schedule-dry-run-reset', updated_at: new Date() })
      .where(eq(schema.emergencies.is_active, true));

    const screenId = randomUUID();
    const serial = `serial-${randomUUID()}`;
    const mediaId = randomUUID();
    const presentationId = randomUUID();

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Schedule Dry Run Screen',
      status: 'OFFLINE',
    });
    await db.insert(schema.deviceCertificates).values({
      screen_id: screenId,
      serial,
      certificate_pem: 'dry-run-cert',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Schedule Dry Run Image',
      type: 'IMAGE',
      status: 'READY',
      created_by: adminUser.id,
      width: 1920,
      height: 1080,
    });
    await db.insert(schema.presentations).values({
      id: presentationId,
      name: 'Schedule Dry Run Presentation',
      created_by: adminUser.id,
    });
    await db.insert(schema.presentationItems).values({
      id: randomUUID(),
      presentation_id: presentationId,
      media_id: mediaId,
      order: 0,
      duration_seconds: 10,
    });
    recordStep('Dry-run fixtures created', true);

    const now = new Date();
    const scheduleStart = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    const scheduleEnd = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const createSchedule = await apiRequest(baseUrl, adminToken, 'POST', '/api/v1/schedules', {
      name: 'Dry Run Schedule',
      timezone: 'UTC',
      start_at: scheduleStart,
      end_at: scheduleEnd,
    });
    if (createSchedule.status !== 201) throw new Error(`Schedule create failed: ${createSchedule.status}`);
    const scheduleId = createSchedule.data.id as string;
    recordStep('Schedule created', true, scheduleId);

    const itemStart = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const itemEnd = new Date(now.getTime() + 25 * 60 * 1000).toISOString();
    const createItem = await apiRequest(baseUrl, adminToken, 'POST', `/api/v1/schedules/${scheduleId}/items`, {
      presentation_id: presentationId,
      start_at: itemStart,
      end_at: itemEnd,
      screen_ids: [screenId],
    });
    if (createItem.status !== 201) throw new Error(`Schedule item create failed: ${createItem.status}`);
    recordStep('Schedule item created', true);

    const publish = await apiRequest(baseUrl, adminToken, 'POST', `/api/v1/schedules/${scheduleId}/publish`, {
      screen_ids: [screenId],
      notes: 'schedule-dry-run',
    });
    if (publish.status !== 200) throw new Error(`Schedule publish failed: ${publish.status}`);
    const snapshotId = publish.data.snapshot_id as string;
    recordStep('Schedule published', true, snapshotId);

    const snapshotResponse = await apiRequest(
      baseUrl,
      null,
      'GET',
      `/api/v1/device/${screenId}/snapshot`,
      undefined,
      { 'x-device-serial': serial }
    );
    if (snapshotResponse.status !== 200) throw new Error(`Device snapshot fetch failed: ${snapshotResponse.status}`);
    if (snapshotResponse.data.publish.snapshot_id !== snapshotId) {
      throw new Error('Snapshot id mismatch in device snapshot response');
    }
    recordStep('Device snapshot fetched', true, snapshotId);

    const etag = snapshotResponse.headers.get('etag');
    if (!etag) throw new Error('ETag missing from device snapshot response');
    const notModified = await apiRequest(
      baseUrl,
      null,
      'GET',
      `/api/v1/device/${screenId}/snapshot`,
      undefined,
      { 'x-device-serial': serial, 'if-none-match': etag }
    );
    if (notModified.status !== 304) throw new Error(`Expected 304, received ${notModified.status}`);
    recordStep('Snapshot ETag honored', true, etag);
  } catch (error) {
    recordStep('Schedule dry run failure', false, error instanceof Error ? error.message : String(error));
  } finally {
    if (server) await server.close();
    await closeDatabase();
  }

  const failures = steps.filter((step) => !step.ok);
  console.log(`\nSummary: ${steps.length - failures.length}/${steps.length} steps passed`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
