import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Enums
export const requestStatusEnum = pgEnum('request_status', [
  'OPEN',
  'IN_PROGRESS',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'COMPLETED',
]);
export const scheduleRequestStatusEnum = pgEnum('schedule_request_status', ['PENDING', 'APPROVED', 'REJECTED']);
export const mediaTypeEnum = pgEnum('media_type', ['IMAGE', 'VIDEO', 'DOCUMENT']);
export const mediaStatusEnum = pgEnum('media_status', ['PENDING', 'PROCESSING', 'READY', 'FAILED']);
export const screenStatusEnum = pgEnum('screen_status', ['ACTIVE', 'INACTIVE', 'OFFLINE']);
export const commandTypeEnum = pgEnum('command_type', ['REBOOT', 'REFRESH', 'TEST_PATTERN', 'TAKE_SCREENSHOT', 'SET_SCREENSHOT_INTERVAL']);
export const commandStatusEnum = pgEnum('command_status', ['PENDING', 'SENT', 'ACKNOWLEDGED', 'COMPLETED', 'FAILED']);
export const chatConversationTypeEnum = pgEnum('chat_conversation_type', ['DM', 'GROUP_CLOSED', 'FORUM_OPEN']);
export const chatConversationStateEnum = pgEnum('chat_conversation_state', ['ACTIVE', 'ARCHIVED', 'DELETED']);
export const chatInvitePolicyEnum = pgEnum('chat_invite_policy', [
  'ANY_MEMBER_CAN_INVITE',
  'ADMINS_ONLY_CAN_INVITE',
  'INVITES_DISABLED',
]);
export const chatMemberRoleEnum = pgEnum('chat_member_role', ['OWNER', 'CHAT_ADMIN', 'MOD', 'MEMBER']);
export const chatRevisionActionEnum = pgEnum('chat_revision_action', ['EDIT', 'DELETE']);
export const chatBookmarkTypeEnum = pgEnum('chat_bookmark_type', ['LINK', 'FILE', 'MESSAGE']);

// Users table
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull().unique(),
    description: text('description'),
    permissions: jsonb('permissions').notNull().default({}),
    is_system: boolean('is_system').notNull().default(false),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: uniqueIndex('roles_name_idx').on(table.name),
  })
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    password_hash: text('password_hash').notNull(),
    first_name: varchar('first_name', { length: 100 }),
    last_name: varchar('last_name', { length: 100 }),
    role_id: uuid('role_id').notNull(),
    department_id: uuid('department_id'),
    is_active: boolean('is_active').notNull().default(true),
    ext: jsonb('ext'),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: uniqueIndex('users_email_idx').on(table.email),
    roleIdx: index('users_role_id_idx').on(table.role_id),
  })
);

// Departments table
export const departments = pgTable('departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  created_at: timestamp('created_at').notNull().defaultNow(),
  updated_at: timestamp('updated_at').notNull().defaultNow(),
});

// Sessions table (for JWT JTI revocation)
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull(),
    access_jti: varchar('access_jti', { length: 255 }).notNull(),
    expires_at: timestamp('expires_at').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('sessions_user_id_idx').on(table.user_id),
    jtiIdx: uniqueIndex('sessions_access_jti_idx').on(table.access_jti),
  })
);

// Storage objects (MinIO references)
export const storageObjects = pgTable(
  'storage_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bucket: varchar('bucket', { length: 255 }).notNull(),
    object_key: varchar('object_key', { length: 1024 }).notNull(),
    content_type: varchar('content_type', { length: 100 }),
    size: integer('size'),
    sha256: varchar('sha256', { length: 64 }),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    bucketKeyIdx: uniqueIndex('storage_objects_bucket_key_idx').on(table.bucket, table.object_key),
  })
);

// Media table
export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    display_name: varchar('display_name', { length: 255 }),
    type: mediaTypeEnum('type').notNull(),
    status: mediaStatusEnum('status').notNull().default('PENDING'),
    source_object_id: uuid('source_object_id'),
    source_bucket: varchar('source_bucket', { length: 255 }),
    source_object_key: varchar('source_object_key', { length: 1024 }),
    source_content_type: varchar('source_content_type', { length: 255 }),
    source_size: integer('source_size'),
    ready_object_id: uuid('ready_object_id'),
    thumbnail_object_id: uuid('thumbnail_object_id'),
    duration_seconds: integer('duration_seconds'),
    width: integer('width'),
    height: integer('height'),
    created_by: uuid('created_by').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    createdByIdx: index('media_created_by_idx').on(table.created_by),
    statusIdx: index('media_status_idx').on(table.status),
  })
);

