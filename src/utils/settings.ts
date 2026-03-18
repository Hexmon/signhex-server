import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { config as appConfig } from '@/config';
import { getPresignedUrl } from '@/s3';

export const GENERAL_SETTINGS_KEY = 'org.general';
export const BRANDING_SETTINGS_KEY = 'org.branding';
export const SECURITY_SETTINGS_KEY = 'org.security';
export const BACKUPS_SETTINGS_KEY = 'org.backups';
export const APPEARANCE_SETTINGS_KEY = 'org.appearance';

const passwordPolicySchema = z.object({
  min_length: z.coerce.number().int().min(8).max(128).default(appConfig.PASSWORD_MIN_LENGTH),
  require_uppercase: z.coerce.boolean().default(true),
  require_lowercase: z.coerce.boolean().default(true),
  require_number: z.coerce.boolean().default(true),
  require_special: z.coerce.boolean().default(true),
});

export const generalSettingsSchema = z.object({
  company_name: z.string().trim().min(1).max(255).default('Signhex'),
  timezone: z.string().trim().min(1).max(100).default('UTC'),
  language: z.string().trim().min(2).max(16).default('en'),
});

export const brandingSettingsSchema = z.object({
  app_name: z.string().trim().min(1).max(255).default('Signhex CMS'),
  logo_media_id: z.string().uuid().nullable().default(null),
  icon_media_id: z.string().uuid().nullable().default(null),
  favicon_media_id: z.string().uuid().nullable().default(null),
});

export const securitySettingsSchema = z.object({
  idle_timeout_minutes: z.coerce.number().int().min(5).max(1440).default(
    Math.min(1440, Math.max(5, Math.floor(appConfig.JWT_EXPIRY / 60)))
  ),
  password_policy: passwordPolicySchema.default({}),
});

export const appearanceSettingsSchema = z.object({
  theme_mode: z.enum(['light', 'dark', 'system']).default('light'),
  accent_preset: z.enum(['crimson', 'blue', 'emerald', 'amber', 'slate']).default('crimson'),
  sidebar_mode: z.enum(['expanded', 'collapsed', 'auto']).default('expanded'),
});

export const backupsSettingsSchema = z.object({
  automatic_enabled: z.coerce.boolean().default(false),
  interval_hours: z.coerce.number().int().min(1).max(168).default(24),
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default(appConfig.LOG_LEVEL),
});

export type GeneralSettings = z.infer<typeof generalSettingsSchema>;
export type BrandingSettings = z.infer<typeof brandingSettingsSchema>;
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;
export type BackupsSettings = z.infer<typeof backupsSettingsSchema>;

export type SettingsSectionKey =
  | typeof GENERAL_SETTINGS_KEY
  | typeof BRANDING_SETTINGS_KEY
  | typeof SECURITY_SETTINGS_KEY
  | typeof APPEARANCE_SETTINGS_KEY
  | typeof BACKUPS_SETTINGS_KEY;

const SECTION_SCHEMAS: Record<SettingsSectionKey, z.ZodTypeAny> = {
  [GENERAL_SETTINGS_KEY]: generalSettingsSchema,
  [BRANDING_SETTINGS_KEY]: brandingSettingsSchema,
  [SECURITY_SETTINGS_KEY]: securitySettingsSchema,
  [APPEARANCE_SETTINGS_KEY]: appearanceSettingsSchema,
  [BACKUPS_SETTINGS_KEY]: backupsSettingsSchema,
};

type SectionValues = {
  [GENERAL_SETTINGS_KEY]: GeneralSettings;
  [BRANDING_SETTINGS_KEY]: BrandingSettings;
  [SECURITY_SETTINGS_KEY]: SecuritySettings;
  [APPEARANCE_SETTINGS_KEY]: AppearanceSettings;
  [BACKUPS_SETTINGS_KEY]: BackupsSettings;
};

const settingsCache: Record<SettingsSectionKey, unknown> = {
  [GENERAL_SETTINGS_KEY]: generalSettingsSchema.parse({}),
  [BRANDING_SETTINGS_KEY]: brandingSettingsSchema.parse({}),
  [SECURITY_SETTINGS_KEY]: securitySettingsSchema.parse({}),
  [APPEARANCE_SETTINGS_KEY]: appearanceSettingsSchema.parse({}),
  [BACKUPS_SETTINGS_KEY]: backupsSettingsSchema.parse({}),
};

export async function preloadSettingsCache() {
  const db = getDatabase();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, Object.keys(SECTION_SCHEMAS) as SettingsSectionKey[]));

  for (const row of rows) {
    const key = row.key as SettingsSectionKey;
    const parser = SECTION_SCHEMAS[key];
    if (!parser) continue;
    settingsCache[key] = parser.parse(row.value ?? {});
  }
}

export function getCachedSettings<K extends SettingsSectionKey>(key: K): SectionValues[K] {
  return settingsCache[key] as SectionValues[K];
}

export async function getSettingsSection<K extends SettingsSectionKey>(key: K): Promise<SectionValues[K]> {
  const db = getDatabase();
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, key));
  const parser = SECTION_SCHEMAS[key];
  const parsed = parser.parse(row?.value ?? {});
  settingsCache[key] = parsed;
  return parsed as SectionValues[K];
}

export async function saveSettingsSection<K extends SettingsSectionKey>(
  key: K,
  value: SectionValues[K]
): Promise<SectionValues[K]> {
  const db = getDatabase();
  const parser = SECTION_SCHEMAS[key];
  const parsed = parser.parse(value);
  await db
    .insert(schema.settings)
    .values({ key, value: parsed })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: parsed, updated_at: new Date() },
    });
  settingsCache[key] = parsed;
  return parsed as SectionValues[K];
}

export function getPasswordPolicy() {
  return getCachedSettings(SECURITY_SETTINGS_KEY).password_policy;
}

export function getIdleTimeoutSeconds() {
  return getCachedSettings(SECURITY_SETTINGS_KEY).idle_timeout_minutes * 60;
}

export function getRuntimeLogLevelSetting() {
  return getCachedSettings(BACKUPS_SETTINGS_KEY).log_level;
}

export async function resolveBrandingMediaMap(ids: Array<string | null | undefined>) {
  const requestedIds = Array.from(new Set(ids.filter((value): value is string => typeof value === 'string' && value.length > 0)));
  if (requestedIds.length === 0) {
    return new Map<string, { id: string; url: string | null }>();
  }

  const db = getDatabase();
  const rows = await db
    .select({
      id: schema.media.id,
      ready_object_id: schema.media.ready_object_id,
      source_bucket: schema.media.source_bucket,
      source_object_key: schema.media.source_object_key,
    })
    .from(schema.media)
    .where(inArray(schema.media.id, requestedIds as string[]));

  const map = new Map<string, { id: string; url: string | null }>();

  for (const row of rows) {
    let url: string | null = null;
    if (row.source_bucket && row.source_object_key) {
      url = await getPresignedUrl(row.source_bucket, row.source_object_key);
    }
    map.set(row.id, { id: row.id, url });
  }

  return map;
}
