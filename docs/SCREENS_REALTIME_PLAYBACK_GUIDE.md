# Screens Realtime Playback Guide

## Summary
Use `GET /api/v1/screens/overview` as the dashboard bootstrap and `/screens` Socket.IO as the live delta channel.

Implemented behavior:
- REST bootstrap is still source-of-truth
- realtime is additive and read-only
- heartbeat emits `screens:state:update`
- schedule publish, emergency trigger/clear, and screen-group membership changes emit `screens:refresh:required`
- per-screen drilldown uses `GET /api/v1/screens/:id/now-playing`

This is zero-downtime relative to existing consumers because old fields remain in place.

## Verified End-to-End
This flow has been verified against real backend mutations, not only unit tests.

Verified path:
- dashboard bootstrap via `GET /api/v1/screens/overview?include_media=true`
- detail bootstrap via `GET /api/v1/screens/:id/now-playing?include_media=true`
- `POST /api/v1/device/heartbeat` emits `screens:state:update`
- `POST /api/v1/emergency/trigger` emits `screens:refresh:required`
- `DELETE /api/v1/screens/:id` emits `screens:refresh:required`
- dashboard refetch after delete no longer includes the deleted screen

Repro:
```bash
npm run screens:dry-run
```

The dry-run script seeds a temporary screen, media, schedule snapshot, publish target, and device certificate, then opens a real Socket.IO client to `/screens` and verifies the full dashboard/detail lifecycle.

## REST

### 1) Dashboard bootstrap
`GET /api/v1/screens/overview?include_media=true|false`

Auth:
- `Authorization: Bearer <token>`

Query:
- `include_media=true`
  - adds `playback.current_media`
  - does not generate presigned media URLs

Response shape:
```json
{
  "server_time": "2026-03-10T07:15:00.000Z",
  "screens": [
    {
      "id": "screen-uuid",
      "name": "Lobby Screen",
      "status": "ACTIVE",
      "last_heartbeat_at": "2026-03-10T07:14:58.000Z",
      "current_schedule_id": "schedule-uuid",
      "current_media_id": "media-from-screen-row-or-null",
      "active_items": [],
      "upcoming_items": [],
      "booked_until": "2026-03-10T08:00:00.000Z",
      "publish": {
        "publish_id": "publish-uuid",
        "schedule_id": "schedule-uuid",
        "snapshot_id": "snapshot-uuid",
        "published_at": "2026-03-10T07:00:00.000Z",
        "schedule_start_at": "2026-03-10T06:00:00.000Z",
        "schedule_end_at": "2026-03-10T18:00:00.000Z"
      },
      "playback": {
        "source": "HEARTBEAT",
        "is_live": true,
        "current_media_id": "resolved-media-uuid",
        "current_schedule_id": "schedule-uuid",
        "current_item_id": "schedule-item-id",
        "started_at": "2026-03-10T07:10:00.000Z",
        "ends_at": "2026-03-10T07:20:00.000Z",
        "heartbeat_received_at": "2026-03-10T07:14:58.000Z",
        "last_proof_of_play_at": "2026-03-10T07:14:40.000Z",
        "current_media": {
          "id": "media-uuid",
          "name": "Promo Loop",
          "type": "VIDEO",
          "status": "READY",
          "source_content_type": "video/mp4",
          "source_size": 15728640,
          "width": 1920,
          "height": 1080,
          "duration_seconds": 15
        }
      },
      "emergency": null
    }
  ],
  "groups": [
    {
      "id": "group-uuid",
      "name": "North Wing",
      "description": "optional",
      "screen_ids": ["screen-uuid"],
      "active_items": [],
      "upcoming_items": [],
      "booked_until": "2026-03-10T08:00:00.000Z"
    }
  ]
}
```

Important semantics:
- `current_media_id` at the screen level is the raw `screens.current_media_id`
- `playback.current_media_id` is the resolved live media id and may come from:
  - emergency
  - heartbeat current media
  - active schedule fallback
  - default media fallback
- FE should use `playback.current_media_id` and `playback.source` for live UI
- FE should use top-level `server_time` instead of local browser time when showing “playing now” timers

### 2) Per-screen drilldown
`GET /api/v1/screens/:id/now-playing?include_media=true|false&include_urls=true|false`

Auth:
- `Authorization: Bearer <token>`

Query:
- `include_media=true`
  - adds `playback.current_media`
- `include_urls=true`
  - only affects the `emergency.media_url` path today

