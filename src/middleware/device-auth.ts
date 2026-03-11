import { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { AppError } from '@/utils/app-error';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';

const logger = createLogger('device-auth');
const deviceIdSchema = z.string().uuid();

type DeviceAuthOptions = {
  allowUserToken?: boolean;
};

const readHeaderValue = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) return value[0];
  return value;
};

export async function authenticateDeviceOrThrow(
  request: FastifyRequest,
  deviceId: string,
  options: DeviceAuthOptions = {}
) {
  const parsedId = deviceIdSchema.safeParse(deviceId);
  if (!parsedId.success) {
    throw AppError.badRequest('Invalid device id');
  }

  const certSerial =
    readHeaderValue(request.headers['x-device-serial'] as string | string[] | undefined) ||
    readHeaderValue(request.headers['x-device-cert-serial'] as string | string[] | undefined) ||
    readHeaderValue(request.headers['x-device-cert'] as string | string[] | undefined);

  if (certSerial) {
    const db = getDatabase();
    const [cert] = await db
      .select()
      .from(schema.deviceCertificates)
      .where(and(eq(schema.deviceCertificates.screen_id, deviceId), eq(schema.deviceCertificates.serial, certSerial)));

    if (!cert) {
      const certificates = await db
        .select({
          id: schema.deviceCertificates.id,
          serial: schema.deviceCertificates.serial,
          is_revoked: schema.deviceCertificates.is_revoked,
          revoked_at: schema.deviceCertificates.revoked_at,
          expires_at: schema.deviceCertificates.expires_at,
        })
        .from(schema.deviceCertificates)
        .where(eq(schema.deviceCertificates.screen_id, deviceId))
        .orderBy(desc(schema.deviceCertificates.created_at));

      const activeCertificate = certificates.find((entry) => !entry.is_revoked && !entry.revoked_at);
      const revokedCertificate = certificates.find((entry) => entry.is_revoked || entry.revoked_at);

      if (revokedCertificate && !activeCertificate) {
        throw AppError.forbidden('Device credentials revoked', {
          reason: 'DEVICE_CREDENTIALS_REVOKED',
          revoked_at: revokedCertificate.revoked_at?.toISOString?.() ?? revokedCertificate.revoked_at ?? null,
        });
      }

      throw AppError.forbidden('Invalid device credentials', {
        reason: activeCertificate ? 'DEVICE_SERIAL_MISMATCH' : 'DEVICE_CREDENTIALS_INVALID',
        expected_serial: activeCertificate?.serial ?? null,
      });
    }

    if (cert.is_revoked || cert.revoked_at) {
      throw AppError.forbidden('Device credentials revoked', {
        reason: 'DEVICE_CREDENTIALS_REVOKED',
        revoked_at: cert.revoked_at?.toISOString?.() ?? cert.revoked_at ?? null,
      });
    }
    if (cert.expires_at && cert.expires_at.getTime() <= Date.now()) {
      throw AppError.forbidden('Device credentials expired', {
        reason: 'DEVICE_CREDENTIALS_EXPIRED',
        expires_at: cert.expires_at.toISOString(),
      });
    }
    const [screen] = await db
      .select({ id: schema.screens.id })
      .from(schema.screens)
      .where(eq(schema.screens.id, deviceId));

    if (!screen) {
      throw AppError.notFound('Device not registered', {
        reason: 'DEVICE_NOT_REGISTERED',
      });
    }

    request.device = {
      id: deviceId,
      authType: 'device',
      certificateId: cert.id,
      fingerprint: cert.serial,
    };

    return { type: 'device' as const };
  }

  if (options.allowUserToken) {
    const token = extractTokenFromHeader(request.headers.authorization);
    if (!token) {
      throw AppError.unauthorized('Missing device identity header', {
        reason: 'MISSING_DEVICE_IDENTITY_HEADER',
      });
    }
    try {
      const payload = await verifyAccessToken(token);
      const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
      if (!ability.can('read', 'Screen')) {
        throw AppError.forbidden('Forbidden');
      }
      request.device = {
        id: deviceId,
        authType: 'user',
        userId: payload.sub,
      };
      return { type: 'user' as const };
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error(err, 'Device auth user token error');
      throw AppError.unauthorized('Invalid token');
    }
  }

  throw AppError.unauthorized('Missing device identity header', {
    reason: 'MISSING_DEVICE_IDENTITY_HEADER',
  });
}
