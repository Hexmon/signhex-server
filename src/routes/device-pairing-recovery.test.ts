import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import forge from 'node-forge';
import { eq } from 'drizzle-orm';
import { createTestServer, closeTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';
import { HTTP_STATUS } from '@/http-status-codes';
import * as s3 from '@/s3';

function buildCsrWithDeviceId(deviceId: string) {
  const keyPair = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keyPair.publicKey;
  csr.setSubject([{ name: 'commonName', value: deviceId }]);
  csr.sign(keyPair.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

async function issueAdminToken() {
  const db = getDatabase();
  const [adminRole] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'ADMIN')).limit(1);
  if (!adminRole) {
    throw new Error('ADMIN role is required for device pairing recovery tests');
  }

  const currentPermissions =
    adminRole.permissions && typeof adminRole.permissions === 'object'
      ? (adminRole.permissions as { grants?: Array<{ action: string; subject: string }> })
      : {};
  const mergedGrants = [...(currentPermissions.grants || [])];
  for (const grant of [
    { action: 'create', subject: 'DevicePairing' },
    { action: 'create', subject: 'Screen' },
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

describe('Device pairing in-place recovery', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    vi.spyOn(s3, 'putObject').mockResolvedValue({ sha256: 'test-sha256' } as any);
    server = await createTestServer();
    adminToken = await issueAdminToken();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeTestServer(server);
  });

  it('reissues credentials for an existing screen without creating a new device id', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();
    const oldSerial = `serial-${randomUUID()}`;

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Recovery Screen',
      status: 'OFFLINE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial: oldSerial,
      certificate_pem: 'old-cert',
      expires_at: new Date(Date.now() + 60_000),
    });

    const generateResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/generate',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        device_id: deviceId,
        expires_in: 600,
      },
    });

    expect(generateResponse.statusCode).toBe(HTTP_STATUS.CREATED);
    const generated = JSON.parse(generateResponse.body);

    const confirmResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/confirm',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        pairing_code: generated.pairing_code,
        name: 'Recovery Screen',
        location: 'Lobby',
      },
    });

    expect(confirmResponse.statusCode).toBe(HTTP_STATUS.OK);

    const completeResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/complete',
      payload: {
        pairing_code: generated.pairing_code,
        csr: buildCsrWithDeviceId(deviceId),
      },
    });

    expect(completeResponse.statusCode).toBe(HTTP_STATUS.CREATED);
    const completed = JSON.parse(completeResponse.body);
    expect(completed.device_id).toBe(deviceId);
    expect(completed.fingerprint).toBeTruthy();

    const certRows = await db
      .select()
      .from(schema.deviceCertificates)
      .where(eq(schema.deviceCertificates.screen_id, deviceId));

    expect(certRows).toHaveLength(2);
    const revokedOld = certRows.find((row) => row.serial === oldSerial);
    const activeNew = certRows.find((row) => row.serial === completed.fingerprint);
    expect(revokedOld?.revoked_at).toBeTruthy();
    expect(revokedOld?.is_revoked).toBe(true);
    expect(activeNew?.revoked_at ?? null).toBeNull();
    expect(activeNew?.public_key_pem).toContain('BEGIN PUBLIC KEY');
    expect(activeNew?.auth_version).toBe('signature_v1');

    const oldHeartbeat = await server.inject({
      method: 'POST',
      url: '/api/v1/device/heartbeat',
      headers: {
        'x-device-serial': oldSerial,
      },
      payload: {
        device_id: deviceId,
        status: 'ONLINE',
        uptime: 100,
        memory_usage: 10,
        cpu_usage: 5,
      },
    });

    expect(oldHeartbeat.statusCode).toBe(HTTP_STATUS.FORBIDDEN);

    const newHeartbeat = await server.inject({
      method: 'POST',
      url: '/api/v1/device/heartbeat',
      headers: {
        'x-device-serial': completed.fingerprint,
      },
      payload: {
        device_id: deviceId,
        status: 'ONLINE',
        uptime: 100,
        memory_usage: 10,
        cpu_usage: 5,
      },
    });

    expect(newHeartbeat.statusCode).toBe(HTTP_STATUS.OK);
  });

  it('starts recovery through the dedicated recovery endpoint', async () => {
    const db = getDatabase();
    const deviceId = randomUUID();

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Dedicated Recovery Screen',
      status: 'OFFLINE',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/device-pairing/recovery/${deviceId}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        expires_in: 900,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CREATED);
    const body = JSON.parse(response.body);
    expect(body.pairing_code).toBeTruthy();
    expect(body.recovery.mode).toBe('RECOVERY');
    expect(body.recovery.device_id).toBe(deviceId);
    expect(body.recovery.screen.id).toBe(deviceId);
    expect(body.diagnostics.recommended_action).toBeTruthy();
  });
});
