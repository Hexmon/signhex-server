-- Cleanup potential orphan rows before adding FK constraints.
DELETE FROM "chat_attachments" ca
WHERE NOT EXISTS (SELECT 1 FROM "chat_messages" cm WHERE cm.id = ca.message_id)
   OR NOT EXISTS (SELECT 1 FROM "media" m WHERE m.id = ca.media_asset_id);
--> statement-breakpoint

DELETE FROM "chat_reactions" cr
WHERE NOT EXISTS (SELECT 1 FROM "chat_messages" cm WHERE cm.id = cr.message_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cr.user_id);
--> statement-breakpoint

DELETE FROM "chat_receipts" cr
WHERE NOT EXISTS (SELECT 1 FROM "chat_conversations" cc WHERE cc.id = cr.conversation_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cr.user_id);
--> statement-breakpoint

DELETE FROM "chat_moderation" cm
WHERE NOT EXISTS (SELECT 1 FROM "chat_conversations" cc WHERE cc.id = cm.conversation_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cm.user_id);
--> statement-breakpoint

DELETE FROM "chat_message_revisions" cmr
WHERE NOT EXISTS (SELECT 1 FROM "chat_messages" cm WHERE cm.id = cmr.message_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cmr.editor_id);
--> statement-breakpoint

DELETE FROM "chat_members" cm
WHERE NOT EXISTS (SELECT 1 FROM "chat_conversations" cc WHERE cc.id = cm.conversation_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cm.user_id);
--> statement-breakpoint

UPDATE "chat_messages" cm
SET "reply_to_message_id" = NULL
WHERE cm.reply_to_message_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "chat_messages" p WHERE p.id = cm.reply_to_message_id);
--> statement-breakpoint

UPDATE "chat_messages" cm
SET "thread_root_id" = NULL
WHERE cm.thread_root_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "chat_messages" p WHERE p.id = cm.thread_root_id);
--> statement-breakpoint

DELETE FROM "chat_messages" cm
WHERE NOT EXISTS (SELECT 1 FROM "chat_conversations" cc WHERE cc.id = cm.conversation_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cm.sender_id);
--> statement-breakpoint

DELETE FROM "chat_conversations" cc
WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cc.created_by);
--> statement-breakpoint

-- Re-run cleanup after conversation pruning to ensure no residual children remain.
DELETE FROM "chat_messages" cm
WHERE NOT EXISTS (SELECT 1 FROM "chat_conversations" cc WHERE cc.id = cm.conversation_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cm.sender_id);
--> statement-breakpoint

DELETE FROM "chat_members" cm
WHERE NOT EXISTS (SELECT 1 FROM "chat_conversations" cc WHERE cc.id = cm.conversation_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cm.user_id);
--> statement-breakpoint

DELETE FROM "chat_receipts" cr
WHERE NOT EXISTS (SELECT 1 FROM "chat_conversations" cc WHERE cc.id = cr.conversation_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cr.user_id);
--> statement-breakpoint

DELETE FROM "chat_moderation" cm
WHERE NOT EXISTS (SELECT 1 FROM "chat_conversations" cc WHERE cc.id = cm.conversation_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cm.user_id);
--> statement-breakpoint

DELETE FROM "chat_attachments" ca
WHERE NOT EXISTS (SELECT 1 FROM "chat_messages" cm WHERE cm.id = ca.message_id)
   OR NOT EXISTS (SELECT 1 FROM "media" m WHERE m.id = ca.media_asset_id);
--> statement-breakpoint

DELETE FROM "chat_reactions" cr
WHERE NOT EXISTS (SELECT 1 FROM "chat_messages" cm WHERE cm.id = cr.message_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cr.user_id);
--> statement-breakpoint

DELETE FROM "chat_message_revisions" cmr
WHERE NOT EXISTS (SELECT 1 FROM "chat_messages" cm WHERE cm.id = cmr.message_id)
   OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = cmr.editor_id);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_conversations"
  ADD CONSTRAINT "chat_conversations_created_by_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_members"
  ADD CONSTRAINT "chat_members_conversation_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_members"
  ADD CONSTRAINT "chat_members_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_conversation_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_sender_fk"
  FOREIGN KEY ("sender_id") REFERENCES "users"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_reply_to_fk"
  FOREIGN KEY ("reply_to_message_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_thread_root_fk"
  FOREIGN KEY ("thread_root_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_attachments"
  ADD CONSTRAINT "chat_attachments_message_fk"
  FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_attachments"
  ADD CONSTRAINT "chat_attachments_media_fk"
  FOREIGN KEY ("media_asset_id") REFERENCES "media"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_reactions"
  ADD CONSTRAINT "chat_reactions_message_fk"
  FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_reactions"
  ADD CONSTRAINT "chat_reactions_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_receipts"
  ADD CONSTRAINT "chat_receipts_conversation_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_receipts"
  ADD CONSTRAINT "chat_receipts_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_moderation"
  ADD CONSTRAINT "chat_moderation_conversation_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_moderation"
  ADD CONSTRAINT "chat_moderation_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_message_revisions"
  ADD CONSTRAINT "chat_message_revisions_message_fk"
  FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chat_message_revisions"
  ADD CONSTRAINT "chat_message_revisions_editor_fk"
  FOREIGN KEY ("editor_id") REFERENCES "users"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
