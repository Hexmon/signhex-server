import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createScheduleRequestRepository } from '@/db/repositories/schedule-request';
import { createScheduleRepository } from '@/db/repositories/schedule';
import { createScheduleItemRepository } from '@/db/repositories/schedule-item';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { getDatabase, schema } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { publishScheduleSnapshot } from '@/routes/schedule-publish-helper';
import { AppError } from '@/utils/app-error';

const logger = createLogger('schedule-request-routes');
const { CREATED, FORBIDDEN, NOT_FOUND, UNAUTHORIZED, BAD_REQUEST } = HTTP_STATUS;

const createRequestSchema = z.object({
  schedule_id: z.string().uuid(),
  notes: z.string().optional(),
});

const createRequestQuerySchema = z.object({
  include: z.string().optional(),
});

const updateRequestSchema = z.object({
  schedule_id: z.string().uuid().optional(),
  notes: z.string().optional(),
});

const listRequestQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'PUBLISHED']).optional(),
  include: z.string().optional(),
});

const getRequestQuerySchema = z.object({
  include: z.string().optional(),
});

const INCLUDE_KEYS = [
  'schedule',
  'schedule_items',
  'presentations',
  'presentation_slots',
  'media',
  'users',
  'screens',
  'screen_groups',
  'departments',
  'layouts',
] as const;

function parseInclude(raw?: string) {
  if (!raw) return new Set<string>();
  const parts = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const set = new Set<string>();
  for (const part of parts) {
    if (part === 'all') {
      INCLUDE_KEYS.forEach((k) => set.add(k));
      continue;
    }
    if ((INCLUDE_KEYS as readonly string[]).includes(part)) {
      set.add(part);
    }
  }
  return set;
}

const toIso = (value: any) => value?.toISOString?.() ?? value ?? null;

function mapUser(u: any | null) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    first_name: u.first_name ?? null,
    last_name: u.last_name ?? null,
    role_id: u.role_id,
    department_id: u.department_id ?? null,
  };
}

function mapDepartment(d: any | null) {
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    description: d.description ?? null,
    created_at: toIso(d.created_at),
    updated_at: toIso(d.updated_at),
  };
}

function mapSchedule(s: any | null) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    start_at: toIso(s.start_at),
    end_at: toIso(s.end_at),
    is_active: s.is_active,
    created_by: s.created_by,
    created_at: toIso(s.created_at),
    updated_at: toIso(s.updated_at),
  };
}

function computeScheduleTimeStatus(s: any | null) {
  if (!s?.start_at || !s?.end_at) return null;
  const now = new Date();
  const start = new Date(s.start_at);
  const end = new Date(s.end_at);
  let status: 'UPCOMING' | 'ACTIVE' | 'EXPIRED' = 'UPCOMING';
  if (now >= end) status = 'EXPIRED';
  else if (now >= start && now < end) status = 'ACTIVE';
  return {
    now: now.toISOString(),
    status,
    is_expired: status === 'EXPIRED',
  };
}

function mapScheduleItem(i: any) {
  return {
    id: i.id,
    schedule_id: i.schedule_id,
    presentation_id: i.presentation_id,
    start_at: toIso(i.start_at),
    end_at: toIso(i.end_at),
    priority: i.priority,
    screen_ids: i.screen_ids ?? [],
    screen_group_ids: i.screen_group_ids ?? [],
    created_at: toIso(i.created_at),
  };
}

function mapPresentation(p: any) {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    layout_id: (p as any).layout_id ?? null,
    created_by: p.created_by,
    created_at: toIso(p.created_at),
    updated_at: toIso(p.updated_at),
  };
}

function mapLayout(l: any | null) {
  if (!l) return null;
  return {
    id: l.id,
    name: l.name,
    description: l.description ?? null,
    aspect_ratio: l.aspect_ratio,
    spec: l.spec,
    created_at: toIso(l.created_at),
    updated_at: toIso(l.updated_at),
  };
}