Response shape:
```json
{
  "server_time": "2026-03-10T07:15:00.000Z",
  "screen_id": "screen-uuid",
  "status": "ACTIVE",
  "last_heartbeat_at": "2026-03-10T07:14:58.000Z",
  "current_schedule_id": "schedule-uuid",
  "current_media_id": "media-uuid",
  "publish": {
    "publish_id": "publish-uuid",
    "schedule_id": "schedule-uuid",
    "snapshot_id": "snapshot-uuid",
    "published_at": "2026-03-10T07:00:00.000Z",
    "schedule_start_at": "2026-03-10T06:00:00.000Z",
    "schedule_end_at": "2026-03-10T18:00:00.000Z"
  },
  "active_items": [],
  "upcoming_items": [],
  "booked_until": "2026-03-10T08:00:00.000Z",
  "playback": {
    "source": "HEARTBEAT",
    "is_live": true,
    "current_media_id": "media-uuid",
    "current_schedule_id": "schedule-uuid",
    "current_item_id": "schedule-item-id",
    "started_at": "2026-03-10T07:10:00.000Z",
    "ends_at": "2026-03-10T07:20:00.000Z",
    "heartbeat_received_at": "2026-03-10T07:14:58.000Z",
    "last_proof_of_play_at": "2026-03-10T07:14:40.000Z",
    "current_media": {
      "id": "media-uuid",
      "name": "Promo Loop",
      "type": "VIDEO",
      "status": "READY",
      "source_content_type": "video/mp4",
      "source_size": 15728640,
      "width": 1920,
      "height": 1080,
      "duration_seconds": 15
    }
  },
  "emergency": null
}
```

### REST errors
Current route behavior:
- `401 UNAUTHORIZED`
  - missing auth header
  - invalid/expired token
- `404 NOT_FOUND`
  - `now-playing` when screen id does not exist
- `500 INTERNAL_ERROR`
  - unexpected backend failure

Frontend handling:
- `401`: redirect to login/session refresh flow
- `404`: show “screen not found”
- `500`: show retry state and keep stale cached data visible if available

## WebSocket

### Namespace
`/screens`

### Auth
Matches the hardened socket model already used by chat/notifications:
- preferred: `socket.handshake.auth.token`
- fallback: `Authorization: Bearer <token>`
- cookie auth allowed only from allowlisted origins

Connection example:
```ts
const socket = io(`${WS_BASE_URL}/screens`, {
  transports: ['websocket'],
  auth: { token: accessToken },
  withCredentials: true,
  reconnection: true,
});
```

### Client events

#### `screens:subscribe`
Payload:
```json
{
  "includeAll": true,
  "screenIds": ["screen-uuid-1", "screen-uuid-2"]
}
```

Ack:
```json
{
  "subscribed_all": true,
  "subscribed": ["screen-uuid-1"],
  "rejected": ["missing-screen-id"]
}
```

Rules:
- `includeAll=true` joins the dashboard room
- `screenIds` joins per-screen rooms
- invalid screen ids are returned in `rejected`

#### `screens:sync`
Use this only as a catch-up helper after reconnect or room resubscribe.

Payload:
```json
{
  "screenIds": ["screen-uuid-1"]
}
```

Ack with ids:
```json
{
  "server_time": "2026-03-10T07:15:00.000Z",
  "screens": [{ "...": "same screen summary shape as overview.screens[]" }]
}
```

Ack without ids:
```json
{
  "server_time": "2026-03-10T07:15:00.000Z",
  "screens": [],
  "groups": []
}
```

When no `screenIds` are sent, the server returns the full `screens/overview` payload shape.

### Server events

#### `screens:state:update`
Emitted after:
- device heartbeat updates the screen row
- proof-of-play ingest writes a new record

Payload:
```json
{
  "server_time": "2026-03-10T07:15:03.000Z",
  "screen": {
    "id": "screen-uuid",
    "name": "Lobby Screen",
    "status": "ACTIVE",
    "last_heartbeat_at": "2026-03-10T07:15:03.000Z",
    "current_schedule_id": "schedule-uuid",
    "current_media_id": "media-uuid",
    "active_items": [],
    "upcoming_items": [],
    "booked_until": "2026-03-10T08:00:00.000Z",
    "publish": {},
    "playback": {},
    "emergency": null
  }
}
```

Frontend use:
- patch that single screen in dashboard cache
- patch that screen in per-screen drilldown cache
- do not refetch the whole list on every heartbeat

#### `screens:refresh:required`
Emitted after:
- schedule publish
- emergency trigger/clear
- screen-group membership changes
- screen delete

