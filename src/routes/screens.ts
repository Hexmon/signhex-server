import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createScreenRepository } from '@/db/repositories/screen';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { getDatabase, schema } from '@/db';
import { eq, desc, inArray, and, gte, lte, sql } from 'drizzle-orm';
import { deleteObject, getPresignedUrl, getObject } from '@/s3';
import { getAspectRatioName, KNOWN_ASPECT_RATIOS, resolveAspectRatio } from '@/utils/aspect-ratio';
import { pruneDefaultMediaTargetsForScreen, resolveDefaultMediaForScreen } from '@/utils/default-media';
import { AppError } from '@/utils/app-error';
import {
  buildScreenScheduleTimelinePayload,
  buildScreenPlaybackStateById,
  buildScreensOverviewPayload,
  getActiveEmergencyForScreen,
  getGroupIdsForScreen,
  getLatestPublishForScreen,
  filterItemsForScreen,
  buildTimeline,
} from '@/screens/playback';
import { emitScreensRefreshRequired, setupScreensNamespace } from '@/realtime/screens-namespace';
import { serializeMediaRecord } from '@/utils/media';

const logger = createLogger('screen-routes');
const { CREATED, OK } = HTTP_STATUS;

const createScreenSchema = z.object({
  name: z.string().min(1).max(255),
  location: z.string().optional(),
});

const listScreensQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['ACTIVE', 'INACTIVE', 'OFFLINE']).optional(),
});

const aspectRatiosQuerySchema = z.object({
  search: z.string().min(1).optional(),
  configured_only: z.enum(['true', 'false']).optional(),
});

const listHeartbeatsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  start_at: z.string().datetime().optional(),
  end_at: z.string().datetime().optional(),
  status: z.enum(['ONLINE', 'OFFLINE', 'ERROR']).optional(),
  include_payload: z.enum(['true', 'false']).optional(),
});

const screenshotSettingsSchema = z.object({
  interval_seconds: z.number().int().positive().max(86400).optional(),
  enabled: z.boolean().optional(),
});

const screenshotTriggerSchema = z.object({
  reason: z.string().optional(),
});

const overviewQuerySchema = z.object({
  include_media: z.string().optional(),
  include_preview: z.string().optional(),
  online_only: z.string().optional(),
});

const scheduleTimelineQuerySchema = z.object({
  window_start: z.string().datetime(),
  window_hours: z.coerce.number().int().positive().max(48).default(24),
  only_active_now: z.string().optional(),
});

const nowPlayingQuerySchema = z.object({
  include_urls: z.string().optional(),
  include_media: z.string().optional(),
  include_preview: z.string().optional(),
});

const snapshotQuerySchema = z.object({
  include_urls: z.string().optional(),
});

