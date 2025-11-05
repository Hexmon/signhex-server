import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { createDevicePairingRepository } from '@/db/repositories/device-pairing';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';

const logger = createLogger('device-pairing-routes');

const generatePairingCodeSchema = z.object({
  device_id: z.string().min(1),
  expires_in: z.number().int().positive().default(3600), // 1 hour
});

const completePairingSchema = z.object({
  pairing_code: z.string().min(1),
  csr: z.string().min(1), // Certificate Signing Request
});

export async function devicePairingRoutes(fastify: FastifyInstance) {
  const pairingRepo = createDevicePairingRepository();

  // Generate pairing code
  fastify.post<{ Body: typeof generatePairingCodeSchema._type }>(
    '/v1/device-pairing/generate',
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('create', 'DevicePairing')) {
          return reply.status(403).send({ error: 'Forbidden' });
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

        return reply.status(201).send({
          id: pairing.id,
          pairing_code: pairingCode,
          expires_at: expiresAt.toISOString(),
          expires_in: data.expires_in,
        });
      } catch (error) {
        logger.error(error, 'Generate pairing code error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Complete pairing (device endpoint - no auth required)
  fastify.post<{ Body: typeof completePairingSchema._type }>(
    '/v1/device-pairing/complete',
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
          return reply.status(404).send({ error: 'Invalid or expired pairing code' });
        }

        // TODO: Sign CSR and generate certificate
        // - Validate CSR format
        // - Sign with CA certificate
        // - Store certificate in database
        // - Mark pairing as used

        await pairingRepo.markAsUsed(pairing.id);

        logger.info(
          {
            deviceId: pairing.device_id,
            pairingId: pairing.id,
          },
          'Device pairing completed'
        );

        return reply.status(201).send({
          success: true,
          message: 'Device pairing completed. Certificate will be issued shortly.',
          device_id: pairing.device_id,
        });
      } catch (error) {
        logger.error(error, 'Complete pairing error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // List pairings
  fastify.get<{ Querystring: { page?: number; limit?: number } }>(
    '/v1/device-pairing',
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
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('read', 'DevicePairing')) {
          return reply.status(403).send({ error: 'Forbidden' });
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
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}

