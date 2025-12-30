# Implementation Helper

Short reference for common integration flows.

## Media Upload & Management

- **Presign upload**: `POST /api/v1/media/presign-upload` (auth; create Media). Body: `{ "filename": "video.mp4", "content_type": "video/mp4", "size": 12345 }`. Response: `{ upload_url, media_id, bucket, object_key, expires_in }`. Server creates a `PENDING` media record tied to that object.
- **Upload file**: Client PUTs the file to `upload_url` (direct to storage, no API auth).
- **Finalize**: `POST /api/v1/media/:id/complete` (auth; update Media). Body example: `{ "status": "READY", "content_type": "video/mp4", "size": 12345, "width": 1920, "height": 1080, "duration_seconds": 30 }`. Server verifies the object exists and updates the record.
- **List**: `GET /api/v1/media?type=IMAGE|VIDEO|DOCUMENT&status=...&page=&limit=` (auth).
- **Get**: `GET /api/v1/media/:id` (auth).
- **Optional metadata-only create**: `POST /api/v1/media` with `{ "name", "type" }` creates a media record without uploading a file. Use this when:
  - The file already exists elsewhere and you just need a DB record (you can later update storage info).
  - You want a placeholder to attach to schedules/presentations before upload happens.
  - You’re migrating/importing existing media and will backfill storage metadata later.
  If you’re uploading a new file through this system, prefer the presign flow (`/media/presign-upload` → PUT file → `/media/:id/complete`).

## Screen Pairing & Verification

New device-driven flow that checks connectivity and uses a numeric code.

1) **Device requests code (connectivity check)**  
   - `POST /api/v1/device-pairing/request` (no auth). Body: `{ "device_label": "Lobby TV", "expires_in": 600 }` (label/expires optional).  
   - If the server is reachable (e.g., over LAN), it returns `{ pairing_code (6-digit), device_id, expires_at, connected: true, observed_ip }`. Device displays the code.

2) **Admin confirms code and creates screen**  
   - `POST /api/v1/device-pairing/confirm` (auth; create Screen). Body: `{ "pairing_code": "...", "name": "Lobby Screen", "location": "First Floor" }`.  
   - Server validates the code (unused/unexpired), creates the screen with the stored `device_id`, marks the code used, and returns screen details.

3) **Device operation and screen management**  
   - Device uses its `device_id` for heartbeats/proof-of-play/screenshot endpoints under `/api/v1/device/...`.  
   - Admin manages screens via `/api/v1/screens` (list/get/update/delete). The confirm step above also creates the screen record; `/api/v1/screens` is how you view or edit it later.
