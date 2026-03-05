# Chat API Catalog (V1)

`/api/v1/chat` is the primary chat domain (REST source of truth, Socket.IO fanout/transient only).

## Conversations
- `POST /api/v1/chat/dm`
- `POST /api/v1/chat/conversations`
- `GET /api/v1/chat/conversations`
- `PATCH /api/v1/chat/conversations/:id`
- `POST /api/v1/chat/conversations/:id/archive`
- `POST /api/v1/chat/conversations/:id/unarchive`
- `DELETE /api/v1/chat/conversations/:id`
- `POST /api/v1/chat/conversations/:id/moderation`

## Membership
- `POST /api/v1/chat/conversations/:id/invite`
- `POST /api/v1/chat/conversations/:id/members/remove`

## Messages
- `GET /api/v1/chat/conversations/:id/messages`
- `GET /api/v1/chat/conversations/:id/thread/:parentMessageId`
- `POST /api/v1/chat/conversations/:id/messages`
- `PATCH /api/v1/chat/messages/:id`
- `DELETE /api/v1/chat/messages/:id`
- `POST /api/v1/chat/messages/:id/reactions`
- `POST /api/v1/chat/conversations/:id/read`

## Security and lifecycle notes
- All `/chat/*` routes enforce JWT + session/JTI revocation checks.
- Attachments enforce ownership/scope checks, readiness (`READY`), and max count limits.
- `ARCHIVED` conversations are read-only for content mutations.
- `DELETED` conversations are hidden from normal list/access flows.

## Legacy compatibility
- `/api/v1/conversations/*` DM routes are compatibility shims over `chat_*` DM data.
- New DM writes should use `/api/v1/chat/*` endpoints.
