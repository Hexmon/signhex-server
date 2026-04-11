import { randomUUID, X509Certificate } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import forge from 'node-forge';
import { createTestServer, closeTestServer } from '@/test/helpers';
import { HTTP_STATUS } from '@/http-status-codes';
import { getDatabase, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';
import { DevicePairingRepository } from '@/db/repositories/device-pairing';
import { ScreenRepository } from '@/db/repositories/screen';
import { testUser } from '@/test/helpers';

function buildCsr(options: { deviceId?: string; bits?: number } = {}) {
  const keyPair = forge.pki.rsa.generateKeyPair(options.bits ?? 2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keyPair.publicKey;
  if (options.deviceId) {
    csr.setSubject([{ name: 'commonName', value: options.deviceId }]);
  } else {
    csr.setSubject([]);
  }
  csr.sign(keyPair.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

function buildCsrWithDeviceId(deviceId: string) {
  return buildCsr({ deviceId });
}

function verifyIssuedCertificate(certificatePem: string, caCertificatePem: string) {
  const issued = new X509Certificate(certificatePem);
  const ca = new X509Certificate(caCertificatePem);
  expect(issued.issuer).toBe(ca.subject);
  expect(issued.verify(ca.publicKey)).toBe(true);
  return issued;
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('retries device-request pairing when the generated active code collides', async () => {
    const originalCreate = DevicePairingRepository.prototype.create;
    const createSpy = vi.spyOn(DevicePairingRepository.prototype, 'create');
    createSpy.mockImplementationOnce(async () => {
      const error = new Error('duplicate pairing code') as Error & { code?: string; constraint?: string };
      error.code = '23505';
      error.constraint = 'device_pairings_active_code_idx';
      throw error;
    });
    createSpy.mockImplementation(function (this: DevicePairingRepository, ...args: Parameters<DevicePairingRepository['create']>) {
      return originalCreate.apply(this, args);
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/request',
      payload: { device_label: 'Colliding Device', expires_in: 600 },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CREATED);
    const body = JSON.parse(response.body);
    expect(body.pairing_code).toMatch(/^\d{6}$/);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it('retries recovery pairing generation when the active code collides', async () => {
    const deviceId = randomUUID();
    const db = getDatabase();
    await db.insert(schema.screens).values({
      id: deviceId,
      name: 'Recovery Retry Screen',
      status: 'OFFLINE',
    });

    const originalCreate = DevicePairingRepository.prototype.create;
    const createSpy = vi.spyOn(DevicePairingRepository.prototype, 'create');
    createSpy.mockImplementationOnce(async () => {
      const error = new Error('duplicate pairing code') as Error & { code?: string; constraint?: string };
      error.code = '23505';
      error.constraint = 'device_pairings_active_code_idx';
      throw error;
    });
    createSpy.mockImplementation(function (this: DevicePairingRepository, ...args: Parameters<DevicePairingRepository['create']>) {
      return originalCreate.apply(this, args);
    });

    const response = await server.inject({
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

    expect(response.statusCode).toBe(HTTP_STATUS.CREATED);
    const body = JSON.parse(response.body);
    expect(body.pairing_code).toMatch(/^[A-F0-9]{6}$/);
    expect(createSpy).toHaveBeenCalledTimes(2);
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

  it('should return 400 when CSR commonName is missing', async () => {
    const requestRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/request',
      payload: { device_label: 'Missing CN Device', expires_in: 600 },
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
        name: 'Missing CN Screen',
      },
    });
    expect(confirmRes.statusCode).toBe(HTTP_STATUS.OK);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/complete',
      payload: {
        pairing_code: requestBody.pairing_code,
        csr: buildCsr(),
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    const body = JSON.parse(response.body);
    expect(body.error.message).toBe('CSR subject commonName is required');
  });

  it('should return 400 when CSR RSA key is too weak', async () => {
    const requestRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/request',
      payload: { device_label: 'Weak Key Device', expires_in: 600 },
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
        name: 'Weak Key Screen',
      },
    });
    expect(confirmRes.statusCode).toBe(HTTP_STATUS.OK);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/complete',
      payload: {
        pairing_code: requestBody.pairing_code,
        csr: buildCsr({ deviceId: requestBody.device_id, bits: 1024 }),
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    const body = JSON.parse(response.body);
    expect(body.error.message).toBe('CSR RSA public key must be at least 2048 bits');
  });

  it('issues a real CA-signed X509 certificate for a confirmed pairing', async () => {
    const requestRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/request',
      payload: { device_label: 'Happy Path Device', expires_in: 600 },
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
        name: 'Happy Path Screen',
      },
    });
    expect(confirmRes.statusCode).toBe(HTTP_STATUS.OK);

    const completeRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/complete',
      payload: {
        pairing_code: requestBody.pairing_code,
        csr: buildCsrWithDeviceId(requestBody.device_id),
      },
    });

    expect(completeRes.statusCode).toBe(HTTP_STATUS.CREATED);
    const body = JSON.parse(completeRes.body);
    const x509 = verifyIssuedCertificate(body.certificate, body.ca_certificate);

    expect(body.device_id).toBe(requestBody.device_id);
    expect(body.fingerprint).toBe(x509.serialNumber);
    expect(x509.subject).toContain(requestBody.device_id);

    const db = getDatabase();
    const certRows = await db
      .select()
      .from(schema.deviceCertificates)
      .where(eq(schema.deviceCertificates.screen_id, requestBody.device_id));
    expect(certRows).toHaveLength(1);
    expect(certRows[0]?.serial).toBe(x509.serialNumber);
    expect(certRows[0]?.certificate_pem).toContain('BEGIN CERTIFICATE');
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

  it('rolls back pairing completion if screen creation fails after certificate work starts', async () => {
    const requestRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/request',
      payload: { device_label: 'Rollback Device', expires_in: 600 },
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
        name: 'Rollback Screen',
      },
    });
    expect(confirmRes.statusCode).toBe(HTTP_STATUS.OK);

    const originalCreate = ScreenRepository.prototype.create;
    const createSpy = vi.spyOn(ScreenRepository.prototype, 'create');
    createSpy.mockImplementationOnce(async () => {
      throw new Error('screen create failed');
    });
    createSpy.mockImplementation(function (this: ScreenRepository, ...args: Parameters<ScreenRepository['create']>) {
      return originalCreate.apply(this, args);
    });

    const completeRes = await server.inject({
      method: 'POST',
      url: '/api/v1/device-pairing/complete',
      payload: {
        pairing_code: requestBody.pairing_code,
        csr: buildCsrWithDeviceId(requestBody.device_id),
      },
    });

    expect(completeRes.statusCode).toBe(500);

    const db = getDatabase();
    const certRows = await db
      .select()
      .from(schema.deviceCertificates)
      .where(eq(schema.deviceCertificates.screen_id, requestBody.device_id));
    expect(certRows).toHaveLength(0);

    const [pairingRow] = await db
      .select()
      .from(schema.devicePairings)
      .where(eq(schema.devicePairings.id, requestBody.id));
    expect(pairingRow?.used).toBe(false);
  });
});
