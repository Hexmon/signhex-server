# Scheduling and Emergency Test Matrix

## Scheduling
- Create schedule with UTC windows and timezone metadata.
- Reject invalid timezone.
- Reject `start_at >= end_at`.
- Reject schedule item outside schedule bounds.
- Reject overlapping schedule items for same effective targets.
- Publish succeeds with valid presentation/layout/media graph.
- Publish rejects missing presentation.
- Publish rejects missing layout.
- Publish rejects missing media.
- Publish rejects non-`READY` media.
- Publish rejects unsupported screen codec.
- Device snapshot returns latest successful publish for target screen.
- Device snapshot returns `ETag` and `304` on matching `If-None-Match`.
- Offline player catch-up uses `snapshot_id` / `published_at`.

## Emergency
- Trigger global emergency.
- Trigger group emergency concurrently with global.
- Trigger screen emergency concurrently with group/global.
- Resolver precedence is `GLOBAL > GROUP > SCREEN`.
- Same-scope precedence is severity then recency.
- Expired emergency is ignored by resolver.
- Clear persists `clear_reason`.
- Status returns `active_count` and `active_emergencies`.
- History returns lifecycle and scope metadata.
- Trigger rejects mixed scope payload.
- Unauthorized trigger/clear blocked.

## Resilience
- Schedule dry-run passes.
- Emergency dry-run passes.
- Existing screens/device lifecycle dry-runs remain green.
- Device snapshot still works with default media only.
- Emergency does not break default-media fallback contract.
