# Scheduling Frontend and Player Contract

## Frontend contract
### Schedule creation remains split in two phases
1. build schedule and schedule items
2. submit request for approval

Drafting is still lightweight. Ownership starts only at request submission.

## Request flow APIs
### `POST /api/v1/schedule-requests`
Behavior:
- creates the request
- resolves concrete screen targets
- acquires temporary `HELD` reservations
- fails with `409` on overlap

Request:
```json
{
  "schedule_id": "uuid",
  "notes": "Optional"
}
```

Success response includes:
```json
{
  "id": "uuid",
  "schedule_id": "uuid",
  "status": "PENDING",
  "reservation_summary": {
    "state": "HELD",
    "token": "uuid",
    "version": 1,
    "hold_expires_at": "2026-03-20T10:00:00.000Z",
    "published_at": null
  }
}
```

### `POST /api/v1/schedule-requests/:id/approve`
Behavior:
- validates current hold ownership
- validates `schedules.revision`
- promotes `HELD -> RESERVED`

### `POST /api/v1/schedule-requests/:id/reject`
Behavior:
- releases active reservations
- request becomes `REJECTED`

### `POST /api/v1/schedule-requests/:id/cancel`
Behavior:
- allowed for request owner or admin
- only for `PENDING` or `APPROVED`
- request becomes `CANCELLED`

### `POST /api/v1/schedule-requests/:id/publish`
Behavior:
- requires valid approved reservation ownership
- fails if request is stale or reservation was lost
- success transitions request reservation summary to `PUBLISHED`
- repeat publish is idempotent

## Reservation preview API
### `POST /api/v1/schedule-reservations/preview`
Use this to render authoritative occupancy/conflict state in the scheduler.

Request:
```json
{
  "start_at": "2026-03-20T10:00:00.000Z",
  "end_at": "2026-03-20T11:00:00.000Z",
  "screen_ids": ["uuid"],
  "screen_group_ids": []
}
```

Response:
```json
{
  "resolved_screen_ids": ["uuid"],
  "reservation_conflicts": [
    {
      "screen_id": "uuid",
      "screen_name": "Lobby Screen",
      "start_at": "2026-03-20T10:00:00.000Z",
      "end_at": "2026-03-20T11:00:00.000Z",
      "conflict_start_at": "2026-03-20T10:15:00.000Z",
      "conflict_end_at": "2026-03-20T10:45:00.000Z",
      "state": "RESERVED",
      "hold_expires_at": null,
      "owned_by_current_user": false
    }
  ]
}
```

Render guidance:
- `HELD`: pending request hold
- `RESERVED`: approved request ownership
- `PUBLISHED`: currently published ownership
- `owned_by_current_user = true`: show as informational, not another-user conflict

## Conflict error payload
Submission or direct publish conflicts return:
```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Selected screens already have active schedule ownership for part of this time window.",
    "details": {
      "conflict_type": "SCREEN_TIME_WINDOW_CONFLICT",
      "reservation_conflicts": []
    }
  }
}
```

Frontend should:
- show the screen name
- show the conflicting window
- show the state
- show hold expiry if present
- refetch request detail after approval/publish failures

## Device / player snapshot contract
### `GET /api/v1/device/:deviceId/snapshot`
Headers:
- `x-device-serial: <serial>` or CMS bearer token for inspection
- optional `If-None-Match: "<snapshot_id>"`

Response publish block may now include:
```json
{
  "publish": {
    "publish_id": "uuid",
    "schedule_id": "uuid",
    "snapshot_id": "uuid",
    "published_at": "2026-03-20T10:00:00.000Z",
    "reservation_version": 3,
    "selection_reason": "active_reservation"
  }
}
```

`selection_reason` values:
- `active_reservation`
- `upcoming_reservation`

Player expectations:
- keep using the snapshot endpoint as the production source of truth
- do not resolve booking conflicts on-device
- preserve precedence:
  - emergency
  - scheduled snapshot
  - default media
  - offline
- after publish, backend also queues `REFRESH` device commands for resolved target screens
- player should fetch a fresh snapshot on `REFRESH` and then rely on its local schedule boundary timer for exact `start_at` activation
- CMS realtime sockets are for dashboard/admin refresh, not the player playback authority

## Screen inspection endpoints
Screen inspection routes now align with reservation-driven selection semantics:
- `/api/v1/screens/:id/now-playing`
- `/api/v1/screens/:id/availability`
- `/api/v1/screens/:id/snapshot`

These should not be treated as independent scheduling authorities; they are inspection views over the reservation-backed publish selection model.
