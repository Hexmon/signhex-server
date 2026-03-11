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
  });
});
