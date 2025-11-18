# Signhex Player API Guide (Electron Screen App)

This guide lists only the CMS endpoints the Electron screen app should call. These endpoints are device-facing and currently do **not** require Bearer auth (mTLS/edge auth TBD). Send/receive JSON unless noted.

## Base
- Base URL: `{{baseURL}}` (e.g., `http://localhost:3000`)
- Common headers: `Content-Type: application/json`
- Errors: `{ "error": string }`

## Device Pairing (out-of-band provisioning)
- **POST /v1/device-pairing/generate** (admin-initiated; not called by player)  
  Body: `{ device_id, expires_in? }` → `{ pairing_code }`
- **POST /v1/device-pairing/complete** (player)  
  Body: `{ pairing_code, csr }` → `{ success, device_id }`  
  Use when pairing with a code shown on screen.
- **GET /v1/device-pairing** (admin) — listing; not used by player.

## Telemetry (Player → CMS)
- **POST /v1/device/heartbeat**  
  Body: `{ device_id, status: ONLINE|OFFLINE|ERROR, uptime, memory_usage, cpu_usage, temperature?, current_schedule_id?, current_media_id? }`  
  Response: `{ success, timestamp, commands: [] }` (commands currently empty).
- **POST /v1/device/proof-of-play**  
  Body: `{ device_id, media_id, schedule_id, start_time, end_time, duration, completed }`  
  Response: `{ success, timestamp }`
- **POST /v1/device/screenshot**  
  Body: `{ device_id, timestamp, image_data: <base64 PNG> }`  
  Response: `{ success, object_key, timestamp }`

## Commands (CMS → Player)
- **GET /v1/device/:deviceId/commands**  
  Response: `{ commands: [ { id, type, ... } ] }` (currently returns empty list; extend when commands are implemented).
- **POST /v1/device/:deviceId/commands/:commandId/ack**  
  Body: `{}`  
  Response: `{ success, timestamp }` — acknowledge execution.

## Content Fetching (Player pulls assets)
The CMS currently stores uploaded media in MinIO/S3; player should be given/hold signed URLs via schedule manifests (future). There is no dedicated player manifest endpoint yet; coordinate with backend for a schedule snapshot/download URL if added.

## Notes / Auth
- These device routes are unauthenticated in the current codebase. If mTLS or token auth is added later, include the required headers/certs accordingly.
- Pairing flow: operator generates code → player calls `/v1/device-pairing/complete` with CSR and code.
- Commands are stubbed; expect empty arrays until command dispatch is implemented.
