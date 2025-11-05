import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createLogger } from '@/utils/logger';
import { putObject } from '@/s3';

const logger = createLogger('device-telemetry-routes');

const heartbeatSchema = z.object({
  device_id: z.string().min(1),
  status: z.enum(['ONLINE', 'OFFLINE', 'ERROR']),
  uptime: z.number().int().nonnegative(),
  memory_usage: z.number().nonnegative(),
  cpu_usage: z.number().nonnegative(),
  temperature: z.number().optional(),
  current_schedule_id: z.string().optional(),
  current_media_id: z.string().optional(),
});

const proofOfPlaySchema = z.object({
  device_id: z.string().min(1),
  media_id: z.string().min(1),
  schedule_id: z.string().min(1),
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  duration: z.number().int().positive(),
  completed: z.boolean(),
});

const screenshotSchema = z.object({
  device_id: z.string().min(1),
  timestamp: z.string().datetime(),
  image_data: z.string(), // base64 encoded
});

export async function deviceTelemetryRoutes(fastify: FastifyInstance) {
  // Device heartbeat (no auth required - mTLS authenticated)
  fastify.post<{ Body: typeof heartbeatSchema._type }>(
    '/v1/device/heartbeat',
    {
      schema: {
        description: 'Device heartbeat (mTLS authenticated)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = heartbeatSchema.parse(request.body);

        // TODO: Store heartbeat in database
        // - Update device status
        // - Store metrics in time-series database or MinIO
        // - Check for commands to send to device

        logger.info(
          {
            deviceId: data.device_id,
            status: data.status,
            memoryUsage: data.memory_usage,
            cpuUsage: data.cpu_usage,
          },
          'Device heartbeat received'
        );

        return reply.send({
          success: true,
          timestamp: new Date().toISOString(),
          commands: [], // TODO: Return pending commands
        });
      } catch (error) {
        logger.error(error, 'Heartbeat error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Proof of Play (PoP) report
  fastify.post<{ Body: typeof proofOfPlaySchema._type }>(
    '/v1/device/proof-of-play',
    {
      schema: {
        description: 'Report proof of play (mTLS authenticated)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = proofOfPlaySchema.parse(request.body);

        // TODO: Store PoP in database and MinIO
        // - Create PoP record
        // - Store raw payload in MinIO
        // - Update media play count

        logger.info(
          {
            deviceId: data.device_id,
            mediaId: data.media_id,
            duration: data.duration,
            completed: data.completed,
          },
          'Proof of play received'
        );

        return reply.status(201).send({
          success: true,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Proof of play error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Device screenshot
  fastify.post<{ Body: typeof screenshotSchema._type }>(
    '/v1/device/screenshot',
    {
      schema: {
        description: 'Upload device screenshot (mTLS authenticated)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = screenshotSchema.parse(request.body);

        // Decode base64 image
        const imageBuffer = Buffer.from(data.image_data, 'base64');

        // Upload to MinIO
        const objectKey = `device-screenshots/${data.device_id}/${Date.now()}.png`;
        await putObject('device-screenshots', objectKey, imageBuffer, 'image/png');

        logger.info(
          {
            deviceId: data.device_id,
            objectKey,
            size: imageBuffer.length,
          },
          'Device screenshot uploaded'
        );

        return reply.status(201).send({
          success: true,
          object_key: objectKey,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Screenshot upload error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Get pending commands for device
  fastify.get<{ Params: { deviceId: string } }>(
    '/v1/device/:deviceId/commands',
    {
      schema: {
        description: 'Get pending commands for device (mTLS authenticated)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const deviceId = (request.params as any).deviceId;

        // TODO: Query pending commands from database
        // - Get commands for this device
        // - Mark as sent
        // - Return command list

        logger.info({ deviceId }, 'Fetching pending commands');

        return reply.send({
          commands: [
            // Example commands:
            // {
            //   id: 'cmd-1',
            //   type: 'REBOOT',
            //   timestamp: '2024-01-01T00:00:00Z'
            // },
            // {
            //   id: 'cmd-2',
            //   type: 'REFRESH_SCHEDULE',
            //   timestamp: '2024-01-01T00:00:00Z'
            // }
          ],
        });
      } catch (error) {
        logger.error(error, 'Get commands error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Acknowledge command
  fastify.post<{ Params: { deviceId: string; commandId: string } }>(
    '/v1/device/:deviceId/commands/:commandId/ack',
    {
      schema: {
        description: 'Acknowledge command execution (mTLS authenticated)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { deviceId, commandId } = request.params as any;

        // TODO: Mark command as acknowledged
        // - Update command status
        // - Store acknowledgment timestamp

        logger.info({ deviceId, commandId }, 'Command acknowledged');

        return reply.send({
          success: true,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Acknowledge command error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}

