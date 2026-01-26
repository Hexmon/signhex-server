# Desktop Player Integration (post-confirm flow)

This flow is derived from code (routes + utils) and the existing player guides. Key refs:
- /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts
- /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts
- /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts
- /Users/anuragkumar/Desktop/signhex/signhex-server/src/utils/default-media.ts
- /Users/anuragkumar/Desktop/signhex/signhex-server/DEVICE_PLAYER_GUIDE.md
- /Users/anuragkumar/Desktop/signhex/signhex-server/PLAYER_FLOW.md

## 0) Auth + transport (what code actually enforces)
- Device snapshot endpoint allows either:
  - Device certificate fingerprint via `x-device-serial` or `x-device-cert-serial` header (validated against `device_certificates.serial`), or
  - CMS JWT (Authorization header).
  Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts authenticateDeviceSnapshot.
- Other device endpoints (heartbeat/PoP/screenshot/commands) do not validate device auth in code; they assume mTLS or trusted network upstream.
- Config defines `DEVICE_PORT=8443` but server listens only on `PORT` (default 3000). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/config/index.ts, /Users/anuragkumar/Desktop/signhex/signhex-server/src/index.ts.

## 1) Pairing flow end-to-end

### 1.1 Device requests pairing
- `POST /api/v1/device-pairing/request` (public)
- Response includes `device_id` + `pairing_code` + `expires_at`.
- Side effects: creates `device_pairings` row. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts fastify.post(apiEndpoints.devicePairing.request)

### 1.2 Admin confirms pairing (CMS)
- `POST /api/v1/device-pairing/confirm` with JWT
- Body: `{ pairing_code, name, location? }`
- Side effects: creates `screens` row (screen id == device_id). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts fastify.post(apiEndpoints.devicePairing.confirm)

### 1.3 Device completes pairing and stores identity
- `POST /api/v1/device-pairing/complete` (public)
- Body: `{ pairing_code, csr }`
- Server reads `CA_CERT_PATH` and issues a PEM certificate by HMAC (not real CA signing).
- Response: `{ device_id, certificate, fingerprint, expires_at }`
- Side effects: inserts `device_certificates` row; marks pairing used.
- Device should store:
  - `device_id`
  - Private key + CSR material (generated on device)
  - Server-issued certificate (PEM)
  - `fingerprint` (used as device serial header)
- Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts fastify.post(apiEndpoints.devicePairing.complete)

## 2) Immediately after confirm: determine what to play

### 2.1 Fetch snapshot (device)
- Call `GET /api/v1/device/:deviceId/snapshot?include_urls=true`
- Auth: include `x-device-serial` (fingerprint) or JWT.
- Response cases (from code):
  1) **Publish found**: `publish + snapshot + media_urls + emergency?`
  2) **Emergency active**: `publish=null`, `snapshot=null`, `emergency` populated, `default_media` optional
  3) **No publish, default media set**: `default_media` populated
  4) **No publish, no default**: 404 NOT_FOUND
- Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts fastify.get(apiEndpoints.deviceTelemetry.snapshot)

### 2.2 Rule for playback
- If `emergency` exists: render emergency media full-screen; pause normal playback.
- Else if `publish` exists: build timelines from `snapshot.schedule.items` (already filtered for screen/group).
- Else if `default_media` exists: render default media.
- Else: show idle/offline screen.

## 3) Schedule/snapshot mechanics

- `snapshot.schedule.items` includes `start_at`, `end_at`, `priority`, `presentation` (with `items` and/or `slots`).
- Items are already filtered by server for screen and screen group targets.
- Use `publish.published_at` as a version to decide whether to rebuild timelines.
- Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts filterItemsForScreen + snapshot response.

## 4) Media URLs + caching strategy

- If `include_urls=true`, response includes `media_urls` map keyed by `media_id`.
- URLs are presigned for 3600 seconds. Ref: `getPresignedUrl(..., 3600)` in /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts.
- Caching guidance:
  - Cache by `media_id` (primary key).
  - If `media_urls[media_id]` is null, skip item and log.
  - If download fails due to URL expiry, refetch snapshot for fresh URLs.
  - Persist last successful snapshot on disk for offline fallback (DEVICE_PLAYER_GUIDE.md).

## 5) Polling + refresh strategy (recommended)