// Presentations table
export const presentations = pgTable(
  'presentations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    layout_id: uuid('layout_id'),
    created_by: uuid('created_by').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    createdByIdx: index('presentations_created_by_idx').on(table.created_by),
    layoutIdx: index('presentations_layout_id_idx').on(table.layout_id),
  })
);

// Presentation items table
export const presentationItems = pgTable(
  'presentation_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    presentation_id: uuid('presentation_id').notNull(),
    media_id: uuid('media_id').notNull(),
    order: integer('order').notNull(),
    duration_seconds: integer('duration_seconds'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    presentationIdIdx: index('presentation_items_presentation_id_idx').on(table.presentation_id),
  })
);

// Presentation slot items table (layout-based playlists)
export const presentationSlotItems = pgTable(
  'presentation_slot_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    presentation_id: uuid('presentation_id').notNull(),
    slot_id: varchar('slot_id', { length: 255 }).notNull(),
    media_id: uuid('media_id').notNull(),
    order: integer('order').notNull().default(0),
    duration_seconds: integer('duration_seconds'),
    fit_mode: varchar('fit_mode', { length: 50 }),
    audio_enabled: boolean('audio_enabled').default(false),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    presentationSlotIdx: index('presentation_slot_items_presentation_id_idx').on(table.presentation_id),
  })
);

// Schedules table
export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    timezone: varchar('timezone', { length: 100 }),
    start_at: timestamp('start_at').notNull(),
    end_at: timestamp('end_at').notNull(),
    is_active: boolean('is_active').notNull().default(true),
    created_by: uuid('created_by').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    createdByIdx: index('schedules_created_by_idx').on(table.created_by),
    isActiveIdx: index('schedules_is_active_idx').on(table.is_active),
    startAtIdx: index('schedules_start_at_idx').on(table.start_at),
    endAtIdx: index('schedules_end_at_idx').on(table.end_at),
  })
);

// Schedule items table
export const scheduleItems = pgTable(
  'schedule_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schedule_id: uuid('schedule_id').notNull(),
    presentation_id: uuid('presentation_id').notNull(),
    start_at: timestamp('start_at').notNull(),
    end_at: timestamp('end_at').notNull(),
    priority: integer('priority').notNull().default(0),
    screen_ids: jsonb('screen_ids').$type<string[]>().notNull().default([] as string[]),
    screen_group_ids: jsonb('screen_group_ids').$type<string[]>().notNull().default([] as string[]),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    scheduleIdIdx: index('schedule_items_schedule_id_idx').on(table.schedule_id),
    startAtIdx: index('schedule_items_start_at_idx').on(table.start_at),
  })
);

// Schedule snapshots (immutable published versions)
export const scheduleSnapshots = pgTable(
  'schedule_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schedule_id: uuid('schedule_id').notNull(),
    payload: jsonb('payload').notNull(),
    storage_object_id: uuid('storage_object_id'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    scheduleIdIdx: index('schedule_snapshots_schedule_id_idx').on(table.schedule_id),
  })
);

// Schedule requests (approval workflow for publishes)
// Publishes (schedule publication events)
export const publishes = pgTable(
  'publishes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schedule_id: uuid('schedule_id').notNull(),
    snapshot_id: uuid('snapshot_id').notNull(),
    published_by: uuid('published_by').notNull(),
    published_at: timestamp('published_at').notNull().defaultNow(),
  },
  (table) => ({
    scheduleIdIdx: index('publishes_schedule_id_idx').on(table.schedule_id),
  })
);

// Screens table
export const screens = pgTable(
  'screens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    location: varchar('location', { length: 255 }),
    aspect_ratio: varchar('aspect_ratio', { length: 50 }),
    width: integer('width'),
    height: integer('height'),
    orientation: varchar('orientation', { length: 50 }),
    device_info: jsonb('device_info'),
    status: screenStatusEnum('status').notNull().default('OFFLINE'),
    last_heartbeat_at: timestamp('last_heartbeat_at'),
    current_schedule_id: uuid('current_schedule_id'),
    current_media_id: uuid('current_media_id'),
    screenshot_interval_seconds: integer('screenshot_interval_seconds'),
    screenshot_enabled: boolean('screenshot_enabled').notNull().default(false),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index('screens_status_idx').on(table.status),
    currentScheduleIdx: index('screens_current_schedule_idx').on(table.current_schedule_id),
    currentMediaIdx: index('screens_current_media_idx').on(table.current_media_id),
  })
);

