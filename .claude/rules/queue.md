# Queue

The queue is the central playback pipeline. All tracks flow through `useQueue.ts` (state/logic) and render in `QueuePanel.tsx` (UI). This document is the behavioral contract — all code that touches the queue must preserve these invariants.

## Track Entry

Every way tracks enter the queue and what each must maintain.

| Operation | Canonical | Invariants |
|---|---|---|
| **Play tracks** | `playTracks(tracks, startIndex, context?)` | Replaces entire queue. Stamps images. Sets `queueIndex` to `startIndex`. If shuffle active, regenerates shuffle order with `startIndex` first. Sets or clears `playlistContext`. |
| **Enqueue tracks** | `enqueueTracks(tracks)` | Appends to end. Stamps images. Does NOT change `queueIndex`. Does NOT clear `playlistContext`. Caller must run `findDuplicates()` first and present the duplicate banner — `enqueueTracks` itself has no dedup guard. |
| **Play next** | `playNextInQueue(track)` | Inserts single track at `queueIndex + 1`. Stamps image. Does NOT advance index or trigger playback. |
| **Insert at position** | `insertAtPosition(tracks, position)` | Inserts at arbitrary index. If `position <= queueIndex`, shifts index up by `tracks.length`. |
| **Add single** | `addToQueue(track)` | Appends one track. Stamps image. No index change. |
| **Add and play** | `addToQueueAndPlay(track, source?)` | Appends one track, sets `queueIndex` to new last position, calls `handlePlay`. |
| **Load playlist** | `loadPlaylist()` | Replaces entire queue from `.m3u`/`.m3u8` file. Converts entries via `queueEntryToTrack`. Sets index to 0, plays first track, sets context to filename. `.mixtape` files delegate to `onOpenMixtape`. Does NOT call `stamp()` (playlist entries lack `album_id` so stamping would have no effect). |

**Image stamping rule:** Every entry path that accepts library tracks calls `stamp()`, which assigns `image_url` from `albumImages` cache for tracks that lack one. This must happen before tracks are added to state. Exception: `loadPlaylist` — playlist entries have no `album_id`, so stamping is a no-op and is skipped.

**External tracks:** Tracks without a library ID (`id: null`) get a synthetic `key` (e.g., `ext:N`). They can be played and queued but cannot be deleted, liked, or edited.

## Playback Progression

How the queue advances through tracks across all three modes.

**Modes:**
- **Normal** — linear, index increments by 1. `playNext` returns `false` at end (no wrap). `playPrevious` stops at index 0.
- **Loop** — circular. `playNext` wraps via `(idx + 1) % length`. `playPrevious` wraps via `(idx - 1 + length) % length`.
- **Shuffle** — Fisher-Yates order generated at mode activation or queue replacement. Current track is always position 0 in shuffle order. Progression follows `shufflePosition` through `shuffleOrder` array. When shuffle exhausts, regenerates full order anchored at the first track of the previous shuffle (`order[0]`) and restarts at position 0. `playPrevious` walks back through shuffle history (stops at position 0, no wrap).

**Mode toggling** (`toggleQueueMode`): cycles `normal -> loop -> shuffle -> normal`. When entering shuffle, generates new order anchored at current `queueIndex`. When leaving shuffle, no special action — `queueIndex` already points to the correct track.

