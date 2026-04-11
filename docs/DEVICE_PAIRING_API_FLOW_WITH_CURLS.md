# Device Pairing API Flow With Curls

This document is the curl-first companion to [`DEVICE_PAIRING_AND_DEVICE_RUNTIME_LIFECYCLE.md`](/Users/anuragkumar/Desktop/signhex/signhex-server/docs/DEVICE_PAIRING_AND_DEVICE_RUNTIME_LIFECYCLE.md).

It reflects current code behavior in:
- [`src/routes/device-pairing.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts)
- [`src/routes/device-telemetry.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts)
- [`src/middleware/device-auth.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/middleware/device-auth.ts)
- [`src/config/apiEndpoints.ts`](/Users/anuragkumar/Desktop/signhex/signhex-server/src/config/apiEndpoints.ts)

## Overview

There are two actors in this flow:

- `Signage Screen`: the player/device running on the display hardware
- `CMS`: the admin/operator web app or backend admin tooling

Core rule:
- A screen row is created only after `POST /api/v1/device-pairing/complete` succeeds.
- The device is not authenticated until pairing completes and a device certificate row exists.

## End-to-End Sequence

1. `Signage Screen` calls `POST /api/v1/device-pairing/request`
2. `Signage Screen` displays `pairing_code`
3. `Signage Screen` polls `GET /api/v1/device-pairing/status?device_id=<device_id>`
4. `CMS` calls `POST /api/v1/device-pairing/confirm`
5. `Signage Screen` calls `POST /api/v1/device-pairing/complete`
6. `Signage Screen` stores `device_id`, `certificate`, `fingerprint`, `ca_certificate`
7. `Signage Screen` starts runtime calls:
   - `POST /api/v1/device/heartbeat`
   - `GET /api/v1/device/:deviceId/commands`
   - `POST /api/v1/device/:deviceId/commands/:commandId/ack`
   - `POST /api/v1/device/proof-of-play`
   - `POST /api/v1/device/screenshot`

## 1. Device Requests Pairing Code

Actor:
- `Signage Screen`

Endpoint:
- `POST /api/v1/device-pairing/request`

Why this call exists:
- creates a temporary `device_pairings` row
- generates a fresh `device_id`
- generates a short-lived `pairing_code`
- stores device capability/spec metadata

### Curl

```bash
curl 'http://localhost:3000/api/v1/device-pairing/request' \
  -X POST \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "device_label": "Kiosk 12",
    "width": 1920,
    "height": 1080,
    "aspect_ratio": "16:9",
    "orientation": "landscape",
    "model": "Chromebox",
    "codecs": ["h264"],
    "device_info": {
      "os": "ChromeOS"
    }
  }'
```

### Success `201 CREATED`

```json
{
  "id": "39eaa8dc-3583-470e-946b-15fda2d26831",
  "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
  "pairing_code": "585138",
  "expires_at": "2026-03-11T06:45:27.548Z",
  "expires_in": 600,
  "connected": true,
  "observed_ip": "127.0.0.1",
  "specs": {
    "width": 1920,
    "height": 1080,
    "aspect_ratio": "16:9",
    "orientation": "landscape",
    "model": "Chromebox",
    "codecs": ["h264"],
    "device_info": {
      "os": "ChromeOS"
    }
  }
}
```

### Possible Error Responses

`422 VALIDATION_ERROR`
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid.",
    "details": [
      {
        "field": "orientation",
        "message": "Invalid enum value. Expected 'portrait' | 'landscape'"
      }
    ],
    "traceId": "trace-id"
  }
}
```

`500 INTERNAL_ERROR`
```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Unexpected error.",
    "details": null,
    "traceId": "trace-id"
  }
}
```

### Important Notes

- This call is for `Signage Screen`, not CMS.
- No authentication is required.
- Every successful request creates a new pairing row and a new `device_id`.
- If the device retries this call after a timeout, it may create multiple pending pairings.
- `codecs` is device-reported playback capability metadata. It is stored, but not currently enforced by the scheduler.

### Tips

- Persist the returned `device_id` immediately.
- Display `pairing_code` prominently.
- Start a local expiry timer using `expires_at`.
- Do not call heartbeat or other authenticated device APIs yet.

