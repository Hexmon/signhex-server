UPDATE "device_pairings"
SET
  "used" = true,
  "used_at" = COALESCE("used_at", "expires_at", "created_at", NOW())
WHERE "used" = false
  AND "expires_at" <= NOW();

CREATE UNIQUE INDEX IF NOT EXISTS "device_pairings_active_code_idx"
ON "device_pairings" ("pairing_code")
WHERE "used" = false;
