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
import { getPresignedUrl, getObject } from '@/s3';
import { getDefaultMedia } from '@/utils/default-media';
import { AppError } from '@/utils/app-error';
import {
  buildScreenPlaybackStateById,
  buildScreensOverviewPayload,
  getActiveEmergencyForScreen,
} from '@/screens/playback';
import { setupScreensNamespace } from '@/realtime/screens-namespace';

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
});

const nowPlayingQuerySchema = z.object({
  include_urls: z.string().optional(),
  include_media: z.string().optional(),
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

        const data = createScreenSchema.parse(request.body);
        const screen = await screenRepo.create(data);

        return reply.status(CREATED).send({
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
        return reply.send({
          items: screens.map((s) => ({
            id: s.id,
            name: s.name,
            aspect_ratio: s.aspect_ratio ?? null,
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

        return reply.send(
          await buildScreensOverviewPayload({
            db,
            includeMedia,
          })
        );
      } catch (error) {
        logger.error(error, 'Get screens overview error');
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

        const screen = await screenRepo.findById((request.params as any).id);
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
        logger.error(error, 'Get screen error');
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

        return reply.send({
          id: screen.id,
          name: screen.name,
          status: screen.status,
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

        const summary = await buildScreenPlaybackStateById(screenId, {
          db,
          includeMedia,
          includeUrls,
        });

        if (!summary) {
          throw AppError.notFound('Screen not found');
        }

        return reply.send({
          server_time: new Date().toISOString(),
          screen_id: screenId,
          status: summary.status,
          last_heartbeat_at: summary.last_heartbeat_at,
          current_schedule_id: summary.current_schedule_id,
          current_media_id: summary.current_media_id,
          publish: summary.publish,
          active_items: summary.active_items,
          upcoming_items: summary.upcoming_items,
          booked_until: summary.booked_until,
          playback: summary.playback,
          emergency: summary.emergency,
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
          .where(eq(schema.publishTargets.screen_id, screenId))
          .orderBy(desc(schema.publishes.published_at))
          .limit(1);

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
        const emergency = await getActiveEmergencyForScreen(screenId, {
          db,
          includeUrls,
        });

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
          .where(eq(schema.publishTargets.screen_id, screenId))
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
              screen_id: screenId,
              publish: null,
              snapshot: null,
              media_urls: undefined,
              emergency,
              default_media: defaultMediaPayload,
            });
          }
          if (defaultMediaPayload) {
            return reply.send({
              screen_id: screenId,
              publish: null,
              snapshot: null,
              media_urls: undefined,
              emergency: null,
              default_media: defaultMediaPayload,
            });
          }
          throw AppError.notFound('No publish found for this screen');
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
          screen_id: screenId,
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

        const commandsDeleted = await db.delete(schema.deviceCommands).where(eq(schema.deviceCommands.screen_id, screenId));
        const heartbeatsDeleted = await db.delete(schema.heartbeats).where(eq(schema.heartbeats.screen_id, screenId));
        const popDeleted = await db.delete(schema.proofOfPlay).where(eq(schema.proofOfPlay.screen_id, screenId));
        const screenshotsDeleted = await db.delete(schema.screenshots).where(eq(schema.screenshots.screen_id, screenId));
        const publishTargetsDeleted = await db
          .delete(schema.publishTargets)
          .where(eq(schema.publishTargets.screen_id, screenId));
        const pairingsDeleted = await db.delete(schema.devicePairings).where(eq(schema.devicePairings.device_id, screenId));
        const certsDeleted = await db.delete(schema.deviceCertificates).where(eq(schema.deviceCertificates.screen_id, screenId));
        const groupMembersDeleted = await db
          .delete(schema.screenGroupMembers)
          .where(eq(schema.screenGroupMembers.screen_id, screenId));

        await screenRepo.delete(screenId);

        return reply.status(OK).send({
          message: 'Screen deleted with related data cleaned up',
          id: screenId,
          cleanup: {
            device_commands: (commandsDeleted as any)?.length ?? 0,
            heartbeats: (heartbeatsDeleted as any)?.length ?? 0,
            proof_of_play: (popDeleted as any)?.length ?? 0,
            screenshots: (screenshotsDeleted as any)?.length ?? 0,
            publish_targets: (publishTargetsDeleted as any)?.length ?? 0,
            device_pairings: (pairingsDeleted as any)?.length ?? 0,
            device_certificates: (certsDeleted as any)?.length ?? 0,
            screen_group_members: (groupMembersDeleted as any)?.length ?? 0,
          },
        });
      } catch (error) {
        logger.error(error, 'Delete screen error');
        return respondWithError(reply, error);
      }
    }
  );
}
