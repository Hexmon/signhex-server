import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { getDatabase, schema } from '@/db';
import { createLogger, getRecentLogs, setRuntimeLogLevel } from '@/utils/logger';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import {
  DEFAULT_MEDIA_SETTING_KEY,
  DEFAULT_MEDIA_TARGETS_SETTING_KEY,
  DEFAULT_MEDIA_VARIANTS_SETTING_KEY,
  getDefaultMedia,
  getDefaultMediaTargetAssignments,
  getDefaultMediaVariants,
  resolveMediaUrl,
} from '@/utils/default-media';
import { AppError } from '@/utils/app-error';
import { serializeMediaRecord } from '@/utils/media';
import {
  APPEARANCE_SETTINGS_KEY,
  BACKUPS_SETTINGS_KEY,
  BRANDING_SETTINGS_KEY,
  GENERAL_SETTINGS_KEY,
  SECURITY_SETTINGS_KEY,
  appearanceSettingsSchema,
  backupsSettingsSchema,
  brandingSettingsSchema,
  generalSettingsSchema,
  getSettingsSection,
  resolveBrandingMediaMap,
  saveSettingsSection,
  securitySettingsSchema,
  type AppearanceSettings,
  type BackupsSettings,
  type BrandingSettings,
  type GeneralSettings,
  type SecuritySettings,
} from '@/utils/settings';
import { createBackupRun, listBackupRuns } from '@/utils/backup-runs';
import { queueBackup } from '@/jobs';
import { resolveAspectRatio } from '@/utils/aspect-ratio';

const logger = createLogger('settings-routes');
const { CREATED, OK } = HTTP_STATUS;

const upsertSettingSchema = z.object({
  key: z.string().min(1),
  value: z.any(),
});

const defaultMediaUpdateSchema = z.object({
  media_id: z.string().uuid().nullable(),
});

const defaultMediaVariantsUpdateSchema = z.object({
  variants: z.record(z.string().uuid().nullable()),
});

const defaultMediaTargetAssignmentSchema = z.object({
  target_type: z.enum(['SCREEN', 'GROUP']),
  target_id: z.string().uuid(),
  media_id: z.string().uuid(),
  aspect_ratio: z.string().min(1),
});

const defaultMediaTargetsUpdateSchema = z.object({
  assignments: z.array(defaultMediaTargetAssignmentSchema),
});

const logsQuerySchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

async function requireAccess(
  request: FastifyRequest,
  action: 'read' | 'update',
  subject: 'OrgSettings' | 'BrandingSettings'
) {
  const token = extractTokenFromHeader(request.headers.authorization);
  if (!token) throw AppError.unauthorized('Missing authorization header');
  const payload = await verifyAccessToken(token);
  const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
  if (!ability.can(action, subject)) {
    throw AppError.forbidden('Forbidden');
  }
  return payload;
}

async function ensureMediaIdsExist(ids: Array<string | null | undefined>) {
  const requestedIds = Array.from(new Set(ids.filter((value): value is string => Boolean(value))));
  if (requestedIds.length === 0) return;

  const db = getDatabase();
  const rows = await db.select({ id: schema.media.id }).from(schema.media).where(inArray(schema.media.id, requestedIds as string[]));
  if (rows.length !== requestedIds.length) {
    throw AppError.notFound('Media not found');
  }
}

async function serializeBranding(settings: BrandingSettings) {
  const mediaMap = await resolveBrandingMediaMap([
    settings.logo_media_id,
    settings.icon_media_id,
    settings.favicon_media_id,
  ]);

  return {
    ...settings,
    logo_url: settings.logo_media_id ? (mediaMap.get(settings.logo_media_id)?.url ?? null) : null,
    icon_url: settings.icon_media_id ? (mediaMap.get(settings.icon_media_id)?.url ?? null) : null,
    favicon_url: settings.favicon_media_id ? (mediaMap.get(settings.favicon_media_id)?.url ?? null) : null,
  };
}

