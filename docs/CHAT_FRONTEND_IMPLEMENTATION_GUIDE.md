# Chat Frontend Implementation Guide (React) - SignHex Enterprise V1

This document is the frontend implementation contract for chat, derived from backend code in:
- `src/routes/chat.ts`
- `src/db/repositories/chat.ts`
- `src/realtime/chat-namespace.ts`
- `src/realtime/socket-server.ts`
- `src/chat/guard.ts`
- `src/chat/notify.ts`
- `src/routes/notifications.ts`
- `src/routes/media.ts`
- `src/auth/request-auth.ts`

Base API prefix: `/api/v1`

## 1) Environment + On-Prem HTTP Setup

## Required FE env
- `VITE_API_BASE_URL=http://<backend-host>:3000`
- `VITE_WS_BASE_URL=http://<backend-host>:3000`

## Backend env impacting FE
- `CORS_ORIGINS` controls HTTP CORS.
- `SOCKET_ALLOWED_ORIGINS` controls WS Origin allowlist for cookie-based WS auth.
  - If unset: socket allowlist falls back to `CORS_ORIGINS` + `http://localhost:8080`.
- `REDIS_URL` exists but chat rate limiter currently remains in-memory.

## Transport/auth mode to use
- REST `/chat/*`: use `Authorization: Bearer <access_token>`.
- WS `/chat`: use `handshake.auth.token` preferred.
- Cookies can be present but do not rely on cookie auth for REST chat routes.

## withCredentials
- If you also use cookie flows elsewhere, set `withCredentials: true`.
- For chat REST, bearer token auth is the source of truth.

---

## 2) Auth Model (REST + WS) and Revocation

## REST (`/chat/*`)
- Auth preHandler: `chatAuthPreHandler`.
- Required:
  - Valid JWT bearer token.
  - Session row exists for `jti`.
  - Session not expired.
  - Session `user_id` matches token `sub`.
- Failure: `401` with `error.code = "UNAUTHORIZED"`.

## WS (`/chat`)
Token resolution order:
1. `socket.handshake.auth.token`
2. `Authorization` header bearer
3. `access_token` cookie (only if Origin is allowed)

Origin rules:
- If Origin header exists and is not allowlisted => reject.
- Cookie auth without Origin => reject.
- Non-browser token client without Origin is allowed.

Revocation/session rules:
- Same as REST: session by JTI must exist, be unexpired, and belong to same user.
- Failure => connect error (`Unauthorized`/`Token has been revoked`).

---

## 3) Conversation Model + Lifecycle + Membership Rules

`chat_conversations.type`:
- `DM`
- `GROUP_CLOSED`
- `FORUM_OPEN`

`chat_conversations.state`:
- `ACTIVE`
- `ARCHIVED` (read-only)
- `DELETED` (hidden/blocked)

Invite policy (`invite_policy`):
- `ANY_MEMBER_CAN_INVITE`
- `ADMINS_ONLY_CAN_INVITE`
- `INVITES_DISABLED`

System admin membership:
- For `GROUP_CLOSED` / `FORUM_OPEN`: backend ensures `ADMIN`/`SUPER_ADMIN` as system chat-admins (`is_system = true`).
- For `DM`: no implicit admin membership; strict participant-only access.

DM confidentiality:
- Only the two participants can read/post/list/subscribe.
- Non-participant admins are blocked.

---

## 4) REST Contract (Endpoint by Endpoint)

All responses shown are representative shapes from current implementation.

## 4.1 Create/Get DM
`POST /api/v1/chat/dm`

Request:
```json
{ "otherUserId": "uuid" }
```

Response `200`:
```json
{
  "conversation": {
    "id": "uuid",
    "type": "DM",
    "dm_pair_key": "uuid:uuid",
    "state": "ACTIVE",
    "invite_policy": "INVITES_DISABLED",
    "last_seq": 0,
    "title": null,
    "topic": null,
    "purpose": null
  }
}
```

Notes:
- Active DM uniqueness by pair key.
- Deleted DM tombstones are not returned; DM may be recreated.

## 4.2 Create Group/Forum
`POST /api/v1/chat/conversations`

Request:
```json
{
  "type": "GROUP_CLOSED",
  "title": "Ops Chat",
  "topic": "Shift handover",
  "purpose": "Daily operations",
  "members": ["uuid", "uuid"],
  "invite_policy": "ANY_MEMBER_CAN_INVITE"
}
```

