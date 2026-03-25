# Scheduling and Emergency E2E Runbook

## Preconditions
- Postgres schema includes `schedule_reservations` and `schedules.revision`.
- CMS, backend, and player are on the same contract version.
- At least one paired screen exists for live player checks.

## Backend gates
Run from [`signhex-server`](/Users/anuragkumar/Desktop/signhex/signhex-server):
```bash
npm run build
npx vitest run src/routes/schedule-reservations.test.ts src/routes/schedules.publish.test.ts src/routes/device-telemetry-auth.test.ts src/routes/emergency.test.ts
npm run schedule:dry-run
npm run emergency:dry-run
```

## CMS gates
Run from [`signhex-nexus-core`](/Users/anuragkumar/Desktop/signhex/signhex-nexus-core):
```bash
npm run build
```

Manual CMS checks:
1. Create a schedule draft with a valid target window.
2. Open the same target window from another user and verify preview conflict visibility.
3. Submit the first request and confirm it shows `Held`.
4. Approve it and confirm it shows `Reserved`.
5. Publish it and confirm it shows `Published`.
6. Attempt direct conflicting publish and verify deterministic `409`.

## Player gates
Run from [`signage-screen`](/Users/anuragkumar/Desktop/signhex/signage-screen):
```bash
npm run build
```

Manual player checks:
1. Publish an approved request for a screen.
2. Verify a `REFRESH` device command is queued for the target screen.
3. Fetch `/api/v1/device/:deviceId/snapshot?include_urls=true`.
4. Verify `publish.selection_reason = active_reservation` while active.
5. Verify the running player updates within one command poll cycle without restart.
6. Verify emergency still overrides the same screen immediately.
7. Clear emergency and verify scheduled playback resumes.
8. Clear/expire the schedule and verify default media fallback remains intact.

## High-value scenarios
### Overlapping request contention
1. User A submits request for Screen A from 10:00 to 11:00.
2. User B submits request for Screen A from 10:15 to 10:45.
3. Expect User B to receive `409 CONFLICT` with `SCREEN_TIME_WINDOW_CONFLICT`.

### Group conflict expansion
1. Group G contains Screen A and Screen B.
2. User A submits request targeting Group G for 12:00 to 13:00.
3. User B submits request directly targeting Screen B for 12:15 to 12:45.
4. Expect conflict because group membership expands to concrete screen ownership.

### Stale reservation
1. Submit request and obtain `HELD`.
2. Change the schedule or schedule items.
3. Attempt approval or publish.
4. Expect stale reservation conflict tied to `schedules.revision`.

### Idempotent publish
1. Publish an approved request successfully.
2. Repeat the same publish call.
3. Expect the existing publish identity instead of a second conflicting publish.

## Troubleshooting
- `409 SCREEN_TIME_WINDOW_CONFLICT`:
  - inspect `reservation_conflicts[]`
  - check screen/group expansion and overlapping windows
- `STALE_RESERVATION`:
  - schedule changed after hold acquisition
  - cancel/reject and resubmit
- `MISSING_RESERVATION`:
  - hold expired or reservation was released
  - refresh request state before retrying
- snapshot still looks wrong:
  - verify no emergency is active
  - verify reservation rows are `PUBLISHED`
  - verify a recent `REFRESH` device command exists or was acknowledged
  - verify the screen is querying `/api/v1/device/:deviceId/snapshot`
- direct publish unexpectedly blocked:
  - an approved or published request already owns that screen/time window

## Ops note
Hold expiry is opportunistic in v1. If a request was abandoned, any route that touches scheduling ownership should age it out automatically. There is no separate cleanup worker in this version.