## 2. Device Polls Pairing Status

Actor:
- `Signage Screen`

Endpoint:
- `GET /api/v1/device-pairing/status?device_id=<device_id>`

Why this call exists:
- tells the screen whether admin approval happened
- tells the screen whether a screen row already exists

### Curl

```bash
curl 'http://localhost:3000/api/v1/device-pairing/status?device_id=a720d78d-62ca-40a3-a550-e0ac86ce58c2'
```

### Success Before Admin Confirm

```json
{
  "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
  "paired": false,
  "confirmed": false,
  "screen": null
}
```

### Success After Admin Confirm But Before Complete

```json
{
  "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
  "paired": true,
  "confirmed": true,
  "screen": null
}
```

### Success After Pairing Is Fully Complete

```json
{
  "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
  "paired": true,
  "confirmed": true,
  "screen": {
    "id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
    "status": "OFFLINE"
  }
}
```

### Success With Active Recovery Pairing On Existing Screen

```json
{
  "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
  "paired": true,
  "confirmed": true,
  "active_pairing": {
    "id": "c1ed0ca5-6843-4e81-acb5-0775f2aa719c",
    "created_at": "2026-03-11T06:39:10.000Z",
    "expires_at": "2026-03-11T06:49:10.000Z",
    "confirmed": true,
    "mode": "RECOVERY"
  },
  "screen": {
    "id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
    "status": "ACTIVE"
  }
}
```

### Possible Error Responses

`422 VALIDATION_ERROR`
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid.",
    "details": [
      {
        "field": "device_id",
        "message": "Invalid uuid"
      }
    ],
    "traceId": "trace-id"
  }
}
```

`500 INTERNAL_ERROR`
```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Unexpected error.",
    "details": null,
    "traceId": "trace-id"
  }
}
```

### Important Notes

- This call is for `Signage Screen`, not CMS.
- No auth is required.
- Polling should stop when `confirmed=true`.
- `active_pairing` is the trustworthy signal for whether there is an active unused, unexpired pairing row for this `device_id`.
- `active_pairing.mode` is:
  - `PAIRING` for first-time/new-screen pairing
  - `RECOVERY` for in-place recovery on an existing screen identity
- If local `expires_at` has passed, stop polling and restart at step 1.

### Tips

- Recommended polling interval: `2s` to `5s`
- Add jitter if many devices are pairing simultaneously.
- If the network is unstable, keep the pairing code visible while retries continue.

## 3. Admin Confirms Pairing

Actor:
- `CMS`

Endpoint:
- `POST /api/v1/device-pairing/confirm`

Why this call exists:
- approves the pairing code
- stores screen name and optional location
- does not yet create the certificate
- does not yet authenticate the device

### Curl

```bash
curl 'http://localhost:3000/api/v1/device-pairing/confirm' \
  -X POST \
  -H 'Authorization: Bearer <cms-admin-jwt>' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "pairing_code": "585138",
    "name": "Lobby Screen",
    "location": "Reception"
  }'
```

### Success `200 OK`

```json
{
  "message": "Pairing confirmed. Awaiting device completion.",
  "pairing": {
    "id": "39eaa8dc-3583-470e-946b-15fda2d26831",
    "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
    "pairing_code": "585138",
    "expires_at": "2026-03-11T06:45:27.548Z",
    "confirmed_at": "2026-03-11T06:39:18.100Z"
  }
}
```

### Possible Error Responses

`401 UNAUTHORIZED`
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing authorization header",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`401 UNAUTHORIZED`
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid token",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`403 FORBIDDEN`
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Device credentials expired",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`403 FORBIDDEN`
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Forbidden",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`404 NOT_FOUND`
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Invalid or expired pairing code",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`409 CONFLICT`
```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Screen already exists for this device",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`422 VALIDATION_ERROR`
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid.",
    "details": [
      {
        "field": "name",
        "message": "String must contain at least 1 character(s)"
      }
    ],
    "traceId": "trace-id"
  }
}
```

### Important Notes

- This call is for `CMS`, not the device.
- Requires a CMS JWT with `create Screen` permission.
- Confirmation alone does not authenticate the device.
- After this call succeeds, the device must still call `/device-pairing/complete`.

### Tips

- Use a clear screen name at confirmation time; this becomes the initial screen row name.
- If the admin confirms too late and the code expired, the device must request a new code.

## 4. Device Completes Pairing With CSR

Actor:
- `Signage Screen`

Endpoint:
- `POST /api/v1/device-pairing/complete`

Why this call exists:
- issues the device certificate
- creates the `device_certificates` row
- creates the `screens` row if it does not already exist
- marks pairing as used
- this is the point where the device becomes authenticated

### Curl

```bash
curl 'http://localhost:3000/api/v1/device-pairing/complete' \
  -X POST \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "pairing_code": "585138",
    "csr": "-----BEGIN CERTIFICATE REQUEST-----\nMIIB...dummy...\n-----END CERTIFICATE REQUEST-----"
  }'
