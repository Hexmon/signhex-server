# Hexmon Signage API Testing Guide

## Quick Start

### 1. Start the Server

```bash
# Terminal 1: Start Docker Compose stack
docker-compose up -d

# Terminal 2: Run migrations and seed data
npm run migrate
npm run seed

# Terminal 3: Start the development server
npm run dev
```

### 2. Access Points

- **API**: http://localhost:3000/api/v1
- **Swagger UI**: http://localhost:3000/docs
- **Health Check**: http://localhost:3000/health
- **MinIO Console**: http://localhost:9001 (minioadmin/minioadmin)
- **PostgreSQL**: localhost:5432

## Authentication Flow

### Step 1: Login and Get JWT Token

```bash
# Login with default admin user
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@hexmon.local",
    "password": "SecurePassword123!"
  }'

# Response:
# {
#   "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
#   "expires_in": 900,
#   "token_type": "Bearer"
# }
```

**Save the token for subsequent requests:**

```bash
export TOKEN="your_access_token_here"
```

### Step 2: Verify Authentication

```bash
# Get current user info
curl -X GET http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN"

# Response:
# {
#   "id": "user-id",
#   "email": "admin@hexmon.local",
#   "name": "Admin User",
#   "role": "ADMIN",
#   "active": true,
#   "created_at": "2024-01-01T00:00:00.000Z"
# }
```

## User Management

### Create User

```bash
curl -X POST http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "operator@hexmon.local",
    "name": "Operator User",
    "password": "SecurePassword123!",
    "role": "OPERATOR"
  }'
```

### List Users

```bash
curl -X GET "http://localhost:3000/api/v1/users?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### Get User by ID

```bash
curl -X GET http://localhost:3000/api/v1/users/{user-id} \
  -H "Authorization: Bearer $TOKEN"
```

### Update User

```bash
curl -X PATCH http://localhost:3000/api/v1/users/{user-id} \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Name",
    "active": true
  }'
```

### Delete User

```bash
curl -X DELETE http://localhost:3000/api/v1/users/{user-id} \
  -H "Authorization: Bearer $TOKEN"
```

## Department Management

### Create Department

```bash
curl -X POST http://localhost:3000/api/v1/departments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Marketing",
    "description": "Marketing Department"
  }'
```

### List Departments

```bash
curl -X GET "http://localhost:3000/api/v1/departments?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Department by ID

```bash
curl -X GET http://localhost:3000/api/v1/departments/{dept-id} \
  -H "Authorization: Bearer $TOKEN"
```

### Update Department

```bash
curl -X PATCH http://localhost:3000/api/v1/departments/{dept-id} \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Department Name"
  }'
```

### Delete Department

```bash
curl -X DELETE http://localhost:3000/api/v1/departments/{dept-id} \
  -H "Authorization: Bearer $TOKEN"
```

## Media Management

### Get Presigned Upload URL

```bash
curl -X POST http://localhost:3000/api/v1/media/presign-upload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "video.mp4",
    "content_type": "video/mp4",
    "size": 1024000
  }'

# Response:
# {
#   "upload_url": "http://localhost:9000/media-source/...",
#   "object_id": "media-object-id",
#   "expires_in": 3600
# }
```

### Upload File to MinIO

```bash
# Using the presigned URL from above
curl -X PUT "http://localhost:9000/media-source/..." \
  -H "Content-Type: video/mp4" \
  --data-binary @video.mp4
```

### Create Media Record

```bash
curl -X POST http://localhost:3000/api/v1/media \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Video",
    "description": "A test video",
    "type": "VIDEO",
    "storage_object_id": "media-object-id",
    "duration": 120,
    "width": 1920,
    "height": 1080
  }'
```

### List Media

```bash
curl -X GET "http://localhost:3000/api/v1/media?page=1&limit=20&type=VIDEO" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Media by ID

```bash
curl -X GET http://localhost:3000/api/v1/media/{media-id} \
  -H "Authorization: Bearer $TOKEN"
```

## Schedules

### Create Schedule

```bash
curl -X POST http://localhost:3000/api/v1/schedules \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Morning Schedule",
    "description": "Morning content",
    "start_time": "2024-01-01T08:00:00Z",
    "end_time": "2024-01-01T12:00:00Z",
    "is_active": true
  }'
```

### List Schedules

```bash
curl -X GET "http://localhost:3000/api/v1/schedules?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Schedule by ID

```bash
curl -X GET http://localhost:3000/api/v1/schedules/{schedule-id} \
  -H "Authorization: Bearer $TOKEN"
```

### Update Schedule

```bash
curl -X PATCH http://localhost:3000/api/v1/schedules/{schedule-id} \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Schedule Name"
  }'
```

### Publish Schedule

```bash
curl -X POST http://localhost:3000/api/v1/schedules/{schedule-id}/publish \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "screen_ids": ["screen-1", "screen-2"]
  }'
```

## Screens

### Create Screen