// Screen groups table
export const screenGroups = pgTable(
  'screen_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  }
);

// Layouts (screen mosaics)
export const layouts = pgTable(
  'layouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    aspect_ratio: varchar('aspect_ratio', { length: 50 }).notNull(),
    spec: jsonb('spec').notNull(), // normalized slots: [{id,x,y,w,h,z,fit,audio_enabled}]
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    aspectIdx: index('layouts_aspect_ratio_idx').on(table.aspect_ratio),
  })
);

// Schedule requests (draft/approval)
export const scheduleRequests = pgTable(
  'schedule_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schedule_id: uuid('schedule_id').notNull(),
    schedule_payload: jsonb('schedule_payload').notNull(),
    status: scheduleRequestStatusEnum('status').notNull().default('PENDING'),
    review_notes: text('review_notes'),
    notes: text('notes'),
    requested_by: uuid('requested_by').notNull(),
    reviewed_by: uuid('reviewed_by'),
    reviewed_at: timestamp('reviewed_at'),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index('schedule_requests_status_idx').on(table.status),
    scheduleIdx: index('schedule_requests_schedule_id_idx').on(table.schedule_id),
    requesterIdx: index('schedule_requests_requested_by_idx').on(table.requested_by),
  })
);

// Screen group members table
export const screenGroupMembers = pgTable(
  'screen_group_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    group_id: uuid('group_id').notNull(),
    screen_id: uuid('screen_id').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    groupIdIdx: index('screen_group_members_group_id_idx').on(table.group_id),
  })
);

// Device certificates (mTLS)
export const deviceCertificates = pgTable(
  'device_certificates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    screen_id: uuid('screen_id').notNull(),
    serial: varchar('serial', { length: 255 }).notNull().unique(),
    certificate_pem: text('certificate_pem').notNull(),
    is_revoked: boolean('is_revoked').notNull().default(false),
    expires_at: timestamp('expires_at').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
    revoked_at: timestamp('revoked_at'),
  },
  (table) => ({
    screenIdIdx: index('device_certificates_screen_id_idx').on(table.screen_id),
    serialIdx: uniqueIndex('device_certificates_serial_idx').on(table.serial),
    expiresAtIdx: index('device_certificates_expires_at_idx').on(table.expires_at),
  })
);

// Device commands
export const deviceCommands = pgTable(
  'device_commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    screen_id: uuid('screen_id').notNull(),
    type: commandTypeEnum('type').notNull(),
    status: commandStatusEnum('status').notNull().default('PENDING'),
    payload: jsonb('payload'),
    created_by: uuid('created_by').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    screenIdIdx: index('device_commands_screen_id_idx').on(table.screen_id),
    statusIdx: index('device_commands_status_idx').on(table.status),
  })
);

// Heartbeats (device telemetry)
export const heartbeats = pgTable(
  'heartbeats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    screen_id: uuid('screen_id').notNull(),
    status: varchar('status', { length: 20 }),
    storage_object_id: uuid('storage_object_id'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    screenIdIdx: index('heartbeats_screen_id_idx').on(table.screen_id),
    createdAtIdx: index('heartbeats_created_at_idx').on(table.created_at),
  })
);

// Proof of Play (PoP)
export const proofOfPlay = pgTable(
  'proof_of_play',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    screen_id: uuid('screen_id').notNull(),
    media_id: uuid('media_id'),
    presentation_id: uuid('presentation_id'),
    started_at: timestamp('started_at').notNull(),
    ended_at: timestamp('ended_at'),
    storage_object_id: uuid('storage_object_id'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    screenIdIdx: index('proof_of_play_screen_id_idx').on(table.screen_id),
    createdAtIdx: index('proof_of_play_created_at_idx').on(table.created_at),
  })
);

// Screenshots
export const screenshots = pgTable(
  'screenshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    screen_id: uuid('screen_id').notNull(),
    storage_object_id: uuid('storage_object_id').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    screenIdIdx: index('screenshots_screen_id_idx').on(table.screen_id),
  })
);

