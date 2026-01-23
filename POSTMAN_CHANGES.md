# Postman Changes Guide (Roles & Permissions)

This file gives Postman-ready requests for the **new APIs** and the **changed payloads**.

**Base URL**
```
{{baseURL}} = http://localhost:3000
```

**Auth headers used in all requests**
```
Authorization: Bearer {{authToken}}
Content-Type: application/json
X-CSRF-Token: {{csrfToken}}
Cookie: csrf_token={{csrfToken}}
```

---

## New APIs

### 1) Permissions metadata
**GET** `{{baseURL}}/api/v1/permissions/metadata`

```bash
curl -X GET "{{baseURL}}/api/v1/permissions/metadata" \
  -H "Authorization: Bearer {{authToken}}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}"
```

---

### 2) Roles: list
**GET** `{{baseURL}}/api/v1/roles?page=1&limit=20&search=admin`

```bash
curl -X GET "{{baseURL}}/api/v1/roles?page=1&limit=20&search=admin" \
  -H "Authorization: Bearer {{authToken}}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}"
```

---

### 3) Roles: create
**POST** `{{baseURL}}/api/v1/roles`

```bash
curl -X POST "{{baseURL}}/api/v1/roles" \
  -H "Authorization: Bearer {{authToken}}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}" \
  -d '{
    "name": "CONTENT_MANAGER",
    "description": "Can manage media and layouts",
    "permissions": {
      "inherits": ["{{adminRoleId}}"],
      "grants": [
        { "action": "read", "subject": "Media" },
        { "action": "create", "subject": "Media" },
        { "action": "update", "subject": "Media" }
      ]
    }
  }'
```

---

### 4) Roles: detail
**GET** `{{baseURL}}/api/v1/roles/{{roleId}}`

```bash
curl -X GET "{{baseURL}}/api/v1/roles/{{roleId}}" \
  -H "Authorization: Bearer {{authToken}}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}"
```

---

### 5) Roles: update
**PUT** `{{baseURL}}/api/v1/roles/{{roleId}}`

```bash
curl -X PUT "{{baseURL}}/api/v1/roles/{{roleId}}" \
  -H "Authorization: Bearer {{authToken}}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}" \
  -d '{
    "name": "CONTENT_EDITOR",
    "description": "Can read and update media",
    "permissions": {
      "inherits": [],
      "grants": [
        { "action": "read", "subject": "Media" },
        { "action": "update", "subject": "Media" }
      ]
    }
  }'
```

---

### 6) Roles: delete
**DELETE** `{{baseURL}}/api/v1/roles/{{roleId}}`

```bash
curl -X DELETE "{{baseURL}}/api/v1/roles/{{roleId}}" \
  -H "Authorization: Bearer {{authToken}}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}"
```

---

## Changed APIs (role_id changes)

### Login
**POST** `{{baseURL}}/api/v1/auth/login`

```bash
curl -X POST "{{baseURL}}/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}" \
  -d '{
    "email": "admin@example.com",
    "password": "password"
  }'
```

### Users create
**POST** `{{baseURL}}/api/v1/users`

```bash
curl -X POST "{{baseURL}}/api/v1/users" \
  -H "Authorization: Bearer {{authToken}}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}" \
  -d '{
    "email": "new.user@example.com",
    "password": "Password@123",
    "first_name": "New",
    "last_name": "User",
    "role_id": "{{roleId}}",
    "department_id": "{{departmentId}}"
  }'
```

### Users list
**GET** `{{baseURL}}/api/v1/users?role_id={{roleId}}`

```bash
curl -X GET "{{baseURL}}/api/v1/users?role_id={{roleId}}" \
  -H "Authorization: Bearer {{authToken}}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}"
```

### Users update
**PUT** `{{baseURL}}/api/v1/users/{{userId}}`

```bash
curl -X PUT "{{baseURL}}/api/v1/users/{{userId}}" \
  -H "Authorization: Bearer {{authToken}}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}" \
  -d '{
    "role_id": "{{roleId}}",
    "department_id": "{{departmentId}}"
  }'
```

### User invite
**POST** `{{baseURL}}/api/v1/users/invite`

```bash
curl -X POST "{{baseURL}}/api/v1/users/invite" \
  -H "Authorization: Bearer {{authToken}}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}" \
  -d '{
    "email": "invite.user@example.com",
    "role_id": "{{roleId}}",
    "department_id": "{{departmentId}}"
  }'
```

### User invite list
**GET** `{{baseURL}}/api/v1/users/invite?role_id={{roleId}}`

```bash
curl -X GET "{{baseURL}}/api/v1/users/invite?role_id={{roleId}}" \
  -H "Authorization: Bearer {{authToken}}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: {{csrfToken}}" \
  -H "Cookie: csrf_token={{csrfToken}}"
```

---

## Notes
- All the above are **Postman-friendly**; just set the environment variables.
- The API now expects `role_id` (UUID) instead of `role` strings in all user-related requests.
- Tokens now include `role_id` and responses always include both `role_id` and `role` name.
