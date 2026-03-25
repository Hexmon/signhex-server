import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createTestServer, closeTestServer } from '@/test/helpers';
import { HTTP_STATUS } from '@/http-status-codes';
import { getDatabase, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';
import { testUser } from '@/test/helpers';

function buildCsrWithDeviceId(deviceId: string) {
  const content = Buffer.from(`CN=${deviceId}`).toString('base64');
  return `-----BEGIN CERTIFICATE REQUEST-----\n${content}\n-----END CERTIFICATE REQUEST-----`;
}

describe('Device Pairing Routes', () => {
  let server: FastifyInstance;
  let adminToken: string;

  async function issueAdminToken() {
    const db = getDatabase();
    const [adminRole] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'ADMIN')).limit(1);
    if (!adminRole) {
      throw new Error('ADMIN role is required for device pairing tests');
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

  beforeAll(async () => {
    server = await createTestServer();
    adminToken = await issueAdminToken();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('should return 404 for invalid pairing code', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/complete',
      payload: {
        pairing_code: '000000',
        csr: buildCsrWithDeviceId('00000000-0000-0000-0000-000000000099'),
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('should return 400 for invalid CSR format', async () => {
    const requestRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/request',
      payload: { device_label: 'Test Device', expires_in: 600 },
    });
    const requestBody = JSON.parse(requestRes.body);

    const confirmRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/confirm',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        pairing_code: requestBody.pairing_code,
        name: 'Test Screen',
      },
    });
    expect(confirmRes.statusCode).toBe(HTTP_STATUS.OK);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/complete',
      payload: {
        pairing_code: requestBody.pairing_code,
        csr: 'invalid-csr',
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('should return 409 when CSR deviceId does not match pairing deviceId', async () => {
    const requestRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/request',
      payload: { device_label: 'Test Device', expires_in: 600 },
    });
    const requestBody = JSON.parse(requestRes.body);

    const confirmRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/confirm',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        pairing_code: requestBody.pairing_code,
        name: 'Test Screen',
      },
    });
    expect(confirmRes.statusCode).toBe(HTTP_STATUS.OK);

    const mismatchedId = '00000000-0000-0000-0000-000000000099';
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/complete',
      payload: {
        pairing_code: requestBody.pairing_code,
        csr: buildCsrWithDeviceId(mismatchedId),
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CONFLICT);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toBe('CSR deviceId does not match pairing deviceId');
  });

  it('should return 404 when a pairing code expires before device completion', async () => {
    const requestRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/request',
      payload: { device_label: 'Expired Device', expires_in: 600 },
    });
    const requestBody = JSON.parse(requestRes.body);

    const confirmRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/confirm',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        pairing_code: requestBody.pairing_code,
        name: 'Expired Screen',
      },
    });
    expect(confirmRes.statusCode).toBe(HTTP_STATUS.OK);

    const db = getDatabase();
    await db
      .update(schema.devicePairings)
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where(eq(schema.devicePairings.id, requestBody.id));

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/complete',
      payload: {
        pairing_code: requestBody.pairing_code,
        csr: buildCsrWithDeviceId(requestBody.device_id),
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Invalid or expired pairing code');
  });

  it('returns active pairing metadata for a confirmed recovery pairing on the same device id', async () => {
    const requestRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/request',
      payload: { device_label: 'Recovery Device', expires_in: 600 },
    });
    const requested = JSON.parse(requestRes.body);

    const db = getDatabase();
    await db.insert(schema.screens).values({
      id: requested.device_id,
      name: 'Existing Screen',
      status: 'OFFLINE',
    });

    const generateRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/generate',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        device_id: requested.device_id,
        expires_in: 600,
      },
    });
    const generated = JSON.parse(generateRes.body);

    const confirmRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/confirm',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        pairing_code: generated.pairing_code,
        name: 'Existing Screen',
        location: 'Lobby',
      },
    });

    expect(confirmRes.statusCode).toBe(HTTP_STATUS.OK);

    const statusRes = await server.inject({
      method: 'GET',
      url: `/api/v1/device-pairing/status?device_id=${requested.device_id}`,
    });

    expect(statusRes.statusCode).toBe(HTTP_STATUS.OK);
    const statusBody = JSON.parse(statusRes.body);
    expect(statusBody.device_id).toBe(requested.device_id);
    expect(statusBody.confirmed).toBe(true);
    expect(statusBody.screen.id).toBe(requested.device_id);
    expect(statusBody.active_pairing).toBeTruthy();
    expect(statusBody.active_pairing.confirmed).toBe(true);
    expect(statusBody.active_pairing.mode).toBe('RECOVERY');
    expect(statusBody.active_pairing.pairing_code).toBe(generated.pairing_code);
  });

  it('rejects superseded recovery codes and keeps only the latest active code per device', async () => {
    const deviceId = randomUUID();
    const db = getDatabase();

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Superseded Recovery Screen',
      status: 'OFFLINE',
    });

    const firstGenerateRes = await server.inject({
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
    expect(firstGenerateRes.statusCode).toBe(HTTP_STATUS.CREATED);
    const firstGenerated = JSON.parse(firstGenerateRes.body);

    const secondGenerateRes = await server.inject({
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
    expect(secondGenerateRes.statusCode).toBe(HTTP_STATUS.CREATED);
    const secondGenerated = JSON.parse(secondGenerateRes.body);

    expect(secondGenerated.pairing_code).not.toBe(firstGenerated.pairing_code);

    const staleConfirmRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/confirm',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        pairing_code: firstGenerated.pairing_code,
        name: 'Superseded Recovery Screen',
      },
    });

    expect(staleConfirmRes.statusCode).toBe(HTTP_STATUS.CONFLICT);
    const staleConfirmBody = JSON.parse(staleConfirmRes.body);
    expect(staleConfirmBody.error.message).toBe(
      'This recovery code has been superseded. Generate or use the latest recovery code.'
    );

    const latestConfirmRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/confirm',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        pairing_code: secondGenerated.pairing_code,
        name: 'Superseded Recovery Screen',
        location: 'Lobby',
      },
    });

    expect(latestConfirmRes.statusCode).toBe(HTTP_STATUS.OK);

    const statusRes = await server.inject({
      method: 'GET',
      url: `/api/v1/device-pairing/status?device_id=${deviceId}`,
    });

    expect(statusRes.statusCode).toBe(HTTP_STATUS.OK);
    const statusBody = JSON.parse(statusRes.body);
    expect(statusBody.active_pairing?.pairing_code).toBe(secondGenerated.pairing_code);
    expect(statusBody.active_pairing?.mode).toBe('RECOVERY');
  });

  it('returns structured recovery diagnostics for an expired device certificate', async () => {
    const deviceId = randomUUID();
    const serial = `expired-cert-${randomUUID()}`;
    const db = getDatabase();

    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Expired Diagnostics Screen',
      status: 'ACTIVE',
    });

    await db.insert(schema.deviceCertificates).values({
      screen_id: deviceId,
      serial,
      certificate_pem: 'expired-cert',
      expires_at: new Date(Date.now() - 60_000),
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/device-pairing/recovery/${deviceId}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.device_id).toBe(deviceId);
    expect(body.screen.id).toBe(deviceId);
    expect(body.certificate.serial).toBe(serial);
    expect(body.recovery.auth_state).toBe('EXPIRED_CERTIFICATE');
    expect(body.recovery.reason).toContain('expired');
    expect(body.recovery.recommended_action).toBe('RECOVER_IN_PLACE');
  });
});
