# Emergency Takeover Frontend and Player Contract

## Trigger
### `POST /api/v1/emergency/trigger`
Request:
```json
{
  "emergency_type_id": "uuid",
  "message": "Optional ad hoc message",
  "severity": "CRITICAL",
  "media_id": "uuid",
  "target_all": true,
  "screen_ids": [],
  "screen_group_ids": [],
  "expires_at": "2026-03-14T12:00:00.000Z",
  "audit_note": "Evacuation notice"
}
```
Rules:
- Exactly one scope is allowed: `target_all`, `screen_ids`, or `screen_group_ids`.
- Multiple active emergency rows are allowed.
- Missing media references are rejected.

## Status
### `GET /api/v1/emergency/status`
Response:
```json
{
  "active": true,
  "active_count": 2,
  "emergency": { "id": "uuid", "scope": "GLOBAL" },
  "active_emergencies": []
}
```
Rules:
- `emergency` is the highest-precedence active emergency in admin view ordering.
- `active_emergencies` contains all active rows with lifecycle metadata.

## Clear
### `POST /api/v1/emergency/:id/clear`
Request:
```json
{
  "clear_reason": "Incident resolved"
}
```
Behavior:
- Sets `cleared_at`, `cleared_by`, `clear_reason`, and `is_active=false`.

## Player behavior
- Player consumes only the resolved `emergency` embedded in device snapshot.
- Resolver precedence is `GLOBAL > GROUP > SCREEN`, then severity, then newest record.
- If emergency is present in snapshot, it overrides scheduled/default playback immediately.
- On clear or expiry, player returns to schedule evaluation without reboot.
- Offline player continues using last cached emergency only while it remains the last known authoritative snapshot state.
