# Conventions

All new code must follow these conventions. When touching existing code that violates them, fix the violations as part of the current work.

## Canonical Actions

Each entry documents the gold standard implementation for a repeated user action. New code that implements the same action must replicate this flow exactly.

### Delete Tracks

- **Canonical:** `useContextMenuActions.ts` -> `handleDeleteRequest()` / `handleDeleteConfirm()`
- **Flow:** Show confirmation modal with track title/count -> `invoke("delete_tracks", { trackIds })` -> filter from `library.tracks` -> remove matching queue entries by path -> stop playback if deleted track is playing -> `addLog()` with result -> show error modal if partial/total failure
- **Availability:** Local tracks only (`file://` scheme). Uses `isLocalTrack()` helper from `queueEntry.ts`. Single-track checks `target.isLocal` on the context menu target. Multi-track filters with `isLocalTrack(t)`.

### Find in YouTube

- **Canonical:** `useContextMenuActions.ts` -> `watchOnYoutube(title, artistName, durationSecs?)`
- **Flow:** `invoke("search_youtube", { title, artistName, durationSecs })` -> on success, open the resolved video URL -> on failure, `console.error` and fall back to opening the manual YouTube search-results URL.
- **Rule:** All entry points must call `watchOnYoutube` -- do not reimplement the search/open logic. There is **no** per-track YouTube URL storage (no `youtube_url` column/command, no "save this link" modal): every invocation searches fresh.
- **Label:** Always "Find in YouTube" (not "Watch on YouTube").

### Like/Unlike Track

- **Canonical:** `useLikeActions.ts` -> `handleToggleLike()` / `handleToggleDislike()`
- **Like flow:** Compute `newLiked` via `nextTriState(track.liked, "like")` -> `invoke("set_entity_like_state", { kind: "track", entity: trackLikePayload(track), likeState: newLiked })` (persists to the durable `entity_likes` store by metadata — see backend.md "Likes") -> mirror the new state into `library.tracks` (by key if the track has a `lib:N` key, else best-effort by title+artist) + `playback.currentTrack` + `queue` via the `sameSong()` predicate -> dispatch plugin event `track:liked` -> catch must `console.error`
- **Dislike flow:** Same as Like but with `nextTriState(track.liked, "dislike")` and no plugin event (dislike does NOT dispatch `track:liked`)
- **Propagation rule:** Likes propagate to same-song copies via `sameSong(a, b)` (key match, falling back to `title` + `artist_name`), so liking a song from any surface updates external/restored/duplicate copies that carry a different `ext:N`/`lib:N` key.
- **No library lookup needed:** Because `entity_likes` is keyed by metadata, there is no `find_track_by_metadata` / "Track not in library" gate — any `QueueTrack` can be liked, library or not.

### Like/Unlike Artist, Album, Tag

- **Canonical:** `useLikeActions.ts` -> `handleToggleArtistLike()` / `handleToggleAlbumLike()` / `handleToggleTagLike()` (and hate variants)
- **Flow:** `invoke("set_entity_like_state", { kind, entity: entityLikePayload(name[, artistName]), likeState })` -> update the relevant entity list in library state -> catch must `console.error`
- These do NOT dispatch plugin events or update queue/currentTrack

### Play / Enqueue / Play Next

- **Canonical:** `useQueue.ts` -> `playTracks()` / `enqueueTracks()` / `playNextInQueue()`
- Enqueue checks for duplicates via `findDuplicates()` with user confirmation modal

### Open Containing Folder

- **Canonical:** `useContextMenuActions.ts` -> `handleShowInFolder()`
- **Flow:** `invoke("show_in_folder", { trackId })` for library tracks, `invoke("show_in_folder_path", { filePath })` for paths
- **Availability:** Local tracks only (`file://` scheme). Visibility controlled by `target.isLocal` flag on the context menu target.

### Download Track

- **Canonical:** `useContextMenuActions.ts` -> `handleDownloadTrack()` / `handleDownloadMulti()`; the unified `DownloadModal` flow is wired in `App.tsx`
- **Flow:** Resolve download URL via provider chain (`resolveTrackDownload`) -> `invoke("enqueue_download", ...)` -> progress via `download-progress` events -> success via `download-complete` -> error via `download-error` -> `addLog()` on both outcomes
- **Multi-track:** `useContextMenuActions.ts` -> `handleDownloadMulti()` loops tracks with `isBatchLast` flag on the final item

