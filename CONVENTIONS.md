# Conventions

This file documents the canonical way repeated user actions are implemented and cross-cutting behavioral rules. All new code must follow these conventions. When touching existing code that violates them, fix the violations as part of the current work.

## Canonical Actions

Each entry below documents the gold standard implementation for a repeated user action. New code that implements the same action must replicate this flow exactly.

### Delete Tracks

- **Canonical:** `useContextMenuActions.ts` → `handleDeleteRequest()` / `handleDeleteConfirm()`
- **Flow:** Show confirmation modal with track title/count → `invoke("delete_tracks", { trackIds })` → filter from `library.tracks` → stop playback if deleted track is playing → `addLog()` with result → show error modal if partial/total failure
- **Availability:** Local tracks only (excludes subsonic:// and tidal:// sources)

### Find in YouTube

- **Canonical:** `useContextMenuActions.ts` → `watchOnYoutube(trackId, title, artistName, youtubeUrl)`
- **Flow:** If `youtubeUrl` exists, open it directly + `addLog()` → otherwise `addLog("Searching YouTube...")` → `invoke("search_youtube", ...)` → on success, open URL + `addLog()` + show feedback modal asking to save → if user confirms, `invoke("set_track_youtube_url")` + update track in `library.tracks` + `addLog()` → on search failure, fall back to manual YouTube search URL + `addLog()`
- **Rule:** All entry points must call `watchOnYoutube` — do not reimplement the search/open/save logic. The save feedback modal lives in App.tsx and is shared across all callers.
- **Label:** Always "Find in YouTube" (not "Watch on YouTube").

### Like/Unlike Track

- **Canonical:** `useLikeActions.ts` → `handleToggleLike()` / `handleToggleDislike()`
- **Like flow:** `invoke("toggle_liked", { kind: "track", id, liked: 1|0 })` → update `library.tracks` + `playback.currentTrack` (if relevant) + `queue` → dispatch plugin event `track:liked` → catch must `console.error`
- **Dislike flow:** `invoke("toggle_liked", { kind: "track", id, liked: -1|0 })` → update `library.tracks` + `playback.currentTrack` (if relevant) + `queue` → catch must `console.error` (note: dislike does NOT dispatch a plugin event)

### Like/Unlike Artist, Album, Tag

- **Canonical:** `useLikeActions.ts` → `handleToggleArtistLike()` / `handleToggleAlbumLike()` / `handleToggleTagLike()` (and hate variants)
- **Flow:** `invoke("toggle_liked", { kind, id, liked })` → update the relevant entity list in library state → catch must `console.error`
- These do NOT dispatch plugin events or update queue/currentTrack

### Play / Enqueue / Play Next

- **Canonical:** `useQueue.ts` → `playTracks()` / `enqueueTracks()` / `playNextInQueue()`
- Enqueue checks for duplicates via `findDuplicates()` with user confirmation modal

### Open Containing Folder

- **Canonical:** `useContextMenuActions.ts` → `handleShowInFolder()`
- **Flow:** `invoke("show_in_folder", { trackId })` for library tracks, `invoke("show_in_folder_path", { filePath })` for paths
- **Availability:** Non-subsonic, non-tidal tracks only

### Download Track

- **Canonical:** `useDownloads.ts` → `downloadTrack()`
- **Flow:** `invoke("download_track", ...)` → progress via `download-progress` events → success via `download-complete` → error via `download-error` → `addLog()` on both outcomes

### Tag Operations

- **Canonical:** `TrackDetailView.tsx` → `handleApplyTag()` / `handleRemoveTag()` / `handleSaveTags()`
- **Apply single tag:** `invoke("plugin_apply_tags", { trackId, tagNames })` → update local tag state → `addLog()`
- **Remove/replace tags:** `invoke("replace_track_tags", { trackId, tagNames })` → update local tag state → `addLog()`
- **Bulk edit:** `invoke("bulk_update_tracks", { trackIds, fields })` → `addLog()` on completion
- Other entry points (InformationSections, BulkEditModal) should route through the same patterns

### Record Play / Scrobble

- **Canonical:** `usePlayback.ts` → record_play invoke, scrobble logic in `App.tsx`
- **Flow:** `invoke("record_play", { trackId })` fired after scrobble threshold met (`shouldScrobble()`) → plugin events `track:played` and `track:scrobbled` dispatched from App.tsx
- Do not reimplement the threshold logic elsewhere

## Behavioral Rules

Cross-cutting rules that apply to all code everywhere.

### Error Logging

- Every `catch` block and `.catch()` handler must log the error with `console.error`
- Never use `.catch(() => {})` — at minimum use `.catch(console.error)`
- Include context in the message: `console.error("Failed to [action]:", e)`
- **Exception:** Fire-and-forget operations where failure has no user impact AND the operation is not the primary action (e.g., caching a waveform, the error logger itself). These must include a comment explaining why the catch is empty.

### User Feedback for Significant Operations

- Any operation that hits the network, writes to disk, or takes >500ms must show feedback
- Use `addLog()` for lightweight feedback (searches, saves, fetches)
- Use loading states / disabled buttons for operations where the user is waiting
- Use progress indicators for multi-step operations (downloads, syncs, imports)
- On failure, the user must know something went wrong — either `addLog()` with error, or error modal for critical failures

### Skin System Compatibility

- When creating or modifying any UI element, verify it uses CSS custom properties from the skin system (defined in `App.css` and `skinUtils.ts`) rather than hardcoded colors
- Check that the element renders correctly across different skins — new UI must not break when a skin overrides colors, fonts, or spacing
- Reference `types/skin.ts` for the available `SkinColors` properties

### Plugin-First for New Functionality

- Before implementing new functionality directly in the app, check whether it could be accomplished as a plugin using the information type plugin system
- If the new feature fetches external data, displays metadata, or adds a new information section, it should be a plugin
- Plugins live in `src-tauri/plugins/` — check existing plugins for the pattern

### Detail Page Consistency

- All detail pages (Artist, Album, Track, Tag) must follow a consistent layout and look/feel
- Shared structure: header area with image + title + actions in the top
- Artist Details. Show the Albums under the header then the track list and finally then other content sections
- Album/Tag Details. Show the track list under the header and then the information sections
- Track Details. Show the informations sections under the header
- Use the same spacing, typography scale (`--fs-*` custom properties), and section patterns
- New detail views or sections should visually match existing ones — check the current detail views before designing new layouts

### Information Sections for Detail Page Content

- When you need to display entity information or provide user actions in detail pages, use the information sections system (the plugin-based `InformationSections` component)
- Two placement options:
  - **Header placement:** For concise, always-visible data and quick actions (e.g., title, scrobble count, YouTube button)
  - **Below placement:** For richer, expandable content (e.g., lyrics, reviews, artist bio)
- New information should be added as an information type via a plugin, not hardcoded into the detail view — this is how the app surfaces entity data consistently across Artist, Album, Track, and Tag detail pages

### Universal Track Actions

- A "track" is a universal concept — it can appear in the library list, queue/playlist, plugin views (e.g., TIDAL search, Spotify playlists), information sections (e.g., similar tracks, top tracks), or search results
- Every surface that displays track items must support right-click context menus with plugin-registered actions
- Each surface defines its own base actions (e.g., queue has remove/reorder, library has delete/folder), but plugin actions appear everywhere
- Plugins register context menu items via `contributes.contextMenuItems` in their manifest with target kinds (`track`, `album`, `artist`, `multi-track`)
- The context menu system resolves the appropriate `PluginContextMenuTarget` from whatever track data is available (library ID, title, artist name)
- For tracks without a library ID (e.g., external search results), the target still carries title/artist so plugins can act on metadata alone
- **Implementation:** Use the shared `ContextMenu` component from `ContextMenu.tsx`. Pass `pluginMenuItems` and `onPluginAction` to every context menu instance. New track surfaces must wire up `onContextMenu` handlers.

### Fix As You Go

- When modifying a file, fix nearby convention violations as part of the same change
- "Nearby" means: in the same function, or in functions directly related to what you're changing
- Don't refactor unrelated parts of the file
