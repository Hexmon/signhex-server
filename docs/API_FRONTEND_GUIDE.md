# Signhex CMS API Guide (Frontend-Facing)

This guide documents the CMS APIs needed by the dashboard UI. It follows a consistent format: overview, required headers, parameters, response shape, and notes. All endpoints expect `Authorization: Bearer <JWT>` unless marked otherwise.

## Base
- Base URL: `{{baseURL}}` (local: `http://localhost:3000`)
- Auth: Bearer JWT from `/v1/auth/login`
- Common headers: `Authorization: Bearer {{authToken}}`, `Content-Type: application/json` where applicable
- Pagination: `page`, `limit` (defaults vary per endpoint)
- Errors: JSON `{ error: string }`

## Auth
- **POST /v1/auth/login**  
  Body: `{ "email": string, "password": string }`  
  Response: `{ token, user:{id,email,first_name,last_name,role}, expiresAt }`
- **GET /v1/auth/me**  
  Response: current user profile
- **POST /v1/auth/logout**

## Users & Invites
- **POST /v1/users** (admin) — create user  
  Body: `email, password, role (ADMIN|OPERATOR|DEPARTMENT), department_id?`
- **GET /v1/users** — query `page,limit,role,department_id,is_active`  
  Response items include `id,email,first_name,last_name,role,is_active,department_id`
- **GET /v1/users/:id**, **PATCH /v1/users/:id**, **DELETE /v1/users/:id**
- **POST /v1/users/invite** (admin) — returns `invite_token`, `invite_expires_at`, `temp_password`
- **POST /v1/users/activate** — body `{ token, password }` to activate invite
- **POST /v1/users/:id/reset-password** (admin) — returns new `temp_password`

## Departments
- **CRUD /v1/departments** — fields: `name`, `description?`; list supports `page,limit`

## Screens
- **POST /v1/screens** — `name`, `location?`
- **GET /v1/screens** — query `page,limit,status`; returns `status`, `last_heartbeat_at`
- **GET /v1/screens/:id**, **PATCH /v1/screens/:id**, **DELETE /v1/screens/:id**

## Media (Direct Upload Flow)
1) **POST /v1/media/presign-upload**  
   Body: `{ filename, content_type, size }`  
   Response: `{ upload_url, media_id, bucket, object_key, expires_in }` (media status=PENDING, source bucket/key stored)
2) Client PUTs file to `upload_url`
3) **POST /v1/media/:id/complete**  
   Body: `{ status?, content_type?, size?, width?, height?, duration_seconds? }` (default status READY)  
   Verifies object via MinIO head; updates metadata.
4) **GET /v1/media** — query `page,limit,type,status`; returns fields incl. `status, duration_seconds, width, height, ready_object_id, thumbnail_object_id, source_bucket/key/content_type/size`
5) **GET /v1/media/:id** — same fields

## Schedules
- **POST /v1/schedules** — `name`, `description?`, `start_at` (future), `end_at` (future, after start)
- **GET /v1/schedules** — query `page,limit,is_active`; returns start/end
- **GET /v1/schedules/:id**
- **PATCH /v1/schedules/:id** — same validation for start/end if provided
- **POST /v1/schedules/:id/publish** — body `{ screen_ids?, screen_group_ids? }`  
  Response: `{ publish_id, snapshot_id, targets }` (targets auto-marked SENT)
- **GET /v1/publishes/:id** — poll publish & targets
- **GET /v1/schedules/:id/publishes** — publish history with targets
- **PATCH /v1/publishes/:publishId/targets/:targetId** — update target `status`, `error?`

## Requests (Tickets) & Messages
- **POST /v1/requests** — `title`, `description?`, `priority? (LOW|MEDIUM|HIGH)`, `assigned_to?`  
- **GET /v1/requests** — query `page,limit,status`; returns priority and attachments (presigned URLs if available)
- **GET /v1/requests/:id**, **PATCH /v1/requests/:id**
- **POST /v1/requests/:id/messages** — body `{ message, attachments?: string[] }` (attachments = storage IDs)  
  Response includes author info and presigned attachment URLs (null if storage row missing).
- **GET /v1/requests/:id/messages** — pagination; items include author and attachments with URLs

## Conversations (1:1)
- **POST /v1/conversations** — `{ participant_id }` to get/create 1:1 thread
- **GET /v1/conversations**
- **GET /v1/conversations/:id/messages** — pagination
- **POST /v1/conversations/:id/messages** — `{ content, attachments? }`
- **POST /v1/conversations/:id/read**

## Proof of Play
- **GET /v1/proof-of-play** — query:  
  `page,limit,screen_id,media_id,schedule_id,start,end,status (COMPLETED|INCOMPLETE),include_url=true,group_by=day|screen|media`  
  - `include_url=true` adds presigned URLs when storage exists.  
  - `group_by` returns counts for charts (no pagination).
- **GET /v1/proof-of-play/export** — CSV export with same filters

## Reports & Metrics
- **GET /v1/reports/summary** — media total, open/completed requests, active/offline screens, uptime %
- **GET /v1/reports/trends** — PoP daily counts, media by type, requests by status
- **GET /v1/metrics/overview** — basic totals + PoP counts (last 24h/7d)

## API Keys (Admin)
- **POST /v1/api-keys** — returns secret once; fields: `name, scopes?, roles?, expires_at?`
- **GET /v1/api-keys**, **POST /v1/api-keys/:id/rotate**, **POST /v1/api-keys/:id/revoke**

## Webhooks (Admin)
- **POST /v1/webhooks** — `name, event_types[], target_url, headers?, is_active?` (auto-generates secret)
- **GET /v1/webhooks**, **PATCH /v1/webhooks/:id**, **DELETE /v1/webhooks/:id**
- **POST /v1/webhooks/:id/test** — test-fire stub (echo)

## SSO Config (Admin)
- **POST /v1/sso-config** — OIDC fields: `issuer, client_id, client_secret, authorization_url?, token_url?, jwks_url?, redirect_uri?, scopes?, is_active?` (only one active)
- **GET /v1/sso-config** (active), **POST /v1/sso-config/:id/deactivate**

## Org Settings (Admin)
- **GET /v1/settings**
- **POST /v1/settings** — upsert `{ key, value }` (e.g., branding/logo_url, timezone, theme, notification prefs)

## Notifications, Audit Logs, Emergency
- Endpoints exist (`/v1/notifications`, `/v1/audit-logs`, `/v1/emergency/*`) but not currently surfaced in UI.

## Device Telemetry & Pairing (Player-side)
- `/v1/device/heartbeat`, `/v1/device/proof-of-play`, `/v1/device/screenshot`, `/v1/device/:deviceId/commands`, pairing at `/v1/device-pairing/*` — reserved for player/edge, not dashboard UI.

## Auth & Headers Quick Reference
- `Authorization: Bearer {{authToken}}` required for all except login/activate/invite flows.
- `Content-Type: application/json` for POST/PATCH except presigned PUT to MinIO.
- File upload: use `upload_url` (PUT) from presign response.

## Notes & Limitations
- Publish lifecycle beyond SENT is manual (update targets via endpoint or device acks). No auto completion without device feedback.
- Uptime/SLA analytics are coarse; deeper telemetry would be needed for full SLA charts.
- Invites/reset do not send email; tokens/temp passwords are returned in API responses.