### Tag Operations

- **Canonical editor:** `TagEditor.tsx` — the shared chip+autocomplete component. Used on every tag surface: `TrackDetailView`, `BulkEditModal`, `NowPlayingView` (inline), and `NowPlayingBar` (via `TagPopover`, a `variant="popover"` host). New tag-editing surfaces must reuse `TagEditor`, not reimplement chips/autocomplete.
- **Suggestion pool:** `buildTagSuggestionPool(libraryTags, communityTags)` in `utils/tagSuggestions.ts` — library tags ranked by `track_count` descending, then community/Last.fm tags appended (case-insensitive dedup) via the shared `appendCommunityTags(pool, communityTags)` helper. Order is preserved so `filterSuggestions` keeps the frequency ranking. Surfaces that already hold a ranked `string[]` library pool (`BulkEditModal`, the Now Playing `TagPopover`) call `appendCommunityTags` directly to fold in Last.fm track/artist tags fetched on demand via the `useCommunityTags` hook (gated by `enabled`; artist-level tags only for multi-track selections). Community tags reach the pool on **every** tag-editing surface, not just `TrackDetailView`. Already-applied tags are hidden from the dropdown via `AutocompleteInput`'s `exclude` set (built inside `TagEditor`), not stripped from the pool — so a just-removed tag is immediately suggestable again.
- **Single-track add/remove (canonical path):** route through `useTagActions` (`hooks/useTagActions.ts`). `add` -> `invoke("plugin_apply_tags", { trackId, tagNames: [name] })`; `remove` -> `invoke("replace_track_tags", { trackId, tagNames: remaining })`. Both return `Array<[tagId, tagName]>`. Quick-edit is **DB-only** and uses **optimistic UI**: the chip appears/disappears immediately, reverts on failure. There is **no** `addLog` mechanism in this codebase — feedback is the optimistic chip update; every `catch` must `console.error`.
- **Bulk edit / file write:** `BulkEditModal` keeps its replace/add/remove mode selector and saves via `invoke("bulk_update_tracks", { trackIds, fields })` with `fields.tag_names` + `fields.tag_mode`. This is the **only** path that writes tags into audio-file genre metadata. The inline quick-editors never touch files.
- **Non-library tracks:** the Now Playing surfaces operate on `QueueTrack` (no DB id). They resolve the playing track to a library row via `invoke("find_track_by_metadata", { title, artistName, albumName })` (on the Bar, only when the popover opens). If not found, `TagEditor` renders read-only (`disabled` + `disabledHint`).

### Record Play / Scrobble

- **Canonical:** `usePlayback.ts` -> record_play invoke, scrobble logic in `App.tsx`
- **Flow:** `invoke("record_play", { trackId })` fired after scrobble threshold met (`shouldScrobble()`) -> plugin events `track:played` and `track:scrobbled` dispatched from App.tsx
- **`track:started`** is dispatched from `App.tsx` when a new track begins playing (separate from the scrobble threshold)
- Do not reimplement the threshold logic elsewhere

### Save / Load Playlist

- **Canonical:** `useQueue.ts` -> `savePlaylist()` / `loadPlaylist()`
- **Save flow:** Prompt for filename -> write current queue to `.m3u8` via file dialog
- **Load flow:** Open file dialog (`.m3u`, `.m3u8`, `.mixtape`) -> parse entries -> convert via `queueEntryToTrack` -> replace queue, set index to 0, play first track, set context to filename. `.mixtape` files delegate to `onOpenMixtape`.
- **Rule:** `loadPlaylist` does NOT call `stamp()` — playlist entries lack `album_id` so stamping is a no-op.

### Queue Management