- Snapshot refresh: every 30-60s (DEVICE_PLAYER_GUIDE.md suggests 60s). Use `publish.published_at` to detect changes.
- Commands refresh: every ~15s (DEVICE_PLAYER_GUIDE.md suggests 15s) OR piggyback on heartbeat response.
- Offline behavior:
  - If snapshot fetch fails, keep playing cached timelines until the last item expires.
  - If no valid items remain, show default/idle screen.
- Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/DEVICE_PLAYER_GUIDE.md

## 6) Telemetry loop

### 6.1 Heartbeat
- `POST /api/v1/device/heartbeat`
- Body includes device metrics; only `device_id`, `status`, `uptime`, `memory_usage`, `cpu_usage` are required by schema.
- Response includes `commands[]` (pending commands), so you can skip a separate poll when heartbeat is frequent.
- Side effects: stores JSON in MinIO `logs-heartbeats`, inserts heartbeats row, updates screen status fields.
- Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts fastify.post(apiEndpoints.deviceTelemetry.heartbeat)

### 6.2 Commands (optional polling)
- `GET /api/v1/device/:deviceId/commands` returns PENDING commands and marks them SENT.
- `POST /api/v1/device/:deviceId/commands/:commandId/ack` marks ACKNOWLEDGED.
- Supported command types: `REBOOT`, `REFRESH`, `TEST_PATTERN`, `TAKE_SCREENSHOT`, `SET_SCREENSHOT_INTERVAL`.
- Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts createCommandSchema + commands endpoints.

### 6.3 Proof of Play
- `POST /api/v1/device/proof-of-play`
- Payload: `{ device_id, media_id, schedule_id, start_time, end_time, duration, completed }`.
- Side effects: writes PoP record + stores JSON in MinIO `logs-proof-of-play`.
- No idempotency handling in code; repeated submissions create multiple records.
- Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts fastify.post(apiEndpoints.deviceTelemetry.proofOfPlay)

### 6.4 Screenshot upload
- `POST /api/v1/device/screenshot`
- Payload: `{ device_id, timestamp, image_data }` (base64)
- Side effects: uploads PNG to MinIO `device-screenshots`.
- Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts fastify.post(apiEndpoints.deviceTelemetry.screenshot)

## 7) Default media fallback

- Default media is stored in settings key `default_media_id`.
- If no publish exists, snapshot returns `{ default_media }` when configured; otherwise 404.
- Default media URL is generated via presigned URL (3600s).
- Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/utils/default-media.ts and /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts snapshot handler.

## 8) Error handling expectations (device)

- 401 UNAUTHORIZED: missing/invalid JWT or invalid device serial header.
- 403 FORBIDDEN: JWT lacks `Screen` read permissions (snapshot only).
- 404 NOT_FOUND: no publish + no default media; invalid ids; command not found.
- 409 CONFLICT: CSR deviceId mismatch, screen already exists, etc.
- 429 RATE_LIMITED: global rate limit (if enabled).
- 500 INTERNAL_ERROR / CA_CERT_MISSING: server error or missing CA cert.
- Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/utils/app-error.ts, /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts

Recommended handling:
- 401/403: re-check device identity and headers; for CMS JWT calls, re-authenticate and retry.
- 409: treat as non-retryable unless the device regenerated CSR or pairing code.
- 429: exponential backoff (e.g., 1s, 2s, 4s, max 60s).
- 5xx: retry with backoff; keep last cached snapshot active.

JWT expiry note (CMS only): `JWT_EXPIRY` is seconds (default 900). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/config/index.ts.

## 9) Minimal device flow summary (sequence)

1) Device boot:
   - Load cached `device_id`, cert, cached media, last snapshot.
2) If no cert:
   - `POST /device-pairing/request`
   - Admin `POST /device-pairing/confirm`
   - Device `POST /device-pairing/complete` and store cert + fingerprint
3) Fetch snapshot:
   - `GET /device/:deviceId/snapshot?include_urls=true`
4) Playback:
   - If emergency -> play emergency
   - Else if publish -> build timelines from `snapshot.schedule.items`
   - Else if default_media -> play it
5) Telemetry loop:
   - Heartbeat every N seconds (include current_schedule_id/current_media_id)
   - Commands: use heartbeat response and/or `GET /device/:deviceId/commands`
   - PoP on media start and end (or at completion if you only report once)
   - Screenshot upload when commanded
6) Refresh:
   - Poll snapshot every 30-60s or on `REFRESH` command
