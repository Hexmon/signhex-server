CREATE TABLE IF NOT EXISTS "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_type" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"triggered_by" uuid,
	"started_at" timestamp,
	"completed_at" timestamp,
	"error_message" text,
	"files" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_runs_status_idx" ON "backup_runs" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_runs_created_at_idx" ON "backup_runs" ("created_at");
