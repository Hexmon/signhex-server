# Chat Share Links Guide

## Purpose
Deep links are **permalink navigation only** for chat conversations.  
They are **not invite links** and do not grant membership or read access.

## Non-Goals
1. No invite-by-link.
2. No tokenized public links.
3. No authorization bypass.

## Environment
1. `API_BASE_URL`: `http://<host>:3000/api/v1`
2. `WS_BASE_URL`: `http://<host>:3000`
3. `APP_PUBLIC_BASE_URL` (optional backend env):
   - If set, share-link endpoint returns absolute `url`.
   - If unset, share-link endpoint returns `path` only.
4. On-prem HTTP is supported.

## FE Route Formats
1. Conversation: `/chat/:conversationId`
2. Thread: `/chat/:conversationId/thread/:threadRootId`
3. Message focus: `/chat/:conversationId?focusMessageId=:messageId`

Note: backend share-link returns only conversation permalink. FE appends thread or query params.

## Auth
1. Bearer token is required for both endpoints.
2. Session/JTI revocation is enforced (same as other `/chat` routes).

## Endpoint: Resolve Conversation

### Request
- Method: `GET`
- Path: `/api/v1/chat/conversations/:id`
- Auth: `Authorization: Bearer <token>`

### Success Response (200)
```json
{
  "conversation": {
    "id": "1e03edd4-0499-4ca2-8497-4178050c02cf",
    "type": "GROUP_CLOSED",
    "state": "ACTIVE",
    "title": "Design Team",
    "topic": "Q2 planning",
    "purpose": "Daily async updates",
    "invite_policy": "ANY_MEMBER_CAN_INVITE",
    "last_seq": 142
  },
  "viewer": {
    "is_member": true,
    "role": "MEMBER"
  }
}
```

### Errors
1. `401 UNAUTHORIZED`: missing/invalid token or revoked session.
2. `403 FORBIDDEN`: no access (not participant/member where required).
3. `403 CHAT_BANNED`: banned in that conversation.
4. `404 NOT_FOUND`: conversation missing or deleted.

## Endpoint: Create Share Link

### Request
- Method: `POST`
- Path: `/api/v1/chat/conversations/:id/share-link`
- Auth: `Authorization: Bearer <token>`

### Success Response (200, with `APP_PUBLIC_BASE_URL`)
```json
{
  "path": "/chat/1e03edd4-0499-4ca2-8497-4178050c02cf",
  "url": "http://localhost:8080/chat/1e03edd4-0499-4ca2-8497-4178050c02cf"
}
```

### Success Response (200, without `APP_PUBLIC_BASE_URL`)
```json
{
  "path": "/chat/1e03edd4-0499-4ca2-8497-4178050c02cf"
}
```

### Errors
1. `401 UNAUTHORIZED`
2. `403 FORBIDDEN`
3. `403 CHAT_BANNED`
4. `404 NOT_FOUND`

## Access Rules (Server-Enforced)
1. DM: only 2 participants can resolve/share.
2. GROUP_CLOSED: only members can resolve/share.
3. FORUM_OPEN: any authenticated user can resolve/share unless banned.
4. ARCHIVED: resolve/share allowed; writes still blocked by `CHAT_ARCHIVED`.
5. DELETED: resolve/share returns `404`.

## FE Link Open Algorithm
1. Parse route (`conversationId`, optional `threadRootId`, optional `focusMessageId`).
2. Call `GET /chat/conversations/:id`.
3. Branch:
   - `200`: load chat view, then fetch messages/thread.
   - `403 FORBIDDEN`: show no-access state.
   - `403 CHAT_BANNED`: show banned state/banner.
   - `404 NOT_FOUND`: show not-found state.
   - `401 UNAUTHORIZED`: redirect/login flow.
4. Never assume link itself implies access.

## Security Notes
1. Do not render conversation details from URL alone.
2. Use resolve response as source of truth for UI permissions/state.
3. Do not cache forbidden/not-found responses as if they were authorization.
4. Share link operation must not modify membership, invite policy, or conversation state.

## Curl Examples

Resolve:
```bash
curl -X GET "http://localhost:3000/api/v1/chat/conversations/<conversationId>" \
  -H "Authorization: Bearer <TOKEN>"
```

Share link:
```bash
curl -X POST "http://localhost:3000/api/v1/chat/conversations/<conversationId>/share-link" \
  -H "Authorization: Bearer <TOKEN>"
```
