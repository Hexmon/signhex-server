import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createTestServer, closeTestServer } from '@/test/helpers';
import { HTTP_STATUS } from '@/http-status-codes';

function buildCsrWithDeviceId(deviceId: string) {
  const content = Buffer.from(`CN=${deviceId}`).toString('base64');
  return `-----BEGIN CERTIFICATE REQUEST-----\n${content}\n-----END CERTIFICATE REQUEST-----`;
}

describe('Device Pairing Routes', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createTestServer();
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
});
