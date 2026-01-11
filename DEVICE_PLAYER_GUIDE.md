# Device Player Implementation Guide

This backend is already serving playlists and presigned media URLs. Implement the device/player with the flow below.

## Fetch snapshot
1. Call `GET /api/v1/device/:deviceId/snapshot?include_urls=true` (device-auth) or `GET /api/v1/screens/:id/snapshot?include_urls=true` (server-auth).
2. Response: `snapshot.schedule` (items with start/end, targets, priority, presentation data), `media_urls` keyed by `media_id`.

## Build timelines
```ts
type TimelineItem = {
  slotId: string;
  mediaUrl: string;
  startAt: Date;
  endAt: Date;
  durationSeconds?: number;
  fitMode?: string;
  audioEnabled?: boolean;
};

function buildSlotTimelines(snapshot: any): Record<string, TimelineItem[]> {
  const timelines: Record<string, TimelineItem[]> = {};
  for (const item of snapshot.schedule.items || []) {
    const pres = item.presentation;
    if (!pres) continue;

    // Base playlist (no layout)
    if (!pres.layout) {
      const list = timelines['default'] || [];
      list.push({
        slotId: 'default',
        mediaUrl: mediaUrl(pres.items?.[0]?.media_id),
        startAt: new Date(item.start_at),
        endAt: new Date(item.end_at),
        durationSeconds: pres.items?.[0]?.duration_seconds,
      });
      timelines['default'] = list;
    }

    // Layout slots
    for (const slot of pres.slots || []) {
      const list = timelines[slot.slot_id] || [];
      list.push({
        slotId: slot.slot_id,
        mediaUrl: mediaUrl(slot.media_id),
        startAt: new Date(item.start_at),
        endAt: new Date(item.end_at),
        durationSeconds: slot.duration_seconds,
        fitMode: slot.fit_mode,
        audioEnabled: slot.audio_enabled,
      });
      timelines[slot.slot_id] = list;
    }
  }

  // Sort each slot by start time
  Object.values(timelines).forEach((list) => list.sort((a, b) => a.startAt.getTime() - b.startAt.getTime()));
  return timelines;
}
```

## Playback loop
1. For each slot timeline, run a loop:
   - Find current item where `startAt <= now <= endAt`.
   - If multiple, pick highest `priority` from parent schedule item (fallback first).
   - Render media (image/video/doc) in that slot; honor `fit_mode`/`audio_enabled`.
   - If no current item, show fallback (black/idle).
2. Respect `duration_seconds` inside the item to advance within a presentation list when needed.
3. On change of active item or completion, post PoP/heartbeat if required by the device app.

## Emergency override
- If `snapshot` response includes `emergency`, pause normal playback and render the emergency media full-screen.
- Use `include_urls=true` to get `emergency.media_url`.
- Resume normal playback only after `emergency` is cleared (no emergency in snapshot).

## Refresh strategy
1. Poll snapshot endpoint periodically (e.g., every 30–60s) with `If-None-Match` or timestamp caching; if `published_at` changes, rebuild timelines.
2. Also poll commands:
   - `GET /api/v1/device/:deviceId/commands` to retrieve queued commands.
   - Execute (e.g., `REFRESH` triggers immediate snapshot refetch).
   - New commands:
     - `TAKE_SCREENSHOT`: capture and upload via `POST /api/v1/device/screenshot`.
     - `SET_SCREENSHOT_INTERVAL`: update local screenshot timer (payload: `{ interval_seconds, enabled }`).
   - Acknowledge via `POST /api/v1/device/:deviceId/commands/:commandId/ack`.

## Validity & targeting
- Each schedule item includes `start_at`/`end_at`; never render outside that window.
- The server already filtered items per device/screen using `screen_ids` and `screen_group_ids`; no extra filtering needed on the client.

## Error handling
- If `media_urls[media_id]` is missing, skip the item and log.
- If snapshot fetch fails, keep playing the last valid timelines until expiry; optionally show an offline banner when all items expire.

## Minimal bootstrap loop
```ts
async function runPlayer(deviceId: string) {
  let timelines = {};
  let publishVersion = '';

  async function refresh() {
    const res = await fetch(`/api/v1/device/${deviceId}/snapshot?include_urls=true`);
    if (!res.ok) throw new Error('snapshot failed');
    const body = await res.json();
    if (body.publish.published_at !== publishVersion) {
      publishVersion = body.publish.published_at;
      timelines = buildSlotTimelines(body.snapshot);
    }
  }

  setInterval(refresh, 60000); // poll for new publish
  setInterval(pollCommands, 15000); // handle device commands
  renderLoop(timelines); // your rendering loop per slot
}
```

Implement `renderLoop` with your UI stack (HTML5/Canvas/React Native/etc.) to draw slots and swap media when timelines change or when the current item expires.