```

### Success `201 CREATED`

```json
{
  "success": true,
  "message": "Device pairing completed. Certificate issued.",
  "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
  "certificate": "-----BEGIN CERTIFICATE-----\nMIIC...dummy...\n-----END CERTIFICATE-----",
  "ca_certificate": "-----BEGIN CERTIFICATE-----\nMIIC...ca-dummy...\n-----END CERTIFICATE-----",
  "fingerprint": "9b8de3c19f3b6f9d8aa0dfd7f7d9ce2e6b8ecf4e151db4d6e5f1aa1bb72d6b9c",
  "expires_at": "2027-03-11T06:39:25.100Z"
}
```

### Possible Error Responses

`404 NOT_FOUND`
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Invalid or expired pairing code",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`400 BAD_REQUEST`
```json
{
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Pairing is missing a device id",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`409 CONFLICT`
```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Pairing not confirmed",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`400 BAD_REQUEST`
```json
{
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid CSR format",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`409 CONFLICT`
```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "CSR deviceId does not match pairing deviceId",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`500 CA_CERT_MISSING`
```json
{
  "success": false,
  "error": {
    "code": "CA_CERT_MISSING",
    "message": "CA certificate not found at /path/to/ca-cert.pem",
    "details": null,
    "traceId": "trace-id"
  }
}
```

### Important Notes

- This call is for `Signage Screen`, not CMS.
- No JWT is required.
- The device is not authenticated before this call succeeds.
- The `screen` row is created here, not at request time, not at confirm time.
- The device must persist:
  - `device_id`
  - `certificate`
  - `fingerprint`
  - `ca_certificate`
  - local private key used to generate the CSR

### Tips

- If `Pairing not confirmed`, keep polling status instead of starting over.
- If the CSR is malformed, fix CSR generation first.
- If the code expired, request a new pairing code.

## 5. Device Heartbeat

Actor:
- `Signage Screen`

Endpoint:
- `POST /api/v1/device/heartbeat`

Why this call exists:
- proves the device is alive
- updates `screens.status`
- updates `last_heartbeat_at`
- updates `current_schedule_id`
- updates `current_media_id`
- returns pending commands inline

Auth requirements:
- send one of these device identity headers:
  - `x-device-serial`
  - `x-device-cert-serial`
  - `x-device-cert`
- the header value must match `device_certificates.serial` for that `device_id`

### Curl

```bash
curl 'http://localhost:3000/api/v1/device/heartbeat' \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'x-device-serial: 9b8de3c19f3b6f9d8aa0dfd7f7d9ce2e6b8ecf4e151db4d6e5f1aa1bb72d6b9c' \
  --data-raw '{
    "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
    "status": "ONLINE",
    "uptime": 86400,
    "memory_usage": 35,
    "cpu_usage": 18,
    "current_schedule_id": "9fe12c8b-4608-4efc-b4ce-552f5b3d8d3c",
    "current_media_id": "95f8a217-c18c-4625-9eff-c41bc38e5153",
    "device_model": "Chromebox",
    "os_version": "ChromeOS 130",
    "app_version": "1.2.0"
  }'
```

### Success `200 OK`

```json
{
  "success": true,
  "timestamp": "2026-03-11T06:40:00.000Z",
  "commands": [
    {
      "id": "0f4d8d07-c1f3-497b-bc0c-a76f2b9176d9",
      "type": "REFRESH",
      "payload": {
        "reason": "publish"
      },
      "timestamp": "2026-03-11T06:39:55.000Z"
    }
  ]
}
```

### Possible Error Responses

`401 UNAUTHORIZED`
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing device identity header",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`403 FORBIDDEN`
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Invalid device credentials",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`404 NOT_FOUND`
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Device not registered",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`422 VALIDATION_ERROR`
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid.",
    "details": [
      {
        "field": "status",
        "message": "Invalid enum value. Expected 'ONLINE' | 'OFFLINE' | 'ERROR'"
      }
    ],
    "traceId": "trace-id"
  }
}
```

### Important Notes

- This call is for `Signage Screen`, not CMS.
- This is the main runtime liveness call.
- It stores heartbeat payloads in object storage and in `heartbeats`.
- It also emits realtime `screens:state:update`.
- `ONLINE` maps to screen status `ACTIVE`.
- `OFFLINE` maps to screen status `OFFLINE`.
- `ERROR` maps to screen status `INACTIVE`.

### Tips

- Send heartbeat on a stable interval from the player.
- Use this response as an inline command fetch.
- If heartbeat fails with `403`, the stored device certificate is no longer valid and the device should go to recovery UI.

## 6. Device Fetches Pending Commands

Actor:
- `Signage Screen`

Endpoint:
- `GET /api/v1/device/:deviceId/commands`

Why this call exists:
- fetches `PENDING` commands for the device
- transitions them to `SENT`

### Curl

```bash
curl 'http://localhost:3000/api/v1/device/a720d78d-62ca-40a3-a550-e0ac86ce58c2/commands' \
  -H 'x-device-serial: 9b8de3c19f3b6f9d8aa0dfd7f7d9ce2e6b8ecf4e151db4d6e5f1aa1bb72d6b9c'
```

### Success `200 OK`

```json
{
  "commands": [
    {
      "id": "0f4d8d07-c1f3-497b-bc0c-a76f2b9176d9",
      "type": "TAKE_SCREENSHOT",
      "payload": {
        "quality": 80
      },
      "timestamp": "2026-03-11T06:41:00.000Z"
    }
  ]
}
```

### Success With No Commands

```json
{
  "commands": []
}
```

### Possible Error Responses

`401 UNAUTHORIZED`
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing device identity header",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`403 FORBIDDEN`
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Invalid device credentials",
    "details": null,
    "traceId": "trace-id"
  }
}
```

### Important Notes

- This call is for `Signage Screen`, not CMS.
- Heartbeat already returns pending commands, so this endpoint is optional if heartbeat cadence is sufficient.
- Once fetched, commands move from `PENDING` to `SENT`.

### Tips

- Prefer heartbeat inline commands for simplicity.
- Use this endpoint when you want a tighter command poll than heartbeat cadence.

## 7. Device Acknowledges a Command

Actor:
- `Signage Screen`

Endpoint:
- `POST /api/v1/device/:deviceId/commands/:commandId/ack`

Why this call exists:
- marks a sent command as acknowledged

### Curl

```bash
curl 'http://localhost:3000/api/v1/device/a720d78d-62ca-40a3-a550-e0ac86ce58c2/commands/0f4d8d07-c1f3-497b-bc0c-a76f2b9176d9/ack' \
  -X POST \
  -H 'x-device-serial: 9b8de3c19f3b6f9d8aa0dfd7f7d9ce2e6b8ecf4e151db4d6e5f1aa1bb72d6b9c'
