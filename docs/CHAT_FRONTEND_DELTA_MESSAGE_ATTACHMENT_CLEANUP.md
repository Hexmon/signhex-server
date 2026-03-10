# Chat Frontend Delta: Deleted Message Attachment Cleanup

## Summary
Backend behavior changed for `DELETE /api/v1/chat/messages/:id`.

The endpoint and response shape are unchanged, but attachment lifecycle changed:
- deleting a message now removes that message's attachment links immediately
- the deleted message remains as a tombstone in the timeline
- if an attached media asset is no longer referenced anywhere else, backend deletes it asynchronously from DB and object storage

## What FE Must Assume
- A deleted message will always render with:
  - `body_text: null`
  - `body_rich: null`
  - `attachments: []`
  - `reactions: []`
  - `deleted_at: <iso>`
- FE must not expect attachments from a deleted message to remain available for preview, retry, download, or re-open.
- Attachment chips/previews/download actions must disappear as soon as the deleted tombstone is rendered.
- If the same media asset is reused somewhere else, backend may keep it. FE should not try to infer physical media deletion from message delete.

## REST Contract
### Delete message
Request:
```http
DELETE /api/v1/chat/messages/:messageId
Authorization: Bearer <token>
```

Response `200`:
```json
{
  "message": {
    "id": "29ac9273-9f44-4e25-ad5d-735565a5832c",
    "conversation_id": "5cb2cae2-fa07-492c-b039-1114d3e04bfc",
    "seq": 1,
    "sender_id": "00000000-0000-0000-0000-000000000001",
    "body_text": null,
    "body_rich": null,
    "reply_to_message_id": null,
    "thread_root_id": null,
    "thread_reply_count": 0,
    "also_to_channel": false,
    "created_at": "2026-03-09T12:00:00.000Z",
    "edited_at": "2026-03-09T12:05:00.000Z",
    "deleted_at": "2026-03-09T12:05:00.000Z"
  }
}
```

No attachment ids are returned after delete.

## List/Thread Behavior
These existing endpoints now always return deleted messages without attachments:
- `GET /api/v1/chat/conversations/:id/messages`
- `GET /api/v1/chat/conversations/:id/thread/:parentMessageId`

Deleted message example inside list response:
```json
{
  "id": "29ac9273-9f44-4e25-ad5d-735565a5832c",
  "seq": 2,
  "sender_id": "00000000-0000-0000-0000-000000000001",
  "body_text": null,
  "body_rich": null,
  "attachments": [],
  "reactions": [],
  "deleted_at": "2026-03-09T12:05:00.000Z"
}
```

## Realtime
No new websocket event was added.

Existing event remains:
- `chat:message:deleted`

Example:
```json
{
  "conversationId": "5cb2cae2-fa07-492c-b039-1114d3e04bfc",
  "messageId": "29ac9273-9f44-4e25-ad5d-735565a5832c",
  "seq": 2
}
```

FE should handle this exactly as before, then refetch or patch local state so the message becomes a tombstone with no attachments.

## UI Changes Required
- In message row rendering:
  - if `deleted_at` is present, never render attachments
  - hide image/file preview blocks
  - hide download/open actions
- In optimistic delete handling:
  - immediately clear `attachments` in local cache for that message
  - do not wait for any later media cleanup signal
- In thread view:
  - apply the same tombstone rendering as the channel timeline
- In media viewer:
  - if a user had a deleted-message attachment open, close the viewer or show a simple unavailable state on refresh

## FE Caching Guidance
- React Query or equivalent:
  - patch the deleted message in cache instead of removing it from the list
  - set `attachments` to `[]`
  - set `reactions` to `[]`
  - set `body_text` / `body_rich` to `null`
- Do not keep stale attachment preview state keyed only by message id.
- If attachment previews are cached separately by media id, treat deleted-message previews as invalid for that message immediately after delete.

## Copy-Paste Guidance For Frontend Codex
Implement this backend delta:

1. Keep using `DELETE /api/v1/chat/messages/:id` with the same request contract.
2. After success, render the message as a tombstone instead of removing it from the list.
3. For any message where `deleted_at` is non-null:
   - force `attachments` UI to hidden
   - force `reactions` UI to hidden
   - show deleted-message placeholder text if the app uses one
4. On `chat:message:deleted`, patch the cached message to:
   - `body_text = null`
   - `body_rich = null`
   - `attachments = []`
   - `reactions = []`
   - `deleted_at = now/response value after refetch`
5. Do not build any FE flow that assumes deleted attachments are still downloadable later. Backend may garbage-collect exclusive media asynchronously.
