# Notification Badge Count Guide

This document defines the backend contract for Home unread notification badge count.

## 1) Environment and transport
- API base: `http://<host>:3000/api/v1`
- WS base: `http://<host>:3000`
- WS namespace: `/notifications`
- On-prem HTTP is supported.
- Socket origin validation:
  - Uses `SOCKET_ALLOWED_ORIGINS` if set.
  - Falls back to `CORS_ORIGINS` + `http://localhost:8080` if unset.

## 2) Auth model (REST + WS)
- REST auth: `Authorization: Bearer <access_token>`.
- REST also validates session/JTI revocation (same as chat routes).
- WS token priority:
  1. `socket.handshake.auth.token`
  2. `Authorization: Bearer ...` header
  3. `access_token` cookie only when Origin is allowlisted
- If session is revoked or token invalid: `401` on REST, `connect_error` on WS.

## 3) REST contract

### 3.1 Get unread badge count
- Method: `GET`
- Path: `/api/v1/notifications/unread-count`
- Auth: bearer token required
- Headers: `Cache-Control: no-store`

Response `200`:
```json
{
  "unread_total": 12
}
```

Error example `401`:
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Token has been revoked",
    "details": null,
    "traceId": "..."
  }
}
```

## 4) Existing endpoints behavior (extended, non-breaking)
- `POST /api/v1/notifications/:id/read`
  - If unread -> read transition happens, badge count decrements once.
  - Repeated call is idempotent for badge count.
- `POST /api/v1/notifications/read-all`
  - Marks unread notifications as read and sets badge count to `0`.
- `DELETE /api/v1/notifications/:id`
  - If deleted notification was unread, badge count decrements.
- `GET /api/v1/notifications` and `GET /api/v1/notifications/:id`
  - Existing response shape remains unchanged.

## 5) WS contract

### 5.1 Connect
- Namespace: `/notifications`
- Recommended:
```ts
io(`${WS_BASE}/notifications`, {
  transports: ['websocket'],
  auth: { token: accessToken },
  withCredentials: true
})
```

### 5.2 Server event
- Event: `notifications:count`
- Payload:
```json
{
  "unread_total": 12
}
```

Emission rules:
- Emitted on successful socket connect (initial count).
- Emitted whenever unread count changes due to notification create/read/read-all/delete.

### 5.3 Optional client event
- Event: `notifications:sync`
- Purpose: request current count on-demand after reconnect/resume.
- Ack payload:
```json
{
  "unread_total": 12
}
```

## 6) Frontend integration algorithm
1. On app boot:
   - Call `GET /notifications/unread-count`.
   - Render badge from response.
2. Open `/notifications` socket with token in `auth.token`.
3. On `notifications:count`:
   - Replace badge value with `payload.unread_total` (server-authoritative).
4. On reconnect:
   - Keep last known badge.
   - Immediately call `GET /notifications/unread-count` or emit `notifications:sync`.
5. If socket fails:
   - Keep REST polling fallback (for example every 30–60s on Home page).

## 7) Error handling guidance
- `401 UNAUTHORIZED`: clear session and redirect to login.
- `403 FORBIDDEN`: do not retry automatically; show permission/session message.
- `429 TOO_MANY_REQUESTS`: back off and retry later.
- WS `connect_error`: retry with backoff; re-fetch unread count via REST after reconnect.

## 8) Curl examples

Get unread badge:
```bash
curl -X GET "http://localhost:3000/api/v1/notifications/unread-count" \
  -H "Authorization: Bearer <TOKEN>"
```

Mark one as read:
```bash
curl -X POST "http://localhost:3000/api/v1/notifications/<id>/read" \
  -H "Authorization: Bearer <TOKEN>"
```

Mark all as read:
```bash
curl -X POST "http://localhost:3000/api/v1/notifications/read-all" \
  -H "Authorization: Bearer <TOKEN>"
```

## 9) Operational reconcile script
- Command:
  - `npm run notifications:reconcile`
  - `npm run notifications:reconcile -- --userId=<uuid>`
- Purpose:
  - Recompute counters from unread rows and correct drift.
