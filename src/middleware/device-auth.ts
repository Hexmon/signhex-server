import { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
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

    if (!cert || cert.is_revoked || cert.revoked_at) {
      throw AppError.forbidden('Invalid device credentials');
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
      throw AppError.unauthorized('Missing device identity header');
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

  throw AppError.unauthorized('Missing device identity header');
}
