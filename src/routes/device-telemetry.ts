import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config as appConfig } from '@/config';
import { getDatabase, schema } from '@/db';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { resolveDefaultMediaForScreen } from '@/utils/default-media';
import { AppError } from '@/utils/app-error';
import { authenticateDeviceOrThrow } from '@/middleware/device-auth';
import { serializeMediaRecord } from '@/utils/media';
import { resolveMediaAccess } from '@/utils/media-access';
import {
  attachResolvedMediaToScheduleSnapshot,
  buildResolvedMediaMap,
} from '@/utils/resolved-media';
import {
  getActiveEmergencyForScreen as getActiveEmergencyForRuntime,
  getLatestPublishForScreen,
} from '@/screens/playback';
import { queueHeartbeatTelemetry, queueProofOfPlayTelemetry, queueScreenshotTelemetry } from '@/jobs';
import {
  buildHeartbeatObjectKey,
  buildProofOfPlayIdempotencyKey,
  buildProofOfPlayObjectKey,
  buildScreenshotObjectKey,
  processHeartbeatTelemetry,
  processProofOfPlayTelemetry,
  processScreenshotTelemetry,
} from '@/jobs/device-telemetry';
import { recordDeviceCommandClaim, recordTelemetryIngest } from '@/observability/metrics';
import { queueScreenStateRefresh } from '@/services/screen-state-refresh';

const logger = createLogger('device-telemetry-routes');
const { CREATED } = HTTP_STATUS;
const DEVICE_SCREENSHOT_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

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