**Invariants:**
- `queueIndex` always points to the currently playing track's position in the `queue` array, regardless of mode. It is the single source of truth for "what's playing."
- `shuffleOrder` and `shufflePosition` are only meaningful when `queueMode === "shuffle"`. They must not be consulted in other modes.
- `playNext` and `playPrevious` always read from refs (`queueRef`, `queueIndexRef`, `queueModeRef`, etc.), never from stale closure state. New code that accesses queue state inside event handlers or callbacks must follow this pattern.
- `peekNext()` returns `null` at shuffle boundary (can't predict regenerated order). Callers must handle `null`.
- `advanceIndex()` moves the index without triggering playback — used for preload/gapless. It follows the same mode logic as `playNext`.
- `handlePlay(track, source)` receives `"user"` or `"auto"` — auto-continue and gapless preload use `"auto"`, user clicks use `"user"`. This distinction matters for scrobble logic downstream.

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
| **Clear** (`clearQueue`) | Index resets to -1. Shuffle state cleared. Playlist context cleared. Also invokes `main_playlist_clear` on backend. |

**Shuffle state on mutation:** Shuffle order is NOT recalculated after add/remove/reorder. This means shuffle indices can become stale if tracks are added or removed mid-shuffle. This is a known limitation — future changes that address it must regenerate `shuffleOrder` while preserving the current track's position.

**Selection behavior:** `selectedIndices` in QueuePanel is cleared on every queue state change (the `useEffect` on `[queue]`). This prevents stale index references after mutations.

## Persistence & Restoration

How the queue survives app restarts.

**Write path:**
- Triggered by a `useEffect` watching `[queue, playlistContext, queueIndex, queueMode, shuffleOrder, shufflePosition]`
- Debounced at 500ms via `setTimeout` / `clearTimeout`
- Guarded by `restoredRef.current` — will not write until initial restore is complete. This prevents overwriting saved state with empty defaults on startup.
- Writes two pieces via `invoke("main_playlist_write")`:
  - **Manifest:** track entries (via `buildManifest`) + playlist context
  - **State:** index, mode, shuffle order, shuffle position (via `buildState`)

**Cover image:**
- Separate `useEffect` on `[playlistContext]`
- Writes cover via `invoke("main_playlist_set_cover", { source })` — either a local path or remote URL
- Clears cover (`source: null`) when no context or no image

**Thumbnail management (remote playlists only):**
- `useEffect` on `[queue, playlistContext]` diffs previous and current queue
- Removed tracks: thumbnails deleted via `main_playlist_remove_thumb`, version entries cleaned from `thumbVersions`
- Added tracks (remote context only): thumbnails written via `main_playlist_set_thumb` using track's `image_url`
- `main-playlist-thumb-ready` backend event bumps `thumbVersions` to bust the `convertFileSrc` cache
- Stale thumbnail removal happens regardless of remote flag — switching away from a remote playlist still cleans up

**Restore path:**
- On startup, App.tsx calls `invoke("main_playlist_read")` to read the manifest and state from the backend's main-playlist folder (NOT from `tauri-plugin-store`).
- Tracks are reconstructed via `tracksFromManifest()` (producing `id: null` tracks with fresh `ext:N` keys). Playlist context is reconstructed via `contextFromManifest()`.
- Queue mode, shuffle order, and shuffle position are restored from the state object.
- The queue and index are NOT set directly during restore — they are deferred via `pendingRestoreQueueRef` / `pendingRestoreTrackRef` and applied after initial library load (so library tracks can be matched and upgraded to full `id`-bearing tracks).
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
- External tracks with `path: null` can be falsely flagged as duplicates of each other (all null-path tracks match via `Set.has(null)`). In practice, most external tracks carry a scheme-based path (`tidal://`, `external://`) so this rarely triggers.

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
- `stamp()` runs on the incoming tracks before duplicate comparison, so `image_url` is populated regardless of which resolution path the user picks.

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

**Header actions:** Load playlist, Save dropdown (Save as Playlist / Export as M3U / Export as Mixtape), Edit playlist, Clear playlist.

**Auto-scroll:** When `queueIndex` changes, the current track scrolls into view (`scrollIntoView({ block: "nearest", behavior: "smooth" })`). Also fires when panel un-collapses.

**Image resolution for queue items (priority order):**
1. Video frame (for video tracks with library ID)
2. `image_url` on the track object
3. Album image from cache (`albumImages[album_id]`)
4. Artist image from cache (`artistImages[artist_id]`)
5. Async name-based resolve via `get_entity_image_by_name` (cached in component state, deduped by `artist::title` key)
6. Remote playlist local thumbnail from `mainPlaylistDir/thumbs/` (with cache-busting `?v=` param)
7. Placeholder SVG

**Tooltips:** 400ms hover delay. Normal mode: title + artist/album/format. Debug mode: full track metadata. Positioned to avoid viewport overflow.

## Cross-Cutting Invariants

Rules that span multiple areas. These are the things most likely to break during changes.

### Ref-Based State Access

Queue state is accessed via refs (`queueRef`, `queueIndexRef`, `queueModeRef`, `shuffleOrderRef`, `shufflePositionRef`) inside callbacks and event handlers. This is because React state closures capture stale values. Every ref mirrors its corresponding state (`queueRef.current = queue` etc.), updated on every render. New code that reads queue state inside `setTimeout`, event listeners, or `handlePlay` callbacks MUST use refs, not direct state variables.

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

Queue tracks may not have playable URLs at enqueue time. URL resolution happens at play time via the stream resolver chain in `App.tsx`. Queue code must never assume `track.path` is a playable URL. It is a scheme-prefixed identifier (`file://`, `subsonic://`, `tidal://`), not a source.

### Shuffle State Fragility

Shuffle order is generated once (on mode switch or `playTracks`) and not updated on queue mutations. Adding, removing, or reordering tracks mid-shuffle can create stale indices in `shuffleOrder`. Current behavior: shuffle continues with potentially invalid indices until regeneration at boundary. Future fix must regenerate shuffle order on mutation while preserving the current position in the walk.

### Common Mistakes to Avoid

1. Using state variables instead of refs inside callbacks — causes stale reads
2. Calling `enqueueTracks` without running `findDuplicates` first — bypasses the duplicate banner
3. Forgetting to pass `PlaylistContext` when calling `playTracks` — loses the queue banner
4. Mutating the queue array without recalculating `queueIndex` — breaks "what's playing"
5. Adding a new persistence effect without the `restoredRef` guard — overwrites saved state on startup
6. Assuming `track.path` is a playable URL — it's a scheme-prefixed identifier
7. Forgetting to call `stamp()` on tracks before adding to queue — tracks lose image URLs
