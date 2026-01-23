# Player Flow (Desktop Screen App) — Full API Reference

This document gives the **exact call sequence** and **per‑API details** (purpose, endpoint, payload, response types, and dummy responses) for the desktop player.

---

## Base URL + Auth
- Base URL: `http://localhost:3000`
- Device endpoints are **mTLS/device‑certificate authenticated**. Some are **public** during pairing.
- When using user auth (admin token), send `Authorization: Bearer <token>`.

### Standard Error Response (all APIs)
All error responses follow this shape:
```json
{
  "success": false,
  "error": {
    "code": "<STABLE_MACHINE_CODE>",
    "message": "<FRONTEND_SAFE_MESSAGE>",
    "details": null,
    "traceId": "<request-id>"
  }
}
```

---

# 0) Boot → Pairing → Playback Loop (Sequence)

## Boot
1. Load from disk: `device_id`, device certificate, cached media, last snapshot.
2. If no certificate → go to **Pairing Flow**.
3. If certificate present → go to **Playback Loop**.

## Pairing Flow (device)
1. `POST /api/v1/device-pairing/request`
2. Admin confirms: `POST /api/v1/device-pairing/confirm` (CMS)
3. Device completes pairing: `POST /api/v1/device-pairing/complete`

## Playback Loop (device)
1. `GET /api/v1/device/:deviceId/snapshot?include_urls=true`
2. Cache media files by `media_id`
3. Play schedule locally
4. Heartbeat + Proof of Play + Screenshot uploads
5. Poll `/commands` and `ack`

---

# 1) Pairing APIs

## 1.1 Request Pairing Code
**Purpose:** Device requests a pairing code and temporary device_id.

**Endpoint:** `POST /api/v1/device-pairing/request`

**Auth:** None

**Request Body**
```json
{
  "device_label": "Lobby Screen",
  "expires_in": 600,
  "width": 1920,
  "height": 1080,
  "aspect_ratio": "16:9",
  "orientation": "landscape",
  "model": "Intel NUC",
  "codecs": ["h264", "h265"],
  "device_info": { "os": "Windows" }
}
```

**Success (201)**
```json
{
  "id": "0c9b2b1c-9f0e-4f0f-96a2-0bfb6f7c7f1a",
  "device_id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "pairing_code": "582931",
  "expires_at": "2026-01-23T12:30:00.000Z",
  "expires_in": 600,
  "connected": true,
  "observed_ip": "192.168.1.10",
  "specs": {
    "width": 1920,
    "height": 1080,
    "aspect_ratio": "16:9",
    "orientation": "landscape",
    "model": "Intel NUC",
    "codecs": ["h264", "h265"],
    "device_info": { "os": "Windows" }
  }
}
```

**Possible Errors**
- 422 `VALIDATION_ERROR`
- 500 `INTERNAL_ERROR`

**Error (422)**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid.",
    "details": [{ "field": "expires_in", "message": "Must be a positive integer" }],
    "traceId": "f8f594cc-3d29-40f7-8d94-0f9dcb99fd8d"
  }
}
```

---

## 1.2 Check Pairing Status
**Purpose:** Check if device is already registered as a screen.

**Endpoint:** `GET /api/v1/device-pairing/status?device_id=<uuid>`

**Auth:** None

**Success (200)**
```json
{
  "device_id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "paired": true,
  "screen": {
    "id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "status": "ACTIVE"
  }
}
```

**Possible Errors**
- 422 `VALIDATION_ERROR`
- 500 `INTERNAL_ERROR`

---

## 1.3 Complete Pairing (CSR → Certificate)
**Purpose:** Device submits CSR to receive a certificate.

**Endpoint:** `POST /api/v1/device-pairing/complete`

**Auth:** None

**Request Body**
```json
{
  "pairing_code": "582931",
  "csr": "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----"
}
```

**Success (201)**
```json
{
  "success": true,
  "message": "Device pairing completed. Certificate issued.",
  "device_id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
  "fingerprint": "2a1c4d9e...",
  "expires_at": "2027-01-23T12:30:00.000Z"
}
```

**Possible Errors**
- 404 `NOT_FOUND` (invalid/expired pairing code)
- 400 `BAD_REQUEST` (invalid CSR format)
- 422 `VALIDATION_ERROR`
- 500 `INTERNAL_ERROR`

**Error (404)**
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Invalid or expired pairing code",
    "details": null,
    "traceId": "b8c2d2c7-4f0a-4e2a-8d60-7b1e9df33835"
  }
}
```

