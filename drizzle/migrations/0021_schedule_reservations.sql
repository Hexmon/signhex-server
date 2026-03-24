CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  ALTER TYPE "schedule_request_status" ADD VALUE IF NOT EXISTS 'CANCELLED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE "schedule_request_status" ADD VALUE IF NOT EXISTS 'PUBLISHED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE "schedule_request_status" ADD VALUE IF NOT EXISTS 'EXPIRED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "schedule_reservation_state" AS ENUM (
    'HELD',
    'RESERVED',
    'PUBLISHED',
    'RELEASED',
    'EXPIRED',
    'CANCELLED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "schedules"
  ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1;

ALTER TABLE "schedule_requests"
  ADD COLUMN IF NOT EXISTS "reservation_token" uuid,
  ADD COLUMN IF NOT EXISTS "reservation_version" integer,
  ADD COLUMN IF NOT EXISTS "reservation_state" varchar(50),
  ADD COLUMN IF NOT EXISTS "hold_expires_at" timestamp,
  ADD COLUMN IF NOT EXISTS "published_at" timestamp;

CREATE TABLE IF NOT EXISTS "schedule_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "screen_id" uuid NOT NULL,
  "schedule_id" uuid NOT NULL,
  "schedule_item_id" uuid NOT NULL,
  "schedule_request_id" uuid,
  "owner_user_id" uuid NOT NULL,
  "state" "schedule_reservation_state" NOT NULL,
  "start_at" timestamp NOT NULL,
  "end_at" timestamp NOT NULL,
  "hold_expires_at" timestamp,
  "reservation_token" uuid NOT NULL,
  "reservation_version" integer NOT NULL DEFAULT 1,
  "publish_id" uuid,
  "approved_at" timestamp,
  "published_at" timestamp,
  "released_at" timestamp,
  "release_reason" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "schedule_requests_reservation_state_idx"
  ON "schedule_requests" ("reservation_state");

CREATE INDEX IF NOT EXISTS "schedule_reservations_screen_window_idx"
  ON "schedule_reservations" ("screen_id", "start_at", "end_at");

CREATE INDEX IF NOT EXISTS "schedule_reservations_request_idx"
  ON "schedule_reservations" ("schedule_request_id");

CREATE INDEX IF NOT EXISTS "schedule_reservations_schedule_idx"
  ON "schedule_reservations" ("schedule_id");

CREATE INDEX IF NOT EXISTS "schedule_reservations_publish_idx"
  ON "schedule_reservations" ("publish_id");

CREATE INDEX IF NOT EXISTS "schedule_reservations_state_expiry_idx"
  ON "schedule_reservations" ("state", "hold_expires_at");

DO $$
BEGIN
  ALTER TABLE "schedule_reservations"
    ADD CONSTRAINT "schedule_reservations_active_overlap_excl"
    EXCLUDE USING gist (
      "screen_id" WITH =,
      tsrange("start_at", "end_at", '[)') WITH &&
    )
    WHERE ("state" IN ('HELD', 'RESERVED', 'PUBLISHED'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
