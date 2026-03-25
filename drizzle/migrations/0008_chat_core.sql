DO $$ BEGIN
 CREATE TYPE "chat_conversation_type" AS ENUM('DM', 'GROUP_CLOSED', 'FORUM_OPEN');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "chat_conversation_state" AS ENUM('ACTIVE', 'ARCHIVED', 'DELETED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "chat_invite_policy" AS ENUM('ANY_MEMBER_CAN_INVITE', 'ADMINS_ONLY_CAN_INVITE', 'INVITES_DISABLED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "chat_member_role" AS ENUM('OWNER', 'CHAT_ADMIN', 'MOD', 'MEMBER');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "chat_conversation_type" NOT NULL,
	"dm_pair_key" varchar(255),
	"title" varchar(255),
	"topic" text,
	"purpose" text,
	"created_by" uuid NOT NULL,
	"state" "chat_conversation_state" DEFAULT 'ACTIVE' NOT NULL,
	"invite_policy" "chat_invite_policy" DEFAULT 'ANY_MEMBER_CAN_INVITE' NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "chat_member_role" DEFAULT 'MEMBER' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"sender_id" uuid NOT NULL,
	"body_text" text,
	"body_rich" jsonb,
	"reply_to_message_id" uuid,
	"thread_root_id" uuid,
	"thread_reply_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"edited_at" timestamp,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"kind" varchar(50),
	"ord" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"last_delivered_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_moderation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"muted_until" timestamp,
	"banned_until" timestamp,
	"reason" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_conversations_dm_pair_key_idx" ON "chat_conversations" ("dm_pair_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_conversations_state_type_idx" ON "chat_conversations" ("state","type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_conversations_updated_at_idx" ON "chat_conversations" ("updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_members_conversation_user_idx" ON "chat_members" ("conversation_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_members_user_idx" ON "chat_members" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_members_conversation_idx" ON "chat_members" ("conversation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_messages_conversation_seq_idx" ON "chat_messages" ("conversation_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_conversation_idx" ON "chat_messages" ("conversation_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_reply_to_idx" ON "chat_messages" ("reply_to_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_thread_root_idx" ON "chat_messages" ("thread_root_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_state_filter_idx" ON "chat_messages" ("conversation_id","deleted_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_attachments_message_media_idx" ON "chat_attachments" ("message_id","media_asset_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_attachments_media_idx" ON "chat_attachments" ("media_asset_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_attachments_message_idx" ON "chat_attachments" ("message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_reactions_message_user_emoji_idx" ON "chat_reactions" ("message_id","user_id","emoji");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_reactions_message_idx" ON "chat_reactions" ("message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_receipts_conversation_user_idx" ON "chat_receipts" ("conversation_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_receipts_user_idx" ON "chat_receipts" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_moderation_conversation_user_idx" ON "chat_moderation" ("conversation_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_moderation_user_idx" ON "chat_moderation" ("user_id");