Response `200`:
```json
{ "conversation": { "id": "uuid", "type": "GROUP_CLOSED", "state": "ACTIVE" } }
```

## 4.3 List Conversations
`GET /api/v1/chat/conversations`

Response `200`:
```json
{
  "items": [
    {
      "id": "uuid",
      "type": "FORUM_OPEN",
      "state": "ACTIVE",
      "last_seq": 12,
      "last_message": { "id": "uuid", "seq": 12, "body_text": "..." },
      "unread_count": 3,
      "viewer_role": "MEMBER",
      "viewer_is_member": true
    }
  ]
}
```

Behavior:
- Returns active conversations.
- Includes `FORUM_OPEN` even if not explicit member.

## 4.4 List Messages
`GET /api/v1/chat/conversations/:id/messages?afterSeq=&limit=`

Query:
- `afterSeq` int >= 0 (default 0)
- `limit` int <= 100 (default 50)

Response `200`:
```json
{
  "items": [
    {
      "id": "uuid",
      "conversation_id": "uuid",
      "seq": 10,
      "sender_id": "uuid",
      "body_text": "hello",
      "body_rich": { "mentions": ["uuid"] },
      "reply_to_message_id": null,
      "thread_root_id": null,
      "thread_reply_count": 0,
      "created_at": "iso",
      "edited_at": null,
      "deleted_at": null,
      "attachments": [],
      "reactions": []
    }
  ]
}
```

Tombstone behavior:
- If `deleted_at` set, FE receives:
  - `body_text: null`
  - `body_rich: null`
  - `attachments: []`
  - `reactions: []`

## 4.5 List Thread
`GET /api/v1/chat/conversations/:id/thread/:parentMessageId?afterSeq=&limit=`

Response `200`:
```json
{
  "threadRootId": "uuid",
  "items": [/* same shape as list messages */]
}
```

## 4.6 Send Message
`POST /api/v1/chat/conversations/:id/messages`

Request:
```json
{
  "text": "hello @550e8400-e29b-41d4-a716-446655440000",
  "replyTo": "uuid",
  "attachmentMediaIds": ["uuid", "uuid"]
}
```

Rules:
- At least one of `text` or `attachmentMediaIds`.
- Max attachments per message: `10`.
- Attachments must be authorized and `READY`.
- Per-conversation sequence allocated atomically (`last_seq + 1` in same tx).

Response `200`:
```json
{
  "message": {
    "id": "uuid",
    "conversation_id": "uuid",
    "seq": 42,
    "sender_id": "uuid",
    "body_text": "hello",
    "body_rich": { "mentions": ["uuid"] },
    "reply_to_message_id": null,
    "thread_root_id": null
  }
}
```

## 4.7 Edit Message
`PATCH /api/v1/chat/messages/:id`

Request:
```json
{ "text": "edited text" }
```

Response `200`:
```json
{ "message": { "id": "uuid", "body_text": "edited text", "edited_at": "iso" } }
```

Backend side-effect:
- Writes revision row (`action=EDIT`) with old/new body.

## 4.8 Delete Message (Soft)
`DELETE /api/v1/chat/messages/:id`

Response `200`:
```json
{
  "message": {
    "id": "uuid",
    "deleted_at": "iso",
    "body_text": null,
    "body_rich": null
  }
}
```

Backend side-effect:
- Writes revision row (`action=DELETE`) with old body and null new body.

## 4.9 Reactions
`POST /api/v1/chat/messages/:id/reactions`

Request:
```json
{ "emoji": ":thumbsup:", "op": "add" }
```

or
```json
{ "emoji": ":thumbsup:", "op": "remove" }
```

Response `200`:
```json
{
  "message": { "id": "uuid" },
  "reactions": [{ "message_id": "uuid", "user_id": "uuid", "emoji": ":thumbsup:" }]
}
```

## 4.10 Read Receipt
`POST /api/v1/chat/conversations/:id/read`

Request:
```json
{ "lastReadSeq": 42 }
```

Response `200`:
```json
{
  "receipt": {
    "conversation_id": "uuid",
    "user_id": "uuid",
    "last_read_seq": 42,
    "last_delivered_seq": 42,
    "updated_at": "iso"
  }
}
```

