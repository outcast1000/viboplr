# Conventions

This file documents the canonical way repeated user actions are implemented and cross-cutting behavioral rules. All new code must follow these conventions. When touching existing code that violates them, fix the violations as part of the current work.

## Canonical Actions

Each entry below documents the gold standard implementation for a repeated user action. New code that implements the same action must replicate this flow exactly.

### Delete Tracks

- **Canonical:** `useContextMenuActions.ts` → `handleDeleteRequest()` / `handleDeleteConfirm()`
- **Flow:** Show confirmation modal with track title/count → `invoke("delete_tracks", { trackIds })` → filter from `library.tracks` → stop playback if deleted track is playing → `addLog()` with result → show error modal if partial/total failure
- **Availability:** Local tracks only (excludes subsonic:// and tidal:// sources)

### Find in YouTube

- **Canonical:** `useContextMenuActions.ts` → context menu flow
- **Flow:** If `track.youtube_url` exists, open it directly → otherwise `invoke("search_youtube", ...)` → on success, open URL + show feedback modal asking to save → if user confirms, `invoke("set_track_youtube_url")` + update track in `library.tracks` + `addLog()` → on search failure, fall back to manual YouTube search URL + `addLog()`
- **Rule:** Every entry point (TrackDetailView buttons, InformationSections, etc.) must use this same full flow with save/feedback.
- **Known violations:** TrackDetailView and InformationSections currently have incomplete implementations (no save/feedback modal, empty catch blocks, no `addLog()`). Fix when those files are touched.

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
- Shared structure: header area with image + title + actions, then content sections below
- Use the same spacing, typography scale (`--fs-*` custom properties), and section patterns
- New detail views or sections should visually match existing ones — check the current detail views before designing new layouts

### Fix As You Go

- When modifying a file, fix nearby convention violations as part of the same change
- "Nearby" means: in the same function, or in functions directly related to what you're changing
- Don't refactor unrelated parts of the file