- **Canonical:** `useContextMenuActions.ts` -> `handleQueueRemove()` / `handleQueueKeepOnly()` / `handleQueueMoveToTop()` / `handleQueueMoveToBottom()`
- **Flow:** Each operates on the current multi-selection indices from the queue context menu
- **Remove:** Calls `queue.removeMultiple(indices)` — recalculates `queueIndex` to keep the playing track correct
- **Keep Only:** Calls `queue.removeMultiple(invertedIndices)` — removes everything NOT in the selection
- **Move to Top/Bottom:** Calls `queue.moveToTop(indices)` / `queue.moveToBottom(indices)` — reorders without changing what's playing
- **Rule:** All mutations must preserve `queueIndex` integrity per the index recalculation rules in `queue.md`

### Home Shelves (built-in or plugin)

- **Canonical:** `useHome.ts` -> `buildBuiltInResolvers()` and the merged plugin shelves; rendered by `HomeShelf.tsx`
- **Built-in shelf flow:** declare a `ShelfResolver` with `{ id: "builtin:<slug>", title, displayKind, limit, fetch }`. The `fetch` function returns `Promise<HomeShelfResult>` (`{ status: "ok", items } | { status: "empty" } | { status: "error", message? }`). Add a matching descriptor to `allShelfDescriptors` in `HomeView.tsx` so the visibility popover knows about it.
- **Plugin shelf flow:** see `plugins.md` "Home Shelves" — declare in `contributes.homeShelves` (static) or call `api.home.registerShelf(...)` (runtime), then register a fetch handler with `api.home.onFetchShelf(id, handler)`.
- **Click handling:** Home shelves never reimplement play/enqueue. `playTracks` / detail navigation flows through the existing canonical actions (see entries above). `playlist-cards` clicks always include `{ name, coverUrl, source: "playlist" }` context so the queue banner shows up — this is wired in `App.tsx` `handleHomeShelfItemClick`, not in the shelf renderer or the plugin.
- **Image resolution:** never pass raw filesystem paths to `<img src>`. Use the `resolveImagePath` helper inside `HomeShelf.tsx` (handles http/data URIs and local paths with optional `#v=` cache-bust suffix). For album/artist fallbacks, route through `useImageCache("album"|"artist")` — same chain the queue and now-playing bar use.
- **Refresh fairness:** keep fetch handlers fast (5s budget). Slow handlers freeze the shelf in `error` state for that cycle. If a handler needs network I/O or expensive computation, populate a cached snapshot in plugin storage and serve from that.

## Behavioral Rules

Cross-cutting rules that apply to all code everywhere.

### Error Logging

- Every `catch` block and `.catch()` handler must log the error with `console.error`
- Never use `.catch(() => {})` -- at minimum use `.catch(console.error)`
- Include context in the message: `console.error("Failed to [action]:", e)`
- **Exception:** Fire-and-forget operations where failure has no user impact AND the operation is not the primary action (e.g., caching a waveform, the error logger itself). These must include a comment explaining why the catch is empty.

### User Feedback for Significant Operations

- Any operation that hits the network, writes to disk, or takes >500ms must show feedback
- Use `addLog()` for lightweight feedback (searches, saves, fetches)
- Use loading states / disabled buttons for operations where the user is waiting
- Use progress indicators for multi-step operations (downloads, syncs, imports)
- On failure, the user must know something went wrong -- either `addLog()` with error, or error modal for critical failures

### Modal Dismiss Behavior

- Modals must NOT close when clicking outside (on the overlay)
- Never add `onClick` handlers to `.ds-modal-overlay` elements
- Users must explicitly dismiss modals via Cancel/Close/Done buttons

### Skin System Compatibility

- When creating or modifying any UI element, verify it uses CSS custom properties from the skin system (defined in `App.css` and `skinUtils.ts`) rather than hardcoded colors
- Check that the element renders correctly across different skins -- new UI must not break when a skin overrides colors, fonts, or spacing
- Reference `types/skin.ts` for the available `SkinColors` properties

### Native Menus Only

