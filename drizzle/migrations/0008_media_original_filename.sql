ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "original_filename" varchar(512);
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "sanitized_hint" varchar(80);
UPDATE "media" SET "original_filename" = "name" WHERE "original_filename" IS NULL;
ALTER TABLE "media" ALTER COLUMN "original_filename" SET NOT NULL;
