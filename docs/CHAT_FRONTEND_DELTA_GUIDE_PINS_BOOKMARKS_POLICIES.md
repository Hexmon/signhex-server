# Chat Frontend Delta Guide: Pins, Bookmarks, Policies, alsoToChannel

Use this as the implementation contract for newly added chat backend features only.

## 1) What changed (summary for FE)
- Added message pins APIs and realtime updates.
- Added conversation bookmarks APIs and realtime updates.
- Added conversation settings policies under `conversation.metadata.settings`:
  - `mention_policy` for `@everyone/@channel/@here`
  - `edit_policy`
  - `delete_policy`
- Added thread reply visibility control via `alsoToChannel` in send-message payload.
- Policy and moderation rules are server-authoritative; FE should pre-gate UI but always handle API errors.

## 2) REST endpoints (method/path/request/response)
Base path: `/api/v1`
Auth: `Authorization: Bearer <token>`

### 2.1 Pin message
`POST /chat/messages/:id/pin`

Response `200`:
```json
{
  "pin": {
    "id": "8cc5f95a-e617-4f77-a067-d74512df96e5",
    "conversation_id": "0d63589d-08f0-4fd3-9ec4-70a584d3be8f",
    "message_id": "acde44b2-8daa-44d2-8f38-0f8ad3df0d7d",
    "pinned_by": "f3f954e8-1f36-457f-a4d7-f57aa59f891f",
    "pinned_at": "2026-03-06T07:35:19.758Z"
  }
}
```

### 2.2 Unpin message
`POST /chat/messages/:id/unpin`

Response `200`:
```json
{ "success": true }
```

### 2.3 List pins
`GET /chat/conversations/:id/pins`

Response `200`:
```json
{
  "items": [
    {
      "id": "8cc5f95a-e617-4f77-a067-d74512df96e5",
      "conversation_id": "0d63589d-08f0-4fd3-9ec4-70a584d3be8f",
      "message_id": "acde44b2-8daa-44d2-8f38-0f8ad3df0d7d",
      "pinned_by": "f3f954e8-1f36-457f-a4d7-f57aa59f891f",
      "pinned_at": "2026-03-06T07:35:19.758Z",
      "message": {
        "id": "acde44b2-8daa-44d2-8f38-0f8ad3df0d7d",
        "conversation_id": "0d63589d-08f0-4fd3-9ec4-70a584d3be8f",
        "seq": 10,
        "sender_id": "f3f954e8-1f36-457f-a4d7-f57aa59f891f",
        "body_text": "important",
        "body_rich": { "mentions": [] },
        "deleted_at": null
      }
    }
  ]
}
```

### 2.4 Create bookmark
`POST /chat/conversations/:id/bookmarks`

Request variants:
```json
{ "type": "LINK", "label": "Runbook", "url": "https://intranet/runbook", "emoji": "📘" }
```
```json
{ "type": "FILE", "label": "Spec PDF", "mediaAssetId": "<media-uuid>" }
```
```json
{ "type": "MESSAGE", "label": "Decision", "messageId": "<message-uuid>" }
```

Response `200`:
```json
{
  "bookmark": {
    "id": "a04d18db-e09a-4e4c-9a3d-795923c16039",
    "conversation_id": "1d52f385-3fab-4d5c-af84-3cdeae06c96c",
    "type": "MESSAGE",
    "label": "Decision",
    "emoji": null,
    "url": null,
    "media_asset_id": null,
    "message_id": "1f4bae9f-58b3-444b-953d-7526d0545241",
    "created_by": "f3f954e8-1f36-457f-a4d7-f57aa59f891f",
    "metadata": null,
    "created_at": "2026-03-06T07:35:19.769Z"
  }
}
```

### 2.5 List bookmarks
`GET /chat/conversations/:id/bookmarks`

Response `200`:
```json
{
  "items": [
    {
      "id": "a04d18db-e09a-4e4c-9a3d-795923c16039",
      "conversation_id": "1d52f385-3fab-4d5c-af84-3cdeae06c96c",
      "type": "MESSAGE",
      "label": "Decision",
      "emoji": null,
      "url": null,
      "media_asset_id": null,
      "message_id": "1f4bae9f-58b3-444b-953d-7526d0545241",
      "created_by": "f3f954e8-1f36-457f-a4d7-f57aa59f891f",
      "metadata": null,
      "created_at": "2026-03-06T07:35:19.769Z"
    }
  ]
}
```

### 2.6 Delete bookmark
`DELETE /chat/bookmarks/:id`

Response `200`:
```json
{ "success": true }
```

### 2.7 Update conversation policies
`PATCH /chat/conversations/:id`

Request:
```json
{
  "settings": {
    "mention_policy": {
      "everyone": "ADMINS_ONLY",
      "channel": "ADMINS_ONLY",
      "here": "ANY_MEMBER"
    },
    "edit_policy": "ADMINS_ONLY",
    "delete_policy": "DISABLED"
  }
}
```

Response `200`:
```json
{
  "conversation": {
    "id": "<conversation-id>",
    "metadata": {
      "settings": {
        "mention_policy": {
          "everyone": "ADMINS_ONLY",
          "channel": "ADMINS_ONLY",
          "here": "ANY_MEMBER"
        },
        "edit_policy": "ADMINS_ONLY",
        "delete_policy": "DISABLED"
      }
    }
  }
}
```