function mapPresentationWithLayout(p: any, layoutMap: Map<string, any>, includeLayouts: boolean) {
  const base = mapPresentation(p);
  if (!includeLayouts) return base;
  const layoutId = (p as any).layout_id;
  return {
    ...base,
    layout: mapLayout(layoutId ? layoutMap.get(layoutId) || null : null),
  };
}

function mapPresentationSlot(s: any) {
  return {
    id: s.id,
    presentation_id: s.presentation_id,
    slot_id: s.slot_id,
    media_id: s.media_id,
    order: s.order,
    duration_seconds: s.duration_seconds ?? null,
    fit_mode: s.fit_mode ?? null,
    audio_enabled: s.audio_enabled ?? false,
    created_at: toIso(s.created_at),
  };
}

function mapMedia(m: any) {
  return {
    id: m.id,
    name: m.name,
    type: m.type,
    status: m.status,
    duration_seconds: m.duration_seconds ?? null,
    width: m.width ?? null,
    height: m.height ?? null,
    source_content_type: m.source_content_type ?? null,
    created_by: m.created_by,
    created_at: toIso(m.created_at),
    updated_at: toIso(m.updated_at),
  };
}

function mapScreen(s: any) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
  };
}

function mapScreenGroup(g: any) {
  return {
    id: g.id,
    name: g.name,
  };
}

