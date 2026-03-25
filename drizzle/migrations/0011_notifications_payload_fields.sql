ALTER TABLE "notifications"
ADD COLUMN IF NOT EXISTS "type" varchar(32) NOT NULL DEFAULT 'INFO';
--> statement-breakpoint
ALTER TABLE "notifications"
ADD COLUMN IF NOT EXISTS "data" jsonb;
