# Media Delete API Contract

## Summary
`DELETE /api/v1/media/:id` is now ownership-aware and usage-aware.

- The uploader can delete their own media.
- `ADMIN` and `SUPER_ADMIN` can delete any user's media.
- Other authenticated users cannot delete media uploaded by someone else.
- Media that is still referenced by active product surfaces cannot be deleted.

This update applies to both:
- soft delete: `DELETE /api/v1/media/:id`
- hard delete: `DELETE /api/v1/media/:id?hard=true`

## Auth
- Header: `Authorization: Bearer <token>`
- Existing auth/session behavior remains unchanged.
- No new request body fields.

## Success Responses
### Soft delete
Request:
```http
DELETE /api/v1/media/946bc043-8265-4949-866c-11b7df9df6b7
Authorization: Bearer <token>
```

Response `200`:
```json
{
  "message": "Media soft deleted (DB retained, storage cleaned where possible)",
  "id": "946bc043-8265-4949-866c-11b7df9df6b7",
  "storage_deleted": []
}
```

### Hard delete
Request:
```http
DELETE /api/v1/media/946bc043-8265-4949-866c-11b7df9df6b7?hard=true
Authorization: Bearer <token>
```

Response `200`:
```json
{
  "message": "Media hard deleted (DB row removed, storage cleaned where possible)",
  "id": "946bc043-8265-4949-866c-11b7df9df6b7",
  "storage_deleted": []
}
```

## Error Responses
### `403 MEDIA_DELETE_FORBIDDEN_OWNER`
Returned when the caller has media delete permission but does not own the media and is not `ADMIN`/`SUPER_ADMIN`.

```json
{
  "success": false,
  "error": {
    "code": "MEDIA_DELETE_FORBIDDEN_OWNER",
    "message": "You can only delete media you uploaded. This media was uploaded by Priya Sharma.",
    "details": {
      "owner_user_id": "4cc5ec64-2d00-4d98-9df8-297d9207ca48",
      "owner_display_name": "Priya Sharma"
    },
    "traceId": "e1018dea-fe7e-47eb-b53a-a5a2ca446cd8"
  }
}
```

Frontend handling:
- Show `error.message` directly.
- Do not show delete confirmation retry.
- If needed, render a secondary hint using `details.owner_display_name`.

### `409 MEDIA_IN_USE`
Returned when the media is still referenced by active product surfaces.

Example for chat attachment usage:
```json
{
  "success": false,
  "error": {
    "code": "MEDIA_IN_USE",
    "message": "Media cannot be deleted because it is still used by chat messages.",
    "details": {
      "references": ["chat_attachments"]
    },
    "traceId": "e1018dea-fe7e-47eb-b53a-a5a2ca446cd8"
  }
}
```

Example for presentation usage:
```json
{
  "success": false,
  "error": {
    "code": "MEDIA_IN_USE",
    "message": "Media cannot be deleted because it is still used in presentations.",
    "details": {
      "references": ["presentations"]
    },
    "traceId": "e1018dea-fe7e-47eb-b53a-a5a2ca446cd8"
  }
}
```

Possible `details.references` values:
- `chat_attachments`
- `presentations`
- `screens`
- `emergencies`
- `settings`
- `proof_of_play`

Frontend handling:
- Show `error.message` directly.
- Optionally branch on `details.references` for a targeted CTA.
- Do not show a retry CTA until the media is detached from the referenced surface.

Reference-specific UX suggestions:
- `chat_attachments`: tell the user the file is attached to chat messages.
- `presentations`: tell the user to remove it from presentations first.
- `screens`: tell the user to unassign it from the screen first.
- `emergencies`: tell the user to remove it from emergency content first.
- `settings`: tell the user to change default media first.
- `proof_of_play`: treat as historical usage and block deletion.

### Other existing errors
`401 UNAUTHORIZED`
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing authorization header",
    "details": null,
    "traceId": "..."
  }
}
```

`404 NOT_FOUND`
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Media not found",
    "details": null,
    "traceId": "..."
  }
}
```

`403 FORBIDDEN`
- Existing generic RBAC denial can still happen if the user lacks `delete Media` permission entirely.
- Frontend should show `error.message` directly.

## FE Integration Notes
- Keep current delete button wiring.
- For owner-aware behavior, the FE does not need to pre-compute ownership; trust the API response.
- For `MEDIA_DELETE_FORBIDDEN_OWNER`, display the exact backend message.
- For `MEDIA_IN_USE`, display the exact backend message and optionally map `details.references[0]` to a product-specific help link or CTA.
- Success responses remain backward-compatible, so current success handling can stay unchanged.