// Requests (Kanban)
export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    status: requestStatusEnum('status').notNull().default('OPEN'),
    priority: varchar('priority', { length: 20 }).default('MEDIUM'),
    created_by: uuid('created_by').notNull(),
    assigned_to: uuid('assigned_to'),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    createdByIdx: index('requests_created_by_idx').on(table.created_by),
    statusIdx: index('requests_status_idx').on(table.status),
  })
);

// Request status history
export const requestStatusHistory = pgTable(
  'request_status_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    request_id: uuid('request_id').notNull(),
    old_status: requestStatusEnum('old_status'),
    new_status: requestStatusEnum('new_status').notNull(),
    changed_by: uuid('changed_by').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    requestIdIdx: index('request_status_history_request_id_idx').on(table.request_id),
  })
);

// Request messages (chat)
export const requestMessages = pgTable(
  'request_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    request_id: uuid('request_id').notNull(),
    author_id: uuid('author_id').notNull(),
    content: text('content').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    requestIdIdx: index('request_messages_request_id_idx').on(table.request_id),
  })
);

// Request attachments
export const requestAttachments = pgTable(
  'request_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    request_id: uuid('request_id').notNull(),
    message_id: uuid('message_id'),
    storage_object_id: uuid('storage_object_id').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    requestIdIdx: index('request_attachments_request_id_idx').on(table.request_id),
  })
);

// Notifications
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    message: text('message'),
    type: varchar('type', { length: 32 }).notNull().default('INFO'),
    data: jsonb('data'),
    is_read: boolean('is_read').notNull().default(false),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('notifications_user_id_idx').on(table.user_id),
    isReadIdx: index('notifications_is_read_idx').on(table.is_read),
    createdAtIdx: index('notifications_created_at_idx').on(table.created_at),
    userUnreadIdx: index('notifications_user_unread_idx')
      .on(table.user_id)
      .where(sql`${table.is_read} = false`),
  })
);

export const userNotificationCounters = pgTable(
  'user_notification_counters',
  {
    user_id: uuid('user_id').primaryKey().notNull(),
    unread_total: integer('unread_total').notNull().default(0),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  () => ({})
);

// Audit logs
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id'),
    action: varchar('action', { length: 100 }).notNull(),
    entity_type: varchar('entity_type', { length: 100 }).notNull(),
    entity_id: uuid('entity_id'),
    ip_address: varchar('ip_address', { length: 45 }),
    storage_object_id: uuid('storage_object_id'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('audit_logs_user_id_idx').on(table.user_id),
    createdAtIdx: index('audit_logs_created_at_idx').on(table.created_at),
  })
);

// System logs
export const systemLogs = pgTable(
  'system_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    level: varchar('level', { length: 20 }).notNull(),
    message: text('message').notNull(),
    context: jsonb('context'),
    storage_object_id: uuid('storage_object_id'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    levelIdx: index('system_logs_level_idx').on(table.level),
    createdAtIdx: index('system_logs_created_at_idx').on(table.created_at),
  })
);

// Login attempts
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull(),
    success: boolean('success').notNull(),
    ip_address: varchar('ip_address', { length: 45 }),
    storage_object_id: uuid('storage_object_id'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: index('login_attempts_email_idx').on(table.email),
    createdAtIdx: index('login_attempts_created_at_idx').on(table.created_at),
  })
);

// Log archives
export const logArchives = pgTable(
  'log_archives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    log_type: varchar('log_type', { length: 50 }).notNull(),
    window_start: timestamp('window_start').notNull(),
    window_end: timestamp('window_end').notNull(),
    record_count: integer('record_count').notNull(),
    storage_object_id: uuid('storage_object_id').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    logTypeIdx: index('log_archives_log_type_idx').on(table.log_type),
  })
);

// Emergency status
export const emergencyStatus = pgTable('emergency_status', {
  id: uuid('id').primaryKey().defaultRandom(),
  is_active: boolean('is_active').notNull().default(false),
  triggered_by: uuid('triggered_by'),
  triggered_at: timestamp('triggered_at'),
  cleared_by: uuid('cleared_by'),
  cleared_at: timestamp('cleared_at'),
  updated_at: timestamp('updated_at').notNull().defaultNow(),
});

