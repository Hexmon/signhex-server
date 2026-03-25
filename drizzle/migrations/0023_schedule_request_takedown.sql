ALTER TYPE "schedule_request_status" ADD VALUE IF NOT EXISTS 'TAKEN_DOWN';

ALTER TABLE "schedule_requests"
  ADD COLUMN IF NOT EXISTS "taken_down_at" timestamp,
  ADD COLUMN IF NOT EXISTS "taken_down_by" uuid,
  ADD COLUMN IF NOT EXISTS "takedown_reason" text;
