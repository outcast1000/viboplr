# Queue

The queue is the central playback pipeline. All tracks flow through `useQueue.ts` (state/logic) and render in `QueuePanel.tsx` (UI). This document is the behavioral contract — all code that touches the queue must preserve these invariants.

## QueueTrack Type

Queue entries, the currently playing track (`currentTrack`), and playlist tracks use the `QueueTrack` type — a metadata-only object with **no DB IDs**. This type is defined in `types.ts`.

```typescript
interface QueueTrack {
  key: string;              // In-memory identity (ext:N, lib:N)
  path: string | null;      // Scheme-prefixed URI (file://, subsonic://, custom://)
  title: string;
  artist_name: string | null;
  album_title: string | null;
  duration_secs: number | null;
  format: string | null;
  image_url?: string;       // Album art path/URL, set by plugin or async resolution
  liked: number;            // -1/0/1, synced on-demand
}
```

**No DB IDs, no `collection_id`, no `youtube_url`.** These are either on the library `Track` type only, derivable from `path` (local vs remote), or resolved on-demand via `find_track_by_metadata`.

**Conversion:** Use `trackToQueueTrack(track: Track): QueueTrack` when adding library tracks to the queue. This strips DB IDs and keeps only portable metadata.

**Why:** Queue tracks may not be in the library (external sources, plugin views, restored playlists). By removing DB ID dependencies, all queue/playback surfaces work uniformly regardless of track origin.

### Image Resolution (Queue/NowPlaying)

Image resolution is **async-only** — there is no synchronous stamping. Tracks enter the queue with `image_url` unset (unless explicitly provided by a plugin). Both `QueuePanel.tsx` and the `currentTrack` effect in `App.tsx` resolve images using the same priority chain:

1. `track.image_url` already set (explicit — from plugin, restored thumbnail). **Skip async resolution.**
2. Video frame capture — for video tracks (`isVideoTrack(t)`), resolve library ID via `find_track_id_by_path`, then check `get_video_frames` for a cached first frame
3. Album image by name via `get_entity_image("album", album_title, artist_name)`
4. Artist image by name via `get_entity_image("artist", artist_name)`
5. Placeholder disc SVG (QueuePanel only)

**Rules:**
- Never pre-stamp tracks with entity images before adding to queue — this bypasses the priority chain
- Only plugin-provided `image_url` (via `PluginTrack.image_url`) should be set before queue entry
- Video frame resolution only checks the cache (`get_video_frames`), never triggers extraction
- The `find_track_id_by_path` command matches against the full computed path (with scheme prefix)

### Library Operations on QueueTracks

Operations that need a library ID (delete, show in folder, audio properties) use on-demand metadata lookup:
- Call `invoke("find_track_by_metadata", { title, artistName, albumName })` to resolve the library track
- If found, proceed with the resolved ID
- If not found, show feedback "Track not in library" via `addLog()`

**Like/dislike is the exception** — it does NOT require a library ID. `useLikeActions` persists via `set_entity_like_state` against the metadata-keyed `entity_likes` store, so any `QueueTrack` (library or not) can be liked, and the new state propagates to same-song copies in the queue/`currentTrack` via the `sameSong()` predicate. The `QueueTrack.liked` field drives the like/dislike indicator rendered before the title in `QueuePanel.tsx`.

### Navigation from QueueTracks

Artist/album clicks in NowPlayingBar and FullscreenControls navigate by name, not ID:
- `onNavigateToArtistByName(artist_name)` — searches library artists by name
- `onNavigateToAlbumByName(album_title, artist_name)` — searches library albums by title + artist

## Track Entry

Every way tracks enter the queue and what each must maintain.

| Operation | Canonical | Invariants |
|---|---|---|
| **Play tracks** | `playTracks(tracks, startIndex, context?)` | Replaces entire queue. Sets `queueIndex` to `startIndex`. Sets or clears `playlistContext`. Queue mode is unaffected (no shuffle order to rebuild). |
| **Enqueue tracks** | `enqueueTracks(tracks)` | Appends to end. Does NOT change `queueIndex`. Does NOT clear `playlistContext`. Caller must run `findDuplicates()` first and present the duplicate banner — `enqueueTracks` itself has no dedup guard. |
| **Play next** | `playNextInQueue(track)` | Inserts single track at `queueIndex + 1`. Does NOT advance index or trigger playback. |
| **Insert at position** | `insertAtPosition(tracks, position)` | Inserts at arbitrary index. If `position <= queueIndex`, shifts index up by `tracks.length`. |
| **Add single** | `addToQueue(track)` | Appends one track. No index change. |
| **Add and play** | `addToQueueAndPlay(track, source?)` | Appends one track, sets `queueIndex` to new last position, calls `handlePlay`. |
| **Load playlist** | `loadPlaylist()` | Replaces entire queue from `.m3u`/`.m3u8` file. Converts entries via `queueEntryToTrack`. Sets index to 0, plays first track, sets context to filename. `.mixtape` files delegate to `onOpenMixtape`. |