## 4.11 Invite Members
`POST /api/v1/chat/conversations/:id/invite`

Request:
```json
{ "userIds": ["uuid", "uuid"] }
```

Response `200`:
```json
{ "success": true }
```

## 4.12 Remove Member
`POST /api/v1/chat/conversations/:id/members/remove`

Request:
```json
{ "userId": "uuid" }
```

Response `200`:
```json
{ "success": true }
```

Notes:
- Cannot remove `is_system=true` members.

## 4.13 Update Conversation Metadata/Policy
`PATCH /api/v1/chat/conversations/:id`

Request:
```json
{
  "title": "New title",
  "topic": "New topic",
  "purpose": "New purpose",
  "invite_policy": "ADMINS_ONLY_CAN_INVITE",
  "state": "ACTIVE"
}
```

Response `200`:
```json
{ "conversation": { "id": "uuid", "title": "New title" } }
```

## 4.14 Archive/Unarchive
- `POST /api/v1/chat/conversations/:id/archive`
- `POST /api/v1/chat/conversations/:id/unarchive`

Response `200`:
```json
{ "conversation": { "id": "uuid", "state": "ARCHIVED" } }
```

or
```json
{ "conversation": { "id": "uuid", "state": "ACTIVE" } }
```

## 4.15 Hard Delete (Vanish)
`DELETE /api/v1/chat/conversations/:id`

Auth:
- `SUPER_ADMIN` only.

Response `200`:
```json
{ "success": true, "conversationId": "uuid" }
```

Effects:
- Purges child rows (messages/attachments/reactions/revisions/receipts/moderation/members).
- Marks conversation `DELETED`.
- Enqueues media cleanup job when attachment media exists.

## 4.16 Moderation
`POST /api/v1/chat/conversations/:id/moderation`

Request:
```json
{
  "userId": "uuid",
  "action": "MUTE",
  "until": "2026-03-10T10:00:00.000Z",
  "reason": "spam"
}
```

`action`:
- `MUTE | UNMUTE | BAN | UNBAN`

Response `200`:
```json
{
  "moderation": {
    "conversation_id": "uuid",
    "user_id": "uuid",
    "muted_until": "iso|null",
    "banned_until": "iso|null",
    "reason": "string|null"
  }
}
```

Rules:
- Not supported for DM.
- Admin/super_admin only.
- Archived conversations are read-only (`CHAT_ARCHIVED`).

---

## 5) Machine-Readable Error Code Table

| HTTP | code | Where | FE handling |
|---|---|---|---|
| 400 | `BAD_REQUEST` | validation/general | inline form error |
| 400 | `CHAT_TOO_MANY_ATTACHMENTS` | send message | block composer, show max=10 |
| 401 | `UNAUTHORIZED` | missing/invalid/revoked session | force re-auth |
| 403 | `FORBIDDEN` | no access/no permission | show access denied |
| 403 | `CHAT_MUTED` | muted write attempts | disable composer/reactions until `details.muted_until` |
| 403 | `CHAT_BANNED` | banned list/read/subscribe/send | lock screen, show ban banner with `details.banned_until` |
| 404 | `NOT_FOUND` | missing message/conversation | show not found + refresh list |
| 409 | `CHAT_ARCHIVED` | archived write attempts | read-only banner + disable mutating controls |
| 409 | `MEDIA_NOT_READY` | attachment not READY | keep pending/uploading state; retry after media complete |
| 429 | `RATE_LIMITED` | forum limiter/global limiter | backoff and retry UX |
| 422 | `VALIDATION_ERROR` | schema validation errors | field-level error mapping |

Error envelope:
```json
{
  "success": false,
  "error": {
    "code": "CHAT_ARCHIVED",
    "message": "Conversation is archived and read-only",
    "details": null,
    "traceId": "uuid-or-null"
  }
}
```

---

## 6) Message Model + Ordering + Threads + Tombstones

Fields:
- `id`, `conversation_id`, `seq`, `sender_id`
- `body_text`, `body_rich`
- `reply_to_message_id`, `thread_root_id`, `thread_reply_count`
- `created_at`, `edited_at`, `deleted_at`

Ordering guarantee:
- `seq` is monotonically increasing per conversation.
- Assigned atomically with insert in one transaction.
- FE should use `seq` as canonical message order and catch-up cursor.

