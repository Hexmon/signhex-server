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

## Frontend Flow: Media -> Presentation -> Schedule -> Publish

Use this as the end-to-end guide for frontend integration. It shows which API to call and when, including the approval path.

Flow chart (Mermaid):

```mermaid
flowchart TD
  %% =============== AUTH ===============
  A0([Start]) --> A1[1) Auth<br/>POST /api/v1/auth/login<br/>→ token]
  A1 --> A2[Use token on ALL subsequent calls<br/>(e.g., Authorization: Bearer ...)]

  %% =============== MEDIA UPLOAD ===============
  A2 --> M0{2) Upload Media<br/>Which method?}

  %% Presigned upload path
  M0 -- "A) Presigned upload (real file)" --> M1[POST /api/v1/media/presign-upload<br/>Body: filename, content_type, size<br/>→ upload_url, media_id]
  M1 --> M2[PUT file to upload_url<br/>(MinIO presigned URL)]
  M2 --> M3[POST /api/v1/media/:id/complete<br/>Body: { status: READY, size,<br/>width?, height?, duration_seconds? }]

  %% Metadata-only path
  M0 -- "B) Metadata-only (placeholder)" --> M4[POST /api/v1/media<br/>Body: { name, type: IMAGE|VIDEO|DOCUMENT }<br/>→ media_id]

  %% Join after upload
  M3 --> M5[(media_id)]
  M4 --> M5

  %% =============== OPTIONAL LAYOUT ===============
  M5 --> L0{3) Optional Layout?<br/>(Split screen / mosaic needed?)}
  L0 -- "Yes" --> L1[POST /api/v1/layouts<br/>Body: { name, aspect_ratio, spec }<br/>spec: slot definitions<br/>(each slot: id, x, y, w, h)<br/>→ layout_id]
  L0 -- "No" --> P0

  %% =============== CREATE PRESENTATION ===============
  L1 --> P1[4) Create Presentation (with layout)<br/>POST /api/v1/presentations<br/>Body: { name, description?, layout_id }<br/>→ presentation_id<br/>(expects slot-based media)]
  P0[4) Create Presentation (no layout)<br/>POST /api/v1/presentations<br/>Body: { name, description? }<br/>→ presentation_id<br/>(full-screen playlist)] --> P2

  %% Join presentations
  P1 --> P2[(presentation_id)]

  %% =============== ADD MEDIA TO PRESENTATION ===============
  P2 --> AM0{5) Add Media to Presentation<br/>Layout used?}

  AM0 -- "No layout → playlist items" --> AM1[POST /api/v1/presentations/:id/items<br/>Body: { media_id, order?, duration_seconds? }]
  AM0 -- "Layout → slot items" --> AM2[POST /api/v1/presentations/:id/slots<br/>Body: { slot_id, media_id,<br/>order?, duration_seconds?, fit_mode?, audio_enabled? }<br/>Rule: slot_id must match layout slot id]

  %% =============== CREATE SCHEDULE ===============
  AM1 --> S1
  AM2 --> S1
  S1[6) Create Schedule<br/>POST /api/v1/schedules<br/>Body: { name, description?, start_at?, end_at? }<br/>→ schedule_id] --> S2

  %% =============== ADD SCHEDULE ITEM ===============
  S2[7) Add Schedule Item<br/>POST /api/v1/schedules/:id/items<br/>Body: { presentation_id,<br/>start_at: ISO, end_at: ISO,<br/>priority: 0,<br/>screen_ids?: [...],<br/>screen_group_ids?: [...] }<br/><br/>Rules:<br/>• start_at/end_at within schedule window<br/>• empty screen_ids & screen_group_ids → applies to ALL<br/>• overlap on same targets is rejected] --> W0

  %% =============== PUBLISH WORKFLOW ===============
  W0{8) Publish Workflow?<br/>Approval required?}

  %% Direct publish
  W0 -- "No approval (direct publish)" --> PUB1[POST /api/v1/schedules/:id/publish<br/>Body: { screen_ids?, screen_group_ids?, notes? }<br/>→ DONE]

  %% Approval workflow
  W0 -- "Yes (approval required)" --> REQ1[POST /api/v1/schedule-requests<br/>Body: { schedule_id, payload, notes? }<br/>payload includes publish targets, e.g.:<br/>{ screen_ids?, screen_group_ids?, notes? }<br/>→ request_id]
  REQ1 --> DEC1{Approve or Reject?}
  DEC1 -- "Reject" --> REJ1[POST /api/v1/schedule-requests/:id/reject<br/>Body: { comment? }<br/>→ DONE (no publish)]
  DEC1 -- "Approve" --> APP1[POST /api/v1/schedule-requests/:id/approve<br/>→ status APPROVED]
  APP1 --> PUB2[POST /api/v1/schedule-requests/:id/publish<br/>(only if APPROVED)<br/>→ DONE]
```

Detailed steps and which API to call:

1) Auth
   - `POST /api/v1/auth/login` -> access token. Use for all subsequent calls.