```

### Success `200 OK`

```json
{
  "success": true,
  "timestamp": "2026-03-11T06:41:30.000Z"
}
```

### Possible Error Responses

`401 UNAUTHORIZED`
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing device identity header",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`403 FORBIDDEN`
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Invalid device credentials",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`404 NOT_FOUND`
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Command not found",
    "details": null,
    "traceId": "trace-id"
  }
}
```

### Important Notes

- This call is for `Signage Screen`, not CMS.
- It does not include command execution result details; it only acknowledges receipt/execution.

### Tips

- Ack only after the player has actually handled the command.
- If the ack request fails transiently, retry; this endpoint is effectively safe to retry.

## 8. Device Sends Proof Of Play

Actor:
- `Signage Screen`

Endpoint:
- `POST /api/v1/device/proof-of-play`

Why this call exists:
- records that media actually played on the screen
- stores a PoP payload object
- inserts a `proof_of_play` row

### Curl

```bash
curl 'http://localhost:3000/api/v1/device/proof-of-play' \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'x-device-serial: 9b8de3c19f3b6f9d8aa0dfd7f7d9ce2e6b8ecf4e151db4d6e5f1aa1bb72d6b9c' \
  --data-raw '{
    "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
    "media_id": "95f8a217-c18c-4625-9eff-c41bc38e5153",
    "schedule_id": "9fe12c8b-4608-4efc-b4ce-552f5b3d8d3c",
    "start_time": "2026-03-11T06:40:00.000Z",
    "end_time": "2026-03-11T06:40:15.000Z",
    "duration": 15,
    "completed": true
  }'
```