const normalizeEtagToken = (value: string) =>
  value
    .trim()
    .replace(/^W\//i, '')
    .replace(/\\/g, '')
    .replace(/^"+|"+$/g, '')
    .trim();

export function shouldPersistTelemetryInline(
  nodeEnv: string = appConfig.NODE_ENV,
  processRole: string | undefined = process.env.HEXMON_PROCESS_ROLE?.trim()
) {
  return nodeEnv === 'development' && processRole === 'api';
}

async function enqueueTelemetryWithFallback(params: {
  telemetryType: 'heartbeat' | 'proof_of_play' | 'screenshot';
  label: string;
  enqueue: () => Promise<unknown>;
  fallback: () => Promise<void>;
  heartbeatStatus?: 'ONLINE' | 'OFFLINE' | 'ERROR';
}) {
  const startedAt = process.hrtime.bigint();
  const processRole = process.env.HEXMON_PROCESS_ROLE?.trim();
  if (shouldPersistTelemetryInline(appConfig.NODE_ENV, processRole)) {
    try {
      logger.info({ label: params.label, processRole, env: appConfig.NODE_ENV }, 'Persisting telemetry inline in api-only runtime');
      await params.fallback();
      recordTelemetryIngest({
        telemetryType: params.telemetryType,
        persistMode: 'inline',
        result: 'success',
        heartbeatStatus: params.heartbeatStatus,
        durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      });
      return 'inline' as const;
    } catch (error) {
      recordTelemetryIngest({
        telemetryType: params.telemetryType,
        persistMode: 'inline',
        result: 'error',
        heartbeatStatus: params.heartbeatStatus,
        durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      });
      throw error;
    }
  }

  try {
    await params.enqueue();
    recordTelemetryIngest({
      telemetryType: params.telemetryType,
      persistMode: 'queue',
      result: 'success',
      heartbeatStatus: params.heartbeatStatus,
      durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    });
    return 'queue' as const;
  } catch (error) {
    logger.warn({ error, label: params.label }, 'Telemetry queue unavailable; using inline fallback');
    try {
      await params.fallback();
      recordTelemetryIngest({
        telemetryType: params.telemetryType,
        persistMode: 'fallback',
        result: 'success',
        heartbeatStatus: params.heartbeatStatus,
        durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      });
      return 'fallback' as const;
    } catch (fallbackError) {
      recordTelemetryIngest({
        telemetryType: params.telemetryType,
        persistMode: 'fallback',
        result: 'error',
        heartbeatStatus: params.heartbeatStatus,
        durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      });
      throw fallbackError;
    }
  }
}

export async function deviceTelemetryRoutes(fastify: FastifyInstance) {
  const db = getDatabase();

  const claimPendingCommands = async (deviceId: string) => {
    const claimedAt = new Date();
    const commands = await db
      .update(schema.deviceCommands)
      .set({ status: 'SENT', updated_at: claimedAt })
      .where(and(eq(schema.deviceCommands.screen_id, deviceId), eq(schema.deviceCommands.status, 'PENDING')))
      .returning({
        id: schema.deviceCommands.id,
        type: schema.deviceCommands.type,
        payload: schema.deviceCommands.payload,
        createdAt: schema.deviceCommands.created_at,
      });

    return commands.sort(
      (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    );
  };

  const getGroupIdsForScreen = async (screenId: string): Promise<string[]> => {
    const rows = await db
      .select({ group_id: schema.screenGroupMembers.group_id })
      .from(schema.screenGroupMembers)
      .where(eq(schema.screenGroupMembers.screen_id, screenId));
    return rows.map((r) => r.group_id);
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

  const serializeResolvedDefaultMedia = async (
    resolvedDefaultMedia: Awaited<ReturnType<typeof resolveDefaultMediaForScreen>>,
    includeUrls: boolean
  ) => {
    if (!resolvedDefaultMedia.media) {
      return {
        default_media: null,
        default_media_resolution: {
          source: resolvedDefaultMedia.source,
          aspect_ratio: resolvedDefaultMedia.aspect_ratio,
        },
      };
    }

    const mediaAccess = await resolveMediaAccess(resolvedDefaultMedia.media, db);
    return {
      default_media: {
        media_id: resolvedDefaultMedia.media.id,
        ...serializeMediaRecord(
          resolvedDefaultMedia.media,
          includeUrls ? mediaAccess.media_url : null,
          {
            content_type: mediaAccess.content_type,
            source_content_type: mediaAccess.source_content_type,
            size: mediaAccess.size,
          }
        ),
      },
      default_media_resolution: {
        source: resolvedDefaultMedia.source,
        aspect_ratio: resolvedDefaultMedia.aspect_ratio,
      },
    };
  };

  fastify.get<{ Params: { deviceId: string } }>(
    apiEndpoints.deviceTelemetry.screenshotPolicy,
    {
      schema: {
        description: 'Return screenshot capture policy for an authenticated device',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const deviceId = (request.params as any).deviceId;
        await authenticateDeviceOrThrow(request, deviceId, { allowUserToken: true });

        const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, deviceId)).limit(1);
        if (!screen) {
          throw AppError.notFound('Device not registered');
        }

        return reply.send({
          enabled: screen.screenshot_enabled === true,
          interval_seconds:
            typeof screen.screenshot_interval_seconds === 'number' ? screen.screenshot_interval_seconds : null,
        });
      } catch (error) {
        logger.error(error, 'Device screenshot policy error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Params: { deviceId: string } }>(
    apiEndpoints.deviceTelemetry.defaultMedia,
    {
      schema: {
        description: 'Resolve target-based default media for a device',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const deviceId = (request.params as any).deviceId;
        await authenticateDeviceOrThrow(request, deviceId, { allowUserToken: true });
        const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, deviceId)).limit(1);
        if (!screen) {
          throw AppError.notFound('Device not registered');
        }

        const resolvedDefaultMedia = await resolveDefaultMediaForScreen(screen, db);
        const defaultMediaAccess = resolvedDefaultMedia.media
          ? await resolveMediaAccess(resolvedDefaultMedia.media, db)
          : null;
        return reply.send({
          source: resolvedDefaultMedia.source,
          aspect_ratio: resolvedDefaultMedia.aspect_ratio,
          media_id: resolvedDefaultMedia.media_id,
          media: resolvedDefaultMedia.media
            ? serializeMediaRecord(
                resolvedDefaultMedia.media,
                defaultMediaAccess?.media_url ?? null,
                {
                  content_type: defaultMediaAccess?.content_type,
                  source_content_type: defaultMediaAccess?.source_content_type,
                  size: defaultMediaAccess?.size,
                }
              )
            : null,
        });
      } catch (error) {
        logger.error(error, 'Get resolved device default media error');
        return respondWithError(reply, error);
      }
    }
  );

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
        const ifNoneMatchHeader = typeof request.headers['if-none-match'] === 'string' ? request.headers['if-none-match'] : '';
        const ifNoneMatchValues = ifNoneMatchHeader
          .split(',')
          .map(normalizeEtagToken)
          .filter(Boolean);
        const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, deviceId)).limit(1);
        if (!screen) {
          throw AppError.notFound('Device not registered');
        }

        const emergency = await getActiveEmergencyForRuntime(deviceId, { db, includeUrls });
        const resolvedDefaultMedia = await resolveDefaultMediaForScreen(screen, db);
        const defaultMediaPayload = await serializeResolvedDefaultMedia(resolvedDefaultMedia, includeUrls);

        const latest = await getLatestPublishForScreen(deviceId, db);

        if (!emergency && latest?.snapshot_id) {
          const etag = `"${latest.snapshot_id}"`;
          reply.header('ETag', etag);
          if (ifNoneMatchValues.includes(latest.snapshot_id)) {
            return reply.status(304).send();
          }
        }

        if (!latest) {
          return reply.send({
            device_id: deviceId,
            publish: null,
            snapshot: null,
            media_urls: undefined,
            emergency,
            ...defaultMediaPayload,
          });
        }

        const rawPayload = (latest.payload as any) || {};
        const schedule = rawPayload.schedule || {};
        const groupIds = await getGroupIdsForScreen(deviceId);
        const filteredItems = filterItemsForScreen(schedule.items || [], deviceId, groupIds);
        let filteredSnapshot = {
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
            const resolvedMediaMap = await buildResolvedMediaMap(ids, db);
            filteredSnapshot = attachResolvedMediaToScheduleSnapshot(filteredSnapshot, resolvedMediaMap);
            mediaUrls = {};
            for (const [mediaId, media] of resolvedMediaMap.entries()) {
              mediaUrls[mediaId] =
                media.type === 'WEBPAGE' ? media.source_url ?? null : media.media_url ?? null;
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
              reservation_version: (latest as any).reservation_version ?? null,
              selection_reason: (latest as any).selection_reason ?? null,
            },
          snapshot: filteredSnapshot,
          media_urls: mediaUrls,
          emergency,
          ...defaultMediaPayload,
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
        const receivedAtIso = receivedAt.toISOString();
        const storageObjectId = randomUUID();
        const objectKey = buildHeartbeatObjectKey(data.device_id, receivedAtIso, data as unknown as Record<string, unknown>);
        const heartbeatJob = {
          deviceId: data.device_id,
          status: data.status,
          payload: data as unknown as Record<string, unknown>,
          receivedAt: receivedAtIso,
          objectKey,
          storageObjectId,
        };

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

        queueScreenStateRefresh(data.device_id);

        await enqueueTelemetryWithFallback({
          telemetryType: 'heartbeat',
          label: 'heartbeat',
          enqueue: () => queueHeartbeatTelemetry(heartbeatJob),
          fallback: () => processHeartbeatTelemetry(heartbeatJob),
          heartbeatStatus: data.status,
        });

        logger.info(
          {
            deviceId: data.device_id,
            status: data.status,
            memoryUsage: data.memory_usage,
            cpuUsage: data.cpu_usage,
          },
          'Device heartbeat received'
        );

        const pendingCommands = await claimPendingCommands(data.device_id);
        recordDeviceCommandClaim('heartbeat', pendingCommands.length);

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
        const idempotencyKey = buildProofOfPlayIdempotencyKey({
          deviceId: data.device_id,
          mediaId: data.media_id,
          scheduleId: data.schedule_id,
          startTime: data.start_time,
          endTime: data.end_time,
          duration: data.duration,
          completed: data.completed,
        });
        const proofOfPlayJob = {
          deviceId: data.device_id,
          mediaId: data.media_id,
          scheduleId: data.schedule_id,
          startTime: data.start_time,
          endTime: data.end_time,
          duration: data.duration,
          completed: data.completed,
          receivedAt: receivedAt.toISOString(),
          idempotencyKey,
          objectKey: buildProofOfPlayObjectKey(data.device_id, idempotencyKey),
        };

        await enqueueTelemetryWithFallback({
          telemetryType: 'proof_of_play',
          label: 'proof-of-play',
          enqueue: () => queueProofOfPlayTelemetry(proofOfPlayJob),
          fallback: () => processProofOfPlayTelemetry(proofOfPlayJob),
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
      bodyLimit: DEVICE_SCREENSHOT_BODY_LIMIT_BYTES,
      schema: {
        description: 'Upload device screenshot (device auth required)',
        tags: ['Device Telemetry'],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = screenshotSchema.parse(request.body);
        await authenticateDeviceOrThrow(request, data.device_id);
        const storageObjectId = randomUUID();
        const objectKey = buildScreenshotObjectKey(data.device_id, data.timestamp, storageObjectId);
        const screenshotJob = {
          deviceId: data.device_id,
          timestamp: data.timestamp,
          imageData: data.image_data,
          objectKey,
          storageObjectId,
        };

        await enqueueTelemetryWithFallback({
          telemetryType: 'screenshot',
          label: 'screenshot',
          enqueue: () => queueScreenshotTelemetry(screenshotJob),
          fallback: () => processScreenshotTelemetry(screenshotJob),
        });

        logger.info(
          {
            deviceId: data.device_id,
            objectKey,
            size: Buffer.byteLength(data.image_data, 'base64'),
          },
          'Device screenshot uploaded'
        );

        return reply.status(CREATED).send({
          success: true,
          object_key: objectKey,
          storage_object_id: storageObjectId,
          timestamp: data.timestamp,
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

        const pendingCommands = await claimPendingCommands(deviceId);
        recordDeviceCommandClaim('poll', pendingCommands.length);

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