async function expandScheduleRequests(
  requests: any[],
  include: Set<string>,
  db: ReturnType<typeof getDatabase>
) {
  if (include.size === 0) return [];
  if (requests.length === 0) return [];

  const scheduleIds = Array.from(new Set(requests.map((r) => r.schedule_id).filter(Boolean)));
  const needScheduleItems =
    include.has('schedule_items') ||
    include.has('presentations') ||
    include.has('presentation_slots') ||
    include.has('media') ||
    include.has('screens') ||
    include.has('screen_groups');

  const schedules =
    (include.has('schedule') || needScheduleItems) && scheduleIds.length
      ? await db
          .select()
          .from(schema.schedules)
          .where(inArray(schema.schedules.id, scheduleIds as any))
      : [];
  const scheduleMap = new Map(schedules.map((s) => [s.id, s]));

  const scheduleItems = needScheduleItems
    ? scheduleIds.length
      ? await db
          .select()
          .from(schema.scheduleItems)
          .where(inArray(schema.scheduleItems.schedule_id, scheduleIds as any))
          .orderBy(schema.scheduleItems.start_at)
      : []
    : [];
  const itemsBySchedule = new Map<string, any[]>();
  scheduleItems.forEach((i) => {
    const list = itemsBySchedule.get(i.schedule_id) || [];
    list.push(i);
    itemsBySchedule.set(i.schedule_id, list);
  });

  const presentationIds = Array.from(
    new Set(scheduleItems.map((i) => i.presentation_id).filter(Boolean))
  );

  const presentations =
    (include.has('presentations') ||
      include.has('presentation_slots') ||
      include.has('media') ||
      include.has('layouts')) &&
    presentationIds.length
      ? await db
          .select()
          .from(schema.presentations)
          .where(inArray(schema.presentations.id, presentationIds as any))
      : [];
  const presentationMap = new Map(presentations.map((p) => [p.id, p]));

  const layoutIds = include.has('layouts')
    ? Array.from(
        new Set(presentations.map((p: any) => p.layout_id).filter(Boolean))
      )
    : [];
  const layouts =
    include.has('layouts') && layoutIds.length
      ? await db.select().from(schema.layouts).where(inArray(schema.layouts.id, layoutIds as any))
      : [];
  const layoutMap = new Map(layouts.map((l) => [l.id, l]));

  const presentationSlots =
    (include.has('presentation_slots') || include.has('media')) && presentationIds.length
      ? await db
          .select()
          .from(schema.presentationSlotItems)
          .where(inArray(schema.presentationSlotItems.presentation_id, presentationIds as any))
      : [];

  const presentationItems =
    include.has('media') && presentationIds.length
      ? await db
          .select()
          .from(schema.presentationItems)
          .where(inArray(schema.presentationItems.presentation_id, presentationIds as any))
      : [];

  const mediaIds = include.has('media')
    ? Array.from(
        new Set(
          presentationSlots.map((s) => s.media_id).concat(presentationItems.map((i) => i.media_id))
        )
      )
    : [];
  const media =
    include.has('media') && mediaIds.length
      ? await db.select().from(schema.media).where(inArray(schema.media.id, mediaIds as any))
      : [];
  const mediaMap = new Map(media.map((m) => [m.id, m]));

  const screenIds = include.has('screens')
    ? Array.from(new Set(scheduleItems.flatMap((i) => i.screen_ids || [])))
    : [];
  const screens =
    include.has('screens') && screenIds.length
      ? await db.select().from(schema.screens).where(inArray(schema.screens.id, screenIds as any))
      : [];
  const screenMap = new Map(screens.map((s) => [s.id, s]));

  const screenGroupIds = include.has('screen_groups')
    ? Array.from(new Set(scheduleItems.flatMap((i) => i.screen_group_ids || [])))
    : [];
  const screenGroups =
    include.has('screen_groups') && screenGroupIds.length
      ? await db
          .select()
          .from(schema.screenGroups)
          .where(inArray(schema.screenGroups.id, screenGroupIds as any))
      : [];
  const screenGroupMap = new Map(screenGroups.map((g) => [g.id, g]));

  const userIds = include.has('users')
    ? Array.from(
        new Set(
          requests
            .map((r) => [r.requested_by, r.reviewed_by].filter(Boolean))
            .flat()
        )
      )
    : [];
  const users =
    include.has('users') && userIds.length
      ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds as any))
      : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  const departmentIds = include.has('departments')
    ? Array.from(new Set(users.map((u: any) => u.department_id).filter(Boolean)))
    : [];
  const departments =
    include.has('departments') && departmentIds.length
      ? await db
          .select()
          .from(schema.departments)
          .where(inArray(schema.departments.id, departmentIds as any))
      : [];
  const departmentMap = new Map(departments.map((d) => [d.id, d]));

  const slotsByPresentation = new Map<string, any[]>();
  presentationSlots.forEach((s) => {
    const list = slotsByPresentation.get(s.presentation_id) || [];
    list.push(s);
    slotsByPresentation.set(s.presentation_id, list);
  });

  return requests.map((r) => {
    const schedule = scheduleMap.get(r.schedule_id) || null;
    const items = itemsBySchedule.get(r.schedule_id) || [];
    const pres = Array.from(
      new Map(
        items
          .map((i) => presentationMap.get(i.presentation_id))
          .filter(Boolean)
          .map((p: any) => [p.id, p])
      ).values()
    ) as any[];
    const presIds = Array.from(new Set(pres.map((p) => p.id)));
    const slots = presIds.flatMap((pid) => slotsByPresentation.get(pid) || []);

    const screensResolved = include.has('screens')
      ? Array.from(
          new Map(
            items
              .flatMap((i) => i.screen_ids || [])
              .map((sid) => screenMap.get(sid))
              .filter(Boolean)
              .map((s: any) => [s.id, s])
          ).values()
        )
      : [];
    const screenGroupsResolved = include.has('screen_groups')
      ? Array.from(
          new Map(
            items
              .flatMap((i) => i.screen_group_ids || [])
              .map((gid) => screenGroupMap.get(gid))
              .filter(Boolean)
              .map((g: any) => [g.id, g])
          ).values()
        )
      : [];

    const mediaResolved = include.has('media')
      ? Array.from(new Map(media.map((m: any) => [m.id, m])).values())
      : [];

    return {
      id: r.id,
      status: r.status,
      notes: r.notes ?? null,
      review_notes: r.review_notes ?? null,
      reviewed_at: toIso(r.reviewed_at),
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
      ...(include.has('users')
        ? {
            requested_by_user: userMap.get(r.requested_by)
              ? {
                  ...mapUser(userMap.get(r.requested_by) || null),
                  ...(include.has('departments')
                    ? {
                        department: mapDepartment(
                          departmentMap.get((userMap.get(r.requested_by) as any)?.department_id) || null
                        ),
                      }
                    : {}),
                }
              : null,
            reviewed_by_user: userMap.get(r.reviewed_by)
              ? {
                  ...mapUser(userMap.get(r.reviewed_by) || null),
                  ...(include.has('departments')
                    ? {
                        department: mapDepartment(
                          departmentMap.get((userMap.get(r.reviewed_by) as any)?.department_id) || null
                        ),
                      }
                    : {}),
                }
              : null,
          }
        : {}),
      ...(include.has('schedule')
        ? {
            schedule: mapSchedule(schedule),
            schedule_time_status: computeScheduleTimeStatus(schedule),
          }
        : {}),
      ...(include.has('schedule_items') ? { schedule_items: items.map(mapScheduleItem) } : {}),
      ...(include.has('presentations')
        ? { presentations: pres.map((p) => mapPresentationWithLayout(p, layoutMap, include.has('layouts'))) }
        : {}),
      ...(include.has('presentation_slots')
        ? { presentation_slots: slots.map(mapPresentationSlot) }
        : {}),
      ...(include.has('media') ? { media: mediaResolved.map(mapMedia) } : {}),
      ...(include.has('screens') ? { screens: screensResolved.map(mapScreen) } : {}),
      ...(include.has('screen_groups') ? { screen_groups: screenGroupsResolved.map(mapScreenGroup) } : {}),
    };
  });
}

