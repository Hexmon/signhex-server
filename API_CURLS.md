# Postman-ready cURL Collection (env-friendly)

Set Postman env vars:
- `baseURL` e.g. `http://localhost:3000`
- `authToken` from `/v1/auth/login`
- `apiKey` if using API key auth (prefix + secret concatenated if needed)
- Reusable IDs: `userId`, `deptId`, `mediaId`, `scheduleId`, `screenId`, `conversationId`, `webhookId`, `apiKeyId`

## Auth
- Login  
  ```bash
  curl -X POST "{{baseURL}}/v1/auth/login" -H "Content-Type: application/json" \
    -d '{"email":"{{adminEmail}}","password":"{{adminPassword}}"}'
  ```
- Me  
  ```bash
  curl "{{baseURL}}/v1/auth/me" -H "Authorization: Bearer {{authToken}}"
  ```

## Dashboard Metrics
- Overview  
  ```bash
  curl "{{baseURL}}/v1/metrics/overview" -H "Authorization: Bearer {{authToken}}"
  ```

## API Keys (admin)
- Create  
  ```bash
  curl -X POST "{{baseURL}}/v1/api-keys" -H "Authorization: Bearer {{authToken}}" -H "Content-Type: application/json" \
    -d '{"name":"CI Key","scopes":["read","write"],"roles":["ADMIN"],"expires_at":null}'
  ```
- List  
  ```bash
  curl "{{baseURL}}/v1/api-keys" -H "Authorization: Bearer {{authToken}}"
  ```
- Rotate  
  ```bash
  curl -X POST "{{baseURL}}/v1/api-keys/{{apiKeyId}}/rotate" -H "Authorization: Bearer {{authToken}}"
  ```
- Revoke  
  ```bash
  curl -X POST "{{baseURL}}/v1/api-keys/{{apiKeyId}}/revoke" -H "Authorization: Bearer {{authToken}}"
  ```

## Webhooks (admin)
- Create  
  ```bash
  curl -X POST "{{baseURL}}/v1/webhooks" -H "Authorization: Bearer {{authToken}}" -H "Content-Type: application/json" \
    -d '{"name":"Media Ready","event_types":["media.ready"],"target_url":"https://example.com/webhook","headers":{"X-Signhex":"1"}}'
  ```
- List  
  ```bash
  curl "{{baseURL}}/v1/webhooks" -H "Authorization: Bearer {{authToken}}"
  ```
- Update  
  ```bash
  curl -X PATCH "{{baseURL}}/v1/webhooks/{{webhookId}}" -H "Authorization: Bearer {{authToken}}" \
    -H "Content-Type: application/json" -d '{"is_active":false}'
  ```
- Delete  
  ```bash
  curl -X DELETE "{{baseURL}}/v1/webhooks/{{webhookId}}" -H "Authorization: Bearer {{authToken}}"
  ```
- Test fire  
  ```bash
  curl -X POST "{{baseURL}}/v1/webhooks/{{webhookId}}/test" -H "Authorization: Bearer {{authToken}}"
  ```

## SSO Config (admin)
- Upsert  
  ```bash
  curl -X POST "{{baseURL}}/v1/sso-config" -H "Authorization: Bearer {{authToken}}" -H "Content-Type: application/json" \
    -d '{"provider":"oidc","issuer":"https://idp.example.com","client_id":"cid","client_secret":"secret","authorization_url":"https://idp.example.com/auth","token_url":"https://idp.example.com/token","jwks_url":"https://idp.example.com/jwks","redirect_uri":"https://app/callback","scopes":["openid","profile"],"is_active":true}'
  ```
- List active  
  ```bash
  curl "{{baseURL}}/v1/sso-config" -H "Authorization: Bearer {{authToken}}"
  ```
- Deactivate  
  ```bash
  curl -X POST "{{baseURL}}/v1/sso-config/{{ssoConfigId}}/deactivate" -H "Authorization: Bearer {{authToken}}"
  ```

## Org Settings (admin)
- List  
  ```bash
  curl "{{baseURL}}/v1/settings" -H "Authorization: Bearer {{authToken}}"
  ```
- Upsert  
  ```bash
  curl -X POST "{{baseURL}}/v1/settings" -H "Authorization: Bearer {{authToken}}" -H "Content-Type: application/json" \
    -d '{"key":"branding","value":{"logo_url":"https://cdn/logo.png","theme":"light","timezone":"UTC","notifications":{"email":true}}}'
  ```

## Conversations (1:1)
- Start/get thread  
  ```bash
  curl -X POST "{{baseURL}}/v1/conversations" -H "Authorization: Bearer {{authToken}}" -H "Content-Type: application/json" \
    -d '{"participant_id":"{{userId}}"}'
  ```
- List threads  
  ```bash
  curl "{{baseURL}}/v1/conversations" -H "Authorization: Bearer {{authToken}}"
  ```
- List messages  
  ```bash
  curl "{{baseURL}}/v1/conversations/{{conversationId}}/messages?page=1&limit=50" -H "Authorization: Bearer {{authToken}}"
  ```
- Send message  
  ```bash
  curl -X POST "{{baseURL}}/v1/conversations/{{conversationId}}/messages" -H "Authorization: Bearer {{authToken}}" \
    -H "Content-Type: application/json" -d '{"content":"Hello","attachments":[]}'
  ```
- Mark read  
  ```bash
  curl -X POST "{{baseURL}}/v1/conversations/{{conversationId}}/read" -H "Authorization: Bearer {{authToken}}"
  ```

## Proof of Play
- List with filters  
  ```bash
  curl "{{baseURL}}/v1/proof-of-play?page=1&limit=20&screen_id={{screenId}}&media_id={{mediaId}}&start=2024-01-01T00:00:00Z&end=2024-01-31T23:59:59Z&status=COMPLETED" \
    -H "Authorization: Bearer {{authToken}}"
  ```
