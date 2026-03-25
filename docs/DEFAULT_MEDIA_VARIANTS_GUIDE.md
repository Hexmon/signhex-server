# Default Media Variants

## Summary
The backend now resolves fallback media in this order:

1. emergency media
2. published schedule content
3. aspect-ratio-specific default media
4. global default media
5. none

Aspect-ratio-specific fallback is dimension-wide, not per-screen. CMS configures it, backend resolves it, and the player consumes the resolved result.

## Settings model
Existing global fallback remains:

- `settings.key = "default_media_id"`

New dimension-wise fallback map:

- `settings.key = "default_media_variants"`
- value shape:

```json
{
  "16:9": "media-id-1",
  "9:16": "media-id-2",
  "1:1": "media-id-3"
}
```

No DB migration is required. The existing `settings.value` JSONB column stores the map.

## Resolution rules
Backend is the source of truth for default-media selection.

Resolution logic:

1. use `screen.aspect_ratio` when present
2. if missing, derive aspect ratio from `width` + `height`
3. look for an exact match in `default_media_variants`
4. if no exact match exists, use `default_media_id`
5. if neither exists, return `NONE`

Response source values:

- `ASPECT_RATIO`
- `GLOBAL`
- `NONE`

## Admin endpoints
Global fallback remains unchanged:

- `GET /api/v1/settings/default-media`
- `PUT /api/v1/settings/default-media`

New variant endpoints:

- `GET /api/v1/settings/default-media/variants`
- `PUT /api/v1/settings/default-media/variants`

Example response:

```json
{
  "global_media_id": "media-global",
  "global_media": {
    "id": "media-global",
    "name": "Global Fallback",
    "type": "IMAGE",
    "media_url": "https://cdn.example.com/global-fallback.png"
  },
  "variants": [
    {
      "aspect_ratio": "16:9",
      "media_id": "media-16-9",
      "media": {
        "id": "media-16-9",
        "name": "Lobby Loop",
        "type": "VIDEO",
        "media_url": "https://cdn.example.com/lobby-loop.mp4"
      }
    }
  ]
}
```

`PUT /api/v1/settings/default-media/variants` request body:

```json
{
  "variants": {
    "16:9": "media-16-9",
    "9:16": null
  }
}
```

Validation:

- media ids must exist
- `null` clears a ratio-specific assignment

## Runtime/debug endpoints
Resolved fallback endpoints:

- `GET /api/v1/device/:deviceId/default-media`
- `GET /api/v1/screens/:id/default-media`

Example resolved response:

```json
{
  "source": "ASPECT_RATIO",
  "aspect_ratio": "16:9",
  "media_id": "media-16-9",
  "media": {
    "id": "media-16-9",
    "name": "Lobby Loop",
    "type": "VIDEO",
    "media_url": "https://cdn.example.com/lobby-loop.mp4"
  }
}
```

`NONE` response:

```json
{
  "source": "NONE",
  "aspect_ratio": "4:3",
  "media_id": null,
  "media": null
}
```

## Snapshot contract
Screen and device snapshot responses now include resolved fallback metadata:

- `default_media`
- `default_media_resolution`

Example:

```json
{
  "screen_id": "screen-1",
  "publish": null,
  "snapshot": null,
  "media_urls": null,
  "emergency": null,
  "default_media": {
    "id": "media-16-9",
    "name": "Lobby Loop",
    "type": "VIDEO",
    "media_url": "https://cdn.example.com/lobby-loop.mp4"
  },
  "default_media_resolution": {
    "source": "ASPECT_RATIO",
    "aspect_ratio": "16:9"
  }
}
```

## Player behavior
The player should not fetch the global setting for runtime fallback anymore.

It should use:

- `GET /api/v1/device/:deviceId/default-media`

Player fallback order:

1. emergency
2. schedule/publish
3. resolved default media
4. empty/idle state

If backend is temporarily unavailable, the player may keep the last cached resolved fallback if it remains locally playable.

## CMS behavior
CMS should configure:

1. global default media
2. aspect-ratio-specific fallback variants

Precedence shown to operators:

1. aspect-ratio default media
2. global default media
3. empty/idle state

## Tests
Coverage added for:

- exact aspect-ratio match
- derived aspect-ratio match from width/height
- global fallback when no ratio-specific media exists
- `NONE` when no fallback exists
- snapshot responses returning resolved default media
- settings variant validation and persistence
- player resolved-fallback fetch and cached fallback reuse