// Emergency types (admin-defined templates)
export const emergencyTypes = pgTable(
  'emergency_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    message: text('message').notNull(),
    severity: varchar('severity', { length: 20 }).notNull().default('HIGH'),
    media_id: uuid('media_id'),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: uniqueIndex('emergency_types_name_idx').on(table.name),
    severityIdx: index('emergency_types_severity_idx').on(table.severity),
  })
);

// Settings
export const settings = pgTable('settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 255 }).notNull().unique(),
  value: jsonb('value'),
  created_at: timestamp('created_at').notNull().defaultNow(),
  updated_at: timestamp('updated_at').notNull().defaultNow(),
});

// API Keys
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    scopes: text('scopes').array(),
    roles: text('roles').array(),
    token_prefix: varchar('token_prefix', { length: 12 }).notNull(),
    secret_hash: varchar('secret_hash', { length: 255 }).notNull(),
    created_by: uuid('created_by').notNull(),
    expires_at: timestamp('expires_at'),
    is_revoked: boolean('is_revoked').notNull().default(false),
    last_used_at: timestamp('last_used_at'),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    prefixIdx: uniqueIndex('api_keys_token_prefix_idx').on(table.token_prefix),
    createdByIdx: index('api_keys_created_by_idx').on(table.created_by),
    expiresAtIdx: index('api_keys_expires_at_idx').on(table.expires_at),
  })
);

// Webhook subscriptions
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    event_types: text('event_types').array().notNull(),
    target_url: varchar('target_url', { length: 2048 }).notNull(),
    secret: varchar('secret', { length: 255 }).notNull(),
    headers: jsonb('headers'),
    is_active: boolean('is_active').notNull().default(true),
    last_status: varchar('last_status', { length: 50 }),
    last_status_at: timestamp('last_status_at'),
    created_by: uuid('created_by').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    createdByIdx: index('webhook_subscriptions_created_by_idx').on(table.created_by),
    activeIdx: index('webhook_subscriptions_is_active_idx').on(table.is_active),
  })
);

// SSO configuration (single active record)
export const ssoConfigs = pgTable(
  'sso_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 50 }).notNull().default('oidc'),
    issuer: varchar('issuer', { length: 255 }).notNull(),
    client_id: varchar('client_id', { length: 255 }).notNull(),
    client_secret: varchar('client_secret', { length: 255 }).notNull(),
    authorization_url: varchar('authorization_url', { length: 512 }),
    token_url: varchar('token_url', { length: 512 }),
    jwks_url: varchar('jwks_url', { length: 512 }),
    redirect_uri: varchar('redirect_uri', { length: 512 }),
    scopes: text('scopes').array(),
    is_active: boolean('is_active').notNull().default(false),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    activeIdx: index('sso_configs_is_active_idx').on(table.is_active),
  })
);

// Conversations (1:1 threads)
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participant_a: uuid('participant_a').notNull(),
    participant_b: uuid('participant_b').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    participantsIdx: uniqueIndex('conversations_participants_idx').on(table.participant_a, table.participant_b),
  })
);

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversation_id: uuid('conversation_id').notNull(),
    author_id: uuid('author_id').notNull(),
    content: text('content').notNull(),
    attachments: jsonb('attachments'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    conversationIdx: index('conversation_messages_conversation_idx').on(table.conversation_id),
    authorIdx: index('conversation_messages_author_idx').on(table.author_id),
  })
);

export const conversationReads = pgTable(
  'conversation_reads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversation_id: uuid('conversation_id').notNull(),
    user_id: uuid('user_id').notNull(),
    last_read_at: timestamp('last_read_at'),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    conversationUserIdx: uniqueIndex('conversation_reads_conversation_user_idx').on(
      table.conversation_id,
      table.user_id
    ),
  })
);

export const chatConversations = pgTable(
  'chat_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: chatConversationTypeEnum('type').notNull(),
    dm_pair_key: varchar('dm_pair_key', { length: 255 }),
    title: varchar('title', { length: 255 }),
    topic: text('topic'),
    purpose: text('purpose'),
    created_by: uuid('created_by').notNull(),
    state: chatConversationStateEnum('state').notNull().default('ACTIVE'),
    invite_policy: chatInvitePolicyEnum('invite_policy').notNull().default('ANY_MEMBER_CAN_INVITE'),
    last_seq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    metadata: jsonb('metadata').notNull().default({}),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
    archived_at: timestamp('archived_at'),
    deleted_at: timestamp('deleted_at'),
  },
  (table) => ({
    // Keep DM pair uniqueness for non-deleted rows; DELETED tombstones may coexist for audit/history.
    dmPairIdx: uniqueIndex('chat_conversations_dm_pair_key_active_idx')
      .on(table.dm_pair_key)
      .where(sql`"type" = 'DM' AND "state" <> 'DELETED'`),
    stateTypeIdx: index('chat_conversations_state_type_idx').on(table.state, table.type),
    updatedAtIdx: index('chat_conversations_updated_at_idx').on(table.updated_at),
  })
);