export async function screenRoutes(fastify: FastifyInstance) {
  const screenRepo = createScreenRepository();
  const db = getDatabase();
  await setupScreensNamespace(fastify);

  const getGroupIdsForScreen = async (screenId: string): Promise<string[]> => {
    const members = await db
      .select({ group_id: schema.screenGroupMembers.group_id })
      .from(schema.screenGroupMembers)
      .where(eq(schema.screenGroupMembers.screen_id, screenId));
    return members.map((m) => m.group_id);
  };

  const fetchHeartbeatPayload = async (bucket?: string | null, objectKey?: string | null) => {
    if (!bucket || !objectKey) return null;
    try {
      const data = await getObject(bucket, objectKey);
      return JSON.parse(data.toString('utf8'));
    } catch {
      return null;
    }
  };

  const serializeResolvedDefaultMedia = (
    resolvedDefaultMedia: Awaited<ReturnType<typeof resolveDefaultMediaForScreen>>,
    includeUrls: boolean
  ) => ({
    default_media: resolvedDefaultMedia.media
      ? {
          media_id: resolvedDefaultMedia.media.id,
          ...serializeMediaRecord(
            resolvedDefaultMedia.media,
            includeUrls ? resolvedDefaultMedia.media_url : null
          ),
        }
      : null,
    default_media_resolution: {
      source: resolvedDefaultMedia.source,
      aspect_ratio: resolvedDefaultMedia.aspect_ratio,
    },
  });

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

  const buildTimeline = (items: any[]) => {
    const now = new Date();
    const activeItems = items
      .filter((i) => {
        const start = new Date(i.start_at);
        const end = new Date(i.end_at);
        return start <= now && end >= now;
      })
      .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());

    const upcomingItems = items
      .filter((i) => new Date(i.start_at) > now)
      .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());

    const bookedUntil = items.length
      ? new Date(Math.max(...items.map((i) => new Date(i.end_at).getTime()))).toISOString()
      : null;

    return { activeItems, upcomingItems, bookedUntil };
  };

  // Create screen
  fastify.post<{ Body: typeof createScreenSchema._type }>(
    apiEndpoints.screens.create,
    {
      schema: {
        description: 'Create a new screen',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);

        if (!ability.can('create', 'Screen')) {
          throw AppError.forbidden('Forbidden');
        }

        throw AppError.conflict(
          'Screens can only be created after a device completes pairing. Use the device pairing flow instead of creating screens manually.'
        );
      } catch (error) {
        logger.error(error, 'Create screen error');
        return respondWithError(reply, error);
      }
    }
  );

  // List screens
  fastify.get<{ Querystring: typeof listScreensQuerySchema._type }>(
    apiEndpoints.screens.list,
    {
      schema: {
        description: 'List screens with pagination',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);

        const query = listScreensQuerySchema.parse(request.query);
        const result = await screenRepo.list({
          page: query.page,
          limit: query.limit,
          status: query.status,
        });

        return reply.send({
          items: result.items.map((s) => ({
            id: s.id,
            name: s.name,
            location: s.location,
            aspect_ratio: (s as any).aspect_ratio ?? null,
            width: (s as any).width ?? null,
            height: (s as any).height ?? null,
            orientation: (s as any).orientation ?? null,
            device_info: (s as any).device_info ?? null,
            status: s.status,
            last_heartbeat_at: s.last_heartbeat_at?.toISOString(),
            current_schedule_id: (s as any).current_schedule_id ?? null,
            current_media_id: (s as any).current_media_id ?? null,
            created_at: s.created_at.toISOString(),
            updated_at: s.updated_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List screens error');
        return respondWithError(reply, error);
      }
    }
  );

  // List screen aspect ratios
  fastify.get<{ Querystring: typeof aspectRatiosQuerySchema._type }>(
    apiEndpoints.screens.aspectRatios,
    {
      schema: {
        description: 'List screens with their aspect ratios',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'Screen')) throw AppError.forbidden('Forbidden');

        const query = aspectRatiosQuerySchema.parse(request.query);
        const screens = await screenRepo.listAspectRatios({ search: query.search });
        const configuredOnly = query.configured_only === 'true';
        const resolvedItems = screens
          .map((s) => {
            const aspectRatio = resolveAspectRatio(s);
            return {
              id: s.id,
              name: s.name,
              aspect_ratio: aspectRatio,
              aspect_ratio_name: getAspectRatioName(aspectRatio),
              is_fallback: false,
            };
          })
          .filter((item) => (configuredOnly ? item.aspect_ratio !== null : true));

        return reply.send({
          items: resolvedItems,
          defaults: KNOWN_ASPECT_RATIOS.map((entry) => ({
            id: null,
            name: entry.name,
            aspect_ratio: entry.aspect_ratio,
            aspect_ratio_name: entry.name,
            is_fallback: true,
          })),
        });
      } catch (error) {
        logger.error(error, 'List screen aspect ratios error');
        return respondWithError(reply, error);
      }
    }
  );

  // Combined overview of screens and groups with now-playing/availability/status
  fastify.get<{ Querystring: typeof overviewQuerySchema._type }>(
    apiEndpoints.screens.overview,
    {
      schema: {
        description: 'List all screens and groups with now-playing, availability, and telemetry',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);
        const query = overviewQuerySchema.parse(request.query);
        const includeMedia = query.include_media?.toLowerCase() === 'true';
        const includePreview = query.include_preview?.toLowerCase() === 'true';
        const onlineOnly = query.online_only?.toLowerCase() === 'true';

        return reply.send(
          await buildScreensOverviewPayload({
            db,
            includeMedia,
            includePreview,
            onlineOnly,
          })
        );
      } catch (error) {
        logger.error(error, 'Get screens overview error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Querystring: typeof scheduleTimelineQuerySchema._type }>(
    apiEndpoints.screens.scheduleTimeline,
    {
      schema: {
        description: 'Get a dashboard-ready 24-hour schedule timeline for currently active scheduled screens',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);
        const query = scheduleTimelineQuerySchema.parse(request.query);

        return reply.send(
          await buildScreenScheduleTimelinePayload({
            db,
            windowStart: new Date(query.window_start),
            windowHours: query.window_hours,
            onlyActiveNow: query.only_active_now?.toLowerCase() === 'true',
          })
        );
      } catch (error) {
        logger.error(error, 'Get screen schedule timeline error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get screen by ID
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.screens.get,
    {
      schema: {
        description: 'Get screen by ID',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);

        const summary = await buildScreenPlaybackStateById((request.params as any).id, { db });
        if (!summary) {
          throw AppError.notFound('Screen not found');
        }

        return reply.send({
          id: summary.id,
          name: summary.name,
          location: (summary as any).location ?? null,
          aspect_ratio: (summary as any).aspect_ratio ?? null,
          width: (summary as any).width ?? null,
          height: (summary as any).height ?? null,
          orientation: (summary as any).orientation ?? null,
          device_info: (summary as any).device_info ?? null,
          status: summary.status,
          health_state: (summary as any).health_state ?? null,
          health_reason: (summary as any).health_reason ?? null,
          auth_diagnostics: (summary as any).auth_diagnostics ?? null,
          active_pairing: (summary as any).active_pairing ?? null,
          last_heartbeat_at: summary.last_heartbeat_at,
          current_schedule_id: summary.current_schedule_id,
          current_media_id: summary.current_media_id,
          created_at: (summary as any).created_at?.toISOString?.() ?? (summary as any).created_at,
          updated_at: (summary as any).updated_at?.toISOString?.() ?? (summary as any).updated_at,
        });
      } catch (error) {
        logger.error(error, 'Get screen error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.screens.defaultMedia,
    {
      schema: {
        description: 'Resolve default media for a screen by aspect ratio/global fallback',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);
        const screenId = (request.params as any).id;
        const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, screenId)).limit(1);
        if (!screen) {
          throw AppError.notFound('Screen not found');
        }

        const resolvedDefaultMedia = await resolveDefaultMediaForScreen(screen, db);
        return reply.send({
          source: resolvedDefaultMedia.source,
          aspect_ratio: resolvedDefaultMedia.aspect_ratio,
          media_id: resolvedDefaultMedia.media_id,
          media: resolvedDefaultMedia.media
            ? serializeMediaRecord(resolvedDefaultMedia.media, resolvedDefaultMedia.media_url)
            : null,
        });
      } catch (error) {
        logger.error(error, 'Get resolved screen default media error');
        return respondWithError(reply, error);
      }
    }
  );

  // Screen status (includes last telemetry fields)
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.screens.status,
    {
      schema: {
        description: 'Get screen status (with current schedule/media)',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);

        const screen = await screenRepo.findById((request.params as any).id);
        if (!screen) {
          throw AppError.notFound('Screen not found');
        }

        const [latestHeartbeat] = await db
          .select({
            id: schema.heartbeats.id,
            status: schema.heartbeats.status,
            created_at: schema.heartbeats.created_at,
            bucket: schema.storageObjects.bucket,
            object_key: schema.storageObjects.object_key,
          })
          .from(schema.heartbeats)
          .leftJoin(schema.storageObjects, eq(schema.heartbeats.storage_object_id, schema.storageObjects.id))
          .where(eq(schema.heartbeats.screen_id, screen.id))
          .orderBy(desc(schema.heartbeats.created_at))
          .limit(1);

        const heartbeatPayload = await fetchHeartbeatPayload(
          (latestHeartbeat as any)?.bucket,
          (latestHeartbeat as any)?.object_key
        );

        const summary = await buildScreenPlaybackStateById(screen.id, { db });

        return reply.send({
          id: screen.id,
          name: screen.name,
          status: screen.status,
          health_state: (summary as any)?.health_state ?? null,
          health_reason: (summary as any)?.health_reason ?? null,
          auth_diagnostics: (summary as any)?.auth_diagnostics ?? null,
          active_pairing: (summary as any)?.active_pairing ?? null,
          last_heartbeat_at: screen.last_heartbeat_at?.toISOString(),
          current_schedule_id: (screen as any).current_schedule_id ?? null,
          current_media_id: (screen as any).current_media_id ?? null,
          updated_at: screen.updated_at.toISOString(),
          latest_heartbeat: latestHeartbeat
            ? {
                id: latestHeartbeat.id,
                status: latestHeartbeat.status ?? null,
                created_at: latestHeartbeat.created_at?.toISOString?.() ?? latestHeartbeat.created_at,
                payload: heartbeatPayload,
              }
            : null,
        });
      } catch (error) {
        logger.error(error, 'Get screen status error');
        return respondWithError(reply, error);
      }
    }
  );

  // Heartbeat history for a screen
  fastify.get<{ Params: { id: string }; Querystring: typeof listHeartbeatsQuerySchema._type }>(
    apiEndpoints.screens.heartbeats,
    {
      schema: {
        description: 'List heartbeat history for a screen',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);

        const screenId = (request.params as any).id;
        const screen = await screenRepo.findById(screenId);
        if (!screen) {
          throw AppError.notFound('Screen not found');
        }

        const query = listHeartbeatsQuerySchema.parse(request.query);
        if (query.start_at && query.end_at) {
          const startAt = new Date(query.start_at);
          const endAt = new Date(query.end_at);
          if (startAt > endAt) {
            throw AppError.badRequest('start_at must be before end_at');
          }
        }

        const includePayload = query.include_payload === 'true';
        const conditions = [eq(schema.heartbeats.screen_id, screenId)];
        if (query.start_at) conditions.push(gte(schema.heartbeats.created_at, new Date(query.start_at)));
        if (query.end_at) conditions.push(lte(schema.heartbeats.created_at, new Date(query.end_at)));
        if (query.status) conditions.push(eq(schema.heartbeats.status, query.status));

        const [{ count }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.heartbeats)
          .where(and(...conditions));

        const page = query.page;
        const limit = query.limit;
        const offset = (page - 1) * limit;

        const rows = await db
          .select({
            id: schema.heartbeats.id,
            status: schema.heartbeats.status,
            created_at: schema.heartbeats.created_at,
            storage_object_id: schema.heartbeats.storage_object_id,
            bucket: schema.storageObjects.bucket,
            object_key: schema.storageObjects.object_key,
          })
          .from(schema.heartbeats)
          .leftJoin(schema.storageObjects, eq(schema.heartbeats.storage_object_id, schema.storageObjects.id))
          .where(and(...conditions))
          .orderBy(desc(schema.heartbeats.created_at))
          .limit(limit)
          .offset(offset);

        const items = await Promise.all(
          rows.map(async (row) => ({
            id: row.id,
            status: row.status ?? null,
            created_at: row.created_at?.toISOString?.() ?? row.created_at,
            storage_object_id: row.storage_object_id ?? null,
            payload: includePayload ? await fetchHeartbeatPayload(row.bucket, row.object_key) : null,
          }))
        );

        return reply.send({
          screen_id: screenId,
          items,
          pagination: {
            page,
            limit,
            total: Number(count || 0),
          },
        });
      } catch (error) {
        logger.error(error, 'List screen heartbeats error');
        return respondWithError(reply, error);
      }
    }
  );

  // Set screenshot interval for a screen
  fastify.post<{ Params: { id: string }; Body: typeof screenshotSettingsSchema._type }>(
    apiEndpoints.screens.screenshotSettings,
    {
      schema: {
        description: 'Set screenshot interval for a screen',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('update', 'Screen')) throw AppError.forbidden('Forbidden');

        const screenId = (request.params as any).id;
        const screen = await screenRepo.findById(screenId);
        if (!screen) {
          throw AppError.notFound('Screen not found');
        }

        const data = screenshotSettingsSchema.parse(request.body);
        const enabled = typeof data.enabled === 'boolean' ? data.enabled : true;
        const intervalSeconds = typeof data.interval_seconds === 'number' ? data.interval_seconds : null;
        if (enabled && !intervalSeconds) {
          throw AppError.badRequest('interval_seconds is required when enabled');
        }

        const updated = await screenRepo.update(screenId, {
          screenshot_interval_seconds: intervalSeconds,
          screenshot_enabled: enabled,
        } as any);

        const [command] = await db
          .insert(schema.deviceCommands)
          .values({
            screen_id: screenId,
            type: 'SET_SCREENSHOT_INTERVAL',
            payload: { interval_seconds: intervalSeconds, enabled },
            status: 'PENDING',
            created_by: payload.sub,
          })
          .returning({ id: schema.deviceCommands.id });

        return reply.send({
          screen_id: screenId,
          screenshot_enabled: (updated as any)?.screenshot_enabled ?? enabled,
          screenshot_interval_seconds: (updated as any)?.screenshot_interval_seconds ?? intervalSeconds,
          command_id: command?.id ?? null,
        });
      } catch (error) {
        logger.error(error, 'Set screenshot interval error');
        return respondWithError(reply, error);
      }
    }
  );

  // Trigger screenshot for a screen
  fastify.post<{ Params: { id: string }; Body: typeof screenshotTriggerSchema._type }>(
    apiEndpoints.screens.screenshot,
    {
      schema: {
        description: 'Trigger screenshot capture for a screen',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('update', 'Screen')) throw AppError.forbidden('Forbidden');

        const screenId = (request.params as any).id;
        const screen = await screenRepo.findById(screenId);
        if (!screen) {
          throw AppError.notFound('Screen not found');
        }

        const data = screenshotTriggerSchema.parse(request.body);

        const [command] = await db
          .insert(schema.deviceCommands)
          .values({
            screen_id: screenId,
            type: 'TAKE_SCREENSHOT',
            payload: { reason: data.reason ?? null },
            status: 'PENDING',
            created_by: payload.sub,
          })
          .returning({ id: schema.deviceCommands.id });

        return reply.send({
          screen_id: screenId,
          command_id: command?.id ?? null,
        });
      } catch (error) {
        logger.error(error, 'Trigger screenshot error');
        return respondWithError(reply, error);
      }
    }
  );

  // Now playing / booking info for a screen
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.screens.nowPlaying,
    {
      schema: {
        description: 'Get current/active schedule items for a screen (based on latest publish)',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);
        const screenId = (request.params as any).id;
        const query = nowPlayingQuerySchema.parse(request.query);
        const includeUrls = query.include_urls?.toLowerCase() === 'true';
        const includeMedia = query.include_media?.toLowerCase() === 'true';
        const includePreview = query.include_preview?.toLowerCase() === 'true';

        const summary = await buildScreenPlaybackStateById(screenId, {
          db,
          includeMedia,
          includePreview,
          includeUrls,
        });

        if (!summary) {
          throw AppError.notFound('Screen not found');
        }

        return reply.send({
          server_time: new Date().toISOString(),
          screen_id: screenId,
          status: summary.status,
          health_state: (summary as any).health_state ?? null,
          health_reason: (summary as any).health_reason ?? null,
          auth_diagnostics: (summary as any).auth_diagnostics ?? null,
          active_pairing: (summary as any).active_pairing ?? null,
          last_heartbeat_at: summary.last_heartbeat_at,
          current_schedule_id: summary.current_schedule_id,
          current_media_id: summary.current_media_id,
          publish: summary.publish,
          active_items: summary.active_items,
          upcoming_items: summary.upcoming_items,
          booked_until: summary.booked_until,
          playback: summary.playback,
          emergency: summary.emergency,
          preview: (summary as any).preview ?? null,
        });
      } catch (error) {
        logger.error(error, 'Get screen now-playing error');
        return respondWithError(reply, error);
      }
    }
  );

  // Availability (current + next bookings) for a screen
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.screens.availability,
    {
      schema: {
        description: 'Get current/next schedule items targeting this screen',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);
        const screenId = (request.params as any).id;
        const latest = await getLatestPublishForScreen(screenId, db);

        if (!latest) {
          return reply.send({
            screen_id: screenId,
            publish: null,
            current_items: [],
            next_item: null,
            upcoming_items: [],
            booked_until: null,
          });
        }

        const schedulePayload = (latest.payload as any)?.schedule;
        const groupIds = await getGroupIdsForScreen(screenId);
        const items = filterItemsForScreen((schedulePayload?.items || []) as any[], screenId, groupIds);
        const { activeItems, upcomingItems, bookedUntil } = buildTimeline(items);

        return reply.send({
          screen_id: screenId,
          publish: {
            publish_id: latest.publish_id,
            schedule_id: latest.schedule_id,
            snapshot_id: latest.snapshot_id,
            published_at: latest.published_at.toISOString?.() ?? latest.published_at,
            reservation_version: (latest as any).reservation_version ?? null,
            selection_reason: (latest as any).selection_reason ?? null,
            schedule_start_at: schedulePayload?.start_at ?? null,
            schedule_end_at: schedulePayload?.end_at ?? null,
          },
          current_items: activeItems,
          next_item: upcomingItems[0] || null,
          upcoming_items: upcomingItems,
          booked_until: bookedUntil,
        });
      } catch (error) {
        logger.error(error, 'Get screen availability error');
        return respondWithError(reply, error);
      }
    }
  );

  // Latest publish snapshot for a screen (for devices/clients to fetch playlist)
  fastify.get<{ Params: { id: string }; Querystring: { include_urls?: string } }>(
    apiEndpoints.screens.snapshot,
    {
      schema: {
        description: 'Get latest publish snapshot targeting this screen',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        await verifyAccessToken(token);
        const screenId = (request.params as any).id;
        const query = snapshotQuerySchema.parse(request.query);
        const includeUrls = query.include_urls?.toLowerCase() === 'true';
        const serverTime = new Date().toISOString();
        const [screen] = await db.select().from(schema.screens).where(eq(schema.screens.id, screenId)).limit(1);
        if (!screen) {
          throw AppError.notFound('Screen not found');
        }

        const emergency = await getActiveEmergencyForScreen(screenId, {
          db,
          includeUrls,
        });
        const resolvedDefaultMedia = await resolveDefaultMediaForScreen(screen, db);
        const defaultMediaPayload = serializeResolvedDefaultMedia(resolvedDefaultMedia, includeUrls);

        const latest = await getLatestPublishForScreen(screenId, db);

        if (!latest) {
          return reply.send({
            server_time: serverTime,
            screen_id: screenId,
            publish: null,
            snapshot: null,
            media_urls: undefined,
            emergency: emergency ?? null,
            ...defaultMediaPayload,
          });
        }

        const rawPayload = (latest.payload as any) || {};
        const schedule = rawPayload.schedule || {};
        const groupIds = await getGroupIdsForScreen(screenId);
        const filteredItems = filterItemsForScreen(schedule.items || [], screenId, groupIds);
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

          scheduleItems.forEach((it) => {
            collectMediaIds(it.presentation);
          });

          const ids = Array.from(mediaIds);
          if (ids.length > 0) {
            const medias = await db.select().from(schema.media).where(inArray(schema.media.id, ids as any));
            const readyIds = medias.map((m: any) => m.ready_object_id).filter(Boolean) as string[];
            const sourceRefs = medias
              .filter((m: any) => m.source_bucket && m.source_object_key)
              .map((m: any) => ({ id: m.id, bucket: m.source_bucket, key: m.source_object_key }));

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
                const source = sourceRefs.find((s) => s.id === m.id);
                if (source) {
                  mediaUrls[m.id] = await getPresignedUrl(source.bucket, source.key, 3600);
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
          server_time: serverTime,
          screen_id: screenId,
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
        logger.error(error, 'Get screen snapshot error');
        return respondWithError(reply, error);
      }
    }
  );

  // Update screen
  fastify.patch<{ Params: { id: string }; Body: Partial<typeof createScreenSchema._type> }>(
    apiEndpoints.screens.update,
    {
      schema: {
        description: 'Update screen',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);

        if (!ability.can('update', 'Screen')) {
          throw AppError.forbidden('Forbidden');
        }

        const data = createScreenSchema.partial().parse(request.body);
        const screen = await screenRepo.update((request.params as any).id, data);

        if (!screen) {
          throw AppError.notFound('Screen not found');
        }

        return reply.send({
          id: screen.id,
          name: screen.name,
          location: screen.location,
          aspect_ratio: (screen as any).aspect_ratio ?? null,
          width: (screen as any).width ?? null,
          height: (screen as any).height ?? null,
          orientation: (screen as any).orientation ?? null,
          device_info: (screen as any).device_info ?? null,
          status: screen.status,
          last_heartbeat_at: screen.last_heartbeat_at?.toISOString(),
          current_schedule_id: (screen as any).current_schedule_id ?? null,
          current_media_id: (screen as any).current_media_id ?? null,
          created_at: screen.created_at.toISOString(),
          updated_at: screen.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Update screen error');
        return respondWithError(reply, error);
      }
    }
  );

  // Delete screen
  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.screens.delete,
    {
      schema: {
        description: 'Delete screen',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);

        if (!ability.can('delete', 'Screen')) {
          throw AppError.forbidden('Forbidden');
        }

        const screenId = (request.params as any).id;

        const screen = await screenRepo.findById(screenId);
        if (!screen) {
          throw AppError.notFound('Screen not found');
        }

        const [heartbeatStorageRefs, proofOfPlayStorageRefs, screenshotStorageRefs] = await Promise.all([
          db
            .select({ storage_object_id: schema.heartbeats.storage_object_id })
            .from(schema.heartbeats)
            .where(eq(schema.heartbeats.screen_id, screenId)),
          db
            .select({ storage_object_id: schema.proofOfPlay.storage_object_id })
            .from(schema.proofOfPlay)
            .where(eq(schema.proofOfPlay.screen_id, screenId)),
          db
            .select({ storage_object_id: schema.screenshots.storage_object_id })
            .from(schema.screenshots)
            .where(eq(schema.screenshots.screen_id, screenId)),
        ]);

        const storageObjectIds = Array.from(
          new Set(
            [...heartbeatStorageRefs, ...proofOfPlayStorageRefs, ...screenshotStorageRefs]
              .map((row) => row.storage_object_id)
              .filter((value): value is string => Boolean(value))
          )
        );

        const storageRows = storageObjectIds.length
          ? await db
              .select({
                id: schema.storageObjects.id,
                bucket: schema.storageObjects.bucket,
                object_key: schema.storageObjects.object_key,
              })
              .from(schema.storageObjects)
              .where(inArray(schema.storageObjects.id, storageObjectIds))
          : [];

        const cleanup = await db.transaction(async (tx) => {
          const commandsDeleted = await tx.delete(schema.deviceCommands).where(eq(schema.deviceCommands.screen_id, screenId));
          const heartbeatsDeleted = await tx.delete(schema.heartbeats).where(eq(schema.heartbeats.screen_id, screenId));
          const popDeleted = await tx.delete(schema.proofOfPlay).where(eq(schema.proofOfPlay.screen_id, screenId));
          const screenshotsDeleted = await tx.delete(schema.screenshots).where(eq(schema.screenshots.screen_id, screenId));
          const reservationsDeleted = await tx
            .delete(schema.scheduleReservations)
            .where(eq(schema.scheduleReservations.screen_id, screenId));
          const publishTargetsDeleted = await tx
            .delete(schema.publishTargets)
            .where(eq(schema.publishTargets.screen_id, screenId));
          const pairingsDeleted = await tx.delete(schema.devicePairings).where(eq(schema.devicePairings.device_id, screenId));
          const certsDeleted = await tx.delete(schema.deviceCertificates).where(eq(schema.deviceCertificates.screen_id, screenId));
          const groupMembersDeleted = await tx
            .delete(schema.screenGroupMembers)
            .where(eq(schema.screenGroupMembers.screen_id, screenId));
          const defaultMediaTargetsRemoved = await pruneDefaultMediaTargetsForScreen(screenId, tx);

          await tx.delete(schema.screens).where(eq(schema.screens.id, screenId));

          return {
            device_commands: (commandsDeleted as any)?.length ?? 0,
            heartbeats: (heartbeatsDeleted as any)?.length ?? 0,
            proof_of_play: (popDeleted as any)?.length ?? 0,
            screenshots: (screenshotsDeleted as any)?.length ?? 0,
            schedule_reservations: (reservationsDeleted as any)?.length ?? 0,
            publish_targets: (publishTargetsDeleted as any)?.length ?? 0,
            device_pairings: (pairingsDeleted as any)?.length ?? 0,
            device_certificates: (certsDeleted as any)?.length ?? 0,
            screen_group_members: (groupMembersDeleted as any)?.length ?? 0,
            default_media_targets: defaultMediaTargetsRemoved,
          };
        });

        const uniqueStorageRows = Array.from(
          new Map(storageRows.map((row) => [row.id, row])).values()
        );
        const storageDeleted: Array<{ id: string; bucket: string; object_key: string }> = [];
        const storageFailed: Array<{ id: string; bucket: string; object_key: string; message: string }> = [];

        for (const storageRow of uniqueStorageRows) {
          try {
            await deleteObject(storageRow.bucket, storageRow.object_key);
            storageDeleted.push(storageRow);
          } catch (error) {
            request.log.warn(
              {
                storageObjectId: storageRow.id,
                bucket: storageRow.bucket,
                objectKey: storageRow.object_key,
                err: error,
              },
              'Failed to delete screen-linked storage object'
            );
            storageFailed.push({
              ...storageRow,
              message: error instanceof Error ? error.message : 'Storage deletion failed',
            });
          }
        }

        if (storageDeleted.length > 0) {
          await db
            .delete(schema.storageObjects)
            .where(
              inArray(
                schema.storageObjects.id,
                storageDeleted.map((row) => row.id) as string[]
              )
            );
        }

        emitScreensRefreshRequired(fastify, {
          reason: 'GROUP_MEMBERSHIP',
          screen_ids: [screenId],
          group_ids: [],
        });

        return reply.status(OK).send({
          message: 'Screen deleted with related data cleaned up',
          id: screenId,
          cleanup,
          storage_cleanup: {
            deleted: storageDeleted,
            failed: storageFailed,
          },
        });
      } catch (error) {
        logger.error(error, 'Delete screen error');
        return respondWithError(reply, error);
      }
    }
  );
}
