DO $$ BEGIN
 CREATE TYPE "chat_revision_action" AS ENUM('EDIT', 'DELETE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "chat_message_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" uuid NOT NULL,
  "editor_id" uuid NOT NULL,
  "action" "chat_revision_action" NOT NULL,
  "old_body_text" text,
  "old_body_rich" jsonb,
  "new_body_text" text,
  "new_body_rich" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "chat_message_revisions_message_idx" ON "chat_message_revisions" ("message_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_revisions_editor_idx" ON "chat_message_revisions" ("editor_id","created_at");
