ALTER TABLE "screens"
  ADD COLUMN "current_scene_id" text,
  ADD COLUMN "active_slots" jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX "screens_current_scene_idx" ON "screens" ("current_scene_id");

ALTER TABLE "device_commands"
  ADD COLUMN "delivery_token" uuid,
  ADD COLUMN "claimed_at" timestamp,
  ADD COLUMN "acknowledged_at" timestamp,
  ADD COLUMN "delivery_attempts" integer NOT NULL DEFAULT 0;

CREATE INDEX "device_commands_delivery_token_idx" ON "device_commands" ("delivery_token");
CREATE INDEX "device_commands_claim_state_idx" ON "device_commands" ("screen_id", "status", "claimed_at");

ALTER TABLE "proof_of_play"
  ADD COLUMN "schedule_id" uuid,
  ADD COLUMN "scene_id" text,
  ADD COLUMN "slot_id" varchar(255),
  ADD COLUMN "item_id" text,
  ADD COLUMN "playback_instance_id" uuid;

UPDATE "proof_of_play"
SET "schedule_id" = "presentation_id"
WHERE "schedule_id" IS NULL AND "presentation_id" IS NOT NULL;

CREATE INDEX "proof_of_play_playback_instance_idx" ON "proof_of_play" ("playback_instance_id");
CREATE INDEX "proof_of_play_schedule_id_idx" ON "proof_of_play" ("schedule_id");