export async function settingsRoutes(fastify: FastifyInstance) {
  const db = getDatabase();

  const serializeMedia = (media: any, media_url: string | null) => serializeMediaRecord(media, media_url);

  const serializeDefaultMediaVariants = async () => {
    const payload = await getDefaultMediaVariants(db);
    return {
      global_media_id: payload.global_media_id,
      global_media: payload.global_media
        ? serializeMedia(payload.global_media, payload.global_media_url)
        : null,
      variants: payload.variants.map((entry) => ({
        aspect_ratio: entry.aspect_ratio,
        media_id: entry.media_id,
        media: entry.media ? serializeMedia(entry.media, entry.media_url) : null,
      })),
    };
  };

  const serializeDefaultMediaTargets = async () => {
    const assignments = await getDefaultMediaTargetAssignments(db);
    return {
      assignments: assignments.map((assignment) => ({
        target_type: assignment.target_type,
        target_id: assignment.target_id,
        media_id: assignment.media_id,
        aspect_ratio: assignment.aspect_ratio,
        media: assignment.media ? serializeMedia(assignment.media, assignment.media_url) : null,
      })),
    };
  };

  const validateDefaultMediaTargets = async (
    assignments: Array<z.infer<typeof defaultMediaTargetAssignmentSchema>>
  ) => {
    const uniqueMediaIds = Array.from(new Set(assignments.map((assignment) => assignment.media_id)));
    await ensureMediaIdsExist(uniqueMediaIds);

    const screenAssignments = assignments.filter((assignment) => assignment.target_type === 'SCREEN');
    if (screenAssignments.length > 0) {
      const screenIds = Array.from(new Set(screenAssignments.map((assignment) => assignment.target_id)));
      const screens = await db.select().from(schema.screens).where(inArray(schema.screens.id, screenIds));
      const screenMap = new Map(screens.map((screen) => [screen.id, screen]));

      for (const assignment of screenAssignments) {
        const screen = screenMap.get(assignment.target_id);
        if (!screen) {
          throw AppError.notFound('Screen not found');
        }
        const aspectRatio = resolveAspectRatio(screen);
        if (!aspectRatio || aspectRatio !== assignment.aspect_ratio.trim()) {
          throw AppError.badRequest(
            `Selected screen ${screen.name} does not match the assignment aspect ratio ${assignment.aspect_ratio}.`
          );
        }
      }
    }

    const groupAssignments = assignments.filter((assignment) => assignment.target_type === 'GROUP');
    if (groupAssignments.length > 0) {
      const groupIds = Array.from(new Set(groupAssignments.map((assignment) => assignment.target_id)));
      const groups = await db.select().from(schema.screenGroups).where(inArray(schema.screenGroups.id, groupIds));
      const groupMap = new Map(groups.map((group) => [group.id, group]));
      const members = await db
        .select({
          group_id: schema.screenGroupMembers.group_id,
          screen_id: schema.screenGroupMembers.screen_id,
          screen_name: schema.screens.name,
          aspect_ratio: schema.screens.aspect_ratio,
          width: schema.screens.width,
          height: schema.screens.height,
        })
        .from(schema.screenGroupMembers)
        .innerJoin(schema.screens, eq(schema.screenGroupMembers.screen_id, schema.screens.id))
        .where(inArray(schema.screenGroupMembers.group_id, groupIds));

      const membersByGroup = members.reduce<Map<string, typeof members>>((acc, member) => {
        const list = acc.get(member.group_id) ?? [];
        list.push(member);
        acc.set(member.group_id, list);
        return acc;
      }, new Map());

      for (const assignment of groupAssignments) {
        const group = groupMap.get(assignment.target_id);
        if (!group) {
          throw AppError.notFound('Screen group not found');
        }

        const groupMembers = membersByGroup.get(assignment.target_id) ?? [];
        if (groupMembers.length === 0) {
          throw AppError.badRequest(`Screen group ${group.name} has no screens.`);
        }

        const aspectRatios = Array.from(
          new Set(groupMembers.map((member) => resolveAspectRatio(member)).filter((value): value is string => Boolean(value)))
        );

        if (aspectRatios.length !== 1 || aspectRatios[0] !== assignment.aspect_ratio.trim()) {
          throw AppError.badRequest(
            `Screen group ${group.name} must contain screens with the same aspect ratio as the selected default media target.`
          );
        }
      }
    }
  };

  const registerSectionRoutes = <T>(
    key: typeof GENERAL_SETTINGS_KEY | typeof SECURITY_SETTINGS_KEY | typeof APPEARANCE_SETTINGS_KEY | typeof BACKUPS_SETTINGS_KEY | typeof BRANDING_SETTINGS_KEY,
    schemaParser: z.ZodTypeAny,
    options: {
      getPath: string;
      putPath: string;
      getPublic?: boolean;
      putSubject?: 'OrgSettings' | 'BrandingSettings';
      transformResponse?: (value: T) => Promise<unknown> | unknown;
      onSave?: (value: T) => Promise<void> | void;
    }
  ) => {
    fastify.get(
      options.getPath,
      {
        schema: {
          description: `Get ${key} settings`,
          tags: ['Settings'],
          ...(options.getPublic ? {} : { security: [{ bearerAuth: [] }] }),
        },
      },
      async (request, reply) => {
        try {
          if (!options.getPublic) {
            await requireAccess(request, 'read', options.putSubject ?? 'OrgSettings');
          }
          const settings = await getSettingsSection(key as any);
          const payload = options.transformResponse ? await options.transformResponse(settings as T) : settings;
          return reply.send(payload);
        } catch (error) {
          logger.error(error, `Get ${key} settings error`);
          return respondWithError(reply, error);
        }
      }
    );

    fastify.put<{ Body: T }>(
      options.putPath,
      {
        schema: {
          description: `Update ${key} settings`,
          tags: ['Settings'],
          security: [{ bearerAuth: [] }],
        },
      },
      async (request, reply) => {
        try {
          await requireAccess(request, 'update', options.putSubject ?? 'OrgSettings');
          const parsed = schemaParser.parse(request.body);
          await options.onSave?.(parsed as T);
          const saved = await saveSettingsSection(key as any, parsed as any);
          const payload = options.transformResponse ? await options.transformResponse(saved as T) : saved;
          return reply.status(OK).send(payload);
        } catch (error) {
          logger.error(error, `Update ${key} settings error`);
          return respondWithError(reply, error);
        }
      }
    );
  };

  registerSectionRoutes<GeneralSettings>(GENERAL_SETTINGS_KEY, generalSettingsSchema, {
    getPath: apiEndpoints.settings.general,
    putPath: apiEndpoints.settings.general,
  });

  registerSectionRoutes<BrandingSettings>(BRANDING_SETTINGS_KEY, brandingSettingsSchema, {
    getPath: apiEndpoints.settings.branding,
    putPath: apiEndpoints.settings.branding,
    getPublic: true,
    putSubject: 'BrandingSettings',
    transformResponse: serializeBranding,
    onSave: async (value) => {
      await ensureMediaIdsExist([value.logo_media_id, value.icon_media_id, value.favicon_media_id]);
    },
  });

  registerSectionRoutes<SecuritySettings>(SECURITY_SETTINGS_KEY, securitySettingsSchema, {
    getPath: apiEndpoints.settings.security,
    putPath: apiEndpoints.settings.security,
  });

  registerSectionRoutes<AppearanceSettings>(APPEARANCE_SETTINGS_KEY, appearanceSettingsSchema, {
    getPath: apiEndpoints.settings.appearance,
    putPath: apiEndpoints.settings.appearance,
    getPublic: true,
  });

  registerSectionRoutes<BackupsSettings>(BACKUPS_SETTINGS_KEY, backupsSettingsSchema, {
    getPath: apiEndpoints.settings.backups,
    putPath: apiEndpoints.settings.backups,
    onSave: async (value) => {
      setRuntimeLogLevel(value.log_level);
    },
  });

  fastify.get(
    apiEndpoints.settings.backupHistory,
    {
      schema: {
        description: 'List backup runs',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      try {
        await requireAccess(request, 'read', 'OrgSettings');
        const runs = await listBackupRuns();
        return reply.send({
          items: runs.map((run) => ({
            id: run.id,
            trigger_type: run.trigger_type,
            status: run.status,
            started_at: run.started_at?.toISOString?.() ?? run.started_at ?? null,
            completed_at: run.completed_at?.toISOString?.() ?? run.completed_at ?? null,
            created_at: run.created_at?.toISOString?.() ?? run.created_at,
            error_message: run.error_message ?? null,
            downloads: run.downloads,
          })),
        });
      } catch (error) {
        logger.error(error, 'List backup runs error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post(
    apiEndpoints.settings.backupRun,
    {
      schema: {
        description: 'Queue a manual backup run',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      try {
        const payload = await requireAccess(request, 'update', 'OrgSettings');
        const run = await createBackupRun('MANUAL', payload.sub);
        await queueBackup({ runId: run.id });
        return reply.status(CREATED).send({
          id: run.id,
          status: run.status,
          trigger_type: run.trigger_type,
        });
      } catch (error) {
        logger.error(error, 'Queue backup run error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Querystring: typeof logsQuerySchema._type }>(
    apiEndpoints.settings.logs,
    {
      schema: {
        description: 'List recent backend application logs',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      try {
        await requireAccess(request, 'read', 'OrgSettings');
        const query = logsQuerySchema.parse(request.query);
        return reply.send({
          items: getRecentLogs(query),
        });
      } catch (error) {
        logger.error(error, 'List recent logs error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.settings.list,
    {
      schema: {
        description: 'List org settings',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'read', 'OrgSettings');
        const items = await db.select().from(schema.settings);
        return reply.send({ items });
      } catch (error) {
        logger.error(error, 'List settings error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Body: typeof upsertSettingSchema._type }>(
    apiEndpoints.settings.upsert,
    {
      schema: {
        description: 'Upsert org setting',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'update', 'OrgSettings');
        const data = upsertSettingSchema.parse(request.body);

        const knownSections = {
          [GENERAL_SETTINGS_KEY]: generalSettingsSchema,
          [BRANDING_SETTINGS_KEY]: brandingSettingsSchema,
          [SECURITY_SETTINGS_KEY]: securitySettingsSchema,
          [APPEARANCE_SETTINGS_KEY]: appearanceSettingsSchema,
          [BACKUPS_SETTINGS_KEY]: backupsSettingsSchema,
        } as const;

        let value = data.value;
        if (data.key === BRANDING_SETTINGS_KEY) {
          value = brandingSettingsSchema.parse(data.value);
          await ensureMediaIdsExist([value.logo_media_id, value.icon_media_id, value.favicon_media_id]);
        } else if (data.key in knownSections) {
          value = (knownSections as any)[data.key].parse(data.value);
        }

        const [record] = await db
          .insert(schema.settings)
          .values({ key: data.key, value })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value, updated_at: new Date() },
          })
          .returning();

        if (data.key === BACKUPS_SETTINGS_KEY) {
          setRuntimeLogLevel((value as BackupsSettings).log_level);
        }

        return reply.status(OK).send(record);
      } catch (error) {
        logger.error(error, 'Upsert setting error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.settings.defaultMedia,
    {
      schema: {
        description: 'Get default media setting',
        tags: ['Settings'],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const defaultMedia = await getDefaultMedia(db);
        if (!defaultMedia || !defaultMedia.media) {
          return reply.send({
            media_id: defaultMedia?.media_id ?? null,
            media: null,
          });
        }

        return reply.send({
          media_id: defaultMedia.media_id,
          media: serializeMedia(defaultMedia.media, defaultMedia.media_url),
        });
      } catch (error) {
        logger.error(error, 'Get default media setting error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.put<{ Body: typeof defaultMediaUpdateSchema._type }>(
    apiEndpoints.settings.defaultMedia,
    {
      schema: {
        description: 'Update default media setting',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'update', 'OrgSettings');
        const data = defaultMediaUpdateSchema.parse(request.body);
        if (data.media_id === null) {
          await db.delete(schema.settings).where(eq(schema.settings.key, DEFAULT_MEDIA_SETTING_KEY));
          return reply.status(OK).send({ media_id: null, media: null });
        }

        const [media] = await db.select().from(schema.media).where(eq(schema.media.id, data.media_id));
        if (!media) {
          throw AppError.notFound('Media not found');
        }

        await db
          .insert(schema.settings)
          .values({ key: DEFAULT_MEDIA_SETTING_KEY, value: data.media_id })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: data.media_id, updated_at: new Date() },
          });

        const media_url = await resolveMediaUrl(media, db);
        return reply.status(OK).send({
          media_id: media.id,
          media: serializeMedia(media, media_url),
        });
      } catch (error) {
        logger.error(error, 'Update default media setting error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.settings.defaultMediaVariants,
    {
      schema: {
        description: 'Get default media variants by aspect ratio',
        tags: ['Settings'],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send(await serializeDefaultMediaVariants());
      } catch (error) {
        logger.error(error, 'Get default media variants error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.put<{ Body: typeof defaultMediaVariantsUpdateSchema._type }>(
    apiEndpoints.settings.defaultMediaVariants,
    {
      schema: {
        description: 'Update default media variants by aspect ratio',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'update', 'OrgSettings');
        const data = defaultMediaVariantsUpdateSchema.parse(request.body);
        const requestedIds = Array.from(
          new Set(Object.values(data.variants).filter((value): value is string => typeof value === 'string' && value.length > 0))
        );

        if (requestedIds.length > 0) {
          const medias = await db.select({ id: schema.media.id }).from(schema.media).where(inArray(schema.media.id, requestedIds as string[]));
          const found = new Set(medias.map((media) => media.id));
          const missing = requestedIds.find((mediaId) => !found.has(mediaId));
          if (missing) {
            throw AppError.notFound('Media not found');
          }
        }

        const normalized = Object.entries(data.variants).reduce<Record<string, string>>((acc, [aspectRatio, mediaId]) => {
          if (mediaId) {
            acc[aspectRatio.trim()] = mediaId;
          }
          return acc;
        }, {});

        if (Object.keys(normalized).length === 0) {
          await db.delete(schema.settings).where(eq(schema.settings.key, DEFAULT_MEDIA_VARIANTS_SETTING_KEY));
        } else {
          await db
            .insert(schema.settings)
            .values({ key: DEFAULT_MEDIA_VARIANTS_SETTING_KEY, value: normalized })
            .onConflictDoUpdate({
              target: schema.settings.key,
              set: { value: normalized, updated_at: new Date() },
            });
        }

        return reply.status(OK).send(await serializeDefaultMediaVariants());
      } catch (error) {
        logger.error(error, 'Update default media variants error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.settings.defaultMediaTargets,
    {
      schema: {
        description: 'Get target-based default media assignments',
        tags: ['Settings'],
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send(await serializeDefaultMediaTargets());
      } catch (error) {
        logger.error(error, 'Get default media targets error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.put<{ Body: typeof defaultMediaTargetsUpdateSchema._type }>(
    apiEndpoints.settings.defaultMediaTargets,
    {
      schema: {
        description: 'Update target-based default media assignments',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'update', 'OrgSettings');
        const data = defaultMediaTargetsUpdateSchema.parse(request.body);
        const dedupedAssignments = Array.from(
          new Map(
            data.assignments.map((assignment) => [
              `${assignment.target_type}:${assignment.target_id}`,
              {
                ...assignment,
                aspect_ratio: assignment.aspect_ratio.trim(),
              },
            ])
          ).values()
        );

        await validateDefaultMediaTargets(dedupedAssignments);

        if (dedupedAssignments.length === 0) {
          await db.delete(schema.settings).where(eq(schema.settings.key, DEFAULT_MEDIA_TARGETS_SETTING_KEY));
          return reply.status(OK).send({ assignments: [] });
        }

        await db
          .insert(schema.settings)
          .values({ key: DEFAULT_MEDIA_TARGETS_SETTING_KEY, value: dedupedAssignments })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: dedupedAssignments, updated_at: new Date() },
          });

        return reply.status(OK).send(await serializeDefaultMediaTargets());
      } catch (error) {
        logger.error(error, 'Update default media targets error');
        return respondWithError(reply, error);
      }
    }
  );
}