---

# 2) Playback / Snapshot

## 2.1 Get Latest Snapshot (Core Playback)
**Purpose:** Fetch the latest publish snapshot filtered for this screen.

**Endpoint:** `GET /api/v1/device/:deviceId/snapshot?include_urls=true`

**Auth:** Device certificate or user token

**Query Params**
- `include_urls=true|false` (include media URLs for download)

**Success (200) — normal publish**
```json
{
  "device_id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "publish": {
    "publish_id": "8bb69a54-3b7d-4b7c-9d4c-2c47c5bca6a2",
    "schedule_id": "5d927d9b-3c67-4cd9-a4f6-9f6f5f0a4321",
    "snapshot_id": "7df5f2fe-0987-4b2e-b4a6-0d2d36f6b6a3",
    "published_at": "2026-01-23T12:00:00.000Z"
  },
  "snapshot": {
    "schedule": {
      "id": "5d927d9b-3c67-4cd9-a4f6-9f6f5f0a4321",
      "items": [
        {
          "id": "item-1",
          "presentation": {
            "id": "pres-1",
            "slots": [
              { "media_id": "media-1", "duration_seconds": 10 }
            ]
          }
        }
      ]
    }
  },
  "media_urls": {
    "media-1": "https://storage.example.com/signed-url"
  },
  "emergency": null
}
```

**Success (200) — emergency active**
```json
{
  "device_id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "publish": null,
  "snapshot": null,
  "media_urls": null,
  "emergency": {
    "id": "emg-1",
    "title": "Fire Drill",
    "media_url": "https://storage.example.com/emergency.png"
  },
  "default_media": null
}
```

**Success (200) — default media fallback**
```json
{
  "device_id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "publish": null,
  "snapshot": null,
  "media_urls": null,
  "emergency": null,
  "default_media": {
    "id": "media-default",
    "name": "Welcome Screen",
    "type": "IMAGE",
    "duration_seconds": 15,
    "media_url": "https://storage.example.com/default.png"
  }
}
```

**Possible Errors**
- 401 `UNAUTHORIZED` (missing/invalid device cert or token)
- 403 `FORBIDDEN` (token lacks screen read permission)
- 404 `NOT_FOUND` (no publish + no default media)
- 422 `VALIDATION_ERROR`
- 500 `INTERNAL_ERROR`

