# Scheduling and Emergency E2E Runbook

## Backend gates
Run from `signhex-server`:
```bash
npm run build
npx vitest run src/routes/schedules.routes.test.ts src/routes/schedules.publish.test.ts src/routes/device-telemetry-auth.test.ts src/routes/emergency.test.ts
npm run schedule:dry-run
npm run emergency:dry-run
```

## Preconditions
- Database schema includes:
  - `schedules.timezone`
  - `emergencies.expires_at`
  - `emergencies.audit_note`
  - `emergencies.clear_reason`
- Object storage is reachable if other media flows depend on it.
- Device pairing/runtime flows are already working.

## Expected green signals
- Schedule publish dry-run creates schedule, item, publish, device snapshot, and `304` on matching ETag.
- Emergency dry-run creates concurrent global + group emergencies, verifies `GLOBAL` precedence, clears both, and ends inactive.
- Route tests pass for:
  - timezone metadata
  - overlap rejection
  - publish asset validation
  - snapshot ETag
  - emergency precedence
  - clear reason persistence

## Troubleshooting
- `column ... does not exist`:
  - apply the DB delta for schedule/emergency fields before rerunning tests.
- `403` on device snapshot/heartbeat:
  - verify `device_certificates.expires_at` and `x-device-serial`.
- `409` on publish:
  - check codec compatibility and target screen codec metadata.
- `400 INVALID_PRESENTATION_ASSETS`:
  - verify all referenced media rows exist and are `READY`.
- `200` instead of `304` on snapshot re-fetch:
  - verify no active emergency currently changes the payload for that screen.

## Current stage note
This runbook covers backend S0-S2 gates. CMS alignment and player runtime upgrades should use the snapshot/emergency docs above as the authoritative contract.
