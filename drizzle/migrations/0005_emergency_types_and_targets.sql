CREATE TABLE IF NOT EXISTS "emergency_types" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(255) NOT NULL,
  "description" text,
  "message" text NOT NULL,
  "severity" varchar(20) NOT NULL DEFAULT 'HIGH',
  "media_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "emergency_types_name_idx" ON "emergency_types" ("name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emergency_types_severity_idx" ON "emergency_types" ("severity");
--> statement-breakpoint
ALTER TABLE "emergencies" ADD COLUMN IF NOT EXISTS "emergency_type_id" uuid;
--> statement-breakpoint
ALTER TABLE "emergencies" ADD COLUMN IF NOT EXISTS "media_id" uuid;
--> statement-breakpoint
ALTER TABLE "emergencies" ADD COLUMN IF NOT EXISTS "screen_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "emergencies" ADD COLUMN IF NOT EXISTS "screen_group_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "emergencies" ADD COLUMN IF NOT EXISTS "target_all" boolean NOT NULL DEFAULT false;
