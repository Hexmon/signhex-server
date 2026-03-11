# Device Pairing And Device Runtime Lifecycle

This document is the code-truth runbook for screen inventory, device pairing, device authentication, runtime playback, telemetry, proof-of-play, and emergency takeover in the current backend.

For curl-by-curl request and response examples, use [`DEVICE_PAIRING_API_FLOW_WITH_CURLS.md`](/Users/anuragkumar/Desktop/signhex/signhex-server/docs/DEVICE_PAIRING_API_FLOW_WITH_CURLS.md).

Primary code references:
- [`src/routes/device-pairing.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts)
- [`src/middleware/device-auth.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/middleware/device-auth.ts)
- [`src/routes/device-telemetry.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts)
- [`src/routes/screens.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts)
- [`src/screens/playback.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/screens/playback.ts)
- [`src/routes/schedules.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts)
- [`src/routes/schedule-requests.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedule-requests.ts)
- [`src/routes/schedule-publish-helper.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedule-publish-helper.ts)
- [`src/routes/emergency.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/emergency.ts)
- [`src/routes/media.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/media.ts)
- [`src/config/apiEndpoints.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/config/apiEndpoints.ts)
- [`src/server/index.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/server/index.ts)
- [`src/index.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/index.ts)

## Glossary
- `Screen`: Row in `screens`. Inventory/config object. Not proof that a real device is authenticated.
- `Device pairing request`: Row in `device_pairings`. Temporary record used before device completion.
- `Device certificate`: Row in `device_certificates`. Current runtime identity used by `authenticateDeviceOrThrow`.
- `Player session`: Local state on the device: `device_id`, private key, issued certificate, fingerprint, cached snapshot, cached media.
- `Publish snapshot`: Immutable snapshot in `schedule_snapshots`, referenced by `publishes` and `publish_targets`.
- `Heartbeat`: Telemetry write that updates the screen’s live state.
- `PoP`: Proof-of-play log written by device.

## Code Truth And Current Mismatches
- The repo docs mention a separate mTLS device server on `DEVICE_PORT`, but current runtime starts only one Fastify server on `PORT`. See [`src/index.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/index.ts).
- Current device auth is header-based certificate identity, not transport-level TLS client-certificate verification. `authenticateDeviceOrThrow` checks `x-device-serial`/`x-device-cert-serial`/`x-device-cert` against `device_certificates.serial`. See [`src/middleware/device-auth.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/middleware/device-auth.ts).
- Pairing response returns `expires_at` for the issued certificate, and current device auth enforces certificate expiry in addition to `is_revoked` / `revoked_at`. See [`src/routes/device-pairing.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts) and [`src/middleware/device-auth.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/middleware/device-auth.ts).
- There is no screen health route in `src/routes`. Operational health is currently inferred from `last_heartbeat_at`, `screens.status`, `metrics`, `reports`, and realtime screen events.
- There is no dedicated standalone certificate rotation endpoint, but in-place recovery is supported through `POST /api/v1/device-pairing/generate` -> `POST /api/v1/device-pairing/confirm` -> `POST /api/v1/device-pairing/complete` on the same `device_id`. Completing that flow revokes older device certificates for the same screen and issues a fresh one.

## Endpoint Inventory
- `GET /api/v1/screens`
- `GET /api/v1/screens/:id`
- `PATCH /api/v1/screens/:id`
- `DELETE /api/v1/screens/:id`
- `GET /api/v1/screens/:id/status`
- `GET /api/v1/screens/:id/heartbeats`
- `GET /api/v1/screens/:id/now-playing`
- `GET /api/v1/screens/:id/availability`
- `GET /api/v1/screens/:id/snapshot`
- `GET /api/v1/screens/overview`
- `POST /api/v1/device-pairing/request`
- `GET /api/v1/device-pairing/status`
- `POST /api/v1/device-pairing/confirm`
- `POST /api/v1/device-pairing/complete`
- `GET /api/v1/device/:deviceId/snapshot`
- `POST /api/v1/device/heartbeat`
- `POST /api/v1/device/proof-of-play`
- `POST /api/v1/device/screenshot`
- `GET /api/v1/device/:deviceId/commands`
- `POST /api/v1/device/:deviceId/commands/:commandId/ack`
- `POST /api/v1/schedules/:id/publish`
- `POST /api/v1/schedule-requests/:id/publish`
- `POST /api/v1/emergency/trigger`
- `POST /api/v1/emergency/:id/clear`

## State Machines
### Screen Inventory State
States:
- `ABSENT`: no `screens` row
- `REGISTERED_OFFLINE`: `screens` row exists, default or last status is `OFFLINE`
- `REGISTERED_ACTIVE`: `screens.status = ACTIVE`
- `REGISTERED_INACTIVE`: `screens.status = INACTIVE`
- `DELETED`: hard-deleted screen, pairings, certs, telemetry links removed

Transitions:
- `ABSENT -> REGISTERED_OFFLINE`
  - device completes pairing and no screen row exists
- `REGISTERED_* -> REGISTERED_ACTIVE`
  - device heartbeat with `status=ONLINE`
- `REGISTERED_* -> REGISTERED_OFFLINE`
  - device heartbeat with `status=OFFLINE`
- `REGISTERED_* -> REGISTERED_INACTIVE`
  - device heartbeat with `status=ERROR`
- `REGISTERED_* -> DELETED`
  - admin deletes screen with `DELETE /screens/:id`

Entry criteria and exits:
- `REGISTERED_OFFLINE`
  - entry: screen created or device reported `OFFLINE`
  - exit: next heartbeat or delete
- `REGISTERED_ACTIVE`
  - entry: heartbeat `ONLINE`
  - exit: next heartbeat `OFFLINE`/`ERROR`, or delete
- `REGISTERED_INACTIVE`
  - entry: heartbeat `ERROR`
  - exit: next heartbeat `ONLINE`/`OFFLINE`, or delete

Important limitation:
- There is no automatic stale-heartbeat sweeper in code that flips `ACTIVE -> OFFLINE`.
- Operational dashboards must use `last_heartbeat_at` freshness, not only `screens.status`.

### Device Authentication State
States:
- `UNPAIRED`: no local cert, no valid device identity
- `PAIRING_REQUESTED`: `device_pairings` row exists, not confirmed, not used, not expired
- `PAIRING_CONFIRMED`: pairing metadata confirmed by admin, device still has not completed
- `AUTHENTICATED_DEVICE`: valid `device_certificates` row exists and not revoked
- `AUTH_BLOCKED_REVOKED`: certificate row exists but revoked
- `AUTH_BLOCKED_DELETED`: screen/cert deleted
- `AUTH_BLOCKED_CERT_LOST`: local device lost cert/private key, server still has prior cert row

Transitions:
- `UNPAIRED -> PAIRING_REQUESTED`
  - device calls `POST /device-pairing/request`
- `PAIRING_REQUESTED -> PAIRING_CONFIRMED`
  - admin calls `POST /device-pairing/confirm`
- `PAIRING_CONFIRMED -> AUTHENTICATED_DEVICE`
  - device calls `POST /device-pairing/complete`
- `AUTHENTICATED_DEVICE -> AUTH_BLOCKED_REVOKED`
  - cert row revoked via repository/admin tooling
- `AUTHENTICATED_DEVICE -> AUTH_BLOCKED_DELETED`
  - admin deletes screen
- `AUTHENTICATED_DEVICE -> AUTH_BLOCKED_CERT_LOST`
  - local reinstall/wipe loses cert/private key

Important limitation:
- Certificate expiry is generated and returned, but not checked in device auth.

## What The Device Must Persist Locally
- `device_id`
- private key used to create CSR
- server-issued certificate PEM
- fingerprint returned by pairing complete
- last successful snapshot
- cached media by `media_id`
- queued proof-of-play entries not yet sent
- last known commands processed or acknowledged
- screenshot interval settings if device honors them locally

If local disk is wiped:
- the device becomes `AUTH_BLOCKED_CERT_LOST`
- it cannot use device-authenticated endpoints
- it must start pairing again

## Scenario Playbooks
### 1. First-time provisioning: brand new device, no screen row exists
1. Device calls `POST /api/v1/device-pairing/request`
   - no auth
   - server creates `device_pairings` with generated `device_id` and `pairing_code`
2. Device displays pairing code
3. Admin confirms with `POST /api/v1/device-pairing/confirm`
   - bearer token required
   - body:
   ```json
   {
     "pairing_code": "582931",
     "name": "Lobby Screen",
     "location": "Reception"
   }
   ```
4. Device completes with `POST /api/v1/device-pairing/complete`
   - body:
   ```json
   {
     "pairing_code": "582931",
     "csr": "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----"
   }
   ```
5. Backend:
   - creates `device_certificates`
   - creates `screens` row if absent
   - marks pairing used
6. Device stores `device_id`, `certificate`, `fingerprint`
7. Device fetches `GET /api/v1/device/:deviceId/snapshot?include_urls=true`

### 2. Recovery pairing for an existing screen row
This is supported through the existing admin-driven flow:
- `POST /api/v1/device-pairing/generate`
- `POST /api/v1/device-pairing/confirm`
- `POST /api/v1/device-pairing/complete`

Actual behavior:
- admin can generate a pairing code for a known `device_id`
- admin can confirm that pairing even when a `screens` row already exists for that `device_id`
- device completes pairing against that same `device_id`
- `complete` does not create a new screen row when one already exists
- `complete` revokes older device certificates for that same `device_id`
- `complete` issues a fresh device certificate for the existing screen identity

### 2a. Manual screen creation through CMS
Current behavior:
- `POST /api/v1/screens` is intentionally blocked
- backend returns `409 CONFLICT`
- message:
  - `Screens can only be created after a device completes pairing. Use the device pairing flow instead of creating screens manually.`

Operational rule:
- screen rows must originate from successful device pairing completion
- inventory-first manual screen creation is no longer allowed

### 3. Pairing approval rejected or code expires
Current backend behavior:
- there is no explicit reject endpoint for pairing
- device should poll `GET /api/v1/device-pairing/status?device_id=<uuid>`
- if `paired=false` and confirmation never arrives before `expires_at`, the code becomes unusable because repository lookup requires `used=false` and `expires_at > now`
- remediation: request a new pairing with `POST /device-pairing/request`

### 4. Device app restart with cert present
No re-pair required.

Sequence:
1. Load persisted `device_id`, `certificate`, `fingerprint`
2. Resume polling/fetching:
   - `GET /api/v1/device/:deviceId/snapshot?include_urls=true`
   - `POST /api/v1/device/heartbeat`
   - `GET /api/v1/device/:deviceId/commands`
3. If device auth succeeds, runtime resumes immediately

### 5. OS reboot with cert present
Same as app restart.

No new authentication ceremony is required because backend only checks:
- `screen_id`
- serial/fingerprint match
- certificate not revoked

### 6. App reinstall / disk wipe / cert missing
Sequence:
1. Device no longer has local cert/private key/fingerprint
2. Device cannot authenticate to device endpoints
3. Any call to heartbeat/PoP/screenshot/commands/snapshot using device auth fails
4. Device must re-pair

Recommended client action:
- detect missing local identity at boot
- skip device-auth calls
- start fresh pairing flow

### 7. Certificate revoked
Current backend has repository support but no public route.

If certificate row is revoked:
- `authenticateDeviceOrThrow` returns `403 Invalid device credentials`
- remediation requires admin/backend operator action:
  - issue a new certificate via re-pair
  - or un-revoke in DB/admin tooling if that exists outside routes

### 8. Certificate expired
Current code truth:
- `complete` returns `expires_at`
- repository accepts `expires_at`
- auth middleware does not check expiry

Operational meaning:
- expiration is informational only in current runtime
- no automatic auth failure occurs on certificate expiry

### 9. Screen deleted
When admin calls `DELETE /api/v1/screens/:id`, backend deletes:
- `device_commands`
- `heartbeats`
- `proof_of_play`
- `screenshots`
- `publish_targets`
- `device_pairings`
- `device_certificates`
- `screen_group_members`
- `screens`
- related storage objects best-effort

After delete:
- device is no longer registered
- old fingerprint no longer authenticates
- future device calls fail
- remediation: full re-pair

### 10. Network offline during pairing
- `POST /device-pairing/request` fails: device stays unpaired, retry with backoff
- `POST /device-pairing/complete` fails after admin confirm: keep pairing code until expiry and retry `complete`
- if code expires before complete succeeds: request a new pairing

### 11. Network offline during sync/playback
- snapshot fetch fails: continue using last cached snapshot/media
- heartbeat fails: server state becomes stale; no immediate local playback stop should occur
- PoP fails: queue locally and retry later
- command fetch fails: keep last known state, retry

### 12. Media download fails
Current backend exposes presigned `media_urls` in snapshot responses only when `include_urls=true`.

Client behavior should be:
1. Try to use local cached media by `media_id`
2. If missing, download from `media_urls[media_id]`
3. If URL expired or download failed, refetch snapshot for fresh URLs
4. If media still unavailable:
   - skip only that item if possible
   - continue schedule with remaining playable items
   - if nothing playable remains, fall back to default media or idle UI

Code truth:
- backend does not provide checksum validation in snapshot responses
- backend does not report unsupported codec to player
- backend does not dedupe or validate PoP against playback failures

### 13. Schedule fetch returns empty
Possible actual outcomes for `GET /device/:deviceId/snapshot`:
- `publish + snapshot`
- `emergency` only
- `default_media` only
- `404 No publish found for this device`

Client action:
- if emergency exists: play emergency
- else if default media exists: play default media
- else show idle/unconfigured state and retry snapshot later

### 14. Schedule references missing media
Current snapshot builder includes media references from presentation data. URL generation may return `null`.

Client action:
- treat missing `media_urls[media_id]` or failed download as item-level failure
- skip the broken item
- continue with remaining items
- log the missing `media_id`

### 15. Proof-of-play backlog and resend
Current backend behavior:
- every PoP POST inserts a new row
- no idempotency key
- no dedupe

Client requirement:
- maintain a local durable queue
- on reconnect, resend oldest-first
- accept that duplicates can occur if the same event is retried after an ambiguous timeout

### 16. Telemetry burst and rate limiting
Current backend:
- global Fastify rate limit can be enabled at server level
- no device-specific telemetry limiter

Client recommendation:
- heartbeat interval should be steady, not bursty
- on `429 RATE_LIMITED`, apply exponential backoff with jitter

### 17. Emergency takeover begins
Trigger:
- admin calls `POST /api/v1/emergency/trigger`

Backend:
- creates active emergency
- emits `emergency:triggered`
- emits `screens:refresh:required` with reason `EMERGENCY`
- device snapshot endpoints now return `emergency` for affected screens

Player action:
- stop or pause normal schedule rendering
- render emergency media/message immediately
- continue heartbeat and PoP as appropriate for what is actually being shown

### 18. Emergency ends
Trigger:
- admin calls `POST /api/v1/emergency/:id/clear`

Backend:
- clears emergency
- emits `emergency:cleared`
- emits `screens:refresh:required` with reason `EMERGENCY`

Player action:
- refetch snapshot
- resume schedule or default media based on current snapshot response

## Runtime Call Sequences
### Boot sequence with valid local identity
1. Load local state
2. `GET /api/v1/device/:deviceId/snapshot?include_urls=true`
3. Start playback
4. Start heartbeat loop: `POST /api/v1/device/heartbeat`
5. Start command loop:
   - prefer command list included in heartbeat response
   - optionally also call `GET /api/v1/device/:deviceId/commands`
6. On each media completion or interval, queue/send `POST /api/v1/device/proof-of-play`

### Recommended steady-state intervals
Code does not enforce these intervals. Operationally reasonable defaults:
- snapshot poll: every 30-60s
- heartbeat: every 15-60s depending on fleet size
- command poll: every 15s if not relying only on heartbeat response
- screenshot: only on command or configured interval

## Endpoint-by-Endpoint Notes
### `POST /api/v1/device-pairing/request`
Purpose:
- create temporary pairing and device id

Safe to retry:
- yes, but each success creates a new pairing row and likely a new `device_id`

Client rule:
- do not blindly spam retries
- if request times out and response is ambiguous, prefer showing retry UI instead of assuming success

### `GET /api/v1/device-pairing/status`
Purpose:
- ask whether device is already paired/confirmed

Safe to retry:
- yes

### `POST /api/v1/device-pairing/confirm`
Purpose:
- admin marks pairing as approved and names the screen

Safe to retry:
- conditionally
- repeat confirm on same unexpired code is mostly safe
- if screen already exists, server returns conflict

### `POST /api/v1/device-pairing/complete`
Purpose:
- issue device certificate and finalize registration

Safe to retry:
- only until success or code expiry
- once code is marked used, repeating complete will fail

### `GET /api/v1/device/:deviceId/snapshot`
Purpose:
- current device runtime source of truth

Safe to retry:
- yes

### `POST /api/v1/device/heartbeat`
Purpose:
- telemetry + server live state update + command delivery

Safe to retry:
- not strictly idempotent
- repeated retries create extra heartbeat rows
- operationally acceptable, but client should avoid burst retries

### `POST /api/v1/device/proof-of-play`
Purpose:
- audit/log actual play

Safe to retry:
- not idempotent
- retries can create duplicate PoP rows

### `GET /api/v1/device/:deviceId/commands`
Purpose:
- fetch pending commands and mark them `SENT`

Safe to retry:
- partially
- repeated calls after first fetch may return fewer/no commands because status changed from `PENDING` to `SENT`

### `POST /api/v1/device/:deviceId/commands/:commandId/ack`
Purpose:
- mark command acknowledged

Safe to retry:
- mostly yes if same command still exists
- if command missing, returns `404`

## Error Catalog And Client Remediation
| Endpoint | Status | Error code/message | Meaning | Client action |
| --- | --- | --- | --- | --- |
| pairing confirm/create/list CMS routes | 401 | `UNAUTHORIZED` / `Missing authorization header` | no JWT | re-auth admin |
| any JWT route | 401 | `UNAUTHORIZED` / `Invalid token` | expired or malformed JWT | re-auth |
| device-auth route | 401 | `UNAUTHORIZED` / `Missing device identity header` | no device serial header and no allowed user JWT fallback | send device identity or stop |
| device-auth route | 403 | `FORBIDDEN` / `Device credentials expired` | cert exists but `expires_at` has passed | enter recovery; re-pair device |
| device-auth route | 403 | `FORBIDDEN` / `Invalid device credentials` | no matching cert, revoked cert, deleted screen/cert | require re-pair or admin intervention |
| `POST /device-pairing/complete` | 404 | `NOT_FOUND` / `Invalid or expired pairing code` | wrong code, used code, expired code | start new pairing |
| `POST /device-pairing/confirm` | 404 | `NOT_FOUND` / `Invalid or expired pairing code` | admin used stale code | refresh pairings and retry with new code |
| `POST /device-pairing/complete` | 409 | `CONFLICT` / `Pairing not confirmed` | device tried complete before admin confirm | poll status and wait |
| `POST /device-pairing/complete` | 409 | `CONFLICT` / `CSR deviceId does not match pairing deviceId` | CSR bound to wrong device id | regenerate CSR with correct subject |
| `POST /device-pairing/confirm` | 409 | `CONFLICT` / `Screen already exists for this device` | device_id already has screen row | investigate duplicate/reuse |
| `POST /device-pairing/complete` | 400 | `BAD_REQUEST` / `Invalid CSR format` | malformed CSR | regenerate CSR |
| `POST /device-pairing/complete` | 500 | `CA_CERT_MISSING` | CA cert file missing on server | operator fix required; do not retry aggressively |
| `GET /device/:deviceId/snapshot` | 404 | `NOT_FOUND` / `No publish found for this device` | no publish and no default media and no emergency | show idle/unconfigured screen; retry later |
| `POST /device/heartbeat` | 404 | `NOT_FOUND` / `Device not registered` | screen row missing | re-pair or admin recreate |
| `GET/POST /device/:deviceId/commands*` | 404 | `NOT_FOUND` / `Command not found` | bad or stale command id | drop local command ack |
| schedule publish | 400 | `BAD_REQUEST` / `No target screens found for publish` | schedule or request resolves to no screens | admin must fix targets |
| emergency trigger | 409 | `CONFLICT` / `Emergency already active` | only one active emergency allowed | fetch current emergency, do not retry |
| any zod-validated route | 422 | `VALIDATION_ERROR` | request body/query invalid | fix payload, no blind retry |
| any route under global limiter | 429 | `RATE_LIMITED` | server rate limit exceeded | exponential backoff with jitter |
| unexpected path | 500 | `INTERNAL_ERROR` | unhandled backend issue | retry with backoff, preserve local state |

## Retry And Backoff Guidance
### Safe retry classes
- safe GETs:
  - `GET /device-pairing/status`
  - `GET /device/:deviceId/snapshot`
  - `GET /screens/:id/snapshot`
  - `GET /screens/overview`
- recommended policy:
  - initial delay 1s
  - multiplier 2x
  - jitter 20%
  - max delay 60s

### Conditional retry
- `POST /device-pairing/request`
  - retry only when client knows previous request definitely failed
  - ambiguous timeout can create multiple pairings
- `POST /device-pairing/complete`
  - retry only while code is still valid and not used
- `POST /device/heartbeat`
  - retry a small number of times, but avoid bursts
  - acceptable to drop a heartbeat and wait until next interval

### Non-idempotent endpoints
- `POST /device/proof-of-play`
  - duplicates possible on retry
  - player should use local queue but understand duplicates can happen
- `GET /device/:deviceId/commands`
  - read has side effect: `PENDING -> SENT`
  - avoid concurrent duplicate polls

### Practical policy by call class
- auth/pairing:
  - `request`: up to 3 attempts, 1s/2s/4s
  - `complete`: up to code expiry, spaced 5s+ with operator-visible state
- snapshot:
  - infinite retry with 1s to 60s backoff
- media download:
  - 2-3 attempts per URL
  - if still failing, refetch snapshot for new URLs
- heartbeat:
  - no more than 2 quick retries, then resume normal interval
- PoP:
  - queue locally, flush oldest-first when network returns

## Emergency Precedence
Order of precedence in runtime responses:
1. emergency media if active and targeted
2. heartbeat-reported current media for playback summary
3. current active schedule item media
4. default media
5. nothing

Actual derivation lives in [`src/screens/playback.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/screens/playback.ts).

