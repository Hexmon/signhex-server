CREATE TABLE IF NOT EXISTS "user_notification_counters" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "unread_total" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "user_notification_counters"
  ADD CONSTRAINT "user_notification_counters_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "notifications_user_unread_idx"
ON "notifications" ("user_id")
WHERE "is_read" = false;