**Image resolution rule:** There is no synchronous image stamping. Image resolution happens asynchronously in `QueuePanel.tsx` (for queue thumbnails) and in the `currentTrack` effect in `App.tsx` (for now-playing art). Both use the same priority chain defined in "Image Resolution (Queue/NowPlaying)" above.

**Key generation:** Library tracks get `lib:N` keys, external tracks get `ext:N` keys. The `key` field is the in-memory identity used for React rendering and multi-select — never persisted to disk.

## Playback Progression

How the queue advances through tracks across all three modes. The per-mode index math lives in pure helpers in `queueNav.ts` (`nextIndex` / `prevIndex`), which `useQueue.ts` calls — they are the single source of truth.

**Modes** (`QueueMode = "normal" | "repeat-all" | "repeat-one"`):
- **Normal** — linear, index increments by 1. `playNext` returns `false` at end (no wrap; auto-continue may then extend the queue). `playPrevious` stops at index 0.
- **Repeat All** — circular. `playNext` wraps via `(idx + 1) % length`. `playPrevious` wraps via `(idx - 1 + length) % length`.
- **Repeat One** — `playNext` / `playPrevious` return the **current** index unchanged, so the same track replays. Because the end-of-track flow re-enters `handlePlay` (the explicit play path), each replay resets the scrobble guard and counts as a fresh play/scrobble. Repeat One is NOT implemented via `audio.loop` or a silent seek (that would suppress scrobbles).

**Randomize** (`randomizeQueue`) — a one-shot action, **not a mode**. It physically reorders the `queue` array: the current track moves to index 0 and the rest are Fisher-Yates shuffled. Play/pause state is left untouched (the same audio keeps playing; only the surrounding queue is renumbered). No-op for queues with fewer than 2 tracks. Disabled in Repeat One. There is no persistent "shuffle order" — once randomized it's just a reordered queue.

**Mode toggling** (`toggleQueueMode`): cycles `normal -> repeat-all -> repeat-one -> normal`. No side effects on toggle — `queueIndex` already points to the correct track in every mode.

**Invariants:**
- `queueIndex` always points to the currently playing track's position in the `queue` array, regardless of mode. It is the single source of truth for "what's playing."
- `playNext` and `playPrevious` always read from refs (`queueRef`, `queueIndexRef`, `queueModeRef`, etc.), never from stale closure state. New code that accesses queue state inside event handlers or callbacks must follow this pattern.
- `peekNext()` mirrors `nextIndex`: it returns the same-mode next track (current track in Repeat One, wrapped in Repeat All), or `null` only when Normal is at the end or the queue is empty. Callers must handle `null`.
- `advanceIndex()` moves the index without triggering playback — used for preload/gapless. It follows the same `nextIndex` logic as `playNext`.
- `handlePlay(track, source)` receives `"user"` or `"auto"` — auto-continue and gapless preload use `"auto"`, user clicks use `"user"`. This distinction matters for scrobble logic downstream.
- Auto-continue runs only in Normal mode (gated in `App.tsx` `handleNext`). In Repeat All / Repeat One `playNext` never returns `false`, so it's unreachable anyway; the UI also disables the auto-continue button outside Normal.

## Queue Mutation & Index Integrity

Every mutation that changes the queue array must also recalculate `queueIndex` so the currently playing track stays correct.

**Core invariant:** After any mutation, `queue[queueIndex]` must still be the currently playing track. If the playing track was removed, index must point to the nearest valid position.

