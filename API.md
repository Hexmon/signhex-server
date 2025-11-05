# Hexmon Signage API Documentation

## Base URL

```
http://localhost:3000/v1
```

## Authentication

All endpoints (except `/auth/login`) require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

## Response Format

All responses are JSON with the following structure:

### Success Response

```json
{
  "id": "uuid",
  "name": "example",
  "created_at": "2024-01-01T00:00:00Z"
}
```

### Error Response

```json
{
  "error": "Error message",
  "statusCode": 400
}
```

## Authentication Endpoints

### Login

```
POST /auth/login
```

Request:

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

Response:

```json
{
  "access_token": "eyJhbGc...",
  "expires_in": 900
}
```

### Get Current User

```
GET /auth/me
```

Response:

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "first_name": "John",
  "last_name": "Doe",
  "role": "ADMIN",
  "created_at": "2024-01-01T00:00:00Z"
}
```

### Logout

```
POST /auth/logout
```

Response: `204 No Content`

## User Endpoints

### Create User

```
POST /users
```

Request:

```json
{
  "email": "newuser@example.com",
  "password": "SecurePassword123!",
  "first_name": "Jane",
  "last_name": "Smith",
  "role": "OPERATOR",
  "department_id": "uuid"
}
```

### List Users

```
GET /users?page=1&limit=20&role=ADMIN&is_active=true
```

Response:

```json
{
  "items": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "first_name": "John",
      "last_name": "Doe",
      "role": "ADMIN",
      "is_active": true,
      "created_at": "2024-01-01T00:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100
  }
}
```

### Get User

```
GET /users/:id
```

### Update User

```
PATCH /users/:id
```

Request:

```json
{
  "first_name": "Jane",
  "last_name": "Smith",
  "is_active": true
}
```

### Delete User

```
DELETE /users/:id
```

Response: `204 No Content`

## Media Endpoints

### Get Presigned Upload URL

```
POST /media/presign-upload
```

Request:

```json
{
  "filename": "video.mp4",
  "content_type": "video/mp4"
}
```

Response:

```json
{
  "upload_url": "https://minio.example.com/...",
  "media_id": "uuid",
  "expires_in": 3600
}
```

### Create Media

```
POST /media
```

Request:

```json
{
  "name": "My Video",
  "type": "VIDEO"
}
```

### List Media

```
GET /media?page=1&limit=20&type=VIDEO&status=READY
```

### Get Media

```
GET /media/:id
```

## Schedule Endpoints

### Create Schedule

```
POST /schedules
```

Request:

```json
{
  "name": "Morning Schedule",
  "description": "Schedule for morning hours"
}
```

### List Schedules

```
GET /schedules?page=1&limit=20&is_active=true
```

### Get Schedule

```
GET /schedules/:id
```

### Update Schedule

```
PATCH /schedules/:id
```

### Publish Schedule

```
POST /schedules/:id/publish
```

Request:

```json
{
  "screen_ids": ["uuid1", "uuid2"]
}
```

## Screen Endpoints

### Create Screen

```
POST /screens
```

Request:

```json
{
  "name": "Lobby Screen",
  "location": "Main Lobby"
}
```

### List Screens

```
GET /screens?page=1&limit=20&status=ACTIVE
```

### Get Screen

```
GET /screens/:id
```

### Update Screen

```
PATCH /screens/:id
```

### Delete Screen

```
DELETE /screens/:id
```

## Error Codes

| Code | Meaning |
|------|---------|
| 200 | OK |
| 201 | Created |
| 204 | No Content |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 409 | Conflict |
| 500 | Internal Server Error |

## Rate Limiting

API endpoints are rate-limited to prevent abuse:

- **Per IP**: 100 requests per minute
- **Per User**: 1000 requests per hour

Rate limit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1234567890
```

## Pagination

List endpoints support pagination with query parameters:

- `page`: Page number (default: 1)
- `limit`: Items per page (default: 20, max: 100)

## Filtering

List endpoints support filtering with query parameters specific to each resource.

## Sorting

Results are sorted by `created_at` in descending order by default.