Thread model:
- Reply uses `replyTo`.
- Backend computes/stores `thread_root_id`.
- Thread list API filters by `thread_root_id`.

Edit/delete compliance:
- Revisions are stored in `chat_message_revisions` (not exposed in chat API).

Tombstone semantics:
- Deleted messages remain in stream with `deleted_at`.
- Content and social metadata are stripped from payload.

---

## 7) Attachments + Media Upload Flow

Chat messages reference media IDs only. Blobs are not stored in chat DB.

## Upload flow
1. `POST /api/v1/media/presign-upload`
```json
{
  "filename": "photo.png",
  "content_type": "image/png",
  "size": 123456
}
```
2. Use `upload_url` to `PUT` directly to object storage.
3. `POST /api/v1/media/:id/complete` to finalize media record (status -> READY).
4. Send chat message with `attachmentMediaIds: ["<media_id>"]`.

Chat attachment checks at send:
- Max 10 IDs.
- Every media ID must exist.
- Authorization:
  - owner OR admin/super_admin OR media override ability.
  - scope/department constraints if present.
- Media status must be `READY`.

Error contracts:
- `400 CHAT_TOO_MANY_ATTACHMENTS`
- `409 MEDIA_NOT_READY`
- `403 FORBIDDEN` for unauthorized attachment usage.

FE preview trust rules:
- Render via backend-provided signed media URLs from media APIs.
- Do not trust arbitrary user-entered URLs for file previews.

---

## 8) Reactions Contract + Realtime

REST:
- `POST /chat/messages/:id/reactions { emoji, op:add|remove }`
- Backend dedupes by `(message_id, user_id, emoji)`.

Realtime:
- Server emits `chat:message:updated` with patch containing `reactions`.

FE:
- Optimistic update allowed.
- Reconcile with server patch by `messageId`.

---

## 9) Read Receipts + Unread Counts

Write:
- `POST /chat/conversations/:id/read { lastReadSeq }`.
- Backend stores max of previous/current (`GREATEST`).

Read:
- Conversation list includes `unread_count`.
- FE fallback compute:
  - unread = `conversation.last_seq - my.last_read_seq` (never < 0).

WS:
- `chat:read` client event updates receipt server-side (same authorization checks).

---

## 10) Moderation FE Behavior

Muted user:
- Allowed: list/read/subscribe.
- Blocked: send/edit/delete/react.
- FE: disable composer + mutating controls and show muted banner with expiry.

Banned user:
- Blocked: list/read/subscribe/send.
- FE: block conversation entry with banned state; show expiry banner.

DM:
- No moderation endpoint allowed.

---

## 11) Realtime (`/chat`) Events + Catch-Up Strategy

Namespace:
- `/chat`

Client -> server:
- `chat:subscribe { conversationIds: string[] }` with ack `{ subscribed: string[], rejected: string[] }`
- `chat:typing { conversationId, isTyping }`
- `chat:read { conversationId, lastReadSeq }`

Server -> client:
- `chat:message:new { conversationId, seq, message }`
- `chat:message:updated { conversationId, messageId, patch }`
- `chat:message:deleted { conversationId, messageId, seq }`
- `chat:conversation:updated { conversationId, patch }`
- `chat:typing { conversationId, userId, isTyping, ttlSeconds }`

Reconnect + catch-up algorithm:
1. Reconnect socket with token.
2. Re-subscribe known conversations.
3. For each open conversation, call `GET /messages?afterSeq=<lastSeenSeq>`.
4. Merge by `seq` and de-duplicate by `id`.
5. Treat REST as source of truth; WS is fanout/latency optimization.

---

## 12) Notifications Contract (DM/Mention/Thread Reply)

Notification types (chat-created):
- `DM`
- `MENTION`
- `THREAD_REPLY`

`notifications.data` shape:
```json
{
  "conversationId": "uuid",
  "messageId": "uuid",
  "notificationType": "DM|MENTION|THREAD_REPLY",
  "snippet": "trimmed message preview"
}
```

Routes:
- `GET /api/v1/notifications?page=&limit=&read=true|false`
- `GET /api/v1/notifications/:id`
- `POST /api/v1/notifications/:id/read`
- `POST /api/v1/notifications/read-all`
- `DELETE /api/v1/notifications/:id`

List response includes:
- `pagination.unread_total`

