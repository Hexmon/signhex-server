DROP INDEX IF EXISTS "chat_conversations_dm_pair_key_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_conversations_dm_pair_key_active_idx"
ON "chat_conversations" ("dm_pair_key")
WHERE "type" = 'DM' AND "state" <> 'DELETED';

