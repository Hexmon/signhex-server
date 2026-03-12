# API Catalog (v1)

Base path: `/api/v1`

Standard error shape (all endpoints):
```json
{
  "success": false,
  "error": {
    "code": "<CODE>",
    "message": "<MESSAGE>",
    "details": null,
    "traceId": "<request-id>"
  }
}
```
Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/utils/app-error.ts formatErrorResponse

Auth types (from code):
- `JWT (CMS)` = `Authorization: Bearer <token>` + RBAC checks.
- `Device cert header` = `x-device-serial` or `x-device-cert-serial` (device certificate fingerprint); validated in device snapshot auth only.
- `Public` = no auth.

Port note (verify): config defines `PORT` (3000) + `DEVICE_PORT` (8443), but the only server created/listening in code is `PORT`. Device endpoints rely on headers and/or JWT, not explicit mTLS enforcement in code. Refs: /Users/anuragkumar/Desktop/signhex/signhex-server/src/config/index.ts env schema, /Users/anuragkumar/Desktop/signhex/signhex-server/src/index.ts fastify.listen.

---

## Health

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /api/v1/health | Public | Liveness check. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/server/index.ts fastify.get('/api/v1/health') | none | `{ status, timestamp }` | 500 INTERNAL_ERROR |

---

## Auth

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/auth/login | Public | Login, issue JWT + session (side effects: sessions table, lockout tracking, cookies). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/auth.ts fastify.post(apiEndpoints.auth.login) | body: `{ email, password }` (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/schemas/auth.ts#loginSchema) | `200 { user, expiresAt }` + cookies; in dev also `token` + `csrf_token` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 429 RATE_LIMITED; 500 INTERNAL_ERROR |
| POST | /api/v1/auth/logout | JWT (CMS) | Revoke token (side effects: sessions revoke, clear cookies). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/auth.ts fastify.post(apiEndpoints.auth.logout) | header: Authorization | `{ message }` | 401 UNAUTHORIZED; 500 INTERNAL_ERROR |
| GET | /api/v1/auth/me | JWT (CMS) | Get current user and role (checks session). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/auth.ts fastify.get(apiEndpoints.auth.me) | header: Authorization | user object (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/schemas/auth.ts#meResponseSchema) | 401 UNAUTHORIZED; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Users

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/users | JWT (CMS) | Create user (side effects: users table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/users.ts fastify.post(apiEndpoints.users.create) | body: create user (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/schemas/user.ts#createUserSchema) | user object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND (role); 409 CONFLICT; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/users | JWT (CMS) | List users. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/users.ts fastify.get(apiEndpoints.users.list) | query: page, limit, role_id, department_id, is_active (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/schemas/user.ts#listUsersQuerySchema) | `{ items, pagination }` | 401 UNAUTHORIZED; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/users/:id | JWT (CMS) | Get user by id. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/users.ts fastify.get(apiEndpoints.users.get) | path: id | user object | 401 UNAUTHORIZED; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| PATCH | /api/v1/users/:id | JWT (CMS) | Update user (side effects: users table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/users.ts fastify.patch(apiEndpoints.users.update) | path: id; body: update user (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/schemas/user.ts#updateUserSchema) | user object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/users/:id | JWT (CMS) | Delete user (side effects: users table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/users.ts fastify.delete(apiEndpoints.users.delete) | path: id | `{ message, id }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

### User Invites + Activation

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/users/invite | JWT (CMS) | Invite user (side effects: users table + ext invite fields). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/users-invite.ts fastify.post(apiEndpoints.userInvite.invite) | body: `{ email, role, department_id? }` | `{ id, email, role, department_id, invite_token, invite_expires_at, invite_status, invited_at, temp_password }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 409 CONFLICT; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/users/invite | JWT (CMS) | List invites (filters). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/users-invite.ts fastify.get(apiEndpoints.userInvite.list) | query: page, limit, status, email, role, department_id, invited_before/after | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/users/invite/pending | JWT (CMS) | List pending invites (legacy). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/users-invite.ts fastify.get(apiEndpoints.userInvite.pending) | none | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| POST | /api/v1/users/:id/reset-password | JWT (CMS) | Reset user password (side effects: users table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/users-invite.ts fastify.post(apiEndpoints.userInvite.resetPassword) | path: id; body: `{ current_password, new_password }` | `{ id, email, message }` | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/users/activate | Public | Activate invited user (side effects: users ext + is_active). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/users-activate.ts fastify.post(apiEndpoints.userActivate.activate) | body: `{ token, password }` | `{ success: true, user_id }` | 400 BAD_REQUEST (expired); 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |

---

## Roles + Permissions

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/roles | JWT (CMS) | Create role (side effects: roles table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/roles.ts fastify.post(apiEndpoints.roles.create) | body: `{ name, description?, permissions }` (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/roles.ts#createRoleSchema) | role object | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/roles | JWT (CMS) | List roles. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/roles.ts fastify.get(apiEndpoints.roles.list) | query: page, limit, search | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/roles/:id | JWT (CMS) | Get role by id. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/roles.ts fastify.get(apiEndpoints.roles.get) | path: id | role object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| PUT | /api/v1/roles/:id | JWT (CMS) | Update role (side effects: roles table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/roles.ts fastify.put(apiEndpoints.roles.update) | path: id; body: update role (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/roles.ts#updateRoleSchema) | role object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/roles/:id | JWT (CMS) | Delete role (side effects: roles table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/roles.ts fastify.delete(apiEndpoints.roles.delete) | path: id | `{ success: true }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 409 CONFLICT; 500 INTERNAL_ERROR |
| GET | /api/v1/permissions/metadata | JWT (CMS) | Get permission actions/subjects. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/permissions.ts fastify.get(apiEndpoints.permissions.metadata) | none | `{ actions, subjects }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |

---

## Departments

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/departments | JWT (CMS) | Create department (side effects: departments table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/departments.ts fastify.post(apiEndpoints.departments.create) | body: `{ name, description? }` | department object | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/departments | JWT (CMS) | List departments. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/departments.ts fastify.get(apiEndpoints.departments.list) | query: page, limit | `{ items, pagination }` | 401 UNAUTHORIZED; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/departments/:id | JWT (CMS) | Get department by id. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/departments.ts fastify.get(apiEndpoints.departments.get) | path: id | department object | 401 UNAUTHORIZED; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| PATCH | /api/v1/departments/:id | JWT (CMS) | Update department (side effects: departments table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/departments.ts fastify.patch(apiEndpoints.departments.update) | path: id; body: `{ name?, description? }` | department object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/departments/:id | JWT (CMS) | Delete department (side effects: departments table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/departments.ts fastify.delete(apiEndpoints.departments.delete) | path: id | `{ message, id }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Media

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/media/presign-upload | JWT (CMS) | Create media record + presigned upload (side effects: media table, MinIO bucket). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/media.ts fastify.post(apiEndpoints.media.presignUpload) | body: `{ filename, content_type, size }` (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/schemas/media.ts#presignUploadSchema) | `{ upload_url, media_id, bucket, object_key, expires_in }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/media | JWT (CMS) | Create media metadata (side effects: media table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/media.ts fastify.post(apiEndpoints.media.create) | body: `{ name, type }` (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/schemas/media.ts#createMediaSchema) | media object | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/media | JWT (CMS) | List media (includes media_url). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/media.ts fastify.get(apiEndpoints.media.list) | query: page, limit, type, status (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/schemas/media.ts#listMediaQuerySchema) | `{ items, pagination }` | 401 UNAUTHORIZED; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/media/:id | JWT (CMS) | Get media by id (includes media_url). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/media.ts fastify.get(apiEndpoints.media.get) | path: id | media object | 401 UNAUTHORIZED; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| POST | /api/v1/media/:id/complete | JWT (CMS) | Finalize upload (side effects: media table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/media.ts fastify.post(apiEndpoints.media.complete) | path: id; body: `{ status?, content_type?, size?, width?, height?, duration_seconds? }` | `{ id, status, source_*, width, height, duration_seconds, updated_at }` | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/media/:id | JWT (CMS) | Delete media (side effects: media table + MinIO delete; optional hard delete). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/media.ts fastify.delete(apiEndpoints.media.delete) | path: id; query: `hard=true` | `{ message, id, storage_deleted[] }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Presentations

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/presentations | JWT (CMS) | Create presentation (side effects: presentations table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/presentations.ts fastify.post(apiEndpoints.presentations.create) | body: `{ name, description?, layout_id? }` | presentation object | 401 UNAUTHORIZED; 404 NOT_FOUND (layout); 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/presentations | JWT (CMS) | List presentations. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/presentations.ts fastify.get(apiEndpoints.presentations.list) | query: page, limit | `{ items, pagination }` | 401 UNAUTHORIZED; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/presentations/:id | JWT (CMS) | Get presentation with slots + media. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/presentations.ts fastify.get(apiEndpoints.presentations.get) | path: id | `{ id, layout, slots[], created_by, ... }` | 401 UNAUTHORIZED; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| PATCH | /api/v1/presentations/:id | JWT (CMS) | Update presentation (side effects: presentations table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/presentations.ts fastify.patch(apiEndpoints.presentations.update) | path: id; body: partial `{ name?, description?, layout_id? }` | presentation object | 401 UNAUTHORIZED; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/presentations/:id | JWT (CMS) | Delete presentation (side effects: presentations table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/presentations.ts fastify.delete(apiEndpoints.presentations.delete) | path: id | 204 no content | 401 UNAUTHORIZED; 500 INTERNAL_ERROR |
| GET | /api/v1/presentations/:id/items | JWT (CMS) | List playlist items. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/presentations.ts fastify.get(apiEndpoints.presentations.items) | path: id | `{ items: [{ media_id, order, duration_seconds, media? }] }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| POST | /api/v1/presentations/:id/items | JWT (CMS) | Add playlist item (side effects: presentation_items). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/presentations.ts fastify.post(apiEndpoints.presentations.items) | body: `{ media_id, order?, duration_seconds? }` | item object + media | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/presentations/:id/items/:itemId | JWT (CMS) | Delete playlist item (side effects: presentation_items). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/presentations.ts fastify.delete(apiEndpoints.presentations.item) | path: id, itemId | 204 no content | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| GET | /api/v1/presentations/:id/slots | JWT (CMS) | List slot items (layout). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/presentations.ts fastify.get(apiEndpoints.presentations.slotItems) | path: id | `{ items: [{ slot_id, media_id, ... }] }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| POST | /api/v1/presentations/:id/slots | JWT (CMS) | Add slot item (side effects: presentation_slot_items). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/presentations.ts fastify.post(apiEndpoints.presentations.slotItems) | body: `{ slot_id, media_id, order?, duration_seconds?, fit_mode?, audio_enabled? }` | item object + media | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/presentations/:id/slots/:slotItemId | JWT (CMS) | Delete slot item (side effects: presentation_slot_items). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/presentations.ts fastify.delete(apiEndpoints.presentations.slotItem) | path: id, slotItemId | 204 no content | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Layouts

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/layouts | JWT (CMS) | Create layout (side effects: layouts table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/layouts.ts fastify.post(apiEndpoints.layouts.create) | body: `{ name, description?, aspect_ratio, spec }` | layout object | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/layouts | JWT (CMS) | List layouts. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/layouts.ts fastify.get(apiEndpoints.layouts.list) | query: page, limit, aspect_ratio?, search? | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/layouts/:id | JWT (CMS) | Get layout by id. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/layouts.ts fastify.get(apiEndpoints.layouts.get) | path: id | layout object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| PATCH | /api/v1/layouts/:id | JWT (CMS) | Update layout (side effects: layouts table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/layouts.ts fastify.patch(apiEndpoints.layouts.update) | path: id; body: partial layout | layout object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/layouts/:id | JWT (CMS) | Delete layout (side effects: layouts table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/layouts.ts fastify.delete(apiEndpoints.layouts.delete) | path: id | 204 no content | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Schedules + Publishes

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/schedules | JWT (CMS) | Create schedule (side effects: schedules table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts fastify.post(apiEndpoints.schedules.create) | body: `{ name, description?, start_at?, end_at? }` (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/schemas/schedule.ts#createScheduleSchema) | schedule object | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/schedules | JWT (CMS) | List schedules. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts fastify.get(apiEndpoints.schedules.list) | query: page, limit, is_active | `{ items, pagination }` | 401 UNAUTHORIZED; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/schedules/:id | JWT (CMS) | Get schedule by id. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts fastify.get(apiEndpoints.schedules.get) | path: id | schedule object | 401 UNAUTHORIZED; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| PATCH | /api/v1/schedules/:id | JWT (CMS) | Update schedule (side effects: schedules table). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts fastify.patch(apiEndpoints.schedules.update) | path: id; body: update schedule (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/schemas/schedule.ts#updateScheduleSchema) | schedule object | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/schedules/:id/publish | JWT (CMS) | Publish schedule (side effects: schedule_snapshots, publishes, publish_targets). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts fastify.post(apiEndpoints.schedules.publish) | body: `{ screen_ids?, screen_group_ids?, notes?, schedule_request_id? }` (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/schemas/schedule.ts#publishScheduleSchema) | `{ message, schedule_id, publish_id, snapshot_id, targets, resolved_screen_ids }` | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/schedules/:id/publishes | JWT (CMS) | List publish history for schedule. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts fastify.get(apiEndpoints.schedules.publishes) | path: id | `{ items: [{ publish + targets[] }] }` | 401 UNAUTHORIZED; 500 INTERNAL_ERROR |
| PATCH | /api/v1/publishes/:publishId/targets/:targetId | JWT (CMS) | Update target status (side effects: publish_targets). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts fastify.patch(apiEndpoints.schedules.updatePublishTarget) | path: publishId, targetId; body: `{ status, error? }` | publish target row | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| GET | /api/v1/publishes/:id | JWT (CMS) | Get publish record + targets. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts fastify.get(apiEndpoints.schedules.publishStatus) | path: id | publish row + `targets` | 401 UNAUTHORIZED; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| GET | /api/v1/schedules/:id/items | JWT (CMS) | List schedule items with resolved presentations/media. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts fastify.get(apiEndpoints.schedules.items) | path: id | `{ items: [{ presentation, slots, ... }] }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| POST | /api/v1/schedules/:id/items | JWT (CMS) | Add schedule item (side effects: schedule_items). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts fastify.post(apiEndpoints.schedules.items) | body: `{ presentation_id, start_at, end_at, priority, screen_ids[], screen_group_ids[] }` | item object | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/schedules/:id/items/:itemId | JWT (CMS) | Delete schedule item (side effects: schedule_items). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedules.ts fastify.delete(apiEndpoints.schedules.item) | path: id, itemId | 204 no content | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Schedule Requests

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/schedule-requests | JWT (CMS) | Create schedule request (side effects: schedule_requests). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedule-requests.ts fastify.post(apiEndpoints.scheduleRequests.create) | body: `{ schedule_id, notes? }`; query: `include=` | request object (optionally expanded) | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/schedule-requests/status-summary | JWT (CMS) | Counts per status. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedule-requests.ts fastify.get(apiEndpoints.scheduleRequests.statusSummary) | none | `{ counts }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| GET | /api/v1/schedule-requests | JWT (CMS) | List requests (optionally expanded). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedule-requests.ts fastify.get(apiEndpoints.scheduleRequests.list) | query: page, limit, status, include | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/schedule-requests/:id | JWT (CMS) | Get request by id (optionally expanded). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedule-requests.ts fastify.get(apiEndpoints.scheduleRequests.get) | path: id; query: include | request object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| PATCH | /api/v1/schedule-requests/:id | JWT (CMS) | Update request (admin only; side effects: schedule_requests). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedule-requests.ts fastify.patch(apiEndpoints.scheduleRequests.update) | path: id; body: `{ schedule_id?, notes? }` | request object | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/schedule-requests/:id/approve | JWT (CMS) | Approve request (side effects: schedule_requests status). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedule-requests.ts fastify.post(apiEndpoints.scheduleRequests.approve) | path: id; body: `{ comment? }` | `{ id, status, reviewed_by, reviewed_at, review_notes }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| POST | /api/v1/schedule-requests/:id/reject | JWT (CMS) | Reject request (side effects: schedule_requests status). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedule-requests.ts fastify.post(apiEndpoints.scheduleRequests.reject) | path: id; body: `{ comment? }` | `{ id, status, reviewed_by, reviewed_at, review_notes }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| POST | /api/v1/schedule-requests/:id/publish | JWT (CMS) | Publish approved request (side effects: publish snapshot + targets). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/schedule-requests.ts fastify.post(apiEndpoints.scheduleRequests.publish) | path: id | `{ message, schedule_request_id, schedule_id, publish_id, snapshot_id, resolved_screen_ids, targets }` | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Screens

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/screens | JWT (CMS) | Manual screen creation is blocked. Screens must be created by successful device pairing completion. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.post(apiEndpoints.screens.create) | body: `{ name, location? }` | `409 CONFLICT` with pairing-flow message | 401 UNAUTHORIZED; 403 FORBIDDEN; 409 CONFLICT |
| GET | /api/v1/screens | JWT (CMS) | List screens. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.get(apiEndpoints.screens.list) | query: page, limit, status | `{ items, pagination }` | 401 UNAUTHORIZED; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/screens/aspect-ratios | JWT (CMS) | List screens with aspect ratios. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.get(apiEndpoints.screens.aspectRatios) | query: search? | `{ items: [{ id, name, aspect_ratio }] }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/screens/overview | JWT (CMS) | Combined overview with now-playing/availability. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.get(apiEndpoints.screens.overview) | none | `{ screens: [...], groups: [...] }` | 401 UNAUTHORIZED; 500 INTERNAL_ERROR |
| GET | /api/v1/screens/:id | JWT (CMS) | Get screen by id. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.get(apiEndpoints.screens.get) | path: id | screen object | 401 UNAUTHORIZED; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| GET | /api/v1/screens/:id/status | JWT (CMS) | Screen status + latest heartbeat payload. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.get(apiEndpoints.screens.status) | path: id | `{ id, status, latest_heartbeat }` | 401 UNAUTHORIZED; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| GET | /api/v1/screens/:id/heartbeats | JWT (CMS) | List heartbeat history (optional payload). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.get(apiEndpoints.screens.heartbeats) | path: id; query: page, limit, start_at, end_at, status, include_payload | `{ screen_id, items, pagination }` | 400 BAD_REQUEST; 401 UNAUTHORIZED; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/screens/:id/screenshot-settings | JWT (CMS) | Set screenshot interval (side effects: screens + device_commands). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.post(apiEndpoints.screens.screenshotSettings) | path: id; body: `{ interval_seconds?, enabled? }` | `{ screen_id, screenshot_enabled, screenshot_interval_seconds, command_id }` | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/screens/:id/screenshot | JWT (CMS) | Trigger screenshot (side effects: device_commands). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.post(apiEndpoints.screens.screenshot) | path: id; body: `{ reason? }` | `{ screen_id, command_id }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/screens/:id/now-playing | JWT (CMS) | Active schedule items for screen. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.get(apiEndpoints.screens.nowPlaying) | path: id | `{ screen_id, publish, active_items, upcoming_items, booked_until }` | 401 UNAUTHORIZED; 500 INTERNAL_ERROR |
| GET | /api/v1/screens/:id/availability | JWT (CMS) | Current + next items (availability). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.get(apiEndpoints.screens.availability) | path: id; query: include_urls? | `{ screen_id, publish, current_items, next_item, upcoming_items, booked_until }` | 401 UNAUTHORIZED; 500 INTERNAL_ERROR |
| GET | /api/v1/screens/:id/snapshot | JWT (CMS) | Latest publish snapshot for screen (includes media_urls if requested). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.get(apiEndpoints.screens.snapshot) | path: id; query: include_urls? | `{ screen_id, publish, snapshot, media_urls, emergency?, default_media? }` | 401 UNAUTHORIZED; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| PATCH | /api/v1/screens/:id | JWT (CMS) | Update screen (side effects: screens). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.patch(apiEndpoints.screens.update) | path: id; body: `{ name?, location? }` | screen object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/screens/:id | JWT (CMS) | Delete screen + cleanup (side effects: screens + related tables). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screens.ts fastify.delete(apiEndpoints.screens.delete) | path: id | `{ message, id, cleanup }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |

---

## Screen Groups

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/screen-groups | JWT (CMS) | Create group (side effects: screen_groups + members). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screen-groups.ts fastify.post(apiEndpoints.screenGroups.create) | body: `{ name, description?, screen_ids? }` | group object | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/screen-groups | JWT (CMS) | List groups. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screen-groups.ts fastify.get(apiEndpoints.screenGroups.list) | query: page, limit | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/screen-groups/available-screens | JWT (CMS) | List screens not in a group. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screen-groups.ts fastify.get(apiEndpoints.screenGroups.availableScreens) | query: page, limit, group_id? | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/screen-groups/:id | JWT (CMS) | Get group by id. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screen-groups.ts fastify.get(apiEndpoints.screenGroups.get) | path: id | group object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| PATCH | /api/v1/screen-groups/:id | JWT (CMS) | Update group (side effects: screen_groups + members). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screen-groups.ts fastify.patch(apiEndpoints.screenGroups.update) | path: id; body: `{ name?, description?, screen_ids? }` | group object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/screen-groups/:id | JWT (CMS) | Delete group (side effects: screen_groups + members). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screen-groups.ts fastify.delete(apiEndpoints.screenGroups.delete) | path: id | 204 no content | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| GET | /api/v1/screen-groups/:id/availability | JWT (CMS) | Availability across group. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screen-groups.ts fastify.get(apiEndpoints.screenGroups.availability) | path: id | `{ group_id, current_items, next_item, booked_until, screens[] }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| GET | /api/v1/screen-groups/:id/snapshot | JWT (CMS) | Latest publish snapshot for group. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screen-groups.ts fastify.get(apiEndpoints.screenGroups.snapshot) | path: id; query: include_urls? | `{ group_id, publish, snapshot, media_urls }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| POST | /api/v1/screen-groups/:id/screenshot-settings | JWT (CMS) | Set screenshot interval for all group screens (side effects: screens + device_commands). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screen-groups.ts fastify.post(apiEndpoints.screenGroups.screenshotSettings) | body: `{ interval_seconds?, enabled? }` | `{ group_id, screenshot_enabled, screenshot_interval_seconds, updated_screens, commands }` | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/screen-groups/:id/screenshot | JWT (CMS) | Trigger screenshot for group (side effects: device_commands). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screen-groups.ts fastify.post(apiEndpoints.screenGroups.screenshot) | body: `{ reason? }` | `{ group_id, commands_created, commands }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/screen-groups/:id/now-playing | JWT (CMS) | Now-playing across group. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/screen-groups.ts fastify.get(apiEndpoints.screenGroupNowPlaying.get) | path: id | `{ group_id, name, screens: [...] }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Device Pairing

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/device-pairing/request | Public | Device requests pairing code + device_id (side effects: device_pairings). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts fastify.post(apiEndpoints.devicePairing.request) | body: `{ device_label?, expires_in?, width?, height?, aspect_ratio?, orientation?, model?, codecs?, device_info? }` | `{ id, device_id, pairing_code, expires_at, expires_in, connected, observed_ip, specs }` | 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/device-pairing/status | Public | Check current pairing/recovery state for a `device_id`. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts fastify.get(apiEndpoints.devicePairing.status) | query: `device_id` | `{ device_id, paired, confirmed, active_pairing?, screen?, diagnostics?, certificate? }` | 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/device-pairing/confirm | JWT (CMS) | Confirm first-time pairing or same-device recovery approval. This does not create the screen row; the device still has to complete pairing with a CSR. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts fastify.post(apiEndpoints.devicePairing.confirm) | body: `{ pairing_code, name, location? }` | `{ message, pairing, recovery? }` | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 409 CONFLICT; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/device-pairing/complete | Public | Complete pairing with CSR; issue certificate and create or recover the screen identity (side effects: device_certificates + device_pairings used + screen row created if needed). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts fastify.post(apiEndpoints.devicePairing.complete) | body: `{ pairing_code, csr }` | `{ success, message, device_id, certificate, fingerprint, expires_at }` | 400 BAD_REQUEST; 404 NOT_FOUND; 409 CONFLICT; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR (includes CA_CERT_MISSING) |
| POST | /api/v1/device-pairing/generate | JWT (CMS) | Admin generates pairing code for existing device_id (side effects: device_pairings). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts fastify.post(apiEndpoints.devicePairing.generate) | body: `{ device_id, expires_in? }` | `{ id, pairing_code, expires_at, expires_in }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/device-pairing | JWT (CMS) | List pairings. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-pairing.ts fastify.get(apiEndpoints.devicePairing.list) | query: page, limit | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |

---

## Device Telemetry + Player

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /api/v1/device/:deviceId/snapshot | Device cert header OR JWT (CMS) | Latest publish snapshot for device (filters items + includes emergency/default media). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts fastify.get(apiEndpoints.deviceTelemetry.snapshot) | path: deviceId; query: `include_urls?` | `{ device_id, publish?, snapshot?, media_urls?, emergency?, default_media? }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/device/:deviceId/commands | JWT (CMS) | Create device command (side effects: device_commands). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts fastify.post(apiEndpoints.deviceTelemetry.commands) | path: deviceId; body: `{ type, payload? }` | `{ id, screen_id, type, payload, status, created_at }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/device/:deviceId/commands | Device cert header (assumed) | Fetch pending commands (side effects: device_commands status set to SENT). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts fastify.get(apiEndpoints.deviceTelemetry.commands) | path: deviceId | `{ commands: [{ id, type, payload, timestamp }] }` | 500 INTERNAL_ERROR |
| POST | /api/v1/device/:deviceId/commands/:commandId/ack | Device cert header (assumed) | Ack command (side effects: device_commands status). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts fastify.post(apiEndpoints.deviceTelemetry.ackCommand) | path: deviceId, commandId | `{ success, timestamp }` | 404 NOT_FOUND; 500 INTERNAL_ERROR |
| POST | /api/v1/device/heartbeat | Device cert header (assumed) | Device heartbeat (side effects: heartbeats, storage_objects, screens). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts fastify.post(apiEndpoints.deviceTelemetry.heartbeat) | body: telemetry payload (schema: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts#heartbeatSchema) | `{ success, timestamp, commands[] }` | 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/device/proof-of-play | Device cert header (assumed) | Report PoP (side effects: proof_of_play + storage_objects). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts fastify.post(apiEndpoints.deviceTelemetry.proofOfPlay) | body: `{ device_id, media_id, schedule_id, start_time, end_time, duration, completed }` | `{ success, timestamp }` | 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/device/screenshot | Device cert header (assumed) | Upload screenshot (side effects: MinIO device-screenshots). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/device-telemetry.ts fastify.post(apiEndpoints.deviceTelemetry.screenshot) | body: `{ device_id, timestamp, image_data }` | `{ success, object_key, timestamp }` | 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |

---

## Emergency

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/emergency/trigger | JWT (CMS) | Trigger emergency (side effects: emergencies + websocket emit). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/emergency.ts fastify.post(apiEndpoints.emergency.trigger) | body: `{ emergency_type_id?, message?, severity?, media_id?, screen_ids?, screen_group_ids?, target_all? }` | emergency object | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 409 CONFLICT; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/emergency/status | JWT (CMS) | Get active emergency. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/emergency.ts fastify.get(apiEndpoints.emergency.status) | none | `{ active, emergency }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| POST | /api/v1/emergency/:id/clear | JWT (CMS) | Clear emergency (side effects: emergencies + websocket emit). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/emergency.ts fastify.post(apiEndpoints.emergency.clear) | path: id | emergency object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| GET | /api/v1/emergency/history | JWT (CMS) | List emergency history. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/emergency.ts fastify.get(apiEndpoints.emergency.history) | query: page, limit | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| POST | /api/v1/emergency-types | JWT (CMS) | Create emergency type (side effects: emergency_types). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/emergency.ts fastify.post(apiEndpoints.emergencyTypes.create) | body: `{ name, description?, message, severity?, media_id? }` | emergency type object | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/emergency-types | JWT (CMS) | List emergency types. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/emergency.ts fastify.get(apiEndpoints.emergencyTypes.list) | query: page, limit | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/emergency-types/:id | JWT (CMS) | Get emergency type by id. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/emergency.ts fastify.get(apiEndpoints.emergencyTypes.get) | path: id | emergency type object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| PATCH | /api/v1/emergency-types/:id | JWT (CMS) | Update emergency type (side effects: emergency_types). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/emergency.ts fastify.patch(apiEndpoints.emergencyTypes.update) | path: id; body: partial emergency type | emergency type object | 400 BAD_REQUEST; 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/emergency-types/:id | JWT (CMS) | Delete emergency type (side effects: emergency_types). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/emergency.ts fastify.delete(apiEndpoints.emergencyTypes.delete) | path: id | 204 no content | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Requests (Content Requests)

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/requests | JWT (CMS) | Create request (side effects: requests). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/requests.ts fastify.post(apiEndpoints.requests.create) | body: `{ title, description?, priority?, assigned_to? }` | request object | 401 UNAUTHORIZED; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/requests | JWT (CMS) | List requests. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/requests.ts fastify.get(apiEndpoints.requests.list) | query: page, limit, status | `{ items, pagination }` | 401 UNAUTHORIZED; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/requests/:id | JWT (CMS) | Get request by id (includes attachment URLs). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/requests.ts fastify.get(apiEndpoints.requests.get) | path: id | request object + attachments | 401 UNAUTHORIZED; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| PATCH | /api/v1/requests/:id | JWT (CMS) | Update request (side effects: requests). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/requests.ts fastify.patch(apiEndpoints.requests.update) | path: id; body: partial request | request object | 401 UNAUTHORIZED; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/requests/:id/messages | JWT (CMS) | Add message (side effects: request_messages). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/requests.ts fastify.post(apiEndpoints.requests.addMessage) | path: id; body: `{ message, attachments? }` | message object + attachment URLs | 401 UNAUTHORIZED; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/requests/:id/messages | JWT (CMS) | List request messages (with attachment URLs). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/requests.ts fastify.get(apiEndpoints.requests.listMessages) | path: id; query: page, limit | `{ items, pagination }` | 401 UNAUTHORIZED; 500 INTERNAL_ERROR |

---

## Notifications

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /api/v1/notifications | JWT (CMS) | List notifications for current user. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/notifications.ts fastify.get(apiEndpoints.notifications.list) | query: page, limit, read? | `{ items, pagination }` | 401 UNAUTHORIZED; 500 INTERNAL_ERROR |
| GET | /api/v1/notifications/:id | JWT (CMS) | Get notification by id. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/notifications.ts fastify.get(apiEndpoints.notifications.get) | path: id | notification object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| POST | /api/v1/notifications/:id/read | JWT (CMS) | Mark notification read (side effects: notifications). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/notifications.ts fastify.post(apiEndpoints.notifications.markRead) | path: id | notification object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| POST | /api/v1/notifications/read-all | JWT (CMS) | Mark all read (side effects: notifications). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/notifications.ts fastify.post(apiEndpoints.notifications.markAllRead) | none | `{ success: true }` | 401 UNAUTHORIZED; 500 INTERNAL_ERROR |
| DELETE | /api/v1/notifications/:id | JWT (CMS) | Delete notification (side effects: notifications). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/notifications.ts fastify.delete(apiEndpoints.notifications.delete) | path: id | 204 no content | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Audit Logs

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /api/v1/audit-logs | JWT (CMS) | List audit logs. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/audit-logs.ts fastify.get(apiEndpoints.auditLogs.list) | query: page, limit, user_id, resource_type, action, start_date, end_date | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/audit-logs/:id | JWT (CMS) | Get audit log by id. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/audit-logs.ts fastify.get(apiEndpoints.auditLogs.get) | path: id | audit log object | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## API Keys

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/api-keys | JWT (CMS) | Create API key (side effects: api_keys). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/api-keys.ts fastify.post(apiEndpoints.apiKeys.create) | body: `{ name, scopes?, roles?, expires_at? }` | `{ record, secret }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/api-keys | JWT (CMS) | List API keys. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/api-keys.ts fastify.get(apiEndpoints.apiKeys.list) | none | `{ items, pagination }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| POST | /api/v1/api-keys/:id/rotate | JWT (CMS) | Rotate API key (side effects: api_keys). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/api-keys.ts fastify.post(apiEndpoints.apiKeys.rotate) | path: id | `{ record, secret }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |
| POST | /api/v1/api-keys/:id/revoke | JWT (CMS) | Revoke API key (side effects: api_keys). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/api-keys.ts fastify.post(apiEndpoints.apiKeys.revoke) | path: id | api key record | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Webhooks

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/webhooks | JWT (CMS) | Create webhook (side effects: webhooks). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/webhooks.ts fastify.post(apiEndpoints.webhooks.create) | body: `{ name, event_types, target_url, headers?, is_active? }` | `{ record, secret }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/webhooks | JWT (CMS) | List webhooks. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/webhooks.ts fastify.get(apiEndpoints.webhooks.list) | none | `{ items }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| PATCH | /api/v1/webhooks/:id | JWT (CMS) | Update webhook (side effects: webhooks). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/webhooks.ts fastify.patch(apiEndpoints.webhooks.update) | path: id; body: partial webhook | webhook record | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| DELETE | /api/v1/webhooks/:id | JWT (CMS) | Delete webhook (side effects: webhooks). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/webhooks.ts fastify.delete(apiEndpoints.webhooks.delete) | path: id | 204 no content | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| POST | /api/v1/webhooks/:id/test | JWT (CMS) | Test webhook (no delivery queue; echo only). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/webhooks.ts fastify.post(apiEndpoints.webhooks.test) | path: id | `{ success, attempted }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## SSO Config

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/sso-config | JWT (CMS) | Upsert active SSO config (side effects: sso_config). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/sso-config.ts fastify.post(apiEndpoints.ssoConfig.upsert) | body: `{ provider, issuer, client_id, client_secret, ... }` | record | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/sso-config | JWT (CMS) | List active SSO configs. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/sso-config.ts fastify.get(apiEndpoints.ssoConfig.list) | none | `{ items }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| POST | /api/v1/sso-config/:id/deactivate | JWT (CMS) | Deactivate SSO config (side effects: sso_config). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/sso-config.ts fastify.post(apiEndpoints.ssoConfig.deactivate) | path: id | record | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 500 INTERNAL_ERROR |

---

## Settings

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /api/v1/settings | JWT (CMS) | List org settings. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/settings.ts fastify.get(apiEndpoints.settings.list) | none | `{ items }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| POST | /api/v1/settings | JWT (CMS) | Upsert setting (side effects: settings). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/settings.ts fastify.post(apiEndpoints.settings.upsert) | body: `{ key, value }` | setting record | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/settings/default-media | Public (no auth check in code) | Get default media setting. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/settings.ts fastify.get(apiEndpoints.settings.defaultMedia) | none | `{ media_id, media }` | 500 INTERNAL_ERROR |
| PUT | /api/v1/settings/default-media | JWT (CMS) | Update default media (side effects: settings). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/settings.ts fastify.put(apiEndpoints.settings.defaultMedia) | body: `{ media_id }` (nullable) | `{ media_id, media }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 404 NOT_FOUND; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |

---

## Conversations

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| POST | /api/v1/conversations | JWT (CMS) | Start or get conversation (side effects: conversations). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/conversations.ts fastify.post(apiEndpoints.conversations.start) | body: `{ participant_id }` | conversation record | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/conversations | JWT (CMS) | List conversations. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/conversations.ts fastify.get(apiEndpoints.conversations.list) | none | `{ items }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| GET | /api/v1/conversations/:id/messages | JWT (CMS) | List conversation messages. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/conversations.ts fastify.get(apiEndpoints.conversations.listMessages) | path: id; query: page, limit | messages list | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| POST | /api/v1/conversations/:id/messages | JWT (CMS) | Send message (side effects: conversation_messages). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/conversations.ts fastify.post(apiEndpoints.conversations.sendMessage) | path: id; body: `{ content, attachments? }` | message record | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| POST | /api/v1/conversations/:id/read | JWT (CMS) | Mark conversation read (side effects: conversation_reads). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/conversations.ts fastify.post(apiEndpoints.conversations.markRead) | path: id | record | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |

---

## Proof of Play (Admin)

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /api/v1/proof-of-play | JWT (CMS) | List PoP records (optional grouping; optional URLs). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/proof-of-play.ts fastify.get(apiEndpoints.proofOfPlay.list) | query: page, limit, screen_id, media_id, schedule_id, start, end, status, include_url, group_by | `{ items, pagination }` or grouped items | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |
| GET | /api/v1/proof-of-play/export | JWT (CMS) | Export PoP CSV. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/proof-of-play.ts fastify.get(apiEndpoints.proofOfPlay.export) | query: same as list | CSV file | 401 UNAUTHORIZED; 403 FORBIDDEN; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR |

---

## Metrics

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /api/v1/metrics/overview | JWT (CMS) | Dashboard metrics overview. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/metrics.ts fastify.get(apiEndpoints.metrics.overview) | none | `{ totals, screens, storage, schedules, proof_of_play, system_health }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |

---

## Reports

| METHOD | PATH | AUTH | PURPOSE | REQUEST | RESPONSE | ERRORS |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /api/v1/reports/summary | JWT (CMS) | KPI summary. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/reports.ts fastify.get(apiEndpoints.reports.summary) | none | summary object | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| GET | /api/v1/reports/trends | JWT (CMS) | Trends for dashboards. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/reports.ts fastify.get(apiEndpoints.reports.trends) | none | `{ proof_of_play_daily, media_by_type, requests_by_status }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| GET | /api/v1/reports/requests-by-department | JWT (CMS) | Pending requests grouped by department. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/reports.ts fastify.get(apiEndpoints.reports.requestsByDepartment) | none | `{ departments: [...] }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| GET | /api/v1/reports/offline-screens | JWT (CMS) | Screens offline > 24h. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/reports.ts fastify.get(apiEndpoints.reports.offlineScreens) | none | `{ count, screens }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| GET | /api/v1/reports/storage | JWT (CMS) | Storage usage report. Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/reports.ts fastify.get(apiEndpoints.reports.storage) | none | `{ storage, expiring_media }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
| GET | /api/v1/reports/system-health | JWT (CMS) | System health extras (jobs/publishes/operators). Ref: /Users/anuragkumar/Desktop/signhex/signhex-server/src/routes/reports.ts fastify.get(apiEndpoints.reports.systemHealth) | none | `{ transcode_queue, publishes, jobs, operators }` | 401 UNAUTHORIZED; 403 FORBIDDEN; 500 INTERNAL_ERROR |