export async function scheduleRequestRoutes(fastify: FastifyInstance) {
  const repo = createScheduleRequestRepository();
  const scheduleRepo = createScheduleRepository();
  const scheduleItemRepo = createScheduleItemRepository();
  const db = getDatabase();

  // Create schedule request (draft)
  fastify.post<{ Body: typeof createRequestSchema._type; Querystring: typeof createRequestQuerySchema._type }>(
    apiEndpoints.scheduleRequests.create,
    {
      schema: {
        description: 'Create a schedule publish request (draft)',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('create', 'ScheduleRequest')) throw AppError.forbidden('Forbidden');

        const data = createRequestSchema.parse(request.body);
        const query = createRequestQuerySchema.parse(request.query);
        const include = parseInclude(query.include);
        const created = await repo.create({
          schedule_id: data.schedule_id,
          notes: data.notes,
          requested_by: payload.sub,
        });

        if (include.size === 0) {
          return reply.status(CREATED).send({
            id: created.id,
            schedule_id: created.schedule_id,
            payload: (created as any).schedule_payload,
            status: created.status,
            notes: created.notes,
            requested_by: created.requested_by,
            review_notes: (created as any).review_notes ?? null,
            created_at: created.created_at.toISOString?.() ?? created.created_at,
          });
        }

        const [expanded] = await expandScheduleRequests([created as any], include, db);
        return reply.status(CREATED).send(expanded);
      } catch (error) {
        logger.error(error, 'Create schedule request error');
        return respondWithError(reply, error);
      }
    }
  );

  // Status summary
  fastify.get(
    apiEndpoints.scheduleRequests.statusSummary,
    {
      schema: {
        description: 'Get counts per schedule request status',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'ScheduleRequest')) throw AppError.forbidden('Forbidden');

        const filter = ability.can('manage', 'all') ? {} : { requested_by: payload.sub };
        const counts = await repo.countSummary(filter);
        return reply.send({ counts });
      } catch (error) {
        logger.error(error, 'Schedule request status summary error');
        return respondWithError(reply, error);
      }
    }
  );

  // List requests
  fastify.get<{ Querystring: typeof listRequestQuerySchema._type }>(
    apiEndpoints.scheduleRequests.list,
    {
      schema: {
        description: 'List schedule requests',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'ScheduleRequest')) throw AppError.forbidden('Forbidden');

        const query = listRequestQuerySchema.parse(request.query);
        const include = parseInclude(query.include);
        const filter = {
          page: query.page,
          limit: query.limit,
          status: query.status,
          requested_by: ability.can('manage', 'all') ? undefined : payload.sub,
        };
        const result = await repo.list(filter);

        if (include.size === 0) {
          return reply.send({
            items: result.items.map((r: any) => ({
              id: r.id,
              schedule_id: r.schedule_id,
              payload: r.schedule_payload,
              status: r.status,
              notes: r.notes,
              requested_by: r.requested_by,
              reviewed_by: r.reviewed_by,
              reviewed_at: r.reviewed_at?.toISOString?.() ?? r.reviewed_at,
              review_notes: r.review_notes ?? null,
              created_at: r.created_at.toISOString?.() ?? r.created_at,
              updated_at: r.updated_at.toISOString?.() ?? r.updated_at,
            })),
            pagination: {
              page: result.page,
              limit: result.limit,
              total: result.total,
            },
          });
        }

        const expanded = await expandScheduleRequests(result.items as any[], include, db);
        return reply.send({
          items: expanded,
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List schedule requests error');
        return respondWithError(reply, error);
      }
    }
  );

  // Update request (admin only, editable before publish)
  fastify.patch<{ Params: { id: string }; Body: typeof updateRequestSchema._type }>(
    apiEndpoints.scheduleRequests.update,
    {
      schema: {
        description: 'Update a schedule request (admin only)',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('manage', 'all')) throw AppError.forbidden('Forbidden');

        const data = updateRequestSchema.parse(request.body);
        const req = await repo.findById((request.params as any).id);
        if (!req) throw AppError.notFound('Schedule request not found');

        if (req.status === 'APPROVED') {
          throw AppError.badRequest('Cannot edit an approved request; reject or create new');
        }

        const [updated] = await db
          .update(schema.scheduleRequests)
          .set({
            schedule_id: data.schedule_id ?? req.schedule_id,
            notes: typeof data.notes === 'undefined' ? req.notes : data.notes,
            updated_at: new Date(),
          })
          .where(eq(schema.scheduleRequests.id, req.id))
          .returning();

        return reply.send({
          id: updated.id,
          schedule_id: updated.schedule_id,
          payload: (updated as any).schedule_payload,
          status: updated.status,
          notes: updated.notes,
          requested_by: updated.requested_by,
          review_notes: updated.review_notes ?? null,
          reviewed_by: updated.reviewed_by,
          reviewed_at: updated.reviewed_at?.toISOString?.() ?? updated.reviewed_at,
          created_at: updated.created_at.toISOString?.() ?? updated.created_at,
          updated_at: updated.updated_at.toISOString?.() ?? updated.updated_at,
        });
      } catch (error) {
        logger.error(error, 'Update schedule request error');
        return respondWithError(reply, error);
      }
    }
  );

  // Get request
  fastify.get<{ Params: { id: string }; Querystring: typeof getRequestQuerySchema._type }>(
    apiEndpoints.scheduleRequests.get,
    {
      schema: {
        description: 'Get schedule request by ID',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'ScheduleRequest')) throw AppError.forbidden('Forbidden');

        const query = getRequestQuerySchema.parse(request.query);
        const include = parseInclude(query.include);

        const req = await repo.findById((request.params as any).id);
        if (!req) throw AppError.notFound('Schedule request not found');
        if (!ability.can('manage', 'all') && req.requested_by !== payload.sub) {
          throw AppError.forbidden('Forbidden');
        }

        if (include.size === 0) {
          return reply.send({
            id: req.id,
            schedule_id: req.schedule_id,
            payload: (req as any).schedule_payload,
            status: req.status,
            notes: req.notes,
            requested_by: req.requested_by,
            reviewed_by: req.reviewed_by,
            reviewed_at: req.reviewed_at?.toISOString?.() ?? req.reviewed_at,
            review_notes: req.review_notes ?? null,
            created_at: req.created_at.toISOString?.() ?? req.created_at,
            updated_at: req.updated_at.toISOString?.() ?? req.updated_at,
          });
        }

        const [expanded] = await expandScheduleRequests([req as any], include, db);
        return reply.send(expanded);
      } catch (error) {
        logger.error(error, 'Get schedule request error');
        return respondWithError(reply, error);
      }
    }
  );

  // Approve request (admin only)
  fastify.post<{ Params: { id: string }; Body: { comment?: string } }>(
    apiEndpoints.scheduleRequests.approve,
    {
      schema: {
        description: 'Approve a schedule request (admin only)',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('manage', 'all')) throw AppError.forbidden('Forbidden');

        const req = await repo.findById((request.params as any).id);
        if (!req) throw AppError.notFound('Schedule request not found');

        const updated = await repo.updateStatus(req.id, 'APPROVED', payload.sub, (request.body as any)?.comment);
        return reply.send({
          id: updated!.id,
          status: updated!.status,
          reviewed_by: updated!.reviewed_by,
          reviewed_at: updated!.reviewed_at?.toISOString?.() ?? updated!.reviewed_at,
          review_notes: (updated as any).review_notes ?? (request.body as any)?.comment ?? null,
        });
      } catch (error) {
        logger.error(error, 'Approve schedule request error');
        return respondWithError(reply, error);
      }
    }
  );

  // Publish an approved request (admin only)
  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.scheduleRequests.publish,
    {
      schema: {
        description: 'Publish a schedule based on an approved request',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('manage', 'all')) throw AppError.forbidden('Forbidden');

        const req = await repo.findById((request.params as any).id);
        if (!req) throw AppError.notFound('Schedule request not found');
        if (req.status !== 'APPROVED') {
          throw AppError.badRequest('Schedule request must be APPROVED to publish');
        }

        const publishResult = await publishScheduleSnapshot({
          scheduleId: req.schedule_id,
          screenIds: [],
          screenGroupIds: [],
          publishedBy: payload.sub,
          notes: req.notes ?? null,
          db,
          scheduleRepo,
          scheduleItemRepo,
        });

        await db
          .update(schema.scheduleRequests)
          .set({ updated_at: new Date() })
          .where(eq(schema.scheduleRequests.id, req.id));

        return reply.send({
          message: 'Schedule published from request',
          schedule_request_id: req.id,
          schedule_id: req.schedule_id,
          publish_id: publishResult.publish.id,
          snapshot_id: publishResult.snapshot.id,
          resolved_screen_ids: publishResult.resolvedScreenIds,
          targets: publishResult.targets.length,
        });
      } catch (error) {
        logger.error(error, 'Publish schedule request error');
        return respondWithError(reply, error);
      }
    }
  );

  // Reject request (admin only)
  fastify.post<{ Params: { id: string }; Body: { comment?: string } }>(
    apiEndpoints.scheduleRequests.reject,
    {
      schema: {
        description: 'Reject a schedule request (admin only)',
        tags: ['Schedules'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('manage', 'all')) throw AppError.forbidden('Forbidden');

        const req = await repo.findById((request.params as any).id);
        if (!req) throw AppError.notFound('Schedule request not found');

        const updated = await repo.updateStatus(req.id, 'REJECTED', payload.sub, (request.body as any)?.comment);
        return reply.send({
          id: updated!.id,
          status: updated!.status,
          reviewed_by: updated!.reviewed_by,
          reviewed_at: updated!.reviewed_at?.toISOString?.() ?? updated!.reviewed_at,
          review_notes: (updated as any).review_notes ?? (request.body as any)?.comment ?? null,
        });
      } catch (error) {
        logger.error(error, 'Reject schedule request error');
        return respondWithError(reply, error);
      }
    }
  );
}
