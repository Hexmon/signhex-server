# Scheduling and Emergency Test Matrix

## Reservation and scheduling ownership
- Submit request for screen/time window and verify `HELD`.
- Submit overlapping request for same screen/time from another user and verify `409 CONFLICT`.
- Submit non-overlapping request for same screen and verify success.
- Submit overlapping request on different screen and verify success.
- Submit request using screen group and verify conflicts are evaluated per concrete member screen.
- Retry the same submission and verify idempotent hold response.

## Approval and release
- Approve held request and verify `RESERVED`.
- Reject held request and verify request becomes `REJECTED` and reservations become `RELEASED`.
- Cancel pending request as owner and verify `CANCELLED`.
- Cancel approved request as admin and verify `CANCELLED`.
- Let a hold expire and verify request/reservations become `EXPIRED`.

## Publish and stale write protection
- Publish approved request with valid reservation and verify success.
- Repeat publish for same published request and verify idempotent response.
- Mutate schedule after hold acquisition and verify approval/publish fails with stale reservation conflict.
- Direct admin publish into a reserved window and verify `409`.
- Simultaneous conflicting publish attempts do not both succeed.

## Runtime determinism
- Device snapshot selects active `PUBLISHED` reservation for the screen.
- If no active reservation exists, device snapshot selects nearest upcoming `PUBLISHED` reservation.
- Snapshot publish metadata includes deterministic selection information.
- Screen availability/now-playing endpoints align with reservation-backed selection.
- Publish queues deduplicated `REFRESH` device commands for affected screens.
- Emergency trigger and clear queue `REFRESH` device commands for affected screens.
- A device already running the player updates without restart after the next command poll cycle.

## Emergency and fallback regression
- Emergency still overrides reserved/published schedule playback.
- Clearing emergency returns device to reservation-backed schedule playback.
- Default media still appears when no active published reservation exists.
- Offline/default media flows remain unchanged when there is no publish.

## Operational and UX checks
- Preview API returns authoritative overlaps for selected screens/groups.
- Conflict payload contains screen name, window, state, and hold expiry where applicable.
- Request list/detail exposes `reservation_summary`.
- Submitted/approved schedules cannot be edited in place.
- CMS scheduler shows authoritative conflict feedback before submit and on submit failure.