- Export CSV  
  ```bash
  curl "{{baseURL}}/v1/proof-of-play/export?start=2024-01-01T00:00:00Z&end=2024-01-31T23:59:59Z" \
    -H "Authorization: Bearer {{authToken}}"
  ```

## Metrics, Publish, Media, Screens, Requests, Departments, Schedules, Notifications, Presentations
- Existing endpoints remain as previously shared; re-use `{{authToken}}` and IDs. Key ones:
  - Schedules publish:  
    ```bash
    curl -X POST "{{baseURL}}/v1/schedules/{{scheduleId}}/publish" -H "Authorization: Bearer {{authToken}}" \
      -H "Content-Type: application/json" -d '{"screen_ids":["{{screenId}}"],"screen_group_ids":[]}'
    ```
  - Requests create:  
    ```bash
    curl -X POST "{{baseURL}}/v1/requests" -H "Authorization: Bearer {{authToken}}" -H "Content-Type: application/json" \
      -d '{"title":"Need update","description":"Please change content","priority":"HIGH","assigned_to":"{{userId}}"}'
    ```
- Media presign:  
  ```bash
  curl -X POST "{{baseURL}}/v1/media/presign-upload" -H "Authorization: Bearer {{authToken}}" -H "Content-Type: application/json" \
    -d '{"filename":"banner.png","content_type":"image/png","size":12345}'
  ```
- Media finalize:  
  ```bash
  curl -X POST "{{baseURL}}/v1/media/{{mediaId}}/complete" -H "Authorization: Bearer {{authToken}}" -H "Content-Type: application/json" \
    -d '{"status":"READY","width":1920,"height":1080,"duration_seconds":15}'
  ```
  Media responses now include status, duration, dimensions, ready_object_id, thumbnail_object_id, and source bucket/key/content_type/size.

## Schedules
- Create (start/end required, must be future, start < end)  
  ```bash
  curl -X POST "{{baseURL}}/v1/schedules" -H "Authorization: Bearer {{authToken}}" -H "Content-Type: application/json" \
    -d '{"name":"Morning Loop","description":"9-12","start_at":"2025-01-01T09:00:00Z","end_at":"2025-01-01T12:00:00Z"}'
  ```
- Update (same validation if provided)  
  ```bash
  curl -X PATCH "{{baseURL}}/v1/schedules/{{scheduleId}}" -H "Authorization: Bearer {{authToken}}" -H "Content-Type: application/json" \
    -d '{"name":"Updated","start_at":"2025-01-02T09:00:00Z","end_at":"2025-01-02T12:00:00Z","is_active":true}'
  ```
- Publish response includes publish_id, snapshot_id, and targets count for status tracking.
- Poll publish  
  ```bash
  curl "{{baseURL}}/v1/publishes/{{publishId}}" -H "Authorization: Bearer {{authToken}}"
  ```
- Publish targets status history  
  ```bash
  curl "{{baseURL}}/v1/schedules/{{scheduleId}}/publishes" -H "Authorization: Bearer {{authToken}}"
  ```
- Update publish target status  
  ```bash
  curl -X PATCH "{{baseURL}}/v1/publishes/{{publishId}}/targets/{{targetId}}" -H "Authorization: Bearer {{authToken}}" \
    -H "Content-Type: application/json" -d '{"status":"SENT","error":null}'
  ```

## Proof of Play
- List with filters  
  ```bash
  curl "{{baseURL}}/v1/proof-of-play?page=1&limit=20&screen_id={{screenId}}&media_id={{mediaId}}&start=2024-01-01T00:00:00Z&end=2024-01-31T23:59:59Z&status=COMPLETED" \
    -H "Authorization: Bearer {{authToken}}"
  ```
- Export CSV  
  ```bash
  curl "{{baseURL}}/v1/proof-of-play/export?start=2024-01-01T00:00:00Z&end=2024-01-31T23:59:59Z" \
    -H "Authorization: Bearer {{authToken}}"
  ```
- Grouping (for charts)  
  ```bash
  curl "{{baseURL}}/v1/proof-of-play?group_by=day&start=2024-01-01T00:00:00Z&end=2024-01-31T23:59:59Z" \
    -H "Authorization: Bearer {{authToken}}"
  ```
- Include URLs  
  ```bash
  curl "{{baseURL}}/v1/proof-of-play?page=1&limit=20&include_url=true" -H "Authorization: Bearer {{authToken}}"
  ```

## Reports
- Summary KPIs  
  ```bash
  curl "{{baseURL}}/v1/reports/summary" -H "Authorization: Bearer {{authToken}}"
  ```
  (includes uptime %, open/completed requests, active/offline screens)
- Trends (PoP daily, media by type, requests by status)  
  ```bash
  curl "{{baseURL}}/v1/reports/trends" -H "Authorization: Bearer {{authToken}}"
  ```

## Users (Invites/Reset)
- Invite (returns temp password and invite token)  
  ```bash
  curl -X POST "{{baseURL}}/v1/users/invite" -H "Authorization: Bearer {{authToken}}" -H "Content-Type: application/json" \
    -d '{"email":"invitee@org.com","role":"OPERATOR","department_id":"{{deptId}}"}'
  ```
- Activate invited user  
  ```bash
  curl -X POST "{{baseURL}}/v1/users/activate" -H "Content-Type: application/json" \
    -d '{"token":"{{inviteToken}}","password":"NewStrongPass123"}'
  ```
- Reset password (admin)  
  ```bash
  curl -X POST "{{baseURL}}/v1/users/{{userId}}/reset-password" -H "Authorization: Bearer {{authToken}}"
  ```

Use these commands directly in Postman by substituting environment variables.***
