# Spotify Playlist Auto-Refresh & Archiving

## Problem

The Spotify plugin fetches playlists only on manual user action. Dynamic playlists like "Discover Weekly" rotate weekly and their content is lost. There's no way to preserve historical snapshots or know when content has changed without manually re-scraping.

## Solution

Three additions: a Rust-side plugin scheduler for reliable periodic tasks, a plugin badge API for sidebar notifications, and archiving logic in the Spotify plugin that detects changes and preserves snapshots of dynamic playlists.

## 1. Rust Plugin Scheduler

A lightweight, DB-persisted scheduler that fires events to the frontend when tasks are due.

### DB Schema

```sql
CREATE TABLE plugin_schedules (
    plugin_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    interval_ms INTEGER NOT NULL,
    last_run INTEGER,
    PRIMARY KEY (plugin_id, task_id)
);
```

### Rust Implementation

`AppState` holds a `PluginScheduler` with the schedule data. On app startup, after the frontend is ready, Rust loads all schedules from the DB and checks which are due (`now - last_run >= interval_ms` or `last_run IS NULL`). For each due task, it emits a Tauri event `plugin-scheduler-due` with `{ pluginId, taskId }`. A background thread re-checks periodically (every 60 seconds) for long-running app sessions.

### Commands

- `plugin_scheduler_register(pluginId, taskId, intervalMs)` — upsert into `plugin_schedules`
- `plugin_scheduler_unregister(pluginId, taskId)` — delete from `plugin_schedules`
- `plugin_scheduler_complete(pluginId, taskId)` — update `last_run` to current timestamp

### Frontend API

```typescript
interface PluginSchedulerAPI {
  register(taskId: string, intervalMs: number): Promise<void>;
  unregister(taskId: string): Promise<void>;
  complete(taskId: string): Promise<void>;
  onDue(taskId: string, handler: () => void): () => void;
}
```

Added to `ViboplrPluginAPI` as `api.scheduler`.

`usePlugins` listens for `plugin-scheduler-due` events and dispatches to the matching plugin's registered `onDue` handler. Handlers are cleared on plugin deactivation. Schedule rows persist in the DB across restarts.

## 2. Plugin Badge API

Any plugin can set a badge on its sidebar icon.

### Types

```typescript
type PluginBadge =
  | null
  | { type: "dot"; variant: "accent" | "error" }
  | { type: "count"; value: number; variant: "accent" | "error" }
```

### API

```typescript
// Added to PluginUIAPI
setBadge(viewId: string, badge: PluginBadge): void;
```

### Implementation

- `usePlugins` stores badge state in a `Map<string, PluginBadge>` keyed by `pluginId:viewId`
- Exposed via a getter to `Sidebar.tsx`
- Sidebar renders an 8px dot or small pill (for count, capped at "99+") positioned top-right of the sidebar icon
- Dot/pill color: `var(--accent)` for `"accent"`, `var(--error)` for `"error"`; count pill uses white text
- Badge state is ephemeral — not persisted, recalculated each session

## 3. Auto-Refresh Flow

### On Plugin Activation

1. Restore saved state from `api.storage.get("spotify_browse_state")`
2. Register scheduler: `api.scheduler.register("auto-refresh", 86400000)` (24h)
3. Register handler: `api.scheduler.onDue("auto-refresh", silentRefresh)`

### Silent Refresh (auto)

1. Open hidden browse window to Spotify
2. Check login (poll DOM, same as today) — if not logged in, set error badge, abort
3. Navigate to "Made for You", scrape playlist list
4. For each playlist, scrape tracks
5. Run change detection (Section 4)
6. If any changes found, set accent badge
7. Call `api.scheduler.complete("auto-refresh")`
8. Close browse window

No visible UI changes during auto-refresh. Errors are silent except for the badge.

### Manual Refresh

Triggered by a "Refresh" button in the Spotify view header.

Same scrape flow but with progress feedback in the view:
- "Checking login..."
- "Finding playlists..."
- "Scraping tracks (3/12: Daily Mix 1)..."
- On completion: "Updated 3 playlists, archived 1 new Discover Weekly snapshot"
- On error: inline error message with retry button

Button shows spinner and disables during refresh.

### Badge Behavior

| Event | Badge |
|---|---|
| Auto-refresh found changes | `{ type: "dot", variant: "accent" }` |
| Login check failed | `{ type: "dot", variant: "error" }` |
| User visits Spotify view | `null` (cleared) |
| Successful refresh (auto or manual) | Clears error badge |

