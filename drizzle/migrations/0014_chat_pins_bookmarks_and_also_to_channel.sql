DO $$ BEGIN
 CREATE TYPE "chat_bookmark_type" AS ENUM('LINK', 'FILE', 'MESSAGE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

ALTER TABLE "chat_messages"
ADD COLUMN IF NOT EXISTS "also_to_channel" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "chat_pins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "pinned_by" uuid NOT NULL,
  "pinned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "chat_pins_conversation_message_idx"
ON "chat_pins" ("conversation_id","message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_pins_conversation_idx" ON "chat_pins" ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_pins_message_idx" ON "chat_pins" ("message_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "chat_bookmarks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "type" "chat_bookmark_type" NOT NULL,
  "label" varchar(255) NOT NULL,
  "emoji" varchar(32),
  "url" text,
  "media_asset_id" uuid,
  "message_id" uuid,
  "created_by" uuid NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "chat_bookmarks_conversation_idx" ON "chat_bookmarks" ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_bookmarks_message_idx" ON "chat_bookmarks" ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_bookmarks_media_idx" ON "chat_bookmarks" ("media_asset_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_bookmarks_created_by_idx" ON "chat_bookmarks" ("created_by");
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_pins"
  ADD CONSTRAINT "chat_pins_conversation_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_pins"
  ADD CONSTRAINT "chat_pins_message_fk"
  FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_pins"
  ADD CONSTRAINT "chat_pins_pinned_by_fk"
  FOREIGN KEY ("pinned_by") REFERENCES "users"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_bookmarks"
  ADD CONSTRAINT "chat_bookmarks_conversation_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_bookmarks"
  ADD CONSTRAINT "chat_bookmarks_message_fk"
  FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_bookmarks"
  ADD CONSTRAINT "chat_bookmarks_media_fk"
  FOREIGN KEY ("media_asset_id") REFERENCES "media"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_bookmarks"
  ADD CONSTRAINT "chat_bookmarks_created_by_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
