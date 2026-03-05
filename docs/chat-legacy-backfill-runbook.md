# Chat Legacy DM Backfill Runbook

## Source of truth cutover
- After this deploy, `/api/v1/conversations/*` reads/writes the `chat_*` DM subset.
- Legacy tables `conversations`, `conversation_messages`, and `conversation_reads` are no longer written by API routes.

## When to run
- Run once after deploy to ensure all historical legacy DMs are represented in `chat_*`.
- Safe to run multiple times (idempotent).

## Command
```bash
npm run chat:backfill-legacy
```

## What it does
- Ensures an ACTIVE DM exists in `chat_conversations` for each legacy `conversations` row.
- Ensures both legacy participants exist in `chat_members`.
- Backfills missing legacy messages into `chat_messages` (no duplicates by message id).
- Backfills/updates read state into `chat_receipts`.

## Verification checklist
1. Legacy vs chat DM count:
```sql
SELECT COUNT(*) FROM conversations;
SELECT COUNT(*) FROM chat_conversations WHERE type = 'DM' AND state = 'ACTIVE';
```
2. Spot-check one conversation pair:
```sql
SELECT id, participant_a, participant_b FROM conversations ORDER BY updated_at DESC LIMIT 5;
SELECT id, dm_pair_key, state, last_seq FROM chat_conversations WHERE type = 'DM' ORDER BY updated_at DESC LIMIT 5;
```
3. Idempotency:
- Re-run `npm run chat:backfill-legacy`.
- Confirm summary shows `messagesBackfilled` no longer increasing for stable data.
