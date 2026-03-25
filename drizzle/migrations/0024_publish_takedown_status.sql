DO $$
BEGIN
  CREATE TYPE "publish_status" AS ENUM ('ACTIVE', 'TAKEN_DOWN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "publishes"
  ADD COLUMN IF NOT EXISTS "status" "publish_status",
  ADD COLUMN IF NOT EXISTS "taken_down_at" timestamp,
  ADD COLUMN IF NOT EXISTS "taken_down_by" uuid,
  ADD COLUMN IF NOT EXISTS "takedown_reason" text;

UPDATE "publishes"
SET "status" = 'ACTIVE'
WHERE "status" IS NULL;

ALTER TABLE "publishes"
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE',
  ALTER COLUMN "status" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "publishes_status_idx" ON "publishes" ("status");