```bash
curl -X POST http://localhost:3000/api/v1/screens \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Lobby Screen",
    "description": "Main lobby display",
    "location": "Lobby",
    "resolution": "1920x1080"
  }'
```

### List Screens

```bash
curl -X GET "http://localhost:3000/api/v1/screens?page=1&limit=20&status=ACTIVE" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Screen by ID

```bash
curl -X GET http://localhost:3000/api/v1/screens/{screen-id} \
  -H "Authorization: Bearer $TOKEN"
```

### Update Screen

```bash
curl -X PATCH http://localhost:3000/api/v1/screens/{screen-id} \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Screen Name",
    "location": "New Location"
  }'
```

### Delete Screen

```bash
curl -X DELETE http://localhost:3000/api/v1/screens/{screen-id} \
  -H "Authorization: Bearer $TOKEN"
```

## Requests (Kanban)

### Create Request

```bash
curl -X POST http://localhost:3000/api/v1/requests \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Update homepage content",
    "description": "Need to update the homepage with new images",
    "priority": "HIGH"
  }'
```

### List Requests

```bash
curl -X GET "http://localhost:3000/api/v1/requests?page=1&limit=20&status=OPEN" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Request by ID

```bash
curl -X GET http://localhost:3000/api/v1/requests/{request-id} \
  -H "Authorization: Bearer $TOKEN"
```

### Update Request

```bash
curl -X PATCH http://localhost:3000/api/v1/requests/{request-id} \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "IN_PROGRESS",
    "assigned_to": "user-id"
  }'
```

### Add Message to Request

```bash
curl -X POST http://localhost:3000/api/v1/requests/{request-id}/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "I'm working on this now"
  }'
```

### List Messages for Request

```bash
curl -X GET "http://localhost:3000/api/v1/requests/{request-id}/messages?page=1&limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

## Emergency System

### Trigger Emergency

```bash
curl -X POST http://localhost:3000/api/v1/emergency/trigger \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "System maintenance in progress",
    "severity": "HIGH"
  }'
```

### Get Emergency Status

```bash
curl -X GET http://localhost:3000/api/v1/emergency/status \
  -H "Authorization: Bearer $TOKEN"
```

### Clear Emergency

```bash
curl -X POST http://localhost:3000/api/v1/emergency/{emergency-id}/clear \
  -H "Authorization: Bearer $TOKEN"
```

### List Emergency History

```bash
curl -X GET "http://localhost:3000/api/v1/emergency/history?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

## Notifications

### List Notifications

```bash
curl -X GET "http://localhost:3000/api/v1/notifications?page=1&limit=20&read=false" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Notification by ID

```bash
curl -X GET http://localhost:3000/api/v1/notifications/{notification-id} \
  -H "Authorization: Bearer $TOKEN"
```

### Mark Notification as Read

```bash
curl -X POST http://localhost:3000/api/v1/notifications/{notification-id}/read \
  -H "Authorization: Bearer $TOKEN"
```

### Mark All Notifications as Read

```bash
curl -X POST http://localhost:3000/api/v1/notifications/read-all \
  -H "Authorization: Bearer $TOKEN"
```

### Delete Notification

```bash
curl -X DELETE http://localhost:3000/api/v1/notifications/{notification-id} \
  -H "Authorization: Bearer $TOKEN"
```

## Audit Logs

### List Audit Logs

```bash
curl -X GET "http://localhost:3000/api/v1/audit-logs?page=1&limit=20&resource_type=USER" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Audit Log by ID

```bash
curl -X GET http://localhost:3000/api/v1/audit-logs/{log-id} \
  -H "Authorization: Bearer $TOKEN"
```

## Presentations

### Create Presentation

```bash
curl -X POST http://localhost:3000/api/v1/presentations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Q1 Marketing Campaign",
    "description": "Marketing presentation for Q1"
  }'
```

### List Presentations

```bash
curl -X GET "http://localhost:3000/api/v1/presentations?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Presentation by ID

```bash
curl -X GET http://localhost:3000/api/v1/presentations/{presentation-id} \
  -H "Authorization: Bearer $TOKEN"
```

### Update Presentation

```bash
curl -X PATCH http://localhost:3000/api/v1/presentations/{presentation-id} \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Presentation Name"
  }'
```

### Delete Presentation

```bash
curl -X DELETE http://localhost:3000/api/v1/presentations/{presentation-id} \
  -H "Authorization: Bearer $TOKEN"
```

## Complete Workflow Example

```bash
# 1. Login
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@hexmon.local",
    "password": "SecurePassword123!"
  }' | jq -r '.access_token')