- All menus — right-click context menus AND ⋯ overflow/dropdown menus — must be native OS menus, never JS/CSS popovers
- **Canonical:** build a `MenuItemSpec[]` and call `showNativeMenu(x, y, specs)` from `nativeMenu.ts`. For entity context menus, go through `buildContextMenuSpecs(target, deps)` + the `buildAndShowNativeMenu` wrapper in `App.tsx`
- A ⋯ trigger button computes its anchor with `e.currentTarget.getBoundingClientRect()` and pops the native menu at `(rect.left, rect.bottom)` — see `HeroOverflowMenu.tsx` and `SavePlaylistModal.tsx`
- Never introduce a menu via React state (`menuOpen`/`setOpen`) + a `<div>` dropdown with click-outside/Escape handlers. That pattern is banned
- `showNativeMenu` supports `item`, `check`, `separator`, and `submenu` specs — use `submenu` instead of a CSS hover fly-out
- When you touch any surface that still shows a JS/CSS menu, convert it as part of the change

### Plugin-First for New Functionality

- Before implementing new functionality directly in the app, check whether it could be accomplished as a plugin using the information type plugin system
- If the new feature fetches external data, displays metadata, or adds a new information section, it should be a plugin
- Plugins live in `src-tauri/plugins/` -- check existing plugins for the pattern

### Detail Page Consistency

- All detail pages (Artist, Album, Track, Tag) must follow a consistent layout and look/feel
- Shared structure: header area with image + title + actions in the top
- Artist Details. Show the Albums under the header then the track list and finally then other content sections
- Album/Tag Details. Show the track list under the header and then the information sections
- Track Details. Show the informations sections under the header
- Use the same spacing, typography scale (`--fs-*` custom properties), and section patterns
- New detail views or sections should visually match existing ones -- check the current detail views before designing new layouts

### Information Sections for Detail Page Content

- When you need to display entity information or provide user actions in detail pages, use the information sections system (the plugin-based `InformationSections` component)
- Two placement options:
  - **Header placement:** For concise, always-visible data and quick actions (e.g., title, scrobble count, YouTube button)
  - **Below placement:** For richer, expandable content (e.g., lyrics, reviews, artist bio)
- New information should be added as an information type via a plugin, not hardcoded into the detail view -- this is how the app surfaces entity data consistently across Artist, Album, Track, and Tag detail pages

### Universal Track Actions

- A "track" is a universal concept -- it can appear in the library list, queue/playlist, plugin views (e.g., streaming service search, playlist browsing), information sections (e.g., similar tracks, top tracks), or search results
- Every surface that displays track items must support right-click context menus with plugin-registered actions
- Each surface defines its own base actions (e.g., queue has remove/reorder, library has delete/folder), but plugin actions appear everywhere
- Plugins register context menu items via `contributes.contextMenuItems` in their manifest with target kinds (`track`, `album`, `artist`, `multi-track`)
- The context menu system resolves the appropriate `PluginContextMenuTarget` from whatever track data is available (library ID, title, artist name)
- For tracks without a library ID (e.g., external search results), the target still carries title/artist so plugins can act on metadata alone
- **Implementation:** Use the shared `ContextMenu` component from `ContextMenu.tsx`. Pass `pluginMenuItems` and `onPluginAction` to every context menu instance. New track surfaces must wire up `onContextMenu` handlers.

### Track Matching by Metadata

- When checking if a track already exists in the library, **always use the backend** `invoke("find_track_by_metadata", { title, artistName, albumName })` command
- Never do JS-side title/artist string comparison for library lookups — the backend uses `strip_diacritics(unicode_lower())` in SQL which correctly handles accented characters (Björk↔Bjork, Jóga↔Joga), Greek, Cyrillic, and other Unicode
- The backend searches across all collection types (local, subsonic, and plugin-registered kinds) and prefers local copies
- Use this for: duplicate detection before downloads, library existence checks, track matching in modals

### Default Startup View

- App startup always lands on the Home view. The previously-selected view is **not** persisted — `view` is neither read nor written from the app store. Selected entities (artist/album/tag) are also not restored at startup.
- New code that adds startup-time persistence must not write to `"view"` or any of `"selectedArtist"` / `"selectedAlbum"` / `"selectedTag"` for the purpose of restoring last position. If a feature needs "remember where I was" semantics, add it as opt-in (a setting), not a default.
- During a session, opening an entity from anywhere navigates to its detail page as before — only startup is forced to Home.

### Fix As You Go

- When modifying a file, fix nearby convention violations as part of the same change
- "Nearby" means: in the same function, or in functions directly related to what you're changing
- Don't refactor unrelated parts of the file
