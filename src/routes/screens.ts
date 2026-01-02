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
import { eq, desc, inArray } from 'drizzle-orm';
import { getPresignedUrl } from '@/s3';

const logger = createLogger('screen-routes');
const { BAD_REQUEST, CREATED, FORBIDDEN, NOT_FOUND, OK, UNAUTHORIZED } = HTTP_STATUS;

const createScreenSchema = z.object({
  name: z.string().min(1).max(255),
  location: z.string().optional(),
});

const listScreensQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['ACTIVE', 'INACTIVE', 'OFFLINE']).optional(),
});

export async function screenRoutes(fastify: FastifyInstance) {
  const screenRepo = createScreenRepository();
  const db = getDatabase();

  const getGroupIdsForScreen = async (screenId: string): Promise<string[]> => {
    const members = await db
      .select({ group_id: schema.screenGroupMembers.group_id })
      .from(schema.screenGroupMembers)
      .where(eq(schema.screenGroupMembers.screen_id, screenId));
    return members.map((m) => m.group_id);
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

  const getLatestPublishForScreen = async (screenId: string) => {
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

    return latest || null;
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('create', 'Screen')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
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

  // Combined overview of screens and groups with now-playing/availability/status
  fastify.get(
    apiEndpoints.screens.overview,
    {
      schema: {
        description: 'List all screens and groups with now-playing, availability, and telemetry',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(_request.headers.authorization);
        if (!token) {
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        await verifyAccessToken(token);

        const screens = await db.select().from(schema.screens);
        const groups = await db.select().from(schema.screenGroups);

        const screenSummaries = await Promise.all(
          screens.map(async (s: any) => {
            const latest = await getLatestPublishForScreen(s.id);
            if (!latest) {
              return {
                id: s.id,
                name: s.name,
                status: s.status,
                last_heartbeat_at: s.last_heartbeat_at?.toISOString?.() ?? s.last_heartbeat_at,
                current_schedule_id: (s as any).current_schedule_id ?? null,
                current_media_id: (s as any).current_media_id ?? null,
                active_items: [],
                upcoming_items: [],
                booked_until: null,
                publish: null,
              };
            }

            const schedulePayload = (latest.payload as any)?.schedule;
            const groupIds = await getGroupIdsForScreen(s.id);
            const items = filterItemsForScreen((schedulePayload?.items || []) as any[], s.id, groupIds);
            const { activeItems, upcomingItems, bookedUntil } = buildTimeline(items);

            return {
              id: s.id,
              name: s.name,
              status: s.status,
              last_heartbeat_at: s.last_heartbeat_at?.toISOString?.() ?? s.last_heartbeat_at,
              current_schedule_id: (s as any).current_schedule_id ?? null,
              current_media_id: (s as any).current_media_id ?? null,
              active_items: activeItems,
              upcoming_items: upcomingItems,
              booked_until: bookedUntil,
              publish: {
                publish_id: latest.publish_id,
                schedule_id: latest.schedule_id,
                snapshot_id: latest.snapshot_id,
                published_at: latest.published_at.toISOString?.() ?? latest.published_at,
                schedule_start_at: schedulePayload?.start_at ?? null,
                schedule_end_at: schedulePayload?.end_at ?? null,
              },
            };
          })
        );

        const groupSummaries = await Promise.all(
          groups.map(async (g: any) => {
            const members = await db
              .select({ screen_id: schema.screenGroupMembers.screen_id })
              .from(schema.screenGroupMembers)
              .where(eq(schema.screenGroupMembers.group_id, g.id));

            const memberIds = members.map((m) => m.screen_id);
            const merged: Map<string, any> = new Map();

            await Promise.all(
              memberIds.map(async (screenId) => {
                const latest = await getLatestPublishForScreen(screenId);
                if (!latest) return;
                const schedulePayload = (latest.payload as any)?.schedule;
                const groupIds = await getGroupIdsForScreen(screenId);
                const items = filterItemsForScreen((schedulePayload?.items || []) as any[], screenId, groupIds);
                items.forEach((it: any) => {
                  if (!merged.has(it.id)) merged.set(it.id, it);
                });
              })
            );

            const { activeItems, upcomingItems, bookedUntil } = buildTimeline(Array.from(merged.values()));

            return {
              id: g.id,
              name: g.name,
              description: g.description,
              screen_ids: memberIds,
              active_items: activeItems,
              upcoming_items: upcomingItems,
              booked_until: bookedUntil,
            };
          })
        );

        return reply.send({
          screens: screenSummaries,
          groups: groupSummaries,
        });
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        await verifyAccessToken(token);

        const screen = await screenRepo.findById((request.params as any).id);
        if (!screen) {
          return reply.status(NOT_FOUND).send({ error: 'Screen not found' });
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        await verifyAccessToken(token);

        const screen = await screenRepo.findById((request.params as any).id);
        if (!screen) {
          return reply.status(NOT_FOUND).send({ error: 'Screen not found' });
        }

        return reply.send({
          id: screen.id,
          name: screen.name,
          status: screen.status,
          last_heartbeat_at: screen.last_heartbeat_at?.toISOString(),
          current_schedule_id: (screen as any).current_schedule_id ?? null,
          current_media_id: (screen as any).current_media_id ?? null,
          updated_at: screen.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get screen status error');
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
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
          return reply.send({ screen_id: screenId, active_items: [], upcoming_items: [], booked_until: null, publish: null });
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
          active_items: activeItems,
          upcoming_items: upcomingItems,
          booked_until: bookedUntil,
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
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
          return reply.status(NOT_FOUND).send({ error: 'No publish found for this screen' });
        }

        const includeUrls =
          typeof (request.query as any).include_urls === 'string' &&
          ((request.query as any).include_urls as string).toLowerCase() === 'true';

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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('update', 'Screen')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
        }

        const data = createScreenSchema.partial().parse(request.body);
        const screen = await screenRepo.update((request.params as any).id, data);

        if (!screen) {
          return reply.status(NOT_FOUND).send({ error: 'Screen not found' });
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
          return reply.status(UNAUTHORIZED).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('delete', 'Screen')) {
          return reply.status(FORBIDDEN).send({ error: 'Forbidden' });
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