# 2. Create a department
DEPT=$(curl -s -X POST http://localhost:3000/api/v1/departments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Marketing"}' | jq -r '.id')

# 3. Create a user
USER=$(curl -s -X POST http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "operator@hexmon.local",
    "name": "Operator",
    "password": "SecurePassword123!",
    "role": "OPERATOR"
  }' | jq -r '.id')

# 4. Create a screen
SCREEN=$(curl -s -X POST http://localhost:3000/api/v1/screens \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Lobby Screen"}' | jq -r '.id')

# 5. Create a schedule
SCHEDULE=$(curl -s -X POST http://localhost:3000/api/v1/schedules \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Morning Schedule",
    "is_active": true
  }' | jq -r '.id')

# 6. Publish schedule to screen
curl -X POST http://localhost:3000/api/v1/schedules/$SCHEDULE/publish \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"screen_ids\": [\"$SCREEN\"]}"

echo "Workflow complete!"
echo "Department: $DEPT"
echo "User: $USER"
echo "Screen: $SCREEN"
echo "Schedule: $SCHEDULE"
```

## Error Handling

All endpoints return standard HTTP status codes:

- **200**: Success
- **201**: Created
- **204**: No Content
- **400**: Bad Request
- **422**: Validation error (invalid input)
- **401**: Unauthorized (missing/invalid token)
- **403**: Forbidden (insufficient permissions)
- **404**: Not Found
- **409**: Conflict (resource already exists)
- **429**: Rate limited
- **500**: Internal Server Error

Example error responses:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid.",
    "details": [
      {
        "field": "name",
        "message": "name must be at least 1 character"
      }
    ],
    "traceId": "b6aaf8d4-6b39-47b0-9b2c-5334e2ac7f0d"
  }
}
```

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Email already exists.",
    "details": null,
    "traceId": "9e49a49a-4698-4a50-9b0a-b2f08f5b5e57"
  }
}
```

## Testing Tips

1. **Use `jq` for JSON parsing**: `curl ... | jq '.access_token'`
2. **Save tokens in variables**: `export TOKEN="..."`
3. **Use Swagger UI**: http://localhost:3000/docs for interactive testing
4. **Check logs**: `npm run dev` shows all requests and errors
5. **Verify database**: Connect to PostgreSQL to inspect data
6. **Monitor MinIO**: Check http://localhost:9001 for uploaded files

## Device Pairing

### Generate Pairing Code

```bash
curl -X POST http://localhost:3000/api/v1/device-pairing/generate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "device-001",
    "expires_in": 3600
  }'

# Response:
# {
#   "id": "pairing-id",
#   "pairing_code": "A1B2C3",
#   "expires_at": "2024-01-01T01:00:00.000Z",
#   "expires_in": 3600
# }
```

### Complete Device Pairing

```bash
curl -X POST http://localhost:3000/api/v1/device-pairing/complete \
  -H "Content-Type: application/json" \
  -d '{
    "pairing_code": "A1B2C3",
    "csr": "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----"
  }'

# Response:
# {
#   "success": true,
#   "message": "Device pairing completed. Certificate will be issued shortly.",
#   "device_id": "device-001"
# }
```

### List Pairings

```bash
curl -X GET "http://localhost:3000/api/v1/device-pairing?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

## Device Telemetry

### Device Heartbeat (mTLS)

```bash
curl -X POST http://localhost:3000/api/v1/device/heartbeat \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "device-001",
    "status": "ONLINE",
    "uptime": 86400,
    "memory_usage": 512,
    "cpu_usage": 45.5,
    "temperature": 65.2,
    "current_schedule_id": "schedule-1",
    "current_media_id": "media-1"
  }'

# Response:
# {
#   "success": true,
#   "timestamp": "2024-01-01T00:00:00.000Z",
#   "commands": []
# }
```

### Proof of Play Report

```bash
curl -X POST http://localhost:3000/api/v1/device/proof-of-play \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "device-001",
    "media_id": "media-1",
    "schedule_id": "schedule-1",
    "start_time": "2024-01-01T08:00:00Z",
    "end_time": "2024-01-01T08:02:00Z",
    "duration": 120,
    "completed": true
  }'

# Response:
# {
#   "success": true,
#   "timestamp": "2024-01-01T00:00:00.000Z"
# }
```

### Upload Device Screenshot

```bash
# First, encode image to base64
BASE64_IMAGE=$(base64 -w 0 screenshot.png)

curl -X POST http://localhost:3000/api/v1/device/screenshot \
  -H "Content-Type: application/json" \
  -d "{
    \"device_id\": \"device-001\",
    \"timestamp\": \"2024-01-01T00:00:00Z\",
    \"image_data\": \"$BASE64_IMAGE\"
  }"

# Response:
# {
#   "success": true,
#   "object_key": "device-screenshots/device-001/1704067200000.png",
#   "timestamp": "2024-01-01T00:00:00.000Z"
# }
```

### Get Pending Commands

```bash
curl -X GET http://localhost:3000/api/v1/device/device-001/commands
```

### Acknowledge Command

```bash
curl -X POST http://localhost:3000/api/v1/device/device-001/commands/cmd-1/ack
```

## Next Steps

- Implement WebSocket for real-time notifications
- Add FFmpeg integration for media processing
- Implement mTLS certificate signing
- Add comprehensive test coverage
