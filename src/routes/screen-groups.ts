import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createScreenGroupRepository } from '@/db/repositories/screen-group';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { getDatabase, schema } from '@/db';
import { desc, eq, inArray } from 'drizzle-orm';
import { AppError } from '@/utils/app-error';

const logger = createLogger('screen-group-routes');
const { BAD_REQUEST, CREATED, FORBIDDEN, NOT_FOUND, UNAUTHORIZED } = HTTP_STATUS;

const screenGroupSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  screen_ids: z.array(z.string().uuid()).optional(),
});

const listGroupsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const screenshotSettingsSchema = z.object({
  interval_seconds: z.number().int().positive().max(86400).optional(),
  enabled: z.boolean().optional(),
});

const screenshotTriggerSchema = z.object({
  reason: z.string().optional(),
});

const availableScreensQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  group_id: z.string().uuid().optional(),
});

export async function screenGroupRoutes(fastify: FastifyInstance) {
  const repo = createScreenGroupRepository();
  const db = getDatabase();

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

  // Create group
  fastify.post<{ Body: typeof screenGroupSchema._type }>(
    apiEndpoints.screenGroups.create,
    {
      schema: {
        description: 'Create a screen group',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('create', 'ScreenGroup')) throw AppError.forbidden('Forbidden');

        const data = screenGroupSchema.parse(request.body);
        const group = await repo.create(data);

        return reply.status(CREATED).send({
          id: group.id,
          name: group.name,
          description: group.description,
          created_at: group.created_at.toISOString(),
          updated_at: group.updated_at.toISOString(),
          screen_ids: data.screen_ids || [],
        });
      } catch (error) {
        logger.error(error, 'Create screen group error');
        return respondWithError(reply, error);
      }
    }
  );

  // Group availability (aggregated from member screens)
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.screenGroups.availability,
    {
      schema: {
        description: 'Get availability (current/next) for all screens in a group',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'ScreenGroup')) throw AppError.forbidden('Forbidden');

        const group = await repo.findById((request.params as any).id);
        if (!group) throw AppError.notFound('Screen group not found');
        const members = await repo.members(group.id);

        const merged: Map<string, any> = new Map();
        const perScreen: any[] = [];

        await Promise.all(
          members.map(async (m: any) => {
            const screenId = m.screen_id;
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
              perScreen.push({
                screen_id: screenId,
                publish: null,
                current_items: [],
                next_item: null,
                upcoming_items: [],
                booked_until: null,
              });
              return;
            }

            const schedulePayload = (latest.payload as any)?.schedule;
            const groupIds = await getGroupIdsForScreen(screenId);
            const items = filterItemsForScreen((schedulePayload?.items || []) as any[], screenId, groupIds);
            items.forEach((it: any) => {
              if (!merged.has(it.id)) merged.set(it.id, it);
            });
            const { activeItems, upcomingItems, bookedUntil } = buildTimeline(items);
            perScreen.push({
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
          })
        );

        const { activeItems, upcomingItems, bookedUntil } = buildTimeline(Array.from(merged.values()));

        return reply.send({
          group_id: group.id,
          name: group.name,
          description: group.description,
          screen_ids: members.map((m: any) => m.screen_id),
          current_items: activeItems,
          next_item: upcomingItems[0] || null,
          upcoming_items: upcomingItems,
          booked_until: bookedUntil,
          screens: perScreen,
        });
      } catch (error) {
        logger.error(error, 'Group availability error');
        return respondWithError(reply, error);
      }
    }
  );

  // Set screenshot interval for a screen group
  fastify.post<{ Params: { id: string }; Body: typeof screenshotSettingsSchema._type }>(
    apiEndpoints.screenGroups.screenshotSettings,
    {
      schema: {
        description: 'Set screenshot interval for all screens in a group',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'ScreenGroup')) throw AppError.forbidden('Forbidden');

        const group = await repo.findById((request.params as any).id);
        if (!group) throw AppError.notFound('Screen group not found');

        const data = screenshotSettingsSchema.parse(request.body);
        const enabled = typeof data.enabled === 'boolean' ? data.enabled : true;
        const intervalSeconds = typeof data.interval_seconds === 'number' ? data.interval_seconds : null;
        if (enabled && !intervalSeconds) {
          throw AppError.badRequest('interval_seconds is required when enabled');
        }

        const members = await repo.members(group.id);
        const screenIds = Array.from(new Set(members.map((m: any) => m.screen_id)));

        if (screenIds.length) {
          await db
            .update(schema.screens)
            .set({
              screenshot_interval_seconds: intervalSeconds,
              screenshot_enabled: enabled,
              updated_at: new Date(),
            })
            .where(inArray(schema.screens.id, screenIds as any));
        }

        const commands = screenIds.map((screenId) => ({
          screen_id: screenId,
          type: 'SET_SCREENSHOT_INTERVAL' as const,
          payload: { interval_seconds: intervalSeconds, enabled },
          status: 'PENDING' as const,
          created_by: payload.sub,
        }));
        const inserted = commands.length
          ? await db.insert(schema.deviceCommands).values(commands).returning({ id: schema.deviceCommands.id, screen_id: schema.deviceCommands.screen_id })
          : [];

        return reply.send({
          group_id: group.id,
          screenshot_enabled: enabled,
          screenshot_interval_seconds: intervalSeconds,
          updated_screens: screenIds.length,
          commands: inserted,
        });
      } catch (error) {
        logger.error(error, 'Set group screenshot interval error');
        return respondWithError(reply, error);
      }
    }
  );

  // Trigger screenshot for a screen group
  fastify.post<{ Params: { id: string }; Body: typeof screenshotTriggerSchema._type }>(
    apiEndpoints.screenGroups.screenshot,
    {
      schema: {
        description: 'Trigger screenshot capture for all screens in a group',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'ScreenGroup')) throw AppError.forbidden('Forbidden');

        const group = await repo.findById((request.params as any).id);
        if (!group) throw AppError.notFound('Screen group not found');

        const data = screenshotTriggerSchema.parse(request.body);

        const members = await repo.members(group.id);
        const screenIds = Array.from(new Set(members.map((m: any) => m.screen_id)));

        const commands = screenIds.map((screenId) => ({
          screen_id: screenId,
          type: 'TAKE_SCREENSHOT' as const,
          payload: { reason: data.reason ?? null },
          status: 'PENDING' as const,
          created_by: payload.sub,
        }));
        const inserted = commands.length
          ? await db.insert(schema.deviceCommands).values(commands).returning({ id: schema.deviceCommands.id, screen_id: schema.deviceCommands.screen_id })
          : [];

        return reply.send({
          group_id: group.id,
          commands_created: inserted.length,
          commands: inserted,
        });
      } catch (error) {
        logger.error(error, 'Trigger group screenshot error');
        return respondWithError(reply, error);
      }
    }
  );

  // List screens that are not members of any group (optionally allow existing members of a group)
  fastify.get<{ Querystring: typeof availableScreensQuerySchema._type }>(
    apiEndpoints.screenGroups.availableScreens,
    {
      schema: {
        description: 'List screens that are not assigned to a group (includes current group members if group_id is provided)',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'ScreenGroup')) throw AppError.forbidden('Forbidden');

        const query = availableScreensQuerySchema.parse(request.query);

        const [screens, memberships] = await Promise.all([
          db.select().from(schema.screens).orderBy(desc(schema.screens.created_at)),
          db.select().from(schema.screenGroupMembers),
        ]);

        const memberMap = memberships.reduce((acc: Map<string, Set<string>>, row: any) => {
          const list = acc.get(row.screen_id) || new Set<string>();
          list.add(row.group_id);
          acc.set(row.screen_id, list);
          return acc;
        }, new Map());

        const available = screens.filter((s: any) => {
          const groups = memberMap.get(s.id);
          if (!groups || groups.size === 0) return true;
          if (query.group_id) {
            // Allow screens already in this group (useful when editing)
            return [...groups].every((gid) => gid === query.group_id);
          }
          return false;
        });

        const start = (query.page - 1) * query.limit;
        const paged = available.slice(start, start + query.limit);

        return reply.send({
          items: paged.map((s: any) => ({
            id: s.id,
            name: s.name,
            location: (s as any).location ?? null,
            status: s.status,
            last_heartbeat_at: s.last_heartbeat_at?.toISOString?.() ?? s.last_heartbeat_at,
            created_at: s.created_at.toISOString(),
            updated_at: s.updated_at.toISOString(),
          })),
          pagination: {
            page: query.page,
            limit: query.limit,
            total: available.length,
          },
        });
      } catch (error) {
        logger.error(error, 'List available screens for groups error');
        return respondWithError(reply, error);
      }
    }
  );

  // List groups
  fastify.get<{ Querystring: typeof listGroupsQuerySchema._type }>(
    apiEndpoints.screenGroups.list,
    {
      schema: {
        description: 'List screen groups',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'ScreenGroup')) throw AppError.forbidden('Forbidden');

        const query = listGroupsQuerySchema.parse(request.query);
        const result = await repo.list({ page: query.page, limit: query.limit });

        return reply.send({
          items: await Promise.all(
            result.items.map(async (g: any) => {
              const members = await repo.members(g.id);
              return {
                id: g.id,
                name: g.name,
                description: g.description,
                screen_ids: members.map((m: any) => m.screen_id),
                created_at: g.created_at.toISOString(),
                updated_at: g.updated_at.toISOString(),
              };
            })
          ),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List screen groups error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get group
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.screenGroups.get,
    {
      schema: {
        description: 'Get screen group by ID',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'ScreenGroup')) throw AppError.forbidden('Forbidden');

        const group = await repo.findById((request.params as any).id);
        if (!group) throw AppError.notFound('Screen group not found');
        const members = await repo.members(group.id);

        return reply.send({
          id: group.id,
          name: group.name,
          description: group.description,
          screen_ids: members.map((m: any) => m.screen_id),
          created_at: group.created_at.toISOString(),
          updated_at: group.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get screen group error');
        return respondWithError(reply, error);
      }
    }
  );

  // Update group
  fastify.patch<{ Params: { id: string }; Body: Partial<typeof screenGroupSchema._type> }>(
    apiEndpoints.screenGroups.update,
    {
      schema: {
        description: 'Update screen group',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('update', 'ScreenGroup')) throw AppError.forbidden('Forbidden');

        const data = screenGroupSchema.partial().parse(request.body);
        const group = await repo.update((request.params as any).id, data);
        if (!group) throw AppError.notFound('Screen group not found');
        const members = await repo.members(group.id);

        return reply.send({
          id: group.id,
          name: group.name,
          description: group.description,
          screen_ids: members.map((m: any) => m.screen_id),
          created_at: group.created_at.toISOString(),
          updated_at: group.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Update screen group error');
        return respondWithError(reply, error);
      }
    }
  );

  // Group now-playing aggregated from member screens
  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.screenGroupNowPlaying.get,
    {
      schema: {
        description: 'Get now-playing info for all screens in a group',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('read', 'ScreenGroup')) throw AppError.forbidden('Forbidden');

        const group = await repo.findById((request.params as any).id);
        if (!group) throw AppError.notFound('Screen group not found');
        const members = await repo.members(group.id);

        const screens = await Promise.all(
          members.map(async (m: any) => {
            const screenId = m.screen_id;
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
              return {
                screen_id: screenId,
                publish: null,
                active_items: [],
                upcoming_items: [],
                booked_until: null,
              };
            }

            const schedulePayload = (latest.payload as any)?.schedule;
            const groupIds = await getGroupIdsForScreen(screenId);
            const items = filterItemsForScreen((schedulePayload?.items || []) as any[], screenId, groupIds);
            const { activeItems, upcomingItems, bookedUntil } = buildTimeline(items);

            return {
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
            };
          })
        );

        return reply.send({
          group_id: group.id,
          name: group.name,
          screens,
        });
      } catch (error) {
        logger.error(error, 'Group now-playing error');
        return respondWithError(reply, error);
      }
    }
  );

  // Delete group
  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.screenGroups.delete,
    {
      schema: {
        description: 'Delete screen group',
        tags: ['Screens'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);
        if (!ability.can('delete', 'ScreenGroup')) throw AppError.forbidden('Forbidden');

        const group = await repo.findById((request.params as any).id);
        if (!group) throw AppError.notFound('Screen group not found');

        await repo.delete(group.id);
        return reply.status(204).send();
      } catch (error) {
        logger.error(error, 'Delete screen group error');
        return respondWithError(reply, error);
      }
    }
  );
}
