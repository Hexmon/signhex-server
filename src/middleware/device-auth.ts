import { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { AppError } from '@/utils/app-error';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { recordDeviceAuthAttempt } from '@/observability/metrics';
import {
  hasAnySignatureHeader,
  hasCompleteSignatureHeaders,
  parseDeviceRequestSignatureHeaders,
  resolveDeviceAuthMode,
  resolveDeviceAuthSignatureMaxSkewSeconds,
  verifyDeviceRequestSignature,
} from '@/utils/device-request-auth';

const logger = createLogger('device-auth');
const deviceIdSchema = z.string().uuid();

type DeviceAuthOptions = {
  allowUserToken?: boolean;
};

const getDeviceRequestUrl = (request: FastifyRequest) => request.raw.url || request.url || '/';

function normalizeAuthFailureReason(error: unknown) {
  if (error instanceof AppError && error.details && !Array.isArray(error.details)) {
    const reason = error.details.reason;
    if (typeof reason === 'string' && reason.trim().length > 0) {
      return reason.trim().toLowerCase();
    }
  }

  if (error instanceof AppError) {
    return error.code.trim().toLowerCase();
  }

  return 'unknown';
}

export async function authenticateDeviceOrThrow(
  request: FastifyRequest,
  deviceId: string,
  options: DeviceAuthOptions = {}
) {
  const parsedId = deviceIdSchema.safeParse(deviceId);
  if (!parsedId.success) {
    throw AppError.badRequest('Invalid device id');
  }

  const authMode = resolveDeviceAuthMode();
  const signatureHeaders = parseDeviceRequestSignatureHeaders(request.headers as Record<string, string | string[] | undefined>);
  const hasSignatureHeaders = hasAnySignatureHeader(signatureHeaders);
  const bearerToken = options.allowUserToken ? extractTokenFromHeader(request.headers.authorization) : null;
  const certSerial = signatureHeaders.serial;
  const recordAuthSuccess = (
    authMethod: 'legacy_serial' | 'signature' | 'user_token' | 'missing_identity'
  ) => {
    recordDeviceAuthAttempt({
      configuredMode: authMode,
      authMethod,
      result: 'success',
      reason: 'authorized',
    });
  };
  const initialAuthMethod: 'legacy_serial' | 'signature' | 'user_token' | 'missing_identity' = certSerial
    ? authMode === 'signature' || hasSignatureHeaders
      ? 'signature'
      : 'legacy_serial'
    : bearerToken
    ? 'user_token'
    : authMode === 'signature' || hasSignatureHeaders
    ? 'signature'
    : 'missing_identity';

  try {
    if (certSerial) {
      const db = getDatabase();
      const certificates = await db
        .select()
        .from(schema.deviceCertificates)
        .where(eq(schema.deviceCertificates.screen_id, deviceId))
        .orderBy(desc(schema.deviceCertificates.created_at));
      const cert = certificates.find((entry) => entry.serial === certSerial) ?? null;
      const activeCertificate = certificates.find((entry) => !entry.is_revoked && !entry.revoked_at) ?? null;
      const revokedCertificate = certificates.find((entry) => entry.is_revoked || entry.revoked_at) ?? null;

      if (!cert) {
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

      if (authMode === 'signature' || hasSignatureHeaders) {
        if (!hasCompleteSignatureHeaders(signatureHeaders)) {
          throw AppError.unauthorized('Missing device request signature', {
            reason: 'MISSING_DEVICE_SIGNATURE',
          });
        }
        if (!cert.public_key_pem) {
          throw AppError.forbidden('Device signature verification unavailable', {
            reason: 'DEVICE_SIGNATURE_UNAVAILABLE',
            auth_version: cert.auth_version,
          });
        }

        const signatureTimestamp = Number.parseInt(signatureHeaders.timestamp!, 10);
        if (!Number.isFinite(signatureTimestamp)) {
          throw AppError.badRequest('Invalid device signature timestamp', {
            reason: 'DEVICE_SIGNATURE_TIMESTAMP_INVALID',
          });
        }

        const maxSkewMs = resolveDeviceAuthSignatureMaxSkewSeconds() * 1000;
        if (Math.abs(Date.now() - signatureTimestamp) > maxSkewMs) {
          throw AppError.forbidden('Device request signature expired', {
            reason: 'DEVICE_SIGNATURE_EXPIRED',
            timestamp: signatureHeaders.timestamp,
          });
        }

        const isValidSignature = verifyDeviceRequestSignature({
          method: request.method,
          url: getDeviceRequestUrl(request),
          deviceId,
          timestamp: signatureHeaders.timestamp!,
          signature: signatureHeaders.signature!,
          publicKeyPem: cert.public_key_pem,
          version: signatureHeaders.version!,
        });

        if (!isValidSignature) {
          throw AppError.forbidden('Invalid device request signature', {
            reason: 'DEVICE_SIGNATURE_INVALID',
          });
        }
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

      const authMethod = authMode === 'legacy' || !hasSignatureHeaders ? 'legacy_serial' : 'signature';

      request.device = {
        id: deviceId,
        authType: 'device',
        certificateId: cert.id,
        fingerprint: cert.serial,
        authMethod,
      };

      recordAuthSuccess(authMethod);
      return { type: 'device' as const };
    }

    if (options.allowUserToken) {
      if (!bearerToken) {
        throw AppError.unauthorized('Missing device identity header', {
          reason: 'MISSING_DEVICE_IDENTITY_HEADER',
        });
      }
      try {
        const payload = await verifyAccessToken(bearerToken);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'Screen')) {
          throw AppError.forbidden('Forbidden');
        }
        request.device = {
          id: deviceId,
          authType: 'user',
          userId: payload.sub,
        };
        recordAuthSuccess('user_token');
        return { type: 'user' as const };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error(err, 'Device auth user token error');
        throw AppError.unauthorized('Invalid token');
      }
    }

    if (authMode === 'signature') {
      throw AppError.unauthorized('Missing device request signature', {
        reason: 'MISSING_DEVICE_SIGNATURE',
      });
    }

    throw AppError.unauthorized('Missing device identity header', {
      reason: 'MISSING_DEVICE_IDENTITY_HEADER',
    });
  } catch (error) {
    recordDeviceAuthAttempt({
      configuredMode: authMode,
      authMethod: initialAuthMethod,
      result: 'failure',
      reason: normalizeAuthFailureReason(error),
    });
    throw error;
  }
}