### Success `201 CREATED`

```json
{
  "success": true,
  "timestamp": "2026-03-11T06:40:15.500Z"
}
```

### Possible Error Responses

`401 UNAUTHORIZED`
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing device identity header",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`403 FORBIDDEN`
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Invalid device credentials",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`422 VALIDATION_ERROR`
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid.",
    "details": [
      {
        "field": "start_time",
        "message": "Invalid datetime"
      }
    ],
    "traceId": "trace-id"
  }
}
```

### Important Notes

- This call is for `Signage Screen`, not CMS.
- Backend does not currently de-duplicate repeated PoP payloads for the same playback window.
- If the device is offline, queue and replay later from the player.

### Tips

- Batch locally when offline.
- Preserve event order when replaying after reconnect.
- Include only completed intervals that the player actually rendered.

## 9. Device Uploads Screenshot

Actor:
- `Signage Screen`

Endpoint:
- `POST /api/v1/device/screenshot`

Why this call exists:
- uploads a base64 screenshot into object storage
- accepts a larger JSON body than normal telemetry routes because base64 PNG screenshots are often bigger than 1 MiB

### Curl

```bash
curl 'http://localhost:3000/api/v1/device/screenshot' \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'x-device-serial: 9b8de3c19f3b6f9d8aa0dfd7f7d9ce2e6b8ecf4e151db4d6e5f1aa1bb72d6b9c' \
  --data-raw '{
    "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
    "timestamp": "2026-03-11T06:42:00.000Z",
    "image_data": "iVBORw0KGgoAAAANSUhEUgAA...dummy-base64..."
  }'
```

### Success `201 CREATED`

```json
{
  "success": true,
  "object_key": "device-screenshots/a720d78d-62ca-40a3-a550-e0ac86ce58c2/1773211320000.png",
  "timestamp": "2026-03-11T06:42:00.100Z"
}
```

Notes:
- the screenshot upload route is configured with a 4 MiB request body limit
- other telemetry routes still use the default server parser limit

### Possible Error Responses

`401 UNAUTHORIZED`
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing device identity header",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`403 FORBIDDEN`
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Invalid device credentials",
    "details": null,
    "traceId": "trace-id"
  }
}
```

`422 VALIDATION_ERROR`
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid.",
    "details": [
      {
        "field": "timestamp",
        "message": "Invalid datetime"
      }
    ],
    "traceId": "trace-id"
  }
}
```

### Important Notes

- This call is for `Signage Screen`, not CMS.
- The current route uploads the PNG object, but the response only returns `object_key`.
- There is no separate screenshot URL returned from this device endpoint.

### Tips

- Use this for diagnostics, not for high-frequency streaming.
- Compress client-side before base64 encoding if bandwidth is constrained.

## 10. Optional CMS Pairing Code Generation Flow

Actor:
- `CMS`

Endpoint:
- `POST /api/v1/device-pairing/generate`

Why this call exists:
- admin can generate a pairing code for a known `device_id`
- this is a CMS-driven pairing helper, not the normal first-time device-led flow

### Curl

```bash
curl 'http://localhost:3000/api/v1/device-pairing/generate' \
  -X POST \
  -H 'Authorization: Bearer <cms-admin-jwt>' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
    "expires_in": 3600
  }'
