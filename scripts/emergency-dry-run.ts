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
      first_name: 'Emergency',
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

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
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

    const adminRole = await ensureRole('ADMIN', [{ action: 'update', subject: 'Screen' }]);
    const adminUser = await createUser(`emergency-dry-run-${Date.now()}@example.com`, adminRole.id);
    const adminToken = await issueToken(adminUser, adminRole);
    recordStep('Admin token issued', true);

    const db = getDatabase();
    await db
      .update(schema.emergencies)
      .set({ is_active: false, cleared_at: new Date(), clear_reason: 'emergency-dry-run-reset', updated_at: new Date() })
      .where(eq(schema.emergencies.is_active, true));

    const screenId = randomUUID();
    const groupId = randomUUID();
    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Emergency Dry Run Screen',
      status: 'ACTIVE',
    });
    await db.insert(schema.screenGroups).values({
      id: groupId,
      name: 'Emergency Dry Run Group',
    });
    await db.insert(schema.screenGroupMembers).values({
      group_id: groupId,
      screen_id: screenId,
    });
    recordStep('Emergency fixtures created', true);

    const globalResponse = await apiRequest(baseUrl, adminToken, 'POST', '/api/v1/emergency/trigger', {
      message: 'Global emergency dry run',
      target_all: true,
      severity: 'LOW',
      audit_note: 'dry-run-global',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    if (globalResponse.status !== 201) throw new Error(`Global emergency trigger failed: ${globalResponse.status}`);
    recordStep('Global emergency triggered', true, globalResponse.data.id);

    const groupResponse = await apiRequest(baseUrl, adminToken, 'POST', '/api/v1/emergency/trigger', {
      message: 'Group emergency dry run',
      screen_group_ids: [groupId],
      severity: 'CRITICAL',
      audit_note: 'dry-run-group',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    if (groupResponse.status !== 201) throw new Error(`Group emergency trigger failed: ${groupResponse.status}`);
    recordStep('Group emergency triggered', true, groupResponse.data.id);

    const statusResponse = await apiRequest(baseUrl, adminToken, 'GET', '/api/v1/emergency/status');
    if (statusResponse.status !== 200) throw new Error(`Emergency status failed: ${statusResponse.status}`);
    if (!statusResponse.data.active || statusResponse.data.emergency.scope !== 'GLOBAL') {
      throw new Error('Emergency precedence did not resolve to GLOBAL as expected');
    }
    recordStep('Emergency precedence verified', true, statusResponse.data.emergency.scope);

    const clearGroup = await apiRequest(baseUrl, adminToken, 'POST', `/api/v1/emergency/${groupResponse.data.id}/clear`, {
      clear_reason: 'dry-run-complete',
    });
    if (clearGroup.status !== 200) throw new Error(`Group emergency clear failed: ${clearGroup.status}`);
    if (clearGroup.data.clear_reason !== 'dry-run-complete') {
      throw new Error('clear_reason not returned from clear response');
    }
    recordStep('Group emergency cleared', true);

    const clearGlobal = await apiRequest(baseUrl, adminToken, 'POST', `/api/v1/emergency/${globalResponse.data.id}/clear`, {
      clear_reason: 'dry-run-complete',
    });
    if (clearGlobal.status !== 200) throw new Error(`Global emergency clear failed: ${clearGlobal.status}`);
    recordStep('Global emergency cleared', true);

    const finalStatus = await apiRequest(baseUrl, adminToken, 'GET', '/api/v1/emergency/status');
    if (finalStatus.status !== 200 || finalStatus.data.active !== false) {
      throw new Error('Emergency status did not return to inactive');
    }
    recordStep('Emergency state returned to inactive', true);
  } catch (error) {
    recordStep('Emergency dry run failure', false, error instanceof Error ? error.message : String(error));
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