Important nuance:
- playback summary may show `source = HEARTBEAT` if `screens.current_media_id` exists
- snapshot response is still the device’s actual playlist source of truth
- emergency overrides schedule rendering in both screen snapshot and device snapshot handlers

## Operational Runbook
### If device cannot authenticate
Check:
1. local `device_id`
2. local fingerprint header being sent
3. `device_certificates` row exists for `screen_id = device_id`
4. `is_revoked` / `revoked_at`
5. screen was not deleted

### If device says paired but playback does not start
Check:
1. `GET /device-pairing/status`
2. `GET /device/:deviceId/snapshot?include_urls=true`
3. whether response is:
   - emergency only
   - default media only
   - `404 No publish found`
4. `publish_targets` for that screen

### If screen shows stale online state
Check:
1. `screens.last_heartbeat_at`
2. latest `heartbeats` row
3. dashboard logic should use freshness threshold, not `status` alone

### If media does not play
Check:
1. `snapshot.media_urls`
2. `GET /media/:id`
3. whether API downgrades broken `READY` media to `FAILED` with `status_reason = MEDIA_OBJECT_MISSING`
4. local codec support on player

### If emergency does not appear
Check:
1. active emergency exists
2. target screens/group ids include this screen
3. device refetched snapshot or received refresh event

