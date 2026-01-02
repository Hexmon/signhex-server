DO $$ BEGIN
 CREATE TYPE "schedule_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "schedule_items" ADD COLUMN IF NOT EXISTS "screen_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "schedule_items" ADD COLUMN IF NOT EXISTS "screen_group_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedule_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "schedule_id" uuid NOT NULL,
  "schedule_payload" jsonb NOT NULL,
  "status" "schedule_request_status" DEFAULT 'PENDING' NOT NULL,
  "requested_by" uuid NOT NULL,
  "reviewed_by" uuid,
  "reviewed_at" timestamp,
  "review_notes" text,
  "notes" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_requests_schedule_id_idx" ON "schedule_requests" ("schedule_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_requests_requested_by_idx" ON "schedule_requests" ("requested_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_requests_status_idx" ON "schedule_requests" ("status");
