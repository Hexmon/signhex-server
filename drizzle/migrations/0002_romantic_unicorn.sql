CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"scopes" text[],
	"roles" text[],
	"token_prefix" varchar(12) NOT NULL,
	"secret_hash" varchar(255) NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"content" text NOT NULL,
	"attachments" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_a" uuid NOT NULL,
	"participant_b" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "publish_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publish_id" uuid NOT NULL,
	"screen_id" uuid,
	"screen_group_id" uuid,
	"status" varchar(50) DEFAULT 'PENDING' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sso_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) DEFAULT 'oidc' NOT NULL,
	"issuer" varchar(255) NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"client_secret" varchar(255) NOT NULL,
	"authorization_url" varchar(512),
	"token_url" varchar(512),
	"jwks_url" varchar(512),
	"redirect_uri" varchar(512),
	"scopes" text[],
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255)[] NOT NULL,
	"event_types" text NOT NULL,
	"target_url" varchar(2048) NOT NULL,
	"secret" varchar(255) NOT NULL,
	"headers" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_status" varchar(50),
	"last_status_at" timestamp,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "source_bucket" varchar(255);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "source_object_key" varchar(1024);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "source_content_type" varchar(255);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "source_size" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "priority" varchar(20) DEFAULT 'MEDIUM';--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "start_at" timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "end_at" timestamp NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_token_prefix_idx" ON "api_keys" ("token_prefix");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_created_by_idx" ON "api_keys" ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_expires_at_idx" ON "api_keys" ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_messages_conversation_idx" ON "conversation_messages" ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_messages_author_idx" ON "conversation_messages" ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_reads_conversation_user_idx" ON "conversation_reads" ("conversation_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_participants_idx" ON "conversations" ("participant_a","participant_b");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_targets_publish_id_idx" ON "publish_targets" ("publish_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_targets_screen_id_idx" ON "publish_targets" ("screen_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sso_configs_is_active_idx" ON "sso_configs" ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_subscriptions_created_by_idx" ON "webhook_subscriptions" ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_subscriptions_is_active_idx" ON "webhook_subscriptions" ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_start_at_idx" ON "schedules" ("start_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_end_at_idx" ON "schedules" ("end_at");