Payload:
```json
{
  "reason": "PUBLISH|EMERGENCY|GROUP_MEMBERSHIP",
  "screen_ids": ["screen-uuid"],
  "group_ids": ["group-uuid"]
}
```

Frontend use:
- if dashboard page is open: refetch `GET /api/v1/screens/overview`
- if per-screen page is open and its `screen_id` is included: refetch `GET /api/v1/screens/:id/now-playing`
- if reason is `EMERGENCY`, show the emergency badge/banner immediately while refetch is in progress

## Backend Trigger Matrix
Use this as the operational source of truth for what actually emits realtime screen events.

| Backend action | Source | WS event |
| --- | --- | --- |
| Device heartbeat | `POST /api/v1/device/heartbeat` | `screens:state:update` |
| Proof-of-play ingest | proof-of-play write path | `screens:state:update` |
| Schedule publish | schedule publish route | `screens:refresh:required` |
| Emergency trigger | `POST /api/v1/emergency/trigger` | `screens:refresh:required` |
| Emergency clear | `POST /api/v1/emergency/:id/clear` | `screens:refresh:required` |
| Screen-group membership change | screen-group routes | `screens:refresh:required` |
| Screen delete | `DELETE /api/v1/screens/:id` | `screens:refresh:required` |

## Frontend integration algorithm

### Dashboard
1. Fetch `GET /api/v1/screens/overview?include_media=true`
2. Connect `/screens`
3. Emit `screens:subscribe { includeAll: true }`
4. On `screens:state:update`
   - replace the matching `screens[i]`
   - do not touch unrelated rows
5. On `screens:refresh:required`
   - refetch overview once
   - debounce if several refresh events arrive quickly
6. On reconnect
   - reconnect socket
   - resubscribe
   - refetch overview

### Per-screen detail
1. Fetch `GET /api/v1/screens/:id/now-playing?include_media=true`
2. Connect `/screens`
3. Emit `screens:subscribe { screenIds: [screenId] }`
4. On `screens:state:update`
   - patch that one screen if ids match
5. On `screens:refresh:required`
   - refetch if `screen_ids` contains the current screen

## UX rules
- `playback.source = EMERGENCY`
  - show emergency badge as highest priority
- `status = OFFLINE`
  - show offline state even if stale playback data exists
- `last_heartbeat_at` too old
  - show delayed heartbeat warning
- `publish = null` and `playback.source = DEFAULT`
  - show “default media fallback”
- `publish = null` and `playback.source = UNKNOWN`
  - show “nothing currently scheduled”

## Copy-paste prompt for frontend Codex

```md
Implement enterprise realtime screen monitoring against the current backend contract.

Backend contract:
- Bootstrap dashboard from `GET /api/v1/screens/overview?include_media=true`
- Bootstrap per-screen detail from `GET /api/v1/screens/:id/now-playing?include_media=true`
- Use `server_time` from the API for all playback-relative timers
- Connect Socket.IO namespace `/screens`
- Authenticate websocket with `auth: { token: accessToken }`
- After connect:
  - dashboard page: `screens:subscribe { includeAll: true }`
  - detail page: `screens:subscribe { screenIds: [screenId] }`
- Listen for:
  - `screens:state:update`
  - `screens:refresh:required`

Data rules:
- Use `playback.current_media_id` as the live media pointer, not top-level `current_media_id`
- Use `playback.source` to label the state:
  - `EMERGENCY`
  - `HEARTBEAT`
  - `SCHEDULE`
  - `DEFAULT`
  - `UNKNOWN`
- If `include_media=true`, `playback.current_media` is available and should drive the media card UI
- `active_items` and `upcoming_items` remain backward-compatible and should still be shown in expanded detail panels

Realtime rules:
- `screens:state:update` means patch only that screen locally
- `screens:refresh:required` means refetch affected data from REST
- On reconnect, always refetch and resubscribe

UX requirements:
- Show offline state when `status = OFFLINE`
- Show stale heartbeat warning when `last_heartbeat_at` is old
- Show emergency state as highest priority when `playback.source = EMERGENCY`
- Show schedule timing using backend `server_time`
- Debounce dashboard refetches if several refresh events arrive quickly
- Keep stale data visible during background refresh instead of blanking the grid

Error handling:
- `401`: force auth refresh or redirect to login
- `404` on per-screen route: show “screen not found”
- `500`: show retry UI and preserve stale cache if present

Expected FE deliverables:
- dashboard grid with live playback chips
- per-screen live detail panel
- reconnect-safe websocket integration
- explicit offline/stale/emergency/default fallback states
```
