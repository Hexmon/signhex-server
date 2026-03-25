ALTER TABLE "presentation_slot_items"
ADD COLUMN IF NOT EXISTS "loop_enabled" boolean DEFAULT false;

UPDATE "presentation_slot_items"
SET "loop_enabled" = false
WHERE "loop_enabled" IS NULL;
