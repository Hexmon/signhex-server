ALTER TABLE "device_certificates"
ADD COLUMN IF NOT EXISTS "expires_at" timestamp;

UPDATE "device_certificates"
SET "expires_at" = COALESCE("expires_at", "created_at" + interval '365 days', now() + interval '365 days')
WHERE "expires_at" IS NULL;

ALTER TABLE "device_certificates"
ALTER COLUMN "expires_at" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "device_certificates_expires_at_idx"
ON "device_certificates" ("expires_at");
