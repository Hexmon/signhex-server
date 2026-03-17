# Scheduling Frontend and Player Contract

## Admin APIs
### `POST /api/v1/schedules`
Request:
```json
{
  "name": "Lobby Morning",
  "description": "Optional",
  "timezone": "Asia/Kolkata",
  "start_at": "2026-03-14T04:00:00.000Z",
  "end_at": "2026-03-14T10:00:00.000Z"
}
```
Notes:
- `timezone` is stored for audit/display only.
- `start_at` and `end_at` remain UTC execution timestamps.

### `POST /api/v1/schedules/:id/items`
Request:
```json
{
  "presentation_id": "uuid",
  "start_at": "2026-03-14T05:00:00.000Z",
  "end_at": "2026-03-14T06:00:00.000Z",
  "priority": 0,
  "screen_ids": ["uuid"],
  "screen_group_ids": []
}
```
Rules:
- Item must stay within schedule bounds.
- Overlap for the same effective targets is rejected.

### `POST /api/v1/schedules/:id/publish`
Request:
```json
{
  "screen_ids": ["uuid"],
  "screen_group_ids": [],
  "notes": "Optional publish note",
  "schedule_request_id": "uuid"
}
```
Rules:
- Publish creates an immutable snapshot.
- Latest successful publish targeting a screen is authoritative for that screen.
- Publish is atomic.
- Publish rejects missing/non-ready presentation assets and unsupported codecs.

## Device API
### `GET /api/v1/device/:deviceId/snapshot`
Headers:
- `x-device-serial: <serial>`
- optional `If-None-Match: "<snapshot_id>"`

Response shape:
```json
{
  "device_id": "uuid",
  "publish": {
    "publish_id": "uuid",
    "schedule_id": "uuid",
    "snapshot_id": "uuid",
    "published_at": "2026-03-14T10:00:00.000Z"
  },
  "snapshot": {
    "schedule": {
      "id": "uuid",
      "name": "Lobby Morning",
      "timezone": "Asia/Kolkata",
      "start_at": "...",
      "end_at": "...",
      "items": [
        {
          "id": "uuid",
          "start_at": "...",
          "end_at": "...",
          "priority": 0,
          "screen_ids": [],
          "screen_group_ids": [],
          "presentation": {
            "id": "uuid",
            "layout": { "id": "uuid", "spec": {} },
            "items": [],
            "slots": []
          }
        }
      ]
    }
  },
  "emergency": null,
  "default_media": null,
  "default_media_resolution": { "source": "NONE", "aspect_ratio": null }
}
```
Behavior:
- `ETag` is the current `snapshot_id` when schedule payload is authoritative.
- `304 Not Modified` is returned on matching `If-None-Match` when no emergency is changing the payload.
- Player must evaluate scheduled items locally against UTC timestamps.
- Player must not use legacy `/v1/device/:deviceId/schedule` or `/v1/device/:deviceId/emergency` as the production contract.