| Mutation | Index recalculation |
|---|---|
| **Remove single** (`removeFromQueue`) | If removed < index: index decrements by 1. If removed === index: index clamps to `min(index, newLength - 1)`. If removed > index: no change. |
| **Remove multiple** (`removeMultiple`) | If current track is in the removed set: index moves to `max(0, index - countRemovedBeforeIndex)`. Otherwise: index decrements by count of removed items before it. |
| **Move single** (`moveInQueue`) | If current track is the one moved: index becomes `to`. Otherwise: adjusts +/-1 if the move crosses the current index. |
| **Move multiple** (`moveMultiple`) | Computes insertion point in the "remaining" array (after extracting moved items). If current track is being moved: its new position is `insertAt + positionInMovedGroup`. If not: adjusts based on whether insertAt falls before or after its new position. |
| **Move to top** (`moveToTop`) | If current track is in set: new index is its position in the sorted moved array. Otherwise: shifts right by `movedSet.length` minus items that were already above it. |
| **Move to bottom** (`moveToBottom`) | Mirror of move-to-top. Current track in set: `remainingLength + posInSorted`. Not in set: decrements by count of moved items before it. |
| **Insert at position** (`insertAtPosition`) | If `position <= index`: index shifts by `insertedCount`. Otherwise: no change. |
| **Play next in queue** (`playNextInQueue`) | Inserts at `index + 1`. Index does not change (inserted item is after current). |
| **Clear** (`clearQueue`) | Index resets to -1. Playlist context cleared. Also invokes `main_playlist_clear` on backend. |

**Selection behavior:** `selectedIndices` in QueuePanel is cleared on every queue state change (the `useEffect` on `[queue]`). This prevents stale index references after mutations.

## Persistence & Restoration

How the queue survives app restarts.

**Write path:**
- Triggered by a `useEffect` watching `[queue, playlistContext, queueIndex, queueMode]`
- Debounced at 500ms via `setTimeout` / `clearTimeout`
- Guarded by `restoredRef.current` — will not write until initial restore is complete. This prevents overwriting saved state with empty defaults on startup.
- Writes two pieces via `invoke("main_playlist_write")`:
  - **Manifest:** track entries (via `buildManifest`) + playlist context
  - **State:** index, mode (via `buildState`)

**Cover image:**
- Separate `useEffect` on `[playlistContext]`
- Writes cover via `invoke("main_playlist_set_cover", { source })` — either a local path or remote URL
- Clears cover (`source: null`) when no context or no image

