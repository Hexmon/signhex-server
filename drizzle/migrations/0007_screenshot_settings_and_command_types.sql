ALTER TYPE "command_type" ADD VALUE IF NOT EXISTS 'TAKE_SCREENSHOT';
--> statement-breakpoint
ALTER TYPE "command_type" ADD VALUE IF NOT EXISTS 'SET_SCREENSHOT_INTERVAL';
--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN IF NOT EXISTS "screenshot_interval_seconds" integer;
--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN IF NOT EXISTS "screenshot_enabled" boolean NOT NULL DEFAULT false;