export const chatMembers = pgTable(
  'chat_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversation_id: uuid('conversation_id').notNull(),
    user_id: uuid('user_id').notNull(),
    role: chatMemberRoleEnum('role').notNull().default('MEMBER'),
    is_system: boolean('is_system').notNull().default(false),
    joined_at: timestamp('joined_at').notNull().defaultNow(),
    left_at: timestamp('left_at'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    conversationUserIdx: uniqueIndex('chat_members_conversation_user_idx').on(table.conversation_id, table.user_id),
    userIdx: index('chat_members_user_idx').on(table.user_id),
    conversationIdx: index('chat_members_conversation_idx').on(table.conversation_id),
  })
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversation_id: uuid('conversation_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    sender_id: uuid('sender_id').notNull(),
    body_text: text('body_text'),
    body_rich: jsonb('body_rich'),
    also_to_channel: boolean('also_to_channel').notNull().default(false),
    reply_to_message_id: uuid('reply_to_message_id'),
    thread_root_id: uuid('thread_root_id'),
    thread_reply_count: integer('thread_reply_count').notNull().default(0),
    created_at: timestamp('created_at').notNull().defaultNow(),
    edited_at: timestamp('edited_at'),
    deleted_at: timestamp('deleted_at'),
  },
  (table) => ({
    conversationSeqUniqueIdx: uniqueIndex('chat_messages_conversation_seq_idx').on(table.conversation_id, table.seq),
    conversationIdx: index('chat_messages_conversation_idx').on(table.conversation_id),
    replyToIdx: index('chat_messages_reply_to_idx').on(table.reply_to_message_id),
    threadRootIdx: index('chat_messages_thread_root_idx').on(table.thread_root_id),
  })
);

export const chatPins = pgTable(
  'chat_pins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversation_id: uuid('conversation_id').notNull(),
    message_id: uuid('message_id').notNull(),
    pinned_by: uuid('pinned_by').notNull(),
    pinned_at: timestamp('pinned_at').notNull().defaultNow(),
  },
  (table) => ({
    conversationMessageIdx: uniqueIndex('chat_pins_conversation_message_idx').on(
      table.conversation_id,
      table.message_id
    ),
    conversationIdx: index('chat_pins_conversation_idx').on(table.conversation_id),
    messageIdx: index('chat_pins_message_idx').on(table.message_id),
  })
);

export const chatAttachments = pgTable(
  'chat_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    message_id: uuid('message_id').notNull(),
    media_asset_id: uuid('media_asset_id').notNull(),
    kind: varchar('kind', { length: 50 }),
    ord: integer('ord').notNull().default(0),
    metadata: jsonb('metadata'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    messageMediaIdx: uniqueIndex('chat_attachments_message_media_idx').on(table.message_id, table.media_asset_id),
    mediaIdx: index('chat_attachments_media_idx').on(table.media_asset_id),
    messageIdx: index('chat_attachments_message_idx').on(table.message_id),
  })
);

export const chatBookmarks = pgTable(
  'chat_bookmarks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversation_id: uuid('conversation_id').notNull(),
    type: chatBookmarkTypeEnum('type').notNull(),
    label: varchar('label', { length: 255 }).notNull(),
    emoji: varchar('emoji', { length: 32 }),
    url: text('url'),
    media_asset_id: uuid('media_asset_id'),
    message_id: uuid('message_id'),
    created_by: uuid('created_by').notNull(),
    metadata: jsonb('metadata'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    conversationIdx: index('chat_bookmarks_conversation_idx').on(table.conversation_id),
    messageIdx: index('chat_bookmarks_message_idx').on(table.message_id),
    mediaIdx: index('chat_bookmarks_media_idx').on(table.media_asset_id),
    creatorIdx: index('chat_bookmarks_created_by_idx').on(table.created_by),
  })
);

