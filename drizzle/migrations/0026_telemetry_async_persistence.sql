ALTER TABLE "proof_of_play"
ADD COLUMN "idempotency_key" varchar(64);

UPDATE "proof_of_play"
SET "idempotency_key" = md5(
  concat_ws(
    '|',
    coalesce("screen_id"::text, ''),
    coalesce("media_id"::text, ''),
    coalesce("presentation_id"::text, ''),
    coalesce("started_at"::text, ''),
    coalesce("ended_at"::text, ''),
    coalesce("created_at"::text, '')
  )
)
WHERE "idempotency_key" IS NULL;

ALTER TABLE "proof_of_play"
ALTER COLUMN "idempotency_key" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "heartbeats_storage_object_id_idx" ON "heartbeats" ("storage_object_id");
CREATE UNIQUE INDEX IF NOT EXISTS "proof_of_play_idempotency_key_idx" ON "proof_of_play" ("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "screenshots_storage_object_id_idx" ON "screenshots" ("storage_object_id");
