import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomBytes, createHash, createHmac, randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { config } from '@/config';
import { createDevicePairingRepository } from '@/db/repositories/device-pairing';
import { createDeviceCertificateRepository } from '@/db/repositories/device-certificate';
import { createScreenRepository } from '@/db/repositories/screen';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';

const logger = createLogger('device-pairing-routes');
const { BAD_REQUEST, CONFLICT, CREATED, FORBIDDEN, NOT_FOUND, OK, UNAUTHORIZED } = HTTP_STATUS;

const generatePairingCodeSchema = z.object({
  device_id: z.string().min(1),
  expires_in: z.number().int().positive().default(3600), // 1 hour
});

const completePairingSchema = z.object({
  pairing_code: z.string().min(1),
  csr: z.string().min(1), // Certificate Signing Request
});

const requestPairingSchema = z.object({
  device_label: z.string().optional(),
  expires_in: z.number().int().positive().default(600), // 10 minutes
});

const confirmPairingSchema = z.object({
  pairing_code: z.string().min(1),
  name: z.string().min(1).max(255),
  location: z.string().optional(),
});

export async function devicePairingRoutes(fastify: FastifyInstance) {
  const pairingRepo = createDevicePairingRepository();
  const certificateRepo = createDeviceCertificateRepository();

  // Generate pairing code
  fastify.post<{ Body: typeof generatePairingCodeSchema._type }>(
    apiEndpoints.devicePairing.generate,
    {
      schema: {
        description: 'Generate pairing code for device (admin only)',
        tags: ['Device Pairing'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('create', 'DevicePairing')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const data = generatePairingCodeSchema.parse(request.body);

        // Generate random pairing code (6 digits)
        const pairingCode = randomBytes(3).toString('hex').toUpperCase();

        const expiresAt = new Date();
        expiresAt.setSeconds(expiresAt.getSeconds() + data.expires_in);

        const pairing = await pairingRepo.create({
          device_id: data.device_id,
          pairing_code: pairingCode,
          expires_at: expiresAt,
        });

        logger.info(
          {
            deviceId: data.device_id,
            pairingCode,
            expiresAt,
          },
          'Pairing code generated'
        );

        return reply.status(CREATED).send({
          id: pairing.id,
          pairing_code: pairingCode,
          expires_at: expiresAt.toISOString(),
          expires_in: data.expires_in,
        });
      } catch (error) {
        logger.error(error, 'Generate pairing code error');
        return respondWithError(reply, error);
      }
    }
  );

  // Device-initiated pairing request (no auth)
  fastify.post<{ Body: typeof requestPairingSchema._type }>(
    apiEndpoints.devicePairing.request,
    {
      schema: {
        description: 'Request a pairing code from device after connectivity check',
        tags: ['Device Pairing'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Reaching this endpoint over LAN implies connectivity; record observed IP for debugging
        const data = requestPairingSchema.parse(request.body);
        const deviceId = randomUUID();

        const pairingCode = (Math.floor(Math.random() * 900000) + 100000).toString(); // 6-digit numeric
        const expiresAt = new Date(Date.now() + data.expires_in * 1000);

        const pairing = await pairingRepo.create({
          device_id: deviceId,
          pairing_code: pairingCode,
          expires_at: expiresAt,
        });

        logger.info(
          { deviceId, pairingCode, expiresAt, ip: request.ip, label: data.device_label },
          'Device pairing requested'
        );

        return reply.status(CREATED).send({
          id: pairing.id,
          device_id: deviceId,
          pairing_code: pairingCode,
          expires_at: expiresAt.toISOString(),
          expires_in: data.expires_in,
          connected: true,
          observed_ip: request.ip,
        });
      } catch (error) {
        logger.error(error, 'Device pairing request error');
        return respondWithError(reply, error);
      }
    }
  );

  // Complete pairing (device endpoint - no auth required)
  fastify.post<{ Body: typeof completePairingSchema._type }>(
    apiEndpoints.devicePairing.complete,
    {
      schema: {
        description: 'Complete device pairing with CSR',
        tags: ['Device Pairing'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = completePairingSchema.parse(request.body);

        // Find pairing by code
        const pairing = await pairingRepo.findByCode(data.pairing_code);
        if (!pairing) {
          return reply.status(NOT_FOUND).send({ error: 'Invalid or expired pairing code' });
        }
        if (!pairing.device_id) {
          return reply.status(BAD_REQUEST).send({ error: 'Pairing is missing a device id' });
        }
        const deviceId = pairing.device_id;

        const csr = data.csr.trim();
        if (!csr.startsWith('-----BEGIN CERTIFICATE REQUEST-----') || !csr.endsWith('-----END CERTIFICATE REQUEST-----')) {
          return reply.status(BAD_REQUEST).send({ error: 'Invalid CSR format' });
        }

        const caCert = await readFile(config.CA_CERT_PATH, 'utf8');
        const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

        const signature = createHmac('sha256', caCert).update(csr).digest('base64');
        const certificateBody = Buffer.from(`${csr}\n${signature}`, 'utf8').toString('base64');
        const certificatePem = `-----BEGIN CERTIFICATE-----\n${certificateBody}\n-----END CERTIFICATE-----`;
        const fingerprint = createHash('sha256').update(certificatePem).digest('hex');

        await certificateRepo.create({
          device_id: deviceId,
          certificate: certificatePem,
          private_key: '',
          fingerprint,
          expires_at: expiresAt,
        });

        await pairingRepo.markAsUsed(pairing.id);

        logger.info(
          {
            deviceId,
            pairingId: pairing.id,
            fingerprint,
          },
          'Device pairing completed'
        );

        return reply.status(CREATED).send({
          success: true,
          message: 'Device pairing completed. Certificate issued.',
          device_id: deviceId,
          certificate: certificatePem,
          fingerprint,
          expires_at: expiresAt.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Complete pairing error');
        return respondWithError(reply, error);
      }
    }
  );

  // Confirm pairing and create screen (admin)
  fastify.post<{ Body: typeof confirmPairingSchema._type }>(
    apiEndpoints.devicePairing.confirm,
    {
      schema: {
        description: 'Confirm pairing code and create screen (admin only)',
        tags: ['Device Pairing'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('create', 'Screen')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const data = confirmPairingSchema.parse(request.body);

        const pairing = await pairingRepo.findByCode(data.pairing_code);
        if (!pairing) {
          return reply.status(NOT_FOUND).send({ error: 'Invalid or expired pairing code' });
        }
        if (!pairing.device_id) {
          return reply.status(BAD_REQUEST).send({ error: 'Pairing missing device reference' });
        }

        const screenRepo = createScreenRepository();
        const existing = await screenRepo.findById(pairing.device_id);
        if (existing) {
          return reply.status(CONFLICT).send({ error: 'Screen already exists for this device' });
        }

        const screen = await screenRepo.create({
          id: pairing.device_id,
          name: data.name,
          location: data.location,
        });

        await pairingRepo.markAsUsed(pairing.id);

        logger.info({ pairingId: pairing.id, deviceId: pairing.device_id, screenId: screen.id }, 'Pairing confirmed and screen created');

        return reply.status(OK).send({
          message: 'Screen paired successfully',
          screen: {
            id: screen.id,
            name: screen.name,
            location: screen.location,
            status: screen.status,
            created_at: screen.created_at.toISOString(),
            updated_at: screen.updated_at.toISOString(),
          },
        });
      } catch (error) {
        logger.error(error, 'Confirm pairing error');
        return respondWithError(reply, error);
      }
    }
  );

  // List pairings
  fastify.get<{ Querystring: { page?: number; limit?: number } }>(
    apiEndpoints.devicePairing.list,
    {
      schema: {
        description: 'List device pairings (admin only)',
        tags: ['Device Pairing'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('read', 'DevicePairing')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const page = (request.query as any).page ? parseInt((request.query as any).page as string) : 1;
        const limit = (request.query as any).limit ? parseInt((request.query as any).limit as string) : 20;

        const result = await pairingRepo.list({ page, limit });

        return reply.send({
          items: result.items.map((p) => ({
            id: p.id,
            device_id: p.device_id,
            pairing_code: p.pairing_code,
            used: p.used,
            used_at: p.used_at?.toISOString() || null,
            expires_at: p.expires_at.toISOString(),
            created_at: p.created_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List pairings error');
        return respondWithError(reply, error);
      }
    }
  );
}