export const chatReactions = pgTable(
  'chat_reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    message_id: uuid('message_id').notNull(),
    user_id: uuid('user_id').notNull(),
    emoji: varchar('emoji', { length: 64 }).notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    messageUserEmojiIdx: uniqueIndex('chat_reactions_message_user_emoji_idx').on(
      table.message_id,
      table.user_id,
      table.emoji
    ),
    messageIdx: index('chat_reactions_message_idx').on(table.message_id),
  })
);

export const chatReceipts = pgTable(
  'chat_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversation_id: uuid('conversation_id').notNull(),
    user_id: uuid('user_id').notNull(),
    last_read_seq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
    last_delivered_seq: bigint('last_delivered_seq', { mode: 'number' }).notNull().default(0),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    conversationUserIdx: uniqueIndex('chat_receipts_conversation_user_idx').on(table.conversation_id, table.user_id),
    userIdx: index('chat_receipts_user_idx').on(table.user_id),
  })
);

export const chatModeration = pgTable(
  'chat_moderation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversation_id: uuid('conversation_id').notNull(),
    user_id: uuid('user_id').notNull(),
    muted_until: timestamp('muted_until'),
    banned_until: timestamp('banned_until'),
    reason: text('reason'),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    conversationUserIdx: uniqueIndex('chat_moderation_conversation_user_idx').on(table.conversation_id, table.user_id),
    userIdx: index('chat_moderation_user_idx').on(table.user_id),
  })
);

export const chatMessageRevisions = pgTable(
  'chat_message_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    message_id: uuid('message_id').notNull(),
    editor_id: uuid('editor_id').notNull(),
    action: chatRevisionActionEnum('action').notNull(),
    old_body_text: text('old_body_text'),
    old_body_rich: jsonb('old_body_rich'),
    new_body_text: text('new_body_text'),
    new_body_rich: jsonb('new_body_rich'),
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    messageIdx: index('chat_message_revisions_message_idx').on(table.message_id, table.created_at),
    editorIdx: index('chat_message_revisions_editor_idx').on(table.editor_id, table.created_at),
  })
);

// Publish targets for schedule publishes
export const publishTargets = pgTable(
  'publish_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publish_id: uuid('publish_id').notNull(),
    screen_id: uuid('screen_id'),
    screen_group_id: uuid('screen_group_id'),
    status: varchar('status', { length: 50 }).notNull().default('PENDING'),
    error: text('error'),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    publishIdx: index('publish_targets_publish_id_idx').on(table.publish_id),
    screenIdx: index('publish_targets_screen_id_idx').on(table.screen_id),
  })
);

// Device pairings (for backward compatibility with repositories)
export const devicePairings = pgTable('device_pairings', {
  id: uuid('id').primaryKey().defaultRandom(),
  device_id: uuid('device_id'),
  pairing_code: varchar('pairing_code', { length: 255 }).notNull(),
  used: boolean('used').notNull().default(false),
  used_at: timestamp('used_at'),
  expires_at: timestamp('expires_at').notNull(),
  width: integer('width'),
  height: integer('height'),
  aspect_ratio: varchar('aspect_ratio', { length: 50 }),
  orientation: varchar('orientation', { length: 50 }),
  model: varchar('model', { length: 255 }),
  codecs: varchar('codecs', { length: 255 }).array(),
  device_info: jsonb('device_info'),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

// Emergencies (for backward compatibility with repositories)
export const emergencies = pgTable('emergencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  emergency_type_id: uuid('emergency_type_id'),
  message: text('message').notNull(),
  priority: varchar('priority', { length: 20 }).notNull().default('HIGH'),
  media_id: uuid('media_id'),
  screen_ids: jsonb('screen_ids').$type<string[]>().notNull().default([] as string[]),
  screen_group_ids: jsonb('screen_group_ids').$type<string[]>().notNull().default([] as string[]),
  target_all: boolean('target_all').notNull().default(false),
  expires_at: timestamp('expires_at'),
  audit_note: text('audit_note'),
  is_active: boolean('is_active').notNull().default(true),
  triggered_by: uuid('triggered_by'),
  triggered_at: timestamp('triggered_at').notNull().defaultNow(),
  cleared_by: uuid('cleared_by'),
  cleared_at: timestamp('cleared_at'),
  clear_reason: text('clear_reason'),
  created_at: timestamp('created_at').notNull().defaultNow(),
  updated_at: timestamp('updated_at').notNull().defaultNow(),
});
