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
   - `POST /api/v1/device-pairing/request` (no auth). Body: `{ "device_label": "Lobby TV", "expires_in": 600, "width": 1920, "height": 1080, "aspect_ratio": "16:9", "orientation": "landscape", "model": "...", "codecs": ["h264"], "device_info": { ... } }` (all specs optional).  
   - If the server is reachable (e.g., over LAN), it returns `{ pairing_code (6-digit), device_id, expires_at, connected: true, observed_ip, specs: { ... } }`. Device displays the code.

2) **Admin confirms code and creates screen**  
   - `POST /api/v1/device-pairing/confirm` (auth; create Screen). Body: `{ "pairing_code": "...", "name": "Lobby Screen", "location": "First Floor" }`.  
   - Server validates the code (unused/unexpired), creates the screen with the stored `device_id` and stored specs, marks the code used, and returns screen details.

3) **Device operation and screen management**  
   - Device uses its `device_id` for heartbeats/proof-of-play/screenshot endpoints under `/api/v1/device/...`.  
   - Admin manages screens via `/api/v1/screens` (list/get/update/delete). The confirm step above also creates the screen record; `/api/v1/screens` is how you view or edit it later.

## Layouts & Slot Media (Mosaics)

- **Layouts**: CRUD at `/api/v1/layouts` with `aspect_ratio` and `spec` (normalized slots: `{id,x,y,w,h,z,fit,audio_enabled}`).
- **Presentations can use a layout**: include `layout_id` on create/update.
- **Slot media**:  
  - List: `GET /api/v1/presentations/:id/slots` (auth; read Presentation).  
  - Add: `POST /api/v1/presentations/:id/slots` with `{ "slot_id": "hero", "media_id": "<uuid>", "order": 0, "duration_seconds": 30, "fit_mode": "cover", "audio_enabled": false }`.  
  - Delete: `DELETE /api/v1/presentations/:id/slots/:slotItemId`.

## Presentation & Schedule Items (Media Linking)

- **Presentation items**:  
  - List: `GET /api/v1/presentations/:id/items` (auth; read Presentation) → returns media items with media metadata.  
  - Add: `POST /api/v1/presentations/:id/items` (auth; update Presentation). Body: `{ "media_id": "<uuid>", "order": 0, "duration_seconds": 30 }` (`order` optional, defaults to append).  
  - Delete: `DELETE /api/v1/presentations/:id/items/:itemId` (auth; update Presentation).

- **Schedule items**:  
  - List: `GET /api/v1/schedules/:id/items` (auth; read Schedule). Returns schedule slots with resolved presentations → items → media for preview.  
  - Add: `POST /api/v1/schedules/:id/items` (auth; update Schedule). Body: `{ "presentation_id": "<uuid>", "start_at": "<iso>", "end_at": "<iso>", "priority": 0 }`. Validates window within schedule and overlap.  
  - Delete: `DELETE /api/v1/schedules/:id/items/:itemId` (auth; update Schedule).

- **Publish snapshot**: `POST /api/v1/schedules/:id/publish` now stores a snapshot that includes schedule details plus resolved items (presentation → media), layout and slot media, and targets. Devices can consume that snapshot to know what to play.

## Screen Status & Commands

- **Screen status**: `GET /api/v1/screens/:id/status` (auth) returns status, last heartbeat, and `current_schedule_id/current_media_id` as reported by device heartbeats.  
- **Now playing**: `GET /api/v1/screens/:id/now-playing` returns active schedule items from the latest publish for that screen.  
- **Device commands**:  
  - Create (admin): `POST /api/v1/device/:deviceId/commands` with `{ "type": "REBOOT|REFRESH|TEST_PATTERN", "payload": { ... } }`.  
  - Devices poll `GET /api/v1/device/:deviceId/commands` and `POST /api/v1/device/:deviceId/commands/:commandId/ack` to acknowledge.