2) Upload media (pick one)
   - Presigned upload (recommended for files):
     - `POST /api/v1/media/presign-upload` with `{ filename, content_type, size }` -> `{ upload_url, media_id }`
     - PUT file to `upload_url`
     - `POST /api/v1/media/:id/complete` with `{ status: "READY", size, width?, height?, duration_seconds? }`
   - Metadata-only placeholder:
     - `POST /api/v1/media` with `{ name, type }`

3) Optional layout (split screen / mosaic)
   - `POST /api/v1/layouts` with `{ name, aspect_ratio, spec }`
   - `spec` defines slots with `id` (slot_id) and `x,y,w,h` coords.

4) Create presentation
   - Full-screen playlist (no layout):
     - `POST /api/v1/presentations` with `{ name, description? }`
   - Slot-based presentation (has layout):
     - `POST /api/v1/presentations` with `{ name, description?, layout_id }`

5) Attach media to presentation
   - If no layout:
     - `POST /api/v1/presentations/:id/items` with `{ media_id, order?, duration_seconds? }`
   - If layout:
     - `POST /api/v1/presentations/:id/slots` with `{ slot_id, media_id, order?, duration_seconds?, fit_mode?, audio_enabled? }`
     - `slot_id` must match a slot `id` from the layout spec.

6) Create schedule
   - `POST /api/v1/schedules` with `{ name, description?, start_at?, end_at? }`
   - If start/end omitted, server defaults a 24h window starting now.

7) Add schedule items (attach presentation + targets)
   - `POST /api/v1/schedules/:id/items` with:
     - `presentation_id`
     - `start_at`, `end_at` (must be inside schedule window)
     - `screen_ids` and/or `screen_group_ids` (empty means global)
   - Server validates:
     - Schedule exists
     - Presentation exists
     - Targets exist
     - No overlapping items for the same targets

8) Publish (choose one)
   - Direct publish (no approval):
     - `POST /api/v1/schedules/:id/publish` with `{ screen_ids?, screen_group_ids?, notes? }`
   - Approval workflow:
     - Create request: `POST /api/v1/schedule-requests`
       - Body: `{ schedule_id, payload, notes? }`
       - `payload` must match publish schema (e.g., `{ screen_ids: [...], screen_group_ids: [...] }`)
     - Approve or reject:
       - `POST /api/v1/schedule-requests/:id/approve`
       - `POST /api/v1/schedule-requests/:id/reject`
     - Publish approved request:
       - `POST /api/v1/schedule-requests/:id/publish`
       - Only works if status is APPROVED.

9) Playback fetch (device or server)
   - `GET /api/v1/device/:deviceId/snapshot?include_urls=true`
   - or `GET /api/v1/screens/:id/snapshot?include_urls=true`

## Emergency Types & Emergency Trigger (Admin Only)

Use this to predefine emergency templates and trigger them to selected screens/groups or all screens. Emergency playback is full-screen media (no layout).

- **Emergency types CRUD** (admin):
  - Create: `POST /api/v1/emergency-types` with `{ name, description?, message, severity, media_id? }`
  - List: `GET /api/v1/emergency-types?page=&limit=`
  - Get: `GET /api/v1/emergency-types/:id`
  - Update: `PATCH /api/v1/emergency-types/:id` (same fields; `media_id` can be set or cleared)
  - Delete: `DELETE /api/v1/emergency-types/:id`

- **Trigger emergency** (admin):
  - `POST /api/v1/emergency/trigger`
  - Body example:
    ```json
    {
      "emergency_type_id": "<uuid>",
      "screen_ids": ["<screen-id>"],
      "screen_group_ids": ["<group-id>"],
      "target_all": false
    }
    ```
  - Targets:
    - If `target_all` is true, it applies to all screens.
    - If both `screen_ids` and `screen_group_ids` are empty and `target_all` is not set, it defaults to all.

- **Emergency status/clear/history** (admin):
  - Status: `GET /api/v1/emergency/status`
  - Clear: `POST /api/v1/emergency/:id/clear`
  - History: `GET /api/v1/emergency/history?page=&limit=`

- **Device behavior (pause schedule + show emergency)**:
  - Snapshot endpoints now include an `emergency` object when active.
  - Devices should pause normal schedule playback while `emergency` is present and render the emergency media full-screen.
  - Use `include_urls=true` to receive `emergency.media_url`.

## Screen Status & Commands

- **Screen status**: `GET /api/v1/screens/:id/status` (auth) returns status, last heartbeat, and `current_schedule_id/current_media_id` as reported by device heartbeats.  
- **Now playing**: `GET /api/v1/screens/:id/now-playing` returns active schedule items from the latest publish for that screen.  
- **Device commands**:  
  - Create (admin): `POST /api/v1/device/:deviceId/commands` with `{ "type": "REBOOT|REFRESH|TEST_PATTERN", "payload": { ... } }`.  
  - Devices poll `GET /api/v1/device/:deviceId/commands` and `POST /api/v1/device/:deviceId/commands/:commandId/ack` to acknowledge.