**Error (404)**
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "No publish found for this device",
    "details": null,
    "traceId": "1fdc41f6-6f6b-4d49-bb40-21c9c3f1e1d0"
  }
}
```

---

# 3) Telemetry / Reporting

## 3.1 Heartbeat
**Purpose:** Report device health + get pending commands.

**Endpoint:** `POST /api/v1/device/heartbeat`

**Auth:** Device certificate (mTLS)

**Request Body**
```json
{
  "device_id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "status": "ONLINE",
  "uptime": 3600,
  "memory_usage": 1234,
  "cpu_usage": 12,
  "current_schedule_id": "5d927d9b-3c67-4cd9-a4f6-9f6f5f0a4321",
  "current_media_id": "media-1"
}
```

**Success (200)**
```json
{
  "success": true,
  "timestamp": "2026-01-23T12:10:00.000Z",
  "commands": [
    {
      "id": "cmd-1",
      "type": "REFRESH",
      "payload": {},
      "timestamp": "2026-01-23T12:09:00.000Z"
    }
  ]
}
```

**Possible Errors**
- 404 `NOT_FOUND` (device not registered)
- 422 `VALIDATION_ERROR`
- 500 `INTERNAL_ERROR`

---

## 3.2 Proof of Play
**Purpose:** Report played media for analytics and audits.

**Endpoint:** `POST /api/v1/device/proof-of-play`

**Auth:** Device certificate (mTLS)

**Request Body**
```json
{
  "device_id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "media_id": "media-1",
  "schedule_id": "5d927d9b-3c67-4cd9-a4f6-9f6f5f0a4321",
  "start_time": "2026-01-23T12:00:00.000Z",
  "end_time": "2026-01-23T12:00:10.000Z",
  "duration": 10,
  "completed": true
}
```

**Success (201)**
```json
{
  "success": true,
  "timestamp": "2026-01-23T12:00:11.000Z"
}
```

**Possible Errors**
- 422 `VALIDATION_ERROR`
- 500 `INTERNAL_ERROR`

---

## 3.3 Screenshot Upload
**Purpose:** Upload a screenshot image (base64).

**Endpoint:** `POST /api/v1/device/screenshot`

**Auth:** Device certificate (mTLS)

**Request Body**
```json
{
  "device_id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "timestamp": "2026-01-23T12:05:00.000Z",
  "image_data": "iVBORw0KGgoAAAANSUhEUg..."
}
```

**Success (201)**
```json
{
  "success": true,
  "object_key": "device-screenshots/1a2b3.../1706011500000.png",
  "timestamp": "2026-01-23T12:05:00.000Z"
}
```

**Possible Errors**
- 422 `VALIDATION_ERROR`
- 500 `INTERNAL_ERROR`

---

# 4) Remote Commands

## 4.1 Fetch Pending Commands
**Purpose:** Device polls for commands (reboot, refresh, screenshot, etc.).

**Endpoint:** `GET /api/v1/device/:deviceId/commands`

**Auth:** Device certificate (mTLS)

**Success (200)**
```json
{
  "commands": [
    {
      "id": "cmd-1",
      "type": "REBOOT",
      "payload": null,
      "timestamp": "2026-01-23T12:12:00.000Z"
    }
  ]
}
```

**Possible Errors**
- 500 `INTERNAL_ERROR`

---

## 4.2 Acknowledge Command
**Purpose:** Confirm command execution.

**Endpoint:** `POST /api/v1/device/:deviceId/commands/:commandId/ack`

**Auth:** Device certificate (mTLS)

**Success (200)**
```json
{
  "success": true,
  "timestamp": "2026-01-23T12:12:30.000Z"
}
```

**Possible Errors**
- 404 `NOT_FOUND` (command not found)
- 500 `INTERNAL_ERROR`

---

# 5) Default Media (Server Setting)

Default media is configured by admin and used when **no publish exists** for a device.

**Endpoints (admin only):**
- `GET /api/v1/settings/default-media`
- `PUT /api/v1/settings/default-media` with `{ "media_id": "..." }`

**Device behavior:**
- Snapshot response includes `default_media` if set
- If no default media, snapshot returns **404**

---

# 6) Caching Guidance (Device)

- **Cache by media_id** on disk. If already cached, skip download.
- **Do not stream** from URLs; download then play locally.
- Pre‑signed URLs expire (about 1 hour). If download fails, re‑fetch snapshot for new URLs.
- Cache the **last snapshot** for offline fallback.

---

# 7) Desktop App Open Questions (Enterprise‑grade checklist)

Please answer these before implementation so we choose the correct, secure defaults.

1) **CSR / keypair generation**
   - Do we already generate a device keypair + CSR today? If yes, where (file path / module)?
   - If not, can we use **Node.js crypto** or **OpenSSL**? Is `openssl` guaranteed on target machines?

2) **mTLS trust model**
   - Do we have a **CA bundle** provided by the backend, or should we use the OS trust store?
   - Any server certificate **pinning** requirements?

3) **Media storage + cache**
   - Where should media files be cached on disk (path conventions per OS)?
   - What file naming strategy do you prefer (by `media_id`, hash, or content signature)?
   - Any size limits / eviction policy (LRU, TTL)?

4) **Playback implementation**
   - How is playback implemented today? (HTML5 video/image rotation, native player, custom renderer)
   - Where is schedule parsing logic located (if any)?

5) **Telemetry & command support**
   - Are heartbeat / proof‑of‑play / screenshot / commands already implemented?
   - If yes, which endpoints are currently called, and from which file paths/modules?
