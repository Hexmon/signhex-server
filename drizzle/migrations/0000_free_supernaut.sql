DO $$ BEGIN
 CREATE TYPE "command_status" AS ENUM('PENDING', 'SENT', 'ACKNOWLEDGED', 'COMPLETED', 'FAILED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "command_type" AS ENUM('REBOOT', 'REFRESH', 'TEST_PATTERN');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "media_status" AS ENUM('PENDING', 'PROCESSING', 'READY', 'FAILED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "media_type" AS ENUM('IMAGE', 'VIDEO', 'DOCUMENT');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "request_status" AS ENUM('OPEN', 'IN_PROGRESS', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'COMPLETED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "role" AS ENUM('ADMIN', 'OPERATOR', 'DEPARTMENT');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "screen_status" AS ENUM('ACTIVE', 'INACTIVE', 'OFFLINE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(100) NOT NULL,
	"entity_id" uuid,
	"ip_address" varchar(45),
	"storage_object_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"screen_id" uuid NOT NULL,
	"serial" varchar(255) NOT NULL,
	"certificate_pem" text NOT NULL,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "device_certificates_serial_unique" UNIQUE("serial")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"screen_id" uuid NOT NULL,
	"type" "command_type" NOT NULL,
	"status" "command_status" DEFAULT 'PENDING' NOT NULL,
	"payload" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "emergency_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"triggered_by" uuid,
	"triggered_at" timestamp,
	"cleared_by" uuid,
	"cleared_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"screen_id" uuid NOT NULL,
	"storage_object_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "log_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"log_type" varchar(50) NOT NULL,
	"window_start" timestamp NOT NULL,
	"window_end" timestamp NOT NULL,
	"record_count" integer NOT NULL,
	"storage_object_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"success" boolean NOT NULL,
	"ip_address" varchar(45),
	"storage_object_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "media_type" NOT NULL,
	"status" "media_status" DEFAULT 'PENDING' NOT NULL,
	"source_object_id" uuid,
	"ready_object_id" uuid,
	"thumbnail_object_id" uuid,
	"duration_seconds" integer,
	"width" integer,
	"height" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "presentation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"presentation_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"order" integer NOT NULL,
	"duration_seconds" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "presentations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proof_of_play" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"screen_id" uuid NOT NULL,
	"media_id" uuid,
	"presentation_id" uuid,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"storage_object_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "publishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"published_by" uuid NOT NULL,
	"published_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"message_id" uuid,
	"storage_object_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"old_status" "request_status",
	"new_status" "request_status" NOT NULL,
	"changed_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"status" "request_status" DEFAULT 'OPEN' NOT NULL,
	"created_by" uuid NOT NULL,
	"assigned_to" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedule_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"start_at" timestamp NOT NULL,
	"end_at" timestamp NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedule_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"storage_object_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "screen_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"screen_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "screen_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "screens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"location" varchar(255),
	"status" "screen_status" DEFAULT 'OFFLINE' NOT NULL,
	"last_heartbeat_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "screenshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"screen_id" uuid NOT NULL,
	"storage_object_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"access_jti" varchar(255) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" varchar(255) NOT NULL,
	"object_key" varchar(1024) NOT NULL,
	"content_type" varchar(100),
	"size" integer,
	"sha256" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level" varchar(20) NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"storage_object_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"role" "role" DEFAULT 'OPERATOR' NOT NULL,
	"department_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"ext" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_user_id_idx" ON "audit_logs" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_certificates_screen_id_idx" ON "device_certificates" ("screen_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_certificates_serial_idx" ON "device_certificates" ("serial");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_commands_screen_id_idx" ON "device_commands" ("screen_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_commands_status_idx" ON "device_commands" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeats_screen_id_idx" ON "heartbeats" ("screen_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeats_created_at_idx" ON "heartbeats" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_archives_log_type_idx" ON "log_archives" ("log_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_email_idx" ON "login_attempts" ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_created_at_idx" ON "login_attempts" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_created_by_idx" ON "media" ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_status_idx" ON "media" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_id_idx" ON "notifications" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_is_read_idx" ON "notifications" ("is_read");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_created_at_idx" ON "notifications" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "presentation_items_presentation_id_idx" ON "presentation_items" ("presentation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "presentations_created_by_idx" ON "presentations" ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proof_of_play_screen_id_idx" ON "proof_of_play" ("screen_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proof_of_play_created_at_idx" ON "proof_of_play" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publishes_schedule_id_idx" ON "publishes" ("schedule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_attachments_request_id_idx" ON "request_attachments" ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_messages_request_id_idx" ON "request_messages" ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_status_history_request_id_idx" ON "request_status_history" ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requests_created_by_idx" ON "requests" ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requests_status_idx" ON "requests" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_items_schedule_id_idx" ON "schedule_items" ("schedule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_items_start_at_idx" ON "schedule_items" ("start_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_snapshots_schedule_id_idx" ON "schedule_snapshots" ("schedule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_created_by_idx" ON "schedules" ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_is_active_idx" ON "schedules" ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screen_group_members_group_id_idx" ON "screen_group_members" ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screens_status_idx" ON "screens" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screenshots_screen_id_idx" ON "screenshots" ("screen_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_access_jti_idx" ON "sessions" ("access_jti");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storage_objects_bucket_key_idx" ON "storage_objects" ("bucket","object_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "system_logs_level_idx" ON "system_logs" ("level");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "system_logs_created_at_idx" ON "system_logs" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" ("email");