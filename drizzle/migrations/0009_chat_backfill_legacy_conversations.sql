INSERT INTO "chat_conversations" (
  "id",
  "type",
  "dm_pair_key",
  "created_by",
  "state",
  "invite_policy",
  "last_seq",
  "metadata",
  "created_at",
  "updated_at"
)
SELECT
  c.id,
  'DM'::chat_conversation_type,
  CASE
    WHEN c.participant_a < c.participant_b THEN c.participant_a || ':' || c.participant_b
    ELSE c.participant_b || ':' || c.participant_a
  END,
  c.participant_a,
  'ACTIVE'::chat_conversation_state,
  'INVITES_DISABLED'::chat_invite_policy,
  0,
  '{}'::jsonb,
  c.created_at,
  c.updated_at
FROM conversations c
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "chat_members" ("conversation_id", "user_id", "role", "is_system", "joined_at", "created_at")
SELECT c.id, c.participant_a, 'MEMBER'::chat_member_role, false, c.created_at, c.created_at
FROM conversations c
ON CONFLICT ("conversation_id","user_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "chat_members" ("conversation_id", "user_id", "role", "is_system", "joined_at", "created_at")
SELECT c.id, c.participant_b, 'MEMBER'::chat_member_role, false, c.created_at, c.created_at
FROM conversations c
ON CONFLICT ("conversation_id","user_id") DO NOTHING;
--> statement-breakpoint

WITH ranked AS (
  SELECT
    cm.id AS legacy_message_id,
    cm.conversation_id,
    cm.author_id,
    cm.content,
    cm.created_at,
    ROW_NUMBER() OVER (
      PARTITION BY cm.conversation_id
      ORDER BY cm.created_at ASC, cm.id ASC
    ) AS seq
  FROM conversation_messages cm
)
INSERT INTO "chat_messages" (
  "id",
  "conversation_id",
  "seq",
  "sender_id",
  "body_text",
  "body_rich",
  "created_at"
)
SELECT
  r.legacy_message_id,
  r.conversation_id,
  r.seq,
  r.author_id,
  r.content,
  NULL,
  r.created_at
FROM ranked r
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

UPDATE chat_conversations cc
SET last_seq = COALESCE(s.max_seq, 0),
    updated_at = GREATEST(cc.updated_at, COALESCE(s.max_created_at, cc.updated_at))
FROM (
  SELECT conversation_id, MAX(seq) AS max_seq, MAX(created_at) AS max_created_at
  FROM chat_messages
  GROUP BY conversation_id
) s
WHERE cc.id = s.conversation_id;
--> statement-breakpoint

INSERT INTO chat_receipts (
  conversation_id,
  user_id,
  last_read_seq,
  last_delivered_seq,
  updated_at
)
SELECT
  cr.conversation_id,
  cr.user_id,
  COALESCE(
    (
      SELECT MAX(m.seq)
      FROM chat_messages m
      WHERE m.conversation_id = cr.conversation_id
        AND m.created_at <= cr.last_read_at
    ),
    0
  ) AS last_read_seq,
  COALESCE(
    (
      SELECT MAX(m.seq)
      FROM chat_messages m
      WHERE m.conversation_id = cr.conversation_id
    ),
    0
  ) AS last_delivered_seq,
  COALESCE(cr.updated_at, cr.created_at)
FROM conversation_reads cr
ON CONFLICT ("conversation_id","user_id")
DO UPDATE SET
  last_read_seq = EXCLUDED.last_read_seq,
  last_delivered_seq = EXCLUDED.last_delivered_seq,
  updated_at = EXCLUDED.updated_at;