```

### Success `201 CREATED`

```json
{
  "id": "pairing-row-id",
  "pairing_code": "A1B2C3",
  "expires_at": "2026-03-11T07:45:00.000Z",
  "expires_in": 3600
}
```

### Possible Error Responses

`401 UNAUTHORIZED`, `403 FORBIDDEN`, `422 VALIDATION_ERROR`, `500 INTERNAL_ERROR`

### Important Notes

- This call is for `CMS`, not the screen.
- It is not required for the normal device-first pairing flow.

## Header Rules For Authenticated Device Calls

Authenticated device endpoints require one of:
- `x-device-serial`
- `x-device-cert-serial`
- `x-device-cert`

Current code behavior:
- the header value is matched against `device_certificates.serial`
- the code uses header-based identity, not transport mTLS
- revoked certificates are rejected
- certificate expiry is returned at pairing time but is not currently enforced in `authenticateDeviceOrThrow`

## Retry Guidance

### Safe to retry with backoff

- `GET /api/v1/device-pairing/status`
- `POST /api/v1/device/heartbeat`
- `GET /api/v1/device/:deviceId/commands`
- `POST /api/v1/device/:deviceId/commands/:commandId/ack`
- `POST /api/v1/device/proof-of-play`
- `POST /api/v1/device/screenshot`

Recommended backoff:
- start: `2s`
- multiply by `2`
- cap at `30s`
- add `10%` to `20%` jitter

### Retry carefully

- `POST /api/v1/device-pairing/request`
  - each success creates a fresh pairing row and fresh `device_id`

- `POST /api/v1/device-pairing/complete`
  - safe to retry only while the same pairing code is still valid and unused

## Quick Operational Checklist For The Screen

Persist locally:
- `device_id`
- device private key
- issued `certificate`
- `fingerprint`
- `ca_certificate`

Before pairing completes:
- do not call heartbeat
- do not fetch commands
- do not send proof-of-play
- do not upload screenshots

After pairing completes:
- start heartbeat loop
- process commands
- send proof-of-play for actual playback
- upload screenshots only if your product needs them

If the device is restarted:
- no re-pair is needed if local device credentials still exist

If the app is reinstalled or local storage is wiped:
- the device must start pairing again

If screen delete happens in CMS:
- screen row, pairing rows, and device certificate rows are removed
- future device-auth calls will fail
- the device must re-pair

## Common Failure Interpretation

- `Missing device identity header`
  - the screen is calling an authenticated device endpoint without device auth headers

- `Invalid device credentials`
  - wrong fingerprint/serial, revoked cert, or deleted screen/cert row

- `Device not registered`
  - the device certificate passed, but the screen row no longer exists

- `Pairing not confirmed`
  - admin has not yet approved the code

- `Invalid or expired pairing code`
  - wrong code, expired code, or already-used code

- `CSR deviceId does not match pairing deviceId`
  - CSR generation logic is binding to the wrong device id

## Recovery Mode Policy

When runtime auth is broken or persisted device credentials are corrupt, the recommended player strategy is:
- use `timed fallback`
- do not use blind `auto re-pair`
- do not use indefinite `hold for action` as the only behavior

Reason:
- blind auto re-pair can create a new `device_id` and lead to duplicate/orphaned screen identities
- indefinite hold is too fragile for unattended signage
- timed fallback gives the player one structured chance to recover without creating bad backend state

### Recommended Recovery States

- `PAIRED_RUNTIME`
- `SOFT_RECOVERY`
- `RECOVERY_REQUIRED`
- `HARD_RECOVERY`
- `PAIRING_PENDING`
- `PAIRING_CONFIRMED`

### Trigger Conditions

Enter recovery when any of these happen:
- local persisted credentials are missing
- local persisted credentials are unreadable/corrupt
- authenticated device endpoint returns:
  - `401 UNAUTHORIZED` with `Missing device identity header`
  - `403 FORBIDDEN` with `Invalid device credentials`
  - `404 NOT_FOUND` with `Device not registered`

Do not enter auth recovery for:
- network timeout
- DNS failure
- connection refused
- `429`
- `5xx`

Those are transport/infrastructure problems, not device-auth failures.

### Step 1. First Reaction To Runtime Auth Failure

If any authenticated device API returns an auth failure:
- stop runtime write loops immediately:
  - heartbeat
  - commands poll
  - command ack
  - proof-of-play upload
  - screenshot upload
- keep current playback running if local content is still available
- show recovery status in the player
- load locally persisted auth material again from disk/secure store

### Step 2. Re-read Local Device Identity

The player should verify these local items exist and are readable:
- `device_id`
- `certificate`
- `fingerprint`
- `ca_certificate`
- device private key

If any are missing or corrupt:
- move to `HARD_RECOVERY`
- clear the broken local auth state
- start fresh pairing flow

### Step 3. Probe Backend State Before Re-pairing

Before starting a new pairing flow, check whether the old identity still exists.

Actor:
- `Signage Screen`

Endpoint:
- `GET /api/v1/device-pairing/status?device_id=<device_id>`

#### Curl

```bash
curl 'http://localhost:3000/api/v1/device-pairing/status?device_id=a720d78d-62ca-40a3-a550-e0ac86ce58c2'
```

#### Response: Screen Still Exists

```json
{
  "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
  "paired": true,
  "confirmed": true,
  "screen": {
    "id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
    "status": "ACTIVE"
  }
}
```

Meaning:
- backend still knows this screen/device id
- the failure is likely:
  - revoked credentials
  - wrong auth header
  - local credential corruption

Action:
- do not blind auto re-pair
- move to `RECOVERY_REQUIRED`
- show operator-facing recovery UI
- allow explicit `Retry`
- allow explicit `Re-pair device`

#### Response: Screen Missing

```json
{
  "device_id": "a720d78d-62ca-40a3-a550-e0ac86ce58c2",
  "paired": false,
  "confirmed": false,
  "screen": null
}
```

Meaning:
- current device identity is not usable anymore
- old screen may have been deleted or the local device identity is no longer valid

Action:
- move to `HARD_RECOVERY`
- fresh pairing is now safe
- auto-start pairing after a short countdown is acceptable

#### Response: Invalid Local Device Id

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid.",
    "details": [
      {
        "field": "device_id",
        "message": "Invalid uuid"
      }
    ],
    "traceId": "trace-id"
  }
}
```

