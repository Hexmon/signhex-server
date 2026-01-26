# Curl Cookbook (Desktop Player)

Placeholders:
- `BASE_URL` (CMS/JWT server, e.g., http://localhost:3000)
- `DEVICE_BASE_URL` (device endpoint host/port, e.g., https://localhost:8443)
- `ADMIN_TOKEN` (CMS JWT)
- `DEVICE_TOKEN` (device fingerprint for header `x-device-serial`)
- `DEVICE_ID`, `SCREEN_ID`, `PAIRING_CODE`, `COMMAND_ID`

Note: code only starts one server on `PORT` (default 3000); mTLS is assumed upstream. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/index.ts.

---

## 1) POST /api/v1/device-pairing/request (device)

curl:
```bash
curl -s -X POST "${DEVICE_BASE_URL}/api/v1/device-pairing/request" \
  -H "Content-Type: application/json" \
  -d '{
    "device_label": "Lobby Screen",
    "expires_in": 600,
    "width": 1920,
    "height": 1080,
    "aspect_ratio": "16:9",
    "orientation": "landscape",
    "model": "Intel NUC",
    "codecs": ["h264"],
    "device_info": { "os": "Windows" }
  }'
```

Success (201):
```json
{
  "id": "pair-uuid",
  "device_id": "DEVICE_ID",
  "pairing_code": "582931",
  "expires_at": "2026-01-26T12:30:00.000Z",
  "expires_in": 600,
  "connected": true,
  "observed_ip": "192.168.1.10",
  "specs": {
    "width": 1920,
    "height": 1080,
    "aspect_ratio": "16:9",
    "orientation": "landscape",
    "model": "Intel NUC",
    "codecs": ["h264"],
    "device_info": { "os": "Windows" }
  }
}
```

Failure (422 VALIDATION_ERROR):
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Some fields are invalid.", "details": [{ "field": "expires_in", "message": "Must be a positive integer" }], "traceId": "..." } }
```

Failure (500 INTERNAL_ERROR):
```json
{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "Unexpected error.", "details": null, "traceId": "..." } }
```

Failure (401 UNAUTHORIZED):
```json
{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "Unauthorized.", "details": null, "traceId": "..." } }
```

---

## 2) GET /api/v1/device-pairing/status (device)

curl:
```bash
curl -s "${DEVICE_BASE_URL}/api/v1/device-pairing/status?device_id=${DEVICE_ID}"
```

Success (200):
```json
{ "device_id": "DEVICE_ID", "paired": true, "screen": { "id": "SCREEN_ID", "status": "ACTIVE" } }
```

Failure (422 VALIDATION_ERROR):
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Some fields are invalid.", "details": [{ "field": "device_id", "message": "Invalid uuid" }], "traceId": "..." } }
```

Failure (500 INTERNAL_ERROR):
```json
{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "Unexpected error.", "details": null, "traceId": "..." } }
```

---

## 3) POST /api/v1/device-pairing/confirm (admin/CMS)

curl:
```bash
curl -s -X POST "${BASE_URL}/api/v1/device-pairing/confirm" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{ "pairing_code": "PAIRING_CODE", "name": "Lobby Screen", "location": "Front Desk" }'
```

Success (200):
```json
{
  "message": "Screen paired successfully",
  "screen": {
    "id": "SCREEN_ID",
    "name": "Lobby Screen",
    "location": "Front Desk",
    "status": "ACTIVE",
    "aspect_ratio": "16:9",
    "width": 1920,
    "height": 1080,
    "orientation": "landscape",
    "device_info": { "model": "Intel NUC", "codecs": ["h264"] },
    "created_at": "2026-01-26T12:31:00.000Z",
    "updated_at": "2026-01-26T12:31:00.000Z"
  }
}
```

Failure (401 UNAUTHORIZED):
```json
{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "Missing authorization header", "details": null, "traceId": "..." } }
```

Failure (404 NOT_FOUND):
```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Invalid or expired pairing code", "details": null, "traceId": "..." } }
```

Failure (409 CONFLICT):
```json
{ "success": false, "error": { "code": "CONFLICT", "message": "Screen already exists for this device", "details": null, "traceId": "..." } }
```

