# Scheduling and Emergency Spec

## Current implemented model
- Player content authority is `GET /api/v1/device/:deviceId/snapshot`.
- Schedule publishes create immutable `schedule_snapshots` rows and `publishes` rows.
- Device snapshot selection is `latest publish targeting this screen wins`.
- Snapshot payload preserves schedule metadata, time-windowed items, presentation data, layout data, and slot media data.
- Device heartbeat reports `current_schedule_id` and `current_media_id` back into `screens`.
- Emergency resolution is now screen-aware and supports multiple active emergency rows.
- Winning emergency precedence is: `GLOBAL > GROUP > SCREEN`, then severity, then newest created record.
- Default media remains a lower-priority fallback behind emergency and scheduled content.

## Scheduling rules
- Execution windows remain absolute UTC via `start_at` and `end_at`.
- `schedules.timezone` is additive metadata for audit/display only.
- Within one schedule, overlapping items for the same effective targets are rejected.
- Across publishes, the most recent successful publish targeting a screen is authoritative for that screen.
- Publish is atomic across `schedule_snapshots`, `publishes`, and `publish_targets`.
- Publish rejects missing presentations, missing layouts, missing media, and non-`READY` media.

## Emergency rules
- Emergency routes remain:
  - `POST /api/v1/emergency/trigger`
  - `GET /api/v1/emergency/status`
  - `POST /api/v1/emergency/:id/clear`
  - `GET /api/v1/emergency/history`
- Trigger payload now supports additive fields:
  - `expires_at`
  - `audit_note`
- Clear payload now supports:
  - `clear_reason`
- Trigger requires exactly one target scope:
  - `target_all`
  - `screen_ids`
  - `screen_group_ids`
- Expired emergencies are treated as inactive by the resolver even if cleanup lags.

## Device contract summary
- Device uses the snapshot endpoint for schedule, emergency, and default media.
- Snapshot response now exposes stable publish identity:
  - `publish.snapshot_id`
  - `publish.published_at`
- Snapshot endpoint emits `ETag` based on `snapshot_id` and honors `If-None-Match` when no emergency override is changing the payload.
- Device should treat emergency in snapshot as authoritative and immediate.

## Current gaps and severity
### MUST-FIX completed in this pass
- Multiple active emergencies with deterministic precedence.
- Snapshot version/ETag contract for device sync.
- Publish-time validation of missing/non-ready presentation assets.
- Backend dry-run gates for scheduling and emergency.

### SHOULD-FIX next
- CMS emergency modal is still not aligned with backend contract.
- Player still contains legacy `schedule-manager` paths that must not drive production behavior.
- Player runtime still needs true absolute-time schedule evaluation and layout-aware rendering.

### NICE-TO-HAVE
- Auto-expiry cleanup job to mark expired emergencies inactive proactively.
- More granular audit payloads if downstream audit consumers require field-level diffs.
