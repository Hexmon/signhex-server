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
} from '@/utils/default-media';
import { AppError } from '@/utils/app-error';
import { serializeMediaRecord } from '@/utils/media';
import { resolveMediaAccess } from '@/utils/media-access';
import { dispatchPlaybackRefresh } from '@/services/playback-refresh-dispatch';
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
import { createBackupRun, deleteBackupRun, listBackupRuns } from '@/utils/backup-runs';
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

async function validateDefaultMediaTargets(
  assignments: Array<z.infer<typeof defaultMediaTargetAssignmentSchema>>
) {
  if (assignments.length === 0) return;

  const db = getDatabase();
  await ensureMediaIdsExist(assignments.map((assignment) => assignment.media_id));

  const screenAssignments = assignments.filter((assignment) => assignment.target_type === 'SCREEN');
  const groupAssignments = assignments.filter((assignment) => assignment.target_type === 'GROUP');

  if (screenAssignments.length > 0) {
    const screenIds = screenAssignments.map((assignment) => assignment.target_id);
    const screens = await db
      .select({
        id: schema.screens.id,
        aspect_ratio: schema.screens.aspect_ratio,
        width: schema.screens.width,
        height: schema.screens.height,
      })
      .from(schema.screens)
      .where(inArray(schema.screens.id, screenIds as string[]));

    if (screens.length !== screenIds.length) {
      throw AppError.notFound('Screen not found');
    }

    const screensById = new Map(screens.map((screen) => [screen.id, screen]));
    for (const assignment of screenAssignments) {
      const screen = screensById.get(assignment.target_id);
      const aspectRatio = screen ? resolveAspectRatio(screen) : null;
      if (!aspectRatio || aspectRatio !== assignment.aspect_ratio) {
        throw AppError.badRequest('Screen default media assignment aspect ratio does not match the target screen.');
      }
    }
  }

  if (groupAssignments.length > 0) {
    const groupIds = groupAssignments.map((assignment) => assignment.target_id);
    const groups = await db
      .select({ id: schema.screenGroups.id })
      .from(schema.screenGroups)
      .where(inArray(schema.screenGroups.id, groupIds as string[]));

    if (groups.length !== groupIds.length) {
      throw AppError.notFound('Screen group not found');
    }

    const members = await db
      .select({
        group_id: schema.screenGroupMembers.group_id,
        screen_id: schema.screenGroupMembers.screen_id,
        aspect_ratio: schema.screens.aspect_ratio,
        width: schema.screens.width,
        height: schema.screens.height,
      })
      .from(schema.screenGroupMembers)
      .innerJoin(schema.screens, eq(schema.screenGroupMembers.screen_id, schema.screens.id))
      .where(inArray(schema.screenGroupMembers.group_id, groupIds as string[]));

    const membersByGroup = new Map<string, typeof members>();
    for (const member of members) {
      const existing = membersByGroup.get(member.group_id) ?? [];
      existing.push(member);
      membersByGroup.set(member.group_id, existing);
    }

    for (const assignment of groupAssignments) {
      const groupMembers = membersByGroup.get(assignment.target_id) ?? [];
      if (groupMembers.length === 0) {
        throw AppError.badRequest('Screen group must contain at least one screen.');
      }

      const aspectRatios = Array.from(
        new Set(
          groupMembers
            .map((member) =>
              resolveAspectRatio({
                aspect_ratio: member.aspect_ratio,
                width: member.width,
                height: member.height,
              })
            )
            .filter((value): value is string => Boolean(value))
        )
      );

      if (aspectRatios.length !== 1) {
        throw AppError.badRequest('Screen group must contain screens with the same aspect ratio.');
      }

      if (aspectRatios[0] !== assignment.aspect_ratio) {
        throw AppError.badRequest('Group default media assignment aspect ratio does not match the target screens.');
      }
    }
  }
}

