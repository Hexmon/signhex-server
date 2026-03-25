ALTER TABLE "layouts"
ADD COLUMN IF NOT EXISTS "created_by" uuid;

CREATE INDEX IF NOT EXISTS "layouts_created_by_idx" ON "layouts" ("created_by");