Deep-linking:
- route to conversation by `data.conversationId`
- optionally scroll/focus by `data.messageId`

---

## 13) Capabilities + FE Gating Rules

No dedicated `/chat/capabilities` endpoint exists currently.

Use these runtime signals:
- conversation `state`
- conversation `type`
- role (`ADMIN`/`SUPER_ADMIN`) from auth context
- membership flags from list payload (`viewer_role`, `viewer_is_member`)
- API errors (`CHAT_ARCHIVED`, `CHAT_MUTED`, `CHAT_BANNED`, `FORBIDDEN`)

Recommended FE gating:
- If state `ARCHIVED`: disable all mutating controls.
- If DM and not participant: hide conversation/access (403 fallback).
- Show moderator controls only for admin/super_admin.
- If `FORUM_OPEN`: allow read/post by default; rely on error handling for bans/mutes.

---

## 14) UI Flows Checklist (React)

Implement screens/components:
1. Conversation list (DM/group/forum) with unread and last message preview.
2. Conversation view with infinite message list by `afterSeq`.
3. Composer with text + attachment picker (media IDs only).
4. Thread panel (parent + replies).
5. Reactions picker + counts.
6. Message actions (edit/delete) with policy fallback by API response.
7. Invite/remove members modal (group/forum only).
8. Conversation settings (title/topic/purpose/invite_policy).
9. Archive/unarchive controls.
10. Moderation UI (mute/ban/unmute/unban).
11. Hard delete confirmation UI (superadmin-only surfaces).
12. Notification center with deep-linking.
13. Read-only banners (archived/muted/banned).

---

## 15) QA Checklist + Curl Snippets

Assume:
- `API=http://localhost:3000/api/v1`
- `TOKEN=<bearer>`
- `CID=<conversationId>`
- `MID=<messageId>`

## DM create
```bash
curl -X POST "$API/chat/dm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"otherUserId":"<uuid>"}'
```

## Send message
```bash
curl -X POST "$API/chat/conversations/$CID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello"}'
```

## Thread reply
```bash
curl -X POST "$API/chat/conversations/$CID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"reply\",\"replyTo\":\"$MID\"}"
```

## Reaction
```bash
curl -X POST "$API/chat/messages/$MID/reactions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"emoji":":thumbsup:","op":"add"}'
```

## Archive write-block check
1. Archive conversation as admin.
2. Attempt send/edit/delete/react/invite/remove/update/moderation.
3. Expect `409 CHAT_ARCHIVED`.

## Moderation checks
1. Mute user, attempt send/edit/delete/react => `403 CHAT_MUTED`.
2. Ban user, attempt list/read/subscribe/send => `403 CHAT_BANNED`.

## DM confidentiality
1. Create DM between A/B.
2. Use non-participant admin token.
3. List/read/subscribe should fail (`403` or rejected subscribe).

## Hard delete + DM recreate
1. Create DM, hard delete by superadmin.
2. Call `/chat/dm` again for same pair.
3. Expect new ACTIVE DM ID.

---

## 16) FE Performance Guidance

React Query keys (recommended):
- `['chat', 'conversations']`
- `['chat', 'messages', conversationId, afterSeq]`
- `['chat', 'thread', conversationId, threadRootId, afterSeq]`
- `['notifications', page, readFilter]`

Guidance:
- Use `seq` cursor pagination, not timestamp pagination.
- Merge WS events into cache optimistically, then reconcile with REST catch-up.
- On reconnect, always do `afterSeq` sync per active conversation.
- Keep tombstones in timeline; do not drop deleted messages.
- For 429 (`RATE_LIMITED`), show retry UI with exponential backoff.

---

## 17) FE Security Notes

1. Treat message text as plain text by default; escape/encode before rendering.
2. Do not render arbitrary HTML from message or notification payloads.
3. Restrict link handling to safe protocols (`https:`, optionally `http:` in intranet).
4. Use signed URLs from backend media APIs only.
5. Keep mention parsing/tokenization deterministic; do not execute user-provided markup.
6. Never expose JWT in logs/telemetry.

---

## Additional Operational Notes

1. CSRF middleware skips token-auth (Authorization header) requests.
2. Chat route contracts are independent of legacy `/conversations/*` response shapes.
3. Legacy `/conversations/*` remains compatibility surface mapped to chat DM domain; do not build new FE features on it.
