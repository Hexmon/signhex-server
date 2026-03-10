import { and, eq, desc, inArray, isNull } from 'drizzle-orm';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getDatabase, schema } from '@/db';
import { createLogger } from '@/utils/logger';
import { putObject, getPresignedUrl } from '@/s3';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { getDefaultMedia } from '@/utils/default-media';
import { AppError } from '@/utils/app-error';
import { authenticateDeviceOrThrow } from '@/middleware/device-auth';
import { buildScreenPlaybackStateById } from '@/screens/playback';
import { emitScreenStateUpdate } from '@/realtime/screens-namespace';

const logger = createLogger('device-telemetry-routes');
const { CREATED } = HTTP_STATUS;
const HEARTBEAT_BUCKET = 'logs-heartbeats';
const PROOF_OF_PLAY_BUCKET = 'logs-proof-of-play';

const heartbeatSchema = z.object({
  device_id: z.string().min(1),
  status: z.enum(['ONLINE', 'OFFLINE', 'ERROR']),
  uptime: z.number().nonnegative(),
  memory_usage: z.number().nonnegative(),
  cpu_usage: z.number().nonnegative(),
  temperature: z.number().optional(),
  current_schedule_id: z.string().optional(),
  current_media_id: z.string().optional(),
  memory_total_mb: z.number().nonnegative().optional(),
  memory_used_mb: z.number().nonnegative().optional(),
  memory_free_mb: z.number().nonnegative().optional(),
  swap_total_mb: z.number().nonnegative().optional(),
  swap_used_mb: z.number().nonnegative().optional(),
  cpu_cores: z.number().int().positive().optional(),
  cpu_load_1m: z.number().nonnegative().optional(),
  cpu_load_5m: z.number().nonnegative().optional(),
  cpu_load_15m: z.number().nonnegative().optional(),
  cpu_temp_c: z.number().optional(),
  gpu_usage: z.number().nonnegative().optional(),
  gpu_temp_c: z.number().optional(),
  disk_total_gb: z.number().nonnegative().optional(),
  disk_used_gb: z.number().nonnegative().optional(),
  disk_free_gb: z.number().nonnegative().optional(),
  disk_usage_percent: z.number().nonnegative().optional(),
  network_ip: z.string().optional(),
  network_interface: z.string().optional(),
  network_rtt_ms: z.number().nonnegative().optional(),
  network_packet_loss_percent: z.number().nonnegative().optional(),
  network_up_mbps: z.number().nonnegative().optional(),
  network_down_mbps: z.number().nonnegative().optional(),
  display_count: z.number().int().nonnegative().optional(),
  displays: z
    .array(
      z.object({
        id: z.string().optional(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        refresh_rate_hz: z.number().positive().optional(),
        orientation: z.enum(['portrait', 'landscape']).optional(),
        connected: z.boolean().optional(),
        model: z.string().optional(),
      })
    )
    .optional(),
  audio_output: z.string().optional(),
  volume: z.number().nonnegative().optional(),
  muted: z.boolean().optional(),
  app_version: z.string().optional(),
  os_version: z.string().optional(),
  hostname: z.string().optional(),
  device_model: z.string().optional(),
  device_serial: z.string().optional(),
  player_uptime_seconds: z.number().int().nonnegative().optional(),
  last_error: z.string().optional(),
  crash_count: z.number().int().nonnegative().optional(),
  battery_percent: z.number().nonnegative().optional(),
  is_charging: z.boolean().optional(),
  power_source: z.enum(['AC', 'BATTERY', 'USB', 'UNKNOWN']).optional(),
  metrics: z.record(z.any()).optional(),
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

const createCommandSchema = z.object({
  type: z.enum(['REBOOT', 'REFRESH', 'TEST_PATTERN', 'TAKE_SCREENSHOT', 'SET_SCREENSHOT_INTERVAL']),
  payload: z.record(z.any()).optional(),
});

const snapshotQuerySchema = z.object({
  include_urls: z.string().optional(),
});

export async function deviceTelemetryRoutes(fastify: FastifyInstance) {
  const db = getDatabase();

  const getGroupIdsForScreen = async (screenId: string): Promise<string[]> => {
    const rows = await db
      .select({ group_id: schema.screenGroupMembers.group_id })
      .from(schema.screenGroupMembers)
      .where(eq(schema.screenGroupMembers.screen_id, screenId));
    return rows.map((r) => r.group_id);
  };

  const resolveEmergencyMediaUrl = async (mediaId?: string | null) => {
    if (!mediaId) return null;
    const [media] = await db.select().from(schema.media).where(eq(schema.media.id, mediaId));
    if (!media) return null;
    try {
      if ((media as any).ready_object_id) {
        const [stor] = await db
          .select()
          .from(schema.storageObjects)
          .where(eq(schema.storageObjects.id, (media as any).ready_object_id));
        if (stor) return await getPresignedUrl((stor as any).bucket, (stor as any).object_key, 3600);
      }
      if ((media as any).source_bucket && (media as any).source_object_key) {
        return await getPresignedUrl((media as any).source_bucket, (media as any).source_object_key, 3600);
      }
    } catch {
      return null;
    }
    return null;
  };

  const getActiveEmergencyForScreen = async (screenId: string, includeUrls: boolean) => {
    const [emergency] = await db
      .select()
      .from(schema.emergencies)
      .where(and(eq(schema.emergencies.is_active, true), isNull(schema.emergencies.cleared_at)))
      .orderBy(desc(schema.emergencies.created_at))
      .limit(1);
    if (!emergency) return null;

    const emergencyScreenIds = ((emergency as any).screen_ids || []) as string[];
    const emergencyGroupIds = ((emergency as any).screen_group_ids || []) as string[];
    const hasTargets = emergencyScreenIds.length > 0 || emergencyGroupIds.length > 0;
    const targetAll = (emergency as any).target_all === true || !hasTargets;

    if (!targetAll) {
      if (emergencyScreenIds.includes(screenId)) {
        // ok
      } else {
        const groupIds = await getGroupIdsForScreen(screenId);
        const groupMatch = emergencyGroupIds.some((gid) => groupIds.includes(gid));
        if (!groupMatch) return null;
      }
    }

    const mediaUrl = includeUrls ? await resolveEmergencyMediaUrl((emergency as any).media_id) : null;
    return {
      id: emergency.id,
      emergency_type_id: (emergency as any).emergency_type_id ?? null,
      triggered_by: emergency.triggered_by,
      message: emergency.message,
      severity: emergency.priority,
      media_id: (emergency as any).media_id ?? null,
      media_url: mediaUrl,
      screen_ids: emergencyScreenIds,
      screen_group_ids: emergencyGroupIds,
      target_all: (emergency as any).target_all ?? false,
      created_at: emergency.created_at.toISOString?.() ?? emergency.created_at,
      cleared_at: emergency.cleared_at?.toISOString?.() ?? emergency.cleared_at,
    };
  };

  const filterItemsForScreen = (items: any[], screenId: string, groupIds: string[]) => {
    return items.filter((i) => {
      const itemScreens = (i.screen_ids || []) as string[];
      const itemGroups = (i.screen_group_ids || []) as string[];
      const hasTargets = (itemScreens && itemScreens.length > 0) || (itemGroups && itemGroups.length > 0);
      if (!hasTargets) return true;
      if (itemScreens.includes(screenId)) return true;
      return itemGroups.some((gid) => groupIds.includes(gid));
    });
  };

  // Latest publish snapshot for device (device auth required; CMS JWT allowed)
  fastify.get<{ Params: { deviceId: string }; Querystring: typeof snapshotQuerySchema._type }>(
    apiEndpoints.deviceTelemetry.snapshot,
    {
      schema: {
        description: 'Get latest publish snapshot targeting this device',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const deviceId = (request.params as any).deviceId;
        await authenticateDeviceOrThrow(request, deviceId, { allowUserToken: true });
        const query = snapshotQuerySchema.parse(request.query);
        const includeUrls = query.include_urls?.toLowerCase() === 'true';

        const emergency = await getActiveEmergencyForScreen(deviceId, includeUrls);

        const [latest] = await db
          .select({
            publish_id: schema.publishes.id,
            schedule_id: schema.publishes.schedule_id,
            snapshot_id: schema.publishes.snapshot_id,
            published_at: schema.publishes.published_at,
            payload: schema.scheduleSnapshots.payload,
          })
          .from(schema.publishTargets)
          .innerJoin(schema.publishes, eq(schema.publishTargets.publish_id, schema.publishes.id))
          .innerJoin(schema.scheduleSnapshots, eq(schema.publishes.snapshot_id, schema.scheduleSnapshots.id))
          .where(eq(schema.publishTargets.screen_id, deviceId))
          .orderBy(desc(schema.publishes.published_at))
          .limit(1);

        if (!latest) {
          const defaultMedia = await getDefaultMedia(db);
          const defaultMediaPayload = defaultMedia?.media
            ? {
                id: defaultMedia.media.id,
                name: defaultMedia.media.name,
                type: defaultMedia.media.type,
                status: defaultMedia.media.status,
                duration_seconds: defaultMedia.media.duration_seconds,
                width: defaultMedia.media.width,
                height: defaultMedia.media.height,
                media_url: includeUrls ? defaultMedia.media_url : null,
              }
            : null;

          if (emergency) {
            return reply.send({
              device_id: deviceId,
              publish: null,
              snapshot: null,
              media_urls: undefined,
              emergency,
              default_media: defaultMediaPayload,
            });
          }
          if (defaultMediaPayload) {
            return reply.send({
              device_id: deviceId,
              publish: null,
              snapshot: null,
              media_urls: undefined,
              emergency: null,
              default_media: defaultMediaPayload,
            });
          }
          throw AppError.notFound('No publish found for this device');
        }

        const rawPayload = (latest.payload as any) || {};
        const schedule = rawPayload.schedule || {};
        const groupIds = await getGroupIdsForScreen(deviceId);
        const filteredItems = filterItemsForScreen(schedule.items || [], deviceId, groupIds);
        const filteredSnapshot = {
          ...rawPayload,
          schedule: { ...schedule, items: filteredItems },
        };

        let mediaUrls: Record<string, string | null> | undefined;
        if (includeUrls) {
          const scheduleItems: any[] = filteredItems;
          const mediaIds = new Set<string>();

          const collectMediaIds = (obj: any) => {
            if (!obj) return;
            if (obj.media_id) mediaIds.add(obj.media_id);
            if (Array.isArray(obj.items)) obj.items.forEach(collectMediaIds);
            if (Array.isArray(obj.slots)) obj.slots.forEach(collectMediaIds);
          };

          scheduleItems.forEach((it) => collectMediaIds(it.presentation));

          const ids = Array.from(mediaIds);
          if (ids.length > 0) {
            const medias = await db.select().from(schema.media).where(inArray(schema.media.id, ids as any));
            const readyIds = medias.map((m: any) => m.ready_object_id).filter(Boolean) as string[];
            const storageRows = readyIds.length
              ? await db.select().from(schema.storageObjects).where(inArray(schema.storageObjects.id, readyIds as any))
              : [];
            const storageMap = new Map(storageRows.map((s: any) => [s.id, s]));

            mediaUrls = {};
            for (const m of medias as any[]) {
              try {
                if (m.ready_object_id) {
                  const stor = storageMap.get(m.ready_object_id);
                  if (stor) {
                    mediaUrls[m.id] = await getPresignedUrl(stor.bucket, stor.object_key, 3600);
                    continue;
                  }
                }
                if (m.source_bucket && m.source_object_key) {
                  mediaUrls[m.id] = await getPresignedUrl(m.source_bucket, m.source_object_key, 3600);
                } else {
                  mediaUrls[m.id] = null;
                }
              } catch {
                mediaUrls[m.id] = null;
              }
            }
          }
        }

        return reply.send({
          device_id: deviceId,
          publish: {
            publish_id: latest.publish_id,
            schedule_id: latest.schedule_id,
            snapshot_id: latest.snapshot_id,
            published_at: latest.published_at.toISOString?.() ?? latest.published_at,
          },
          snapshot: filteredSnapshot,
          media_urls: mediaUrls,
          emergency,
        });
      } catch (error) {
        logger.error(error, 'Get device snapshot error');
        return respondWithError(reply, error);
      }
    }
  );

  // Create command for device (admin)
  fastify.post<{ Params: { deviceId: string }; Body: typeof createCommandSchema._type }>(
    apiEndpoints.deviceTelemetry.commands,
    {
      schema: {
        description: 'Create a device command (admin only)',
        tags: ['Device Telemetry'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('update', 'Screen')) throw AppError.forbidden('Forbidden');

        const data = createCommandSchema.parse(request.body);
        const screenId = (request.params as any).deviceId;

        const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, screenId));
        if (!screen) throw AppError.notFound('Screen not found');

        const [command] = await db
          .insert(schema.deviceCommands)
          .values({
            screen_id: screenId,
            type: data.type as any,
            payload: data.payload,
            status: 'PENDING',
            created_by: payload.sub,
          })
          .returning();

        return reply.status(CREATED).send({
          id: command.id,
          screen_id: command.screen_id,
          type: command.type,
          payload: command.payload,
          status: command.status,
          created_at: command.created_at?.toISOString?.() ?? command.created_at,
        });
      } catch (error) {
        logger.error(error, 'Create device command error');
        return respondWithError(reply, error);
      }
    }
  );

  // Device heartbeat (device auth required)
  fastify.post<{ Body: typeof heartbeatSchema._type }>(
    apiEndpoints.deviceTelemetry.heartbeat,
    {
      schema: {
        description: 'Device heartbeat (device auth required)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = heartbeatSchema.parse(request.body);
        await authenticateDeviceOrThrow(request, data.device_id);
        const [screen] = await db
          .select({ id: schema.screens.id })
          .from(schema.screens)
          .where(eq(schema.screens.id, data.device_id));

        if (!screen) {
          throw AppError.notFound('Device not registered');
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
          status: data.status,
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
            current_schedule_id: data.current_schedule_id ?? null,
            current_media_id: data.current_media_id ?? null,
            updated_at: receivedAt,
          })
          .where(eq(schema.screens.id, data.device_id));

        const playbackState = await buildScreenPlaybackStateById(data.device_id, { db });
        if (playbackState) {
          emitScreenStateUpdate(fastify, playbackState);
        }

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
        return respondWithError(reply, error);
      }
    }
  );

  // Proof of Play (PoP) report (device auth required)
  fastify.post<{ Body: typeof proofOfPlaySchema._type }>(
    apiEndpoints.deviceTelemetry.proofOfPlay,
    {
      schema: {
        description: 'Report proof of play (device auth required)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = proofOfPlaySchema.parse(request.body);
        await authenticateDeviceOrThrow(request, data.device_id);

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

        const playbackState = await buildScreenPlaybackStateById(data.device_id, { db });
        if (playbackState) {
          emitScreenStateUpdate(fastify, playbackState);
        }

        logger.info(
          {
            deviceId: data.device_id,
            mediaId: data.media_id,
            duration: data.duration,
            completed: data.completed,
          },
          'Proof of play received'
        );

        return reply.status(CREATED).send({
          success: true,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Proof of play error');
        return respondWithError(reply, error);
      }
    }
  );

  // Device screenshot (device auth required)
  fastify.post<{ Body: typeof screenshotSchema._type }>(
    apiEndpoints.deviceTelemetry.screenshot,
    {
      schema: {
        description: 'Upload device screenshot (device auth required)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = screenshotSchema.parse(request.body);
        await authenticateDeviceOrThrow(request, data.device_id);

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

        return reply.status(CREATED).send({
          success: true,
          object_key: objectKey,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Screenshot upload error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get pending commands for device (device auth required)
  fastify.get<{ Params: { deviceId: string } }>(
    apiEndpoints.deviceTelemetry.commands,
    {
      schema: {
        description: 'Get pending commands for device (device auth required)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const deviceId = (request.params as any).deviceId;
        await authenticateDeviceOrThrow(request, deviceId);

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
        return respondWithError(reply, error);
      }
    }
  );

  // Acknowledge command (device auth required)
  fastify.post<{ Params: { deviceId: string; commandId: string } }>(
    apiEndpoints.deviceTelemetry.ackCommand,
    {
      schema: {
        description: 'Acknowledge command execution (device auth required)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { deviceId, commandId } = request.params as any;
        await authenticateDeviceOrThrow(request, deviceId);

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
          throw AppError.notFound('Command not found');
        }

        logger.info({ deviceId, commandId }, 'Command acknowledged');

        return reply.send({
          success: true,
          timestamp: acknowledgedAt.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Acknowledge command error');
        return respondWithError(reply, error);
      }
    }
  );
}