### 2.8 Send thread reply with `alsoToChannel`
`POST /chat/conversations/:id/messages`

Request (hidden from channel):
```json
{ "text": "thread-only", "replyTo": "<parent-message-id>" }
```

Request (visible in channel and thread):
```json
{ "text": "send to channel", "replyTo": "<parent-message-id>", "alsoToChannel": true }
```

Validation rule:
- `alsoToChannel` without `replyTo` -> `422 VALIDATION_ERROR`.

## 3) WS events (names + payloads)
Namespace: `/chat`

### 3.1 Pin updates
Event: `chat:pin:update`
```json
{
  "conversationId": "1d52f385-3fab-4d5c-af84-3cdeae06c96c",
  "messageId": "1f4bae9f-58b3-444b-953d-7526d0545241",
  "pinned": true,
  "pin": {
    "id": "8cc5f95a-e617-4f77-a067-d74512df96e5",
    "conversation_id": "1d52f385-3fab-4d5c-af84-3cdeae06c96c",
    "message_id": "1f4bae9f-58b3-444b-953d-7526d0545241",
    "pinned_by": "f3f954e8-1f36-457f-a4d7-f57aa59f891f",
    "pinned_at": "2026-03-06T07:35:19.758Z"
  }
}
```

### 3.2 Bookmark updates
Event: `chat:bookmark:update`
```json
{ "conversationId": "1d52f385-3fab-4d5c-af84-3cdeae06c96c", "bookmarkId": "a04d18db-e09a-4e4c-9a3d-795923c16039", "op": "add" }
```
```json
{ "conversationId": "1d52f385-3fab-4d5c-af84-3cdeae06c96c", "bookmarkId": "a04d18db-e09a-4e4c-9a3d-795923c16039", "op": "remove" }
```

### 3.3 Policy updates
Event: `chat:conversation:updated`
```json
{
  "conversationId": "1d52f385-3fab-4d5c-af84-3cdeae06c96c",
  "patch": {
    "settings": {
      "mention_policy": { "everyone": "ADMINS_ONLY", "channel": "ADMINS_ONLY", "here": "ANY_MEMBER" },
      "edit_policy": "ADMINS_ONLY",
      "delete_policy": "DISABLED"
    }
  }
}
```

## 4) Error codes + exact UX handling
- `409 CHAT_ARCHIVED`
  - Applies to pin/bookmark/policy changes/send/edit/delete/react/invite/remove/moderation.
  - UX: disable composer/actions and show archived banner.
- `403 CHAT_MENTION_POLICY_VIOLATION`:
  - `@everyone mention is restricted to admins`
  - `@channel mention is restricted to admins`
  - `@<token> mentions are disabled in this conversation`
- `403 CHAT_EDIT_POLICY_DISABLED`:
  - `Message editing is disabled in this conversation`
- `403 CHAT_EDIT_POLICY_FORBIDDEN`:
  - `You cannot edit this message`
- `403 CHAT_DELETE_POLICY_DISABLED`:
  - `Message deletion is disabled in this conversation`
- `403 CHAT_DELETE_POLICY_FORBIDDEN`:
  - `You cannot delete this message`
  - UX: show inline toast using server message.
- Existing moderation codes remain:
  - `403 CHAT_MUTED` (disable composer/actions)
  - `403 CHAT_BANNED` (block view/subscribe)

## 5) UI integration checklist
1. Message actions menu:
   - Add `Pin` / `Unpin` actions.
   - Hide/disable when archived/muted/banned or policy denies write.
2. Conversation side panels:
   - Add pinned items panel from `GET /pins`.
   - Add bookmarks panel from `GET /bookmarks`.
3. Composer/thread UI:
   - Add `Also send to channel` toggle for thread replies only.
   - Enforce toggle disabled when no `replyTo`.
4. Conversation settings modal:
   - Add controls for `mention_policy`, `edit_policy`, `delete_policy`.
5. Realtime cache sync:
   - On `chat:pin:update`, mutate local pin state.
   - On `chat:bookmark:update`, add/remove bookmark cache entry.
   - On `chat:conversation:updated`, refresh conversation settings cache.

## 6) FE test checklist (manual/e2e)
1. Thread reply with `alsoToChannel=false`:
   - Not present in channel list.
   - Present in thread list.
2. Thread reply with `alsoToChannel=true`:
   - Present in both channel and thread lists.
3. Pin flow:
   - Pin/unpin via REST.
   - Verify realtime event updates second client.
4. Bookmark flow:
   - Create/list/delete.
   - Verify realtime add/remove event updates second client.
5. Mention policy:
   - Member `@everyone` blocked.
   - Admin `@everyone` allowed.
6. Edit/delete policy:
   - `ADMINS_ONLY` edit blocks member, allows admin.
   - `DISABLED` delete blocks everyone.
7. Archive behavior:
   - Pin/bookmark/policy mutations return `409 CHAT_ARCHIVED`.

## 7) Backward compatibility / defaults
- If FE does not send new fields:
  - `alsoToChannel` defaults to `false`.
  - mention policy defaults to:
    - `@everyone`: `ADMINS_ONLY`
    - `@channel`: `ADMINS_ONLY`
    - `@here`: `ANY_MEMBER`
  - `edit_policy` defaults to `OWN`.
  - `delete_policy` defaults to `OWN`.
- Existing clients continue to work; they just won’t expose new controls.