Meaning:
- local persisted identity is corrupt

Action:
- clear local auth state
- start fresh pairing

#### Response: Status Probe Temporarily Unavailable

Examples:
- timeout
- network error
- `500`

Action:
- do not re-pair yet
- keep cached playback running if possible
- retry status probe with exponential backoff

### Step 4. Fresh Pairing Only When Safe

Fresh pairing creates a new `device_id`, so it must not happen blindly.

Only auto-start fresh pairing when:
- local auth state is missing/corrupt, or
- backend says the old screen/device identity no longer exists

Use:

```bash
curl 'http://localhost:3000/api/v1/device-pairing/request' \
  -X POST \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "device_label": "Kiosk 12",
    "width": 1920,
    "height": 1080,
    "aspect_ratio": "16:9",
    "orientation": "landscape",
    "model": "Chromebox",
    "codecs": ["h264"],
    "device_info": {
      "os": "ChromeOS"
    }
  }'
```

### Runtime Auth Failure Examples

#### Missing Device Auth Header

Example from heartbeat:

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing device identity header",
    "details": null,
    "traceId": "trace-id"
  }
}
```

Meaning:
- the player called a device-authenticated route without a valid device auth header

Action:
- re-read local identity
- verify the header injection code path
- if local auth state is broken, go `HARD_RECOVERY`

#### Invalid Device Credentials

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Invalid device credentials",
    "details": null,
    "traceId": "trace-id"
  }
}
```

Meaning:
- header value does not match the stored device certificate serial for this screen
- or the certificate is revoked