## 4. Change Detection

Compare the new track list against the stored one for each playlist. Two lists are considered different if their sets of `(title, artist)` tuples differ. Order changes do not count as a change.

```javascript
function tracksChanged(oldTracks, newTracks) {
  if (!oldTracks || oldTracks.length !== newTracks.length) return true;
  var oldSet = new Set(oldTracks.map(function(t) { return t.name + "\0" + t.artist; }));
  var newSet = new Set(newTracks.map(function(t) { return t.name + "\0" + t.artist; }));
  if (oldSet.size !== newSet.size) return true;
  for (var item of newSet) {
    if (!oldSet.has(item)) return true;
  }
  return false;
}
```

## 5. Archiving

### Dynamic Playlist Identification

Hardcoded prefixes (auto-archived):
- "Discover Weekly"
- "Daily Mix"
- "Release Radar"
- "Repeat Rewind"
- "On Repeat"
- "Your Top Songs"

Plus user override: any playlist can be toggled as "archive this" via a button in the playlist detail view. User overrides stored in `spotify_browse_state.archivedIds` as a `string[]` of playlist IDs.

A playlist is archivable if it matches a hardcoded prefix OR its ID is in `archivedIds`.

### What Happens on Change

| Playlist type | Tracks changed? | Action |
|---|---|---|
| Static (not archivable) | Yes | Overwrite stored tracks, mark as "updated" |
| Static | No | No action |
| Archivable | Yes | Save old version as dated snapshot, store new as current |
| Archivable | No | No action |

Archive snapshot names use the date of the previous fetch: `"Discover Weekly — Apr 14, 2026"`.

### Storage Layout

```
spotify_browse_state → {
  playlists: [...],           // current playlist metadata
  playlistTracks: { id: [...] }, // current track lists
  savedAt: number,            // last fetch timestamp
  archivedIds: string[]       // user-toggled archive playlist IDs
}

spotify_browse_archive_index → [
  { playlistId, name, date, storageKey },
  ...
]

spotify_browse_archive:{uuid} → {
  name: string,               // e.g. "Discover Weekly — Apr 14, 2026"
  playlistId: string,
  date: string,               // ISO date
  tracks: [...]
}
```

Index is a flat list for cheap rendering. Individual snapshots stored separately so loading the list doesn't pull all track data.

### Deleting Archived Playlists

Remove the entry from `spotify_browse_archive_index` and delete the corresponding `spotify_browse_archive:{uuid}` storage key.

## 6. UI Changes

### Spotify Home View

- **Refresh button** in header area (ds-btn secondary). Shows spinner during refresh, disables.
- **"Updated" dot** on playlist cards whose tracks changed in the last refresh. Clears when user visits that playlist's detail view.
- **Archived section** below the playlists grid. Collapsible, titled "Archived". Renders as a flat list: playlist name + date + track count. Each row has a delete button (trash icon). Clicking a row opens the snapshot in detail view (read-only track list).

### Playlist Detail View

- **"Archive snapshots" toggle** — for playlists in the hardcoded dynamic list, on by default with "(auto-detected)" label. For others, off by default. Toggling adds/removes the playlist ID from `archivedIds`.

### Sidebar

- **Badge rendering** on plugin sidebar icons, driven by the badge API.

## 7. Files Changed

| File | Change |
|---|---|
| `src-tauri/src/db.rs` | `plugin_schedules` table, CRUD functions, migration |
| `src-tauri/src/commands.rs` | `plugin_scheduler_register`, `plugin_scheduler_unregister`, `plugin_scheduler_complete` commands |
| `src-tauri/src/lib.rs` | Register commands, spawn scheduler background thread, emit events |
| `src/types/plugin.ts` | `PluginBadge` type, `PluginSchedulerAPI` interface, add to `ViboplrPluginAPI` |
| `src/hooks/usePlugins.ts` | Implement `setBadge` + badge state map, implement scheduler API in `buildAPI`, listen for `plugin-scheduler-due` |
| `src/components/Sidebar.tsx` | Read badge state from usePlugins, render dot/pill |
| `src/components/Sidebar.css` | Badge dot and pill styles |
| `src-tauri/plugins/spotify-browse/index.js` | Auto-refresh, manual refresh, change detection, archiving, archive UI, archive toggle, badge calls, scheduler registration |