**Thumbnail management:**
- `useEffect` on `[queue, playlistContext]` diffs previous and current queue by file URI (`diffThumbs`)
- Removed tracks: thumbnails deleted via `main_playlist_remove_thumb`, their `thumbInfo` entries dropped
- Added tracks: a thumbnail is written via `main_playlist_set_thumb` for **any** track that carries an `image_url` (plugin/remote art the entity-image cache can't serve) — there is **no** remote-context gate. Library tracks carry no `image_url` on their `QueueTrack`, so they're skipped (their art resolves via the entity cache)
- `main-playlist-thumb-ready` backend event records the backend-named filename into `thumbInfo` and bumps its `version` to bust the `convertFileSrc` cache
- The on-disk thumb is named solely by Rust (`canonical_slug(file)`); the frontend never computes the filename

**Restore path:**
- On startup, App.tsx calls `invoke("main_playlist_read")` to read the manifest and state from the backend's main-playlist folder (NOT from `tauri-plugin-store`).
- Tracks are reconstructed via `tracksFromManifest()` (producing `id: null` tracks with fresh `ext:N` keys). Playlist context is reconstructed via `contextFromManifest()`.
- Queue mode is restored from the state object. Legacy persisted modes are normalized on read: `"loop"` → `"repeat-all"`, `"shuffle"` → `"normal"` (App.tsx restore path) so older stored state stays valid.
- The queue and index are NOT set directly during restore — they are deferred via `pendingRestoreQueueRef` / `pendingRestoreTrackRef` and applied after initial library load (so library tracks can be matched and upgraded to full `id`-bearing tracks).
- Cached thumbnails are seeded synchronously into `thumbInfo` from the `thumbs` field of the `main_playlist_read` result (the backend existence-checks each queued track's thumb and returns its `canonical_slug`-derived filename), so restored queue rows paint their cached art on the first render — no separate async reconcile round-trip. Rust stays the sole namer of the on-disk file.
- `restoredRef` is set to `true` only after all restore operations complete.
- `invoke("main_playlist_gc")` runs fire-and-forget after restore to clean up orphaned cover/thumb files in the main-playlist folder.

**Invariants:**
- The `restoredRef` guard must be checked in every persistence effect. New persistence effects must follow this pattern.
- Debounce must remain at 500ms — lower values thrash disk I/O, higher values risk data loss on crash.
- `clearQueue()` must invoke `main_playlist_clear` on the backend in addition to resetting React state — the debounced write alone is not sufficient because the backend call also cleans up cover/thumb files.
- The deferred restore pattern (`pendingRestoreQueueRef` / `pendingRestoreTrackRef`) must not be bypassed — applying the queue before library load produces tracks with `id: null` that cannot be liked, deleted, or matched.

## Duplicate Detection

How the app prevents accidental duplicate enqueues.

**Detection:** `findDuplicates(newTracks)` compares incoming tracks against current queue by `track.path`. Returns `{ duplicates, unique }`. Path-based comparison means:
- Same file from different collections = duplicate (same path)
- Different formats of the same song = NOT detected (different paths)
- External tracks with `path: null` can be falsely flagged as duplicates of each other (all null-path tracks match via `Set.has(null)`). In practice, most external tracks carry a scheme-based path (`custom://`, `external://`) so this rarely triggers.

**UX flow:**
1. Caller (typically `useContextMenuActions`) calls `findDuplicates()` before enqueueing
2. If duplicates found, sets `pendingEnqueue: { all, duplicates, unique }` state
3. QueuePanel renders the duplicate banner with three options:
   - **"Add all (Ns)"** — enqueues everything including duplicates. Has a 10-second auto-approve countdown.
   - **"Add N new"** — enqueues only `unique` tracks. Only shown when `unique.length > 0`.
   - **"Cancel"** — discards the pending enqueue entirely.
4. Countdown starts at 10s, decrements every 1s. At 0, auto-triggers "Add all" via `onAllowAll`.
5. Any of the three actions clears `pendingEnqueue`.

**Invariants:**
- `enqueueTracks()` itself has NO built-in dedup. Callers are responsible for running `findDuplicates()` and presenting the banner. If you add a new enqueue entry point, it must follow this pattern.
- The countdown resets to 10s whenever `pendingEnqueue` changes (new batch replaces previous).
- Auto-approve fires via a `useEffect` watching `[countdown, pendingEnqueue]` — when `countdown === 0 && pendingEnqueue !== null`, calls `onAllowAll`.
- Image resolution happens async after tracks are added to the queue, regardless of which duplicate resolution path the user picks.

## Queue Panel UI

The visual and interaction layer.

**Layout states:**
- **Expanded** — full panel with header, optional context banner, scrollable track list, optional info bar. Width resizable 200-600px via left-edge drag handle.
- **Collapsed** — 40px vertical strip showing "Playlist" label, track count, and total duration. Click to expand.

**Context banner vs info bar:**
- When `playlistContext` is set AND queue is non-empty: context banner appears at top of the list showing cover image, playlist name, track count, and total duration. An info button opens a popover with source and metadata.
- When `playlistContext` is null AND queue is non-empty: a simple info bar appears at the bottom with count and duration.
- Never both at the same time.

**Selection model:**
- Click: select single item, deselect others
- Cmd/Ctrl+Click: toggle individual item in/out of selection
- Shift+Click: range select from last clicked index (Cmd+Shift extends, plain Shift replaces)
- Cmd/Ctrl+A: select all
- Escape: clear selection
- Selection clears on any queue state change (add/remove/reorder)
- Implementation: `computeIndexSelection()` — a pure function. Selection is index-based (`Set<number>`).

**Drag-and-drop (internal reorder):**
- mouseDown records drag candidates — if clicked index is in a multi-selection, drags the whole selection; otherwise drags single item
- 5px movement threshold before drag activates
- Ghost element shows track count, follows cursor
- Drop target indicator (line above/below) computed from cursor position relative to item midpoint
- mouseUp calls `onMoveMultiple(indices, targetIndex)`
- Click handler is suppressed after drag via `didDragRef` + `setTimeout` reset
- Tooltip is dismissed on drag start

**External drop (from track list):**
- Managed by `useContextMenuActions` outside QueuePanel
- `externalDropTarget` prop provides the visual indicator
- Collapsed queue auto-expands on external drag-over

**Context menu:**
- Right-click on single item: selects it, fires `onContextMenu` with `[index]`
- Right-click on multi-selection (if clicked index is in selection): fires `onContextMenu` with sorted selection indices
- Right-click on non-selected item while multi-selection exists: replaces selection with clicked item

**Header actions:** Load playlist, Save dropdown (Save as Playlist / Export as M3U / Export as Mixtape), Share queue, Clear playlist.

**Auto-scroll:** When `queueIndex` changes, the current track scrolls into view (`scrollIntoView({ block: "nearest", behavior: "smooth" })`). Also fires when panel un-collapses.

**Image resolution for queue items (priority order):**
1. `image_url` on the track object (explicit — from plugin or restored thumb) — skips async resolution
2. Remote playlist local thumbnail from `mainPlaylistDir/thumbs/` (with cache-busting `?v=` param)
3. Async resolution chain (see "Image Resolution (Queue/NowPlaying)" section above): video frame → album → artist → placeholder SVG

No ID-based cache lookups — all image resolution is name-based, path-based, or uses the track's own `image_url`.

**Tooltips:** 400ms hover delay. Normal mode: title + artist/album/format. Debug mode: full track metadata. Positioned to avoid viewport overflow.

## Cross-Cutting Invariants

Rules that span multiple areas. These are the things most likely to break during changes.

### Ref-Based State Access

Queue state is accessed via refs (`queueRef`, `queueIndexRef`, `queueModeRef`) inside callbacks and event handlers. This is because React state closures capture stale values. Every ref mirrors its corresponding state (`queueRef.current = queue` etc.), updated on every render. New code that reads queue state inside `setTimeout`, event listeners, or `handlePlay` callbacks MUST use refs, not direct state variables.

### The `restoredRef` Guard

Multiple `useEffect` hooks check `restoredRef.current` before writing. This prevents the startup sequence (where state is default-empty) from overwriting persisted data. Any new `useEffect` that writes to the backend or store must check this guard.

### Playlist Context Lifecycle

**`PlaylistContext` interface:**
- `name: string` — display name (album title, artist name, playlist name)
- `imagePath?: string | null` — local filesystem path to cover image
- `coverUrl?: string | null` — remote URL to cover image (for plugins)
- `source?: string | null` — origin label (e.g., `"album"`, `"artist"`, `"playlist"`)
- `metadata?: Record<string, string> | null` — arbitrary key-value pairs shown in the info popover
- `remote?: boolean` — whether the playlist is from a remote source (enables thumbnail management)

**Lifecycle rules:**
- Context is set when `playTracks` is called with a context argument, or when loading a playlist file.
- Context is cleared only by `clearQueue()` or by a new `playTracks` call with `null`/`undefined` context.
- `enqueueTracks` does NOT clear context — appending tracks to an album queue should keep the album banner.
- Every surface that calls `playTracks` should pass context when the source is known (album, artist, tag, playlist).

### Interaction with Auto-Continue

When `playNext` returns `false` (normal mode, end of queue), auto-continue takes over — it selects a new track via weighted strategy and calls `addToQueueAndPlay`. Auto-continue must not be confused with queue advancement. The queue hook only handles tracks already in the queue. Auto-continue extends the queue.

### Interaction with Scrobble

The `source` parameter (`"user"` vs `"auto"`) flows from `playNext`/`playPrevious` through `handlePlay` to scrobble logic. Scrobble threshold is evaluated regardless of source, but the distinction is used in plugin event dispatch. Queue code must always pass `source` through. Dropping it defaults to `"user"` which misattributes auto-advanced plays.

### Interaction with Stream Resolvers

Queue tracks may not have playable URLs at enqueue time. URL resolution happens at play time via the stream resolver chain in `App.tsx`. Queue code must never assume `track.path` is a playable URL. It is a scheme-prefixed identifier (`file://`, `subsonic://`, `custom://`), not a source.

### Randomize Is Destructive, Not Stateful

Randomization is a one-shot reorder of the `queue` array (`randomizeQueue`), not a persistent mode. There is no `shuffleOrder`/`shufflePosition` to keep in sync with mutations — the queue array IS the order. This deliberately avoids the old shuffle-state fragility class (stale shuffle indices on add/remove/reorder). After Randomize, the current track sits at index 0 and normal index-recalc rules apply to any further mutations.

1. Using state variables instead of refs inside callbacks — causes stale reads
2. Calling `enqueueTracks` without running `findDuplicates` first — bypasses the duplicate banner
3. Forgetting to pass `PlaylistContext` when calling `playTracks` — loses the queue banner
4. Mutating the queue array without recalculating `queueIndex` — breaks "what's playing"
5. Adding a new persistence effect without the `restoredRef` guard — overwrites saved state on startup
6. Assuming `track.path` is a playable URL — it's a scheme-prefixed identifier
7. Pre-stamping tracks with entity images before adding to queue — bypasses the async resolution priority chain (video frame → album → artist)
8. Using `track.id`, `track.album_id`, or `track.artist_id` on queue/playlist/currentTrack — these are `QueueTrack` which has no DB IDs. Use name-based lookups or on-demand `find_track_by_metadata` instead.