## Player Implementer Checklist
- persist `device_id`, cert, fingerprint, cached snapshot, cached media
- support full re-pair when local identity is missing
- treat snapshot as source of truth for schedule
- treat emergency as hard override
- keep playback running from cache during transient server/network failures
- queue PoP locally
- avoid concurrent command polls
- use heartbeat response commands to reduce polling
- use `last_heartbeat_at` and snapshot versioning to drive UI

## Existing Doc Mismatches
- [`DEVICE_PLAYER_GUIDE.md`](/Users/anuragkumar/Desktop/signhex/signhex-server/DEVICE_PLAYER_GUIDE.md)
- [`docs/DESKTOP_PLAYER_INTEGRATION.md`](/Users/anuragkumar/Desktop/signhex/signhex-server/docs/DESKTOP_PLAYER_INTEGRATION.md)
- [`PLAYER_FLOW.md`](/Users/anuragkumar/Desktop/signhex/signhex-server/PLAYER_FLOW.md)

These docs are directionally useful, but current code truth differs in these places:
- no separate device server is started on `DEVICE_PORT`
- no transport-level mTLS enforcement is visible in server code
- certificate expiry is not enforced in runtime auth
- `GET /device/:deviceId/commands` mutates command state from `PENDING` to `SENT`
- PoP is not idempotent

## Recommended Minimal Fixes Outside This Doc
- enforce certificate expiry in [`src/middleware/device-auth.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/middleware/device-auth.ts)
- add explicit certificate rotation/revocation admin routes
- add heartbeat stale-state sweeper
- add idempotency key support for proof-of-play
- add a real device health endpoint if operations need one
