# Scheduling and Emergency Spec

## Problem summary
Before this change, SignHex behaved like a governed request flow in the CMS but like a `last publish wins` system in the backend:
- selecting a screen did not reserve it
- submitting a request did not reserve it
- approving a request did not reserve it
- two users could approve and publish overlapping windows for the same screen
- runtime then picked the newest publish for the screen

That was not acceptable for governed enterprise scheduling. The backend is now the authority for time-window ownership.

## Reservation ownership model
The scheduling lifecycle is now:
- `draft`: local CMS work only, no backend lock
- `held`: created on request submission; temporary ownership with TTL
- `reserved`: created on approval; durable ownership for the approved request
- `published`: created when a valid reservation is published; runtime uses this state
- `released`: reservation was explicitly released, usually on rejection
- `expired`: a hold timed out before approval/publish
- `cancelled`: request owner or admin cancelled the request

Emergency precedence is unchanged:
- `EMERGENCY > PUBLISHED SCHEDULE > DEFAULT MEDIA > OFFLINE`

## Conflict rule
Conflict is evaluated per resolved concrete screen, not per group id.

Two windows conflict when:

```text
existing.start_at < incoming.end_at
AND incoming.start_at < existing.end_at
```

The comparison uses `[start_at, end_at)` semantics. If a group is selected, it is expanded to member screens first, and overlap is checked for each screen independently.

## Data model
New or changed storage:
- `schedule_reservations`
- `schedules.revision`
- `schedule_requests.reservation_token`
- `schedule_requests.reservation_version`
- `schedule_requests.reservation_state`
- `schedule_requests.hold_expires_at`
- `schedule_requests.published_at`
- `schedule_request_status` now includes:
  - `CANCELLED`
  - `PUBLISHED`
  - `EXPIRED`

`schedule_reservations` stores one row per:
- concrete `screen_id`
- `schedule_item_id`
- request or direct publish ownership window

Active ownership states are:
- `HELD`
- `RESERVED`
- `PUBLISHED`

The database enforces overlap exclusion for those active states on the same screen/time range.

## Lifecycle
### 1. Draft
- CMS may preview conflicts.
- No reservation row is created.

### 2. Submission
- `POST /api/v1/schedule-requests`
- backend resolves concrete screens from direct targets and groups
- backend creates `HELD` rows with a shared `reservation_token`
- hold TTL is currently `4 hours`
- conflicting active hold/reserved/published rows cause `409 CONFLICT`

### 3. Approval
- `POST /api/v1/schedule-requests/:id/approve`
- request must still own valid `HELD` rows
- `schedules.revision` must still match `reservation_version`
- rows are promoted `HELD -> RESERVED`

### 4. Reject / cancel / expiry
- reject releases active rows as `RELEASED`
- cancel releases active rows as `CANCELLED`
- expired holds become `EXPIRED`
- request status is updated to match the lifecycle outcome

### 5. Publish
- request publish requires:
  - request status `APPROVED`
  - matching reservation token/version
  - current `schedules.revision`
  - active `RESERVED` rows still owned by the request
- publish and reservation finalization happen in the same transaction
- successful publish transitions rows `RESERVED -> PUBLISHED`
- repeated publish for an already-published request is idempotent and returns the existing publish
- after publish commit, backend dispatches playback refreshes to target screens:
  - Socket.IO `screens:refresh:required` for CMS/admin consumers
  - deduplicated `REFRESH` device commands for the actual screens

### Direct admin publish
- `POST /api/v1/schedules/:id/publish`
- still supported
- now acquires `PUBLISHED` reservation rows in the same transaction
- conflicting active ownership returns `409` instead of silently overriding another request

## Concurrency and determinism
### Why simultaneous publish no longer silently races
- active ownership is enforced in Postgres, not only in application memory
- the exclusion constraint prevents two active overlapping owners on the same screen
- publish validates request ownership before the snapshot is finalized

### Stale writer protection
- `schedules.revision` increments on schedule and schedule-item mutation
- request holds capture the current `reservation_version`
- approval/publish fail if the schedule revision changed after hold acquisition

### Runtime determinism
Runtime no longer selects schedule authority by plain latest publish target alone.

For a device/screen:
1. resolve emergency
2. pick active `PUBLISHED` reservation for the screen
3. if none are active, pick nearest upcoming `PUBLISHED` reservation by:
   - `start_at ASC`
   - `published_at DESC`
   - `publish_id DESC`
4. otherwise fall back to default media / no publish

Where a latest-publish query is still needed for history, ordering must include a stable secondary tie-breaker.

## CMS / API contract
### Preview
- `POST /api/v1/schedule-reservations/preview`

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
      "screen_name": "Lobby",
      "start_at": "2026-03-20T10:00:00.000Z",
      "end_at": "2026-03-20T11:00:00.000Z",
      "conflict_start_at": "2026-03-20T10:15:00.000Z",
      "conflict_end_at": "2026-03-20T10:45:00.000Z",
      "state": "HELD",
      "hold_expires_at": "2026-03-20T09:30:00.000Z",
      "owned_by_current_user": false
    }
  ]
}
```

### Conflict error
Submission/publish conflicts return:
- HTTP `409`
- `error.code = CONFLICT`
- `details.conflict_type = SCREEN_TIME_WINDOW_CONFLICT`
- `details.reservation_conflicts[]`

### Request detail/list
Schedule request payloads now include:
```json
{
  "reservation_summary": {
    "state": "HELD",
    "token": "uuid",
    "version": 3,
    "hold_expires_at": "2026-03-20T09:30:00.000Z",
    "published_at": null
  }
}
```

## Player contract
Player remains intentionally simple:
- no booking logic on-device
- one snapshot remains the runtime source of truth
- emergency/default/offline precedence is unchanged

Optional publish metadata may include:
- `selection_reason`
- `reservation_version`

The player must not infer or resolve ownership conflicts itself.

## Device refresh delivery
- A newly published schedule is not expected to wait for the long snapshot poll.
- Backend queues `REFRESH` commands for affected screens on publish and emergency playback changes.
- The player polls commands, fetches a fresh snapshot immediately, and then activates the correct window at the exact boundary using its local timer.
- Default media is fallback only when no active scheduled playback or emergency content is available.

## Operational caveats
- hold expiry is opportunistic in v1; there is no background cleanup worker
- submitted or approved schedules should not be edited in place; cancel/reject and resubmit instead
- direct admin publish respects the same overlap protection
- reservation rows themselves are the audit trail for hold, reserve, publish, and release transitions