---

## 4) POST /api/v1/device-pairing/complete (device)

curl:
```bash
curl -s -X POST "${DEVICE_BASE_URL}/api/v1/device-pairing/complete" \
  -H "Content-Type: application/json" \
  -d '{ "pairing_code": "PAIRING_CODE", "csr": "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----" }'
```

Success (201):
```json
{ "success": true, "message": "Device pairing completed. Certificate issued.", "device_id": "DEVICE_ID", "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----", "fingerprint": "abc123", "expires_at": "2027-01-26T12:32:00.000Z" }
```

Failure (404 NOT_FOUND):
```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Invalid or expired pairing code", "details": null, "traceId": "..." } }
```

Failure (400 BAD_REQUEST):
```json
{ "success": false, "error": { "code": "BAD_REQUEST", "message": "Invalid CSR format", "details": null, "traceId": "..." } }
```

Failure (500 CA_CERT_MISSING):
```json
{ "success": false, "error": { "code": "CA_CERT_MISSING", "message": "CA certificate is missing. Please configure CA_CERT_PATH correctly.", "details": null, "traceId": "..." } }
```

---

## 5) GET /api/v1/device/:deviceId/snapshot (device)

curl:
```bash
curl -s "${DEVICE_BASE_URL}/api/v1/device/${DEVICE_ID}/snapshot?include_urls=true" \
  -H "x-device-serial: ${DEVICE_TOKEN}"
```

Success (200, publish found):
```json
{
  "device_id": "DEVICE_ID",
  "publish": { "publish_id": "pub-1", "schedule_id": "sch-1", "snapshot_id": "snap-1", "published_at": "2026-01-26T12:40:00.000Z" },
  "snapshot": { "schedule": { "id": "sch-1", "items": [ { "id": "item-1", "presentation": { "id": "pres-1", "slots": [ { "media_id": "media-1", "duration_seconds": 10 } ] } } ] } },
  "media_urls": { "media-1": "https://storage.example.com/signed-url" },
  "emergency": null
}
```

Success (200, no publish + default media):
```json
{ "device_id": "DEVICE_ID", "publish": null, "snapshot": null, "media_urls": null, "emergency": null, "default_media": { "id": "media-default", "name": "Welcome", "type": "IMAGE", "duration_seconds": 15, "media_url": "https://storage.example.com/default.png" } }
```

Failure (401 UNAUTHORIZED):
```json
{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "Missing authorization header", "details": null, "traceId": "..." } }
```

Failure (403 FORBIDDEN):
```json
{ "success": false, "error": { "code": "FORBIDDEN", "message": "Forbidden", "details": null, "traceId": "..." } }
```

Failure (404 NOT_FOUND):
```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "No publish found for this device", "details": null, "traceId": "..." } }
```

---

## 6) GET /api/v1/screens/:id/snapshot (admin/CMS)

curl:
```bash
curl -s "${BASE_URL}/api/v1/screens/${SCREEN_ID}/snapshot?include_urls=true" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}"
```

Success (200, publish found):
```json
{ "screen_id": "SCREEN_ID", "publish": { "publish_id": "pub-1", "schedule_id": "sch-1", "snapshot_id": "snap-1", "published_at": "2026-01-26T12:40:00.000Z" }, "snapshot": { "schedule": { "id": "sch-1", "items": [] } }, "media_urls": {}, "emergency": null }
```

Success (200, no publish + default media):
```json
{ "screen_id": "SCREEN_ID", "publish": null, "snapshot": null, "media_urls": null, "emergency": null, "default_media": { "id": "media-default", "name": "Welcome", "type": "IMAGE", "duration_seconds": 15, "media_url": "https://storage.example.com/default.png" } }
```

Failure (401 UNAUTHORIZED):
```json
{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "Missing authorization header", "details": null, "traceId": "..." } }
```

Failure (404 NOT_FOUND):
```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "No publish found for this screen", "details": null, "traceId": "..." } }
```

---

## 7) POST /api/v1/device/heartbeat (device)