export async function settingsRoutes(fastify: FastifyInstance) {
  const db = getDatabase();

  const serializeMedia = async (media: any) => {
    const mediaAccess = await resolveMediaAccess(media, db);
    return serializeMediaRecord(media, mediaAccess.media_url, {
      content_type: mediaAccess.content_type,
      source_content_type: mediaAccess.source_content_type,
      size: mediaAccess.size,
    });
  };

  const serializeDefaultMediaVariants = async () => {
    const data = await getDefaultMediaVariants(db);
    return {
      global_media_id: data.global_media_id,
      global_media: data.global_media ? await serializeMedia(data.global_media) : null,
      variants: await Promise.all(
        data.variants.map(async (variant) => ({
          aspect_ratio: variant.aspect_ratio,
          media_id: variant.media_id,
          media: variant.media ? await serializeMedia(variant.media) : null,
        }))
      ),
    };
  };

  const serializeDefaultMediaTargets = async () => {
    const data = await getDefaultMediaTargetAssignments(db);
    return {
      assignments: await Promise.all(
        data.map(async (assignment) => ({
          target_type: assignment.target_type,
          target_id: assignment.target_id,
          aspect_ratio: assignment.aspect_ratio,
          media_id: assignment.media_id,
          media: assignment.media ? await serializeMedia(assignment.media) : null,
        }))
      ),
    };
  };

  const serializeDefaultMediaVariants = async () => {
    const data = await getDefaultMediaVariants(db);
    return {
      global_media_id: data.global_media_id,
      global_media: data.global_media ? serializeMedia(data.global_media, data.global_media_url) : null,
      variants: data.variants.map((variant) => ({
        aspect_ratio: variant.aspect_ratio,
        media_id: variant.media_id,
        media: variant.media ? serializeMedia(variant.media, variant.media_url) : null,
      })),
    };
  };

  const serializeDefaultMediaTargets = async () => {
    const data = await getDefaultMediaTargetAssignments(db);
    return {
      assignments: data.map((assignment) => ({
        target_type: assignment.target_type,
        target_id: assignment.target_id,
        aspect_ratio: assignment.aspect_ratio,
        media_id: assignment.media_id,
        media: assignment.media ? serializeMedia(assignment.media, assignment.media_url) : null,
      })),
    };
  };

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
    apiEndpoints.settings.general,
    {
      schema: {
        description: 'Get general organization settings',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'read', 'OrgSettings');
        return reply.send(await getSettingsSection(GENERAL_SETTINGS_KEY));
      } catch (error) {
        logger.error(error, 'Get general settings error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.put<{ Body: GeneralSettings }>(
    apiEndpoints.settings.general,
    {
      schema: {
        description: 'Update general organization settings',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'update', 'OrgSettings');
        const data = generalSettingsSchema.parse(request.body);
        return reply.status(OK).send(await saveSettingsSection(GENERAL_SETTINGS_KEY, data));
      } catch (error) {
        logger.error(error, 'Update general settings error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.settings.branding,
    {
      schema: {
        description: 'Get branding settings',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'read', 'BrandingSettings');
        return reply.send(await serializeBranding(await getSettingsSection(BRANDING_SETTINGS_KEY)));
      } catch (error) {
        logger.error(error, 'Get branding settings error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.put<{ Body: BrandingSettings }>(
    apiEndpoints.settings.branding,
    {
      schema: {
        description: 'Update branding settings',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'update', 'BrandingSettings');
        const data = brandingSettingsSchema.parse(request.body);
        await ensureMediaIdsExist([data.logo_media_id, data.icon_media_id, data.favicon_media_id]);
        const saved = await saveSettingsSection(BRANDING_SETTINGS_KEY, data);
        return reply.status(OK).send(await serializeBranding(saved));
      } catch (error) {
        logger.error(error, 'Update branding settings error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.settings.security,
    {
      schema: {
        description: 'Get security settings',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'read', 'OrgSettings');
        return reply.send(await getSettingsSection(SECURITY_SETTINGS_KEY));
      } catch (error) {
        logger.error(error, 'Get security settings error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.put<{ Body: SecuritySettings }>(
    apiEndpoints.settings.security,
    {
      schema: {
        description: 'Update security settings',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'update', 'OrgSettings');
        const data = securitySettingsSchema.parse(request.body);
        return reply.status(OK).send(await saveSettingsSection(SECURITY_SETTINGS_KEY, data));
      } catch (error) {
        logger.error(error, 'Update security settings error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.settings.appearance,
    {
      schema: {
        description: 'Get appearance settings',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'read', 'OrgSettings');
        return reply.send(await getSettingsSection(APPEARANCE_SETTINGS_KEY));
      } catch (error) {
        logger.error(error, 'Get appearance settings error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.put<{ Body: AppearanceSettings }>(
    apiEndpoints.settings.appearance,
    {
      schema: {
        description: 'Update appearance settings',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'update', 'OrgSettings');
        const data = appearanceSettingsSchema.parse(request.body);
        return reply.status(OK).send(await saveSettingsSection(APPEARANCE_SETTINGS_KEY, data));
      } catch (error) {
        logger.error(error, 'Update appearance settings error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.settings.backups,
    {
      schema: {
        description: 'Get backups settings',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'read', 'OrgSettings');
        return reply.send(await getSettingsSection(BACKUPS_SETTINGS_KEY));
      } catch (error) {
        logger.error(error, 'Get backups settings error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.put<{ Body: BackupsSettings }>(
    apiEndpoints.settings.backups,
    {
      schema: {
        description: 'Update backups settings',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'update', 'OrgSettings');
        const data = backupsSettingsSchema.parse(request.body);
        const saved = await saveSettingsSection(BACKUPS_SETTINGS_KEY, data);
        setRuntimeLogLevel(saved.log_level);
        return reply.status(OK).send(saved);
      } catch (error) {
        logger.error(error, 'Update backups settings error');
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
    async (request: FastifyRequest, reply: FastifyReply) => {
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
        logger.error(error, 'Run backup error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.settings.backupById,
    {
      schema: {
        description: 'Delete a completed or failed backup run and its archive files',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'update', 'OrgSettings');
        const result = await deleteBackupRun(request.params.id);
        return reply.status(OK).send(result);
      } catch (error) {
        logger.error(error, 'Delete backup run error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.settings.backupHistory,
    {
      schema: {
        description: 'List recent backup runs',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'read', 'OrgSettings');
        return reply.send({ items: await listBackupRuns() });
      } catch (error) {
        logger.error(error, 'List backup history error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Querystring: typeof logsQuerySchema._type }>(
    apiEndpoints.settings.logs,
    {
      schema: {
        description: 'List recent application logs',
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAccess(request, 'read', 'OrgSettings');
        const query = logsQuerySchema.parse(request.query);
        return reply.send({ items: getRecentLogs(query) });
      } catch (error) {
        logger.error(error, 'List recent logs error');
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
          media: await serializeMedia(defaultMedia.media),
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
        const payload = await requireAccess(request, 'update', 'OrgSettings');
        const data = defaultMediaUpdateSchema.parse(request.body);
        if (data.media_id === null) {
          await db.delete(schema.settings).where(eq(schema.settings.key, DEFAULT_MEDIA_SETTING_KEY));
          await dispatchPlaybackRefresh(fastify, {
            reason: 'DEFAULT_MEDIA',
            targetAll: true,
            createdBy: payload.sub,
          });
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

        await dispatchPlaybackRefresh(fastify, {
          reason: 'DEFAULT_MEDIA',
          targetAll: true,
          createdBy: payload.sub,
        });

        return reply.status(OK).send({
          media_id: media.id,
          media: await serializeMedia(media),
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
        const payload = await requireAccess(request, 'update', 'OrgSettings');
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

        await dispatchPlaybackRefresh(fastify, {
          reason: 'DEFAULT_MEDIA',
          targetAll: true,
          createdBy: payload.sub,
        });

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
        const payload = await requireAccess(request, 'update', 'OrgSettings');
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
          await dispatchPlaybackRefresh(fastify, {
            reason: 'DEFAULT_MEDIA',
            targetAll: true,
            createdBy: payload.sub,
          });
          return reply.status(OK).send({ assignments: [] });
        }

        await db
          .insert(schema.settings)
          .values({ key: DEFAULT_MEDIA_TARGETS_SETTING_KEY, value: dedupedAssignments })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: dedupedAssignments, updated_at: new Date() },
          });

        await dispatchPlaybackRefresh(fastify, {
          reason: 'DEFAULT_MEDIA',
          targetAll: true,
          createdBy: payload.sub,
        });

        return reply.status(OK).send(await serializeDefaultMediaTargets());
      } catch (error) {
        logger.error(error, 'Update default media targets error');
        return respondWithError(reply, error);
      }
    }
  );
}
