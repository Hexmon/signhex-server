import { and, eq } from 'drizzle-orm';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getDatabase, schema } from '@/db';
import { createLogger } from '@/utils/logger';
import { putObject } from '@/s3';
import { apiEndpoints } from '@/config/apiEndpoints';

const logger = createLogger('device-telemetry-routes');
const HEARTBEAT_BUCKET = 'logs-heartbeats';
const PROOF_OF_PLAY_BUCKET = 'logs-proof-of-play';

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
  const db = getDatabase();

  // Device heartbeat (no auth required - mTLS authenticated)
  fastify.post<{ Body: typeof heartbeatSchema._type }>(
    apiEndpoints.deviceTelemetry.heartbeat,
    {
      schema: {
        description: 'Device heartbeat (mTLS authenticated)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = heartbeatSchema.parse(request.body);
        const [screen] = await db
          .select({ id: schema.screens.id })
          .from(schema.screens)
          .where(eq(schema.screens.id, data.device_id));

        if (!screen) {
          return reply.status(404).send({ error: 'Device not registered' });
        }

        const receivedAt = new Date();
        const objectKey = `heartbeats/${data.device_id}/${receivedAt.getTime()}.json`;
        const payload = JSON.stringify({ ...data, received_at: receivedAt.toISOString() });

        const upload = await putObject(HEARTBEAT_BUCKET, objectKey, payload, 'application/json');

        const [storageObject] = await db
          .insert(schema.storageObjects)
          .values({
            bucket: HEARTBEAT_BUCKET,
            object_key: objectKey,
            content_type: 'application/json',
            size: Buffer.byteLength(payload),
            sha256: upload.sha256,
          })
          .returning();

        await db.insert(schema.heartbeats).values({
          screen_id: data.device_id,
          storage_object_id: storageObject?.id,
          created_at: receivedAt,
        });

        const screenStatus =
          data.status === 'ONLINE' ? 'ACTIVE' : data.status === 'OFFLINE' ? 'OFFLINE' : 'INACTIVE';

        await db
          .update(schema.screens)
          .set({
            status: screenStatus as any,
            last_heartbeat_at: receivedAt,
            updated_at: receivedAt,
          })
          .where(eq(schema.screens.id, data.device_id));

        logger.info(
          {
            deviceId: data.device_id,
            status: data.status,
            memoryUsage: data.memory_usage,
            cpuUsage: data.cpu_usage,
          },
          'Device heartbeat received'
        );

        const pendingCommands = await db
          .select({
            id: schema.deviceCommands.id,
            type: schema.deviceCommands.type,
            payload: schema.deviceCommands.payload,
            createdAt: schema.deviceCommands.created_at,
          })
          .from(schema.deviceCommands)
          .where(
            and(eq(schema.deviceCommands.screen_id, data.device_id), eq(schema.deviceCommands.status, 'PENDING'))
          )
          .orderBy(schema.deviceCommands.created_at);

        return reply.send({
          success: true,
          timestamp: new Date().toISOString(),
          commands: pendingCommands.map((command) => ({
            id: command.id,
            type: command.type,
            payload: command.payload,
            timestamp: new Date(command.createdAt).toISOString(),
          })),
        });
      } catch (error) {
        logger.error(error, 'Heartbeat error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Proof of Play (PoP) report
  fastify.post<{ Body: typeof proofOfPlaySchema._type }>(
    apiEndpoints.deviceTelemetry.proofOfPlay,
    {
      schema: {
        description: 'Report proof of play (mTLS authenticated)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = proofOfPlaySchema.parse(request.body);

        const receivedAt = new Date();
        const startedAt = new Date(data.start_time);
        const endedAt = new Date(data.end_time);
        const objectKey = `proof-of-play/${data.device_id}/${receivedAt.getTime()}.json`;
        const payload = JSON.stringify({ ...data, received_at: receivedAt.toISOString() });

        const upload = await putObject(PROOF_OF_PLAY_BUCKET, objectKey, payload, 'application/json');

        const [storageObject] = await db
          .insert(schema.storageObjects)
          .values({
            bucket: PROOF_OF_PLAY_BUCKET,
            object_key: objectKey,
            content_type: 'application/json',
            size: Buffer.byteLength(payload),
            sha256: upload.sha256,
          })
          .returning();

        await db.insert(schema.proofOfPlay).values({
          screen_id: data.device_id,
          media_id: data.media_id,
          presentation_id: data.schedule_id,
          started_at: startedAt,
          ended_at: endedAt,
          storage_object_id: storageObject?.id,
        });

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
    apiEndpoints.deviceTelemetry.screenshot,
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
    apiEndpoints.deviceTelemetry.commands,
    {
      schema: {
        description: 'Get pending commands for device (mTLS authenticated)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const deviceId = (request.params as any).deviceId;

        const pendingCommands = await db.transaction(async (tx) => {
          const commands = await tx
            .select({
              id: schema.deviceCommands.id,
              type: schema.deviceCommands.type,
              payload: schema.deviceCommands.payload,
              createdAt: schema.deviceCommands.created_at,
            })
            .from(schema.deviceCommands)
            .where(and(eq(schema.deviceCommands.screen_id, deviceId), eq(schema.deviceCommands.status, 'PENDING')))
            .orderBy(schema.deviceCommands.created_at);

          if (commands.length > 0) {
            await tx
              .update(schema.deviceCommands)
              .set({ status: 'SENT', updated_at: new Date() })
              .where(and(eq(schema.deviceCommands.screen_id, deviceId), eq(schema.deviceCommands.status, 'PENDING')));
          }

          return commands;
        });

        logger.info({ deviceId }, 'Fetching pending commands');

        return reply.send({
          commands: pendingCommands.map((command) => ({
            id: command.id,
            type: command.type,
            payload: command.payload,
            timestamp: new Date(command.createdAt).toISOString(),
          })),
        });
      } catch (error) {
        logger.error(error, 'Get commands error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Acknowledge command
  fastify.post<{ Params: { deviceId: string; commandId: string } }>(
    apiEndpoints.deviceTelemetry.ackCommand,
    {
      schema: {
        description: 'Acknowledge command execution (mTLS authenticated)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { deviceId, commandId } = request.params as any;

        const acknowledgedAt = new Date();

        const [updatedCommand] = await db
          .update(schema.deviceCommands)
          .set({
            status: 'ACKNOWLEDGED',
            updated_at: acknowledgedAt,
          })
          .where(and(eq(schema.deviceCommands.id, commandId), eq(schema.deviceCommands.screen_id, deviceId)))
          .returning({ id: schema.deviceCommands.id });

        if (!updatedCommand) {
          return reply.status(404).send({ error: 'Command not found' });
        }

        logger.info({ deviceId, commandId }, 'Command acknowledged');

        return reply.send({
          success: true,
          timestamp: acknowledgedAt.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Acknowledge command error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}