Action:
- stop runtime writes
- probe pairing status
- if screen still exists, stay in `RECOVERY_REQUIRED`
- if screen does not exist, move to `HARD_RECOVERY`

#### Device Not Registered

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Device not registered",
    "details": null,
    "traceId": "trace-id"
  }
}
```

Meaning:
- screen row is gone

Action:
- move to `HARD_RECOVERY`
- start fresh pairing

### Recommended Player Behavior

Use this policy:

1. On first auth failure, enter `SOFT_RECOVERY`.
2. Reload local credentials once.
3. Probe `GET /api/v1/device-pairing/status?device_id=...`.
4. If screen exists, move to `RECOVERY_REQUIRED` and require explicit operator/admin intervention or explicit re-pair.
5. If screen is missing or local identity is corrupt, move to `HARD_RECOVERY`.
6. In `HARD_RECOVERY`, auto-start fresh pairing after a short countdown such as `10s` to `30s`.
7. Keep playback alive from local cache whenever possible.

### What The Electron Player Should Notice

- There is no dedicated standalone recovery endpoint.
- In-place credential recovery is now possible through the existing admin-driven flow:
  - `POST /api/v1/device-pairing/generate` with the current `device_id`
  - `POST /api/v1/device-pairing/confirm`
  - device-side `POST /api/v1/device-pairing/complete`
- Completing that flow revokes older device certificates for the same `device_id` and issues a fresh one.
- Recovery is still client-driven using:
  - local credential checks
  - runtime auth failures
  - `GET /api/v1/device-pairing/status`
  - in-place recovery for existing screen identities when admin assistance is available
  - fresh pairing flow when the old identity is gone or local identity is corrupt

- Do not wipe local credentials on the first `403`.
- Do not blind auto re-pair while the old screen identity still exists.
- Prefer preserving playback while the app is in recovery.

## Electron Implementation Notes

If the player is built in Electron, the local app should split responsibilities clearly:

- `main process`
  - owns persisted device identity
  - owns pairing state
  - owns HTTP client for device-authenticated calls
  - owns retry/backoff timers
  - owns offline queues for proof-of-play and optional screenshots

- `renderer process`
  - displays pairing code
  - displays connectivity and pairing status
  - displays recovery UI when auth is broken
  - must not be the only source of truth for device credentials

Recommended persisted state:
- `device_id`
- `pairing_code`
- `pairing_expires_at`
- `certificate`
- `fingerprint`
- `ca_certificate`
- device private key
- last successful heartbeat timestamp
- offline proof-of-play queue
- current player mode: `UNPAIRED | PAIRING_PENDING | PAIRING_CONFIRMED | PAIRED_RUNTIME | RECOVERY_REQUIRED`

Recommended fallback behavior:
- if pairing request fails:
  - keep setup screen open
  - retry with exponential backoff
- if status polling fails:
  - keep pairing code visible
  - continue polling until local expiry
- if complete fails with `Pairing not confirmed`:
  - continue status polling
- if complete fails with `Invalid or expired pairing code`:
  - discard old pairing state
  - restart at request step
- if any authenticated device call fails with `Invalid device credentials`:
  - stop runtime loops
  - transition to recovery UI
  - require fresh pairing unless local investigation proves headers are wrong
- if server is temporarily unavailable:
  - keep current playback running if local content is still available
  - queue proof-of-play locally
  - retry heartbeat and command fetch with backoff

Important runtime header note:
- current backend device auth checks the device certificate `serial` field against:
  - `x-device-serial`
  - `x-device-cert-serial`
  - `x-device-cert`
- current backend also rejects device credentials whose `expires_at` has passed
- for Electron implementation, use one stable header convention everywhere.
- recommended: send `x-device-serial: <fingerprint-or-issued-serial-value your backend stores for this device>`
- do not assume sending the full PEM certificate in headers is required by current code.

## Related Docs

- [`DEVICE_PAIRING_AND_DEVICE_RUNTIME_LIFECYCLE.md`](/Users/anuragkumar/Desktop/signhex/signhex-server/docs/DEVICE_PAIRING_AND_DEVICE_RUNTIME_LIFECYCLE.md)
- `signhex-platform/docs/contracts/device-player-guide.md`