curl:
```bash
curl -s -X POST "${DEVICE_BASE_URL}/api/v1/device/heartbeat" \
  -H "Content-Type: application/json" \
  -H "x-device-serial: ${DEVICE_TOKEN}" \
  -d '{
    "device_id": "DEVICE_ID",
    "status": "ONLINE",
    "uptime": 3600,
    "memory_usage": 1234,
    "cpu_usage": 12,
    "current_schedule_id": "sch-1",
    "current_media_id": "media-1"
  }'
```

Success (200):
```json
{ "success": true, "timestamp": "2026-01-26T12:45:00.000Z", "commands": [] }
```

Failure (404 NOT_FOUND):
```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Device not registered", "details": null, "traceId": "..." } }
```

Failure (422 VALIDATION_ERROR):
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Some fields are invalid.", "details": [{ "field": "status", "message": "Invalid enum value" }], "traceId": "..." } }
```

---

## 8) POST /api/v1/device/proof-of-play (device)

curl:
```bash
curl -s -X POST "${DEVICE_BASE_URL}/api/v1/device/proof-of-play" \
  -H "Content-Type: application/json" \
  -H "x-device-serial: ${DEVICE_TOKEN}" \
  -d '{
    "device_id": "DEVICE_ID",
    "media_id": "media-1",
    "schedule_id": "sch-1",
    "start_time": "2026-01-26T12:45:00.000Z",
    "end_time": "2026-01-26T12:45:10.000Z",
    "duration": 10,
    "completed": true
  }'
```

Success (201):
```json
{ "success": true, "timestamp": "2026-01-26T12:45:11.000Z" }
```

Failure (422 VALIDATION_ERROR):
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Some fields are invalid.", "details": [{ "field": "start_time", "message": "Invalid datetime" }], "traceId": "..." } }
```

Failure (500 INTERNAL_ERROR):
```json
{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "Unexpected error.", "details": null, "traceId": "..." } }
```

---

## 9) POST /api/v1/device/screenshot (device)

curl:
```bash
curl -s -X POST "${DEVICE_BASE_URL}/api/v1/device/screenshot" \
  -H "Content-Type: application/json" \
  -H "x-device-serial: ${DEVICE_TOKEN}" \
  -d '{
    "device_id": "DEVICE_ID",
    "timestamp": "2026-01-26T12:46:00.000Z",
    "image_data": "iVBORw0KGgoAAAANSUhEUg..."
  }'
```

Success (201):
```json
{ "success": true, "object_key": "device-screenshots/DEVICE_ID/1706273160000.png", "timestamp": "2026-01-26T12:46:00.000Z" }
```

Failure (422 VALIDATION_ERROR):
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Some fields are invalid.", "details": [{ "field": "image_data", "message": "Required" }], "traceId": "..." } }
```

Failure (500 INTERNAL_ERROR):
```json
{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "Unexpected error.", "details": null, "traceId": "..." } }
```

---

## 10) GET /api/v1/device/:deviceId/commands (device)

curl:
```bash
curl -s "${DEVICE_BASE_URL}/api/v1/device/${DEVICE_ID}/commands" \
  -H "x-device-serial: ${DEVICE_TOKEN}"
```

Success (200):
```json
{ "commands": [ { "id": "cmd-1", "type": "REFRESH", "payload": {}, "timestamp": "2026-01-26T12:47:00.000Z" } ] }
```

Failure (500 INTERNAL_ERROR):
```json
{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "Unexpected error.", "details": null, "traceId": "..." } }
```

---

## 11) POST /api/v1/device/:deviceId/commands/:commandId/ack (device)

curl:
```bash
curl -s -X POST "${DEVICE_BASE_URL}/api/v1/device/${DEVICE_ID}/commands/${COMMAND_ID}/ack" \
  -H "x-device-serial: ${DEVICE_TOKEN}"
```

Success (200):
```json
{ "success": true, "timestamp": "2026-01-26T12:47:10.000Z" }
```

Failure (404 NOT_FOUND):
```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Command not found", "details": null, "traceId": "..." } }
```

Failure (500 INTERNAL_ERROR):
```json
{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "Unexpected error.", "details": null, "traceId": "..." } }
```
