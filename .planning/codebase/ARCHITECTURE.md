<!-- refreshed: 2026-08-14 -->
# Architecture

**Analysis Date:** 2026-08-14

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                        Frontend (React/TypeScript)                      │
│  App.tsx (root) → Views (Home, Search, Artists, Albums, etc.)          │
│  Components: Sidebar, NowPlayingBar, QueuePanel, SettingsPanel         │
└────────────┬────────────────────────────────────────────────────────────┘
             │ Tauri IPC (invoke/listen)
             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Command Layer (Tauri Handler)                        │
│  lib.rs: Command router, AppState initialization, plugin registration  │
│  commands/: 70+ #[tauri::command] handlers (split by domain)            │
└────────────┬────────────────────────────────────────────────────────────┘
             │
             ├──────────────────┬──────────────────┬──────────────────┐
             ▼                  ▼                  ▼                  ▼
┌──────────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────┐
│  Database Layer      │ │ Scanner & Sync   │ │ Download Manager │ │ Plugins
│  db/: SQLite ops    │ │ scanner.rs       │ │ downloader.rs    │ │ services
│  models.rs          │ │ sync.rs          │ │ queue + threads  │ │
└──────────────────────┘ └──────────────────┘ └──────────────────┘ └──────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                       External Services & Storage                        │
│  File system, Subsonic API, Last.fm, Image providers, libmpv engine     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **App.tsx** | Root React component, state orchestration, event subscriptions, view routing | `src/App.tsx` |
| **Sidebar** | Navigation, view switching, collection/extension badges | `src/components/Sidebar.tsx` |
| **NowPlayingBar** | Playback controls, seek bar, track info, mini/full mode | `src/components/NowPlayingBar.tsx` |
| **QueuePanel** | Queue management, drag-to-reorder, multi-select, duplicates | `src/components/QueuePanel.tsx` |
| **SearchView** | Unified library (tracks/artists/albums/tags), text search | `src/components/SearchView.tsx` |
| **HomeView** | Landing surface, radio carousel, horizontal shelves, plugins | `src/components/HomeView.tsx` |
| **TrackDetailView** | Track hero, quality/stats, sections (similar, lyrics, community tags) | `src/components/TrackDetailView.tsx` |
| **ArtistDetail** | Circular avatar, albums, top songs, similar artists | `src/components/ArtistDetail.tsx` |
| **AlbumDetail** | Cover art, track list, metadata, sections | `src/components/AlbumDetail.tsx` |
| **SettingsPanel** | User preferences, playback config, skins, extensions, dependencies | `src/components/SettingsPanel.tsx` |
| **Tauri Commands** | IPC handlers, business logic, DB access, external service calls | `src-tauri/src/commands/` |
| **Database** | Schema, queries, transaction handling, liking state | `src-tauri/src/db/` |
| **Scanner** | File walk, tag reading, fallback filename parsing | `src-tauri/src/scanner.rs` |
| **mpv Engine** | Native audio/video playback, dual decks, gapless, DSP | `src-tauri/src/mpv_engine/` |

## Pattern Overview

**Overall:** Tauri-mediated separation with frontend-driven UX and backend persistence.

**Key Characteristics:**
- **Two track types:** `Track` (library, full IDs) vs `QueueTrack` (metadata-only, no DB IDs)
- **Queue/playback independence:** Queue surfaces never lookup DB IDs; all operations work via metadata keys
- **Plugin system:** Register providers (image, lyrics, info), search, context menu, visualizers, information sections
- **Collections abstraction:** Unified treat of local folders, Subsonic servers, manifest URLs, plugin catalogs
- **Durable, ID-less likes:** `entity_likes` table keyed by metadata (artist+title for tracks), survives across sync/restore
- **Background tasks:** Scanning, syncing, downloading, last.fm import, image fetching use thread::spawn + AtomicBool + event emit
- **Command handler per domain:** Each `commands/*.rs` file covers a subsystem (library, downloads, images, history, etc.)

## Layers

**Frontend (React/TypeScript):**
- Purpose: User interface, state management, real-time playback control, event subscriptions
- Location: `src/`
- Contains: Components, hooks, utility functions, CSS
- Depends on: Tauri IPC invoke/listen, browser APIs
- Used by: User interactions, system events (deep links, global shortcuts)

**Tauri IPC / Command Layer:**
- Purpose: Dispatch frontend invocations to backend, serialize responses
- Location: `src-tauri/src/lib.rs` (routing macro), `src-tauri/src/commands/mod.rs` (re-exports)
- Contains: Tauri command handler registration, AppState construction
- Depends on: All backend modules
- Used by: Frontend invoke, backend services

**Database Layer:**
- Purpose: Persistent storage, query execution, schema management
- Location: `src-tauri/src/db/`
- Contains: SQLite wrapper (`Database` struct), per-entity query modules
- Depends on: rusqlite, migrations
- Used by: Commands, scanner, downloader, history

**Service Layers:**
- **Scanner** (`scanner.rs`): Walk file trees, read tags, insert/upsert tracks
- **Sync** (`sync.rs`, `manifest_sync.rs`): Subsonic/manifest collection synchronization
- **Downloader** (`downloader.rs`): Queue-based track download with format conversion and tag writing
- **Image Provider** (`image_provider/`): Trait-based artist/album image resolution with fallback chains
- **Plugins** (`plugins.rs`): Directory scanning, manifest loading, storage, gallery install
- **Scanner** (`scanner.rs`): File walk, tag reading, filename parsing fallback
- **Dependencies** (`dependencies.rs`): External binary (ffmpeg, yt-dlp) probing, installation, updates
- **mpv Engine** (`mpv_engine/`): Native playback via libmpv (audio/video, gapless, DSP)

**External Integrations:**
- Subsonic/Navidrome API (`subsonic.rs`)
- Last.fm API (`lastfm.rs`)
- Image providers (artist/album via trait chain)
- Lyric providers (LRC/plain text)
- Plugin bridges (stream resolution, image providers, info types, visualizers, download providers)

## Data Flow

### Primary Request Path: Playing a Track

1. **User clicks track** in queue/library (`TrackList.tsx` row click) → fires `play()` via context menu or double-click handler
2. **Frontend calls** `usePlayActions.playTracks([track], 0, context)` → `useQueue.playTracks()` → `invoke("get_track_path", { trackId })`
3. **Backend command** `get_track_path` (in `commands/library.rs`) queries `db::tracks::resolve_path()` → returns URL-schemed path (`file://`, `subsonic://`, plugin URI, etc.)
4. **Frontend resolves stream** via `useStreamResolution` (plugin hook system or built-in for subsonic) → `invoke("yt_dlp_stream_audio")` / `api.stream.resolve()` if a plugin handler exists
5. **Audio element mounts** with the resolved URL → browser or native engine plays
6. **Position/playback events** fire from audio element or mpv engine → position updates via position store, gapless decisions via `progressMachine`
7. **Track scrobble** recorded when 50% or 4 min played (whichever first) → `invoke("record_play", { trackId })` → updates `history_tracks`, dispatches plugin event `track:played`

### Startup Path

1. **Tauri app starts** → `lib.rs` main setup: database init, plugin scanning, dependency probes, telemetry opt-in check
2. **Frontend mounts** → `App.tsx` restore effect reads persisted settings from `store.json`
3. **Queue restore** → `invoke("main_playlist_read")` loads prior queue from manifest file → applied to state
4. **Like reconciliation** → `invoke("get_track_like_states")` batch-reads like states from `entity_likes` table → patches queue/current-track with durable likes
5. **Engine probe** → `invoke("engine_capabilities")` checks if libmpv loads → cached, gates playback engine choice
6. **Home shelves resolve** → `useHome` fetches built-in shelf data (recently played, most played, etc.) + triggers plugin shelf handlers
7. **App ready** → render complete, first play/interaction is live

### Download Flow

1. **User clicks Download on track** → `useDownloadOrchestration.openDownloadForCurrentTrack()`
2. **Provider decision** → `decideDownload(effectiveSource, track, providers)` maps source to provider (built-in Subsonic, plugin, or none)
3. **DownloadModal mounts** → calls `invoke("download_preview")` (checks for in-place upgrade vs fresh download)
4. **User confirms format/destination** → `invoke("enqueue_download", buildDownloadRequest(...))` queues the job
5. **Backend resolve thread** → walks provider chain (`resolveTrackDownload` → `resolveByUri` / `resolveByMetadata`), emits `download-resolve-request` bridge event
6. **Frontend handler** → `useDownloadOrchestration` listens for `download-resolve-request`, calls plugin `onResolveDownload` if registered, posts result via `invoke("download_resolve_response")`
7. **Download executes** → format conversion (ffmpeg), tag writing, cache eviction, `download-progress` / `download-complete` / `download-error` events
8. **UI feedback** → modal shows progress bar + elapsed time, auto-closes on success, shows error modal on failure

## Key Abstractions

**Track Type Hierarchy:**
- **`Track`** (Rust: `models.rs`, TS: `types.ts`) — Full library entity with DB IDs (`id`, `album_id`, `artist_id`). Used by library views (SearchView, ArtistDetail).
- **`QueueTrack`** (Rust: embedded in commands/responses, TS: `types.ts`) — Metadata-only (title, artist, album, path, duration, genre). No DB IDs. Used by queue, now-playing, playlists. All playback/queue operations work on this type so they survive re-scan without ID breakage.
- **`ResolvedTrackSource`** (TS: `types.ts`) — Result of resolving a QueueTrack to a playable URL + effective source (for download provider selection).

**Collections:**
- **`Collection`** — Discriminated union by `kind`: `"local"` (folder), `"subsonic"` (server), `"manifest"` (HTTP JSON), `"seed"` (debug). Schema: `collections` table with `kind` discriminator, `name`, `path_or_url`, `enabled`, `auto_update`.
- **Track paths encode source:** `file://`, `subsonic://{collection_id}/{id}`, `{plugin_scheme}://{id}`, etc. Tracks belong to a collection via `collection_id` FK.

**Like State (ID-less):**
- **`entity_likes` table** — Durable source of truth: `(kind, entity_key, liked, metadata)` with PK on `(kind, entity_key)`.
- **Entity keys** — Metadata-based, diacritic-normalized: `track:{artist}:{title}`, `album:{artist}:{title}`, `artist:{name}`, `tag:{name}`. Built by `db::likes::build_entity_key()`.
- **Propagation** — Likes sync to all same-song copies via `sameSong(a, b)` predicate (key match, fallback to title+artist).

**Queue State:**
- **`QueueTrack[]`** — Ordered list of entries, zero-indexed.
- **`queueIndex`** — Current play position (set on play, incremented at gapless, clamped on deletion).
- **`queueMode`** — `"normal"` (stop at end) | `"loop"` (restart) | `"loop-one"` (current track) | `"shuffle"` (random next).
- **Persistence** — Serialized to `{app_data_dir}/profiles/{name}/main_playlist/` by `main_playlist_*` commands.

**Playback Session:**
- **Play generation** — Incremented on every `playTracks()` (user starts new session). Guards against stale `appendToPlaySession()` calls during gapless.
- **Engine session** — Marked by `nativeSessionRef.current` when routed through mpv. Unified under both audio elements and engine.
- **Track key** — Opaque token from the session (`currentTrack.key`) propagated through platform events to guard against replayed/stale track data.

## Entry Points

**Frontend Initialization:**
- Location: `src/main.tsx` (entry, mounts App to #root)
- Triggers: App startup
- Responsibilities: React DOM bootstrap

**Root Component:**
- Location: `src/App.tsx` (1800+ lines)
- Triggers: Mounted after main.tsx
- Responsibilities: Restore settings, initialize all hooks, wire event listeners, render view tree, own modal states, context menu dispatch

**Backend Initialization:**
- Location: `src-tauri/src/lib.rs::main()`
- Triggers: Tauri app startup
- Responsibilities: Database init, plugin discovery, image provider chain construction, dependency probes, telemetry opt-in read, AppState construction

**Command Handlers:**
- Location: `src-tauri/src/commands/*.rs` (70+ handlers)
- Triggers: Frontend `invoke(command, args)`
- Responsibilities: Validate input, call business logic, serialize response or error

## Architectural Constraints

- **Threading:** Main thread runs the webview; background tasks (scanning, syncing, downloading, image fetching, lyrics) spawn OS threads with AtomicBool cancellation + event emit. Tauri's async runtime is used for async commands (extension operations, network I/O).
- **Global state:** `AppState` (Arc'd, Mutex'd) holds the database, plugin registry, download manager. Per-session state (queue, playback) lives in frontend React hooks.
- **Circular imports:** None by design — backend is modules from lib.rs; frontend builds a tree from App.tsx.
- **IPC data shape:** All command args/returns must be `serde` JSON-serializable. Complex types are flattened (e.g., `struct DownloadRequest { url, format, destination, ... }` not nested objects).
- **Plugin runtime:** Single `new Function("api", code)` per plugin, reloaded on enable/disable. No sandboxing — plugins run with full access to the host API.
- **Database transactions:** Background tasks upsert in batches; no concurrent writes at the library level (scanning/syncing use transactions). Reads are unblocked.

## Anti-Patterns

### Bypassing the Canonical Like Path

**What happens:** Direct `invoke("set_entity_like_state")` outside of `useLikeActions.ts`, with no propagation to `currentTrack` / queue / siblings.

**Why it's wrong:** The track in now-playing or queue reflects the old like state, and other copies of the song stay out of sync. Fixes made in one surface don't reach others.

**Do this instead:** Route through `useLikeActions.ts` (`handleToggleLike()`, `handleToggleArtistLike()`, etc.), which invoke the command AND patch the in-memory track references via `sameSong()`.

### Using DB IDs in Queue/Playback

**What happens:** Storing or looking up `track.id` when working with queue entries or now-playing data. Example: `queue.map(t => t.id)` passed to a backend query, then breaking when the library is rescanned and IDs change.

**Why it's wrong:** Queue/playback data must be independent of database IDs so a rescan doesn't orphan the active session. The queue is loaded from a persisted manifest that has no database.

**Do this instead:** Use `QueueTrack` (metadata-only, path-based) everywhere. Path is the durable key. When you need library data, resolve the track *from* the queue entry via `invoke("find_track_by_metadata")` at the moment it's needed (e.g., bulk edit, tag operations).

### Reimplementing the Scrobble Threshold

**What happens:** A handler that invokes `record_play` or `plugin_record_history_plays_batch` at an arbitrary point, without checking 50% or 4 minutes.

**Why it's wrong:** Scrobbles are double-counted, false positives, or never fire. The threshold has one place to live for auditability.

**Do this instead:** The threshold is already enforced in `usePlayback.ts` → `shouldScrobble()` (pure, unit-tested) driven by `progressMachine`. Do not re-derive it anywhere else.

### Non-Async Commands Blocking the Webview

**What happens:** A `#[tauri::command]` that does network I/O without `pub async fn` and `spawn_blocking`. Examples: fetching plugin manifests, downloading gallery entries.

**Why it's wrong:** The command blocks the main thread, freezing the webview for tens of seconds. The UI appears dead.

**Do this instead:** Mark the function `pub async fn` and wrap I/O in `tauri::async_runtime::spawn_blocking`. See `commands/extensions.rs` and `commands/skins_cmd.rs` for the pattern. Set explicit timeouts on all network operations (no infinite hangs).

### Losing Image Cache Keys on Every Resize

**What happens:** `useImageCache` lookups via a key that includes window geometry or some transient value that changes on every render.

**Why it's wrong:** The cache is invalidated on every keystroke / scroll / window event. Every image fetch becomes uncached.

**Do this instead:** Image cache keys must be stable (e.g., `album:{name}:{artist}` normalized). Use the `isResolved(name, artist?)` helper to distinguish "image loaded and is null" from "image is in flight" — only the former reads the image as truly absent and allows rendering fallback text.

## Error Handling

**Strategy:** Result-based (try/catch is rare). Backend commands return `Result<T, String>`. Frontend catches and calls `notify()` for lightweight feedback or a modal for critical failures.

**Patterns:**
- **Every `catch` block logs via `console.error`** with context. Exception: fire-and-forget operations (e.g., telemetry, async refresh) with a comment explaining why.
- **Uncaught window errors** are captured in `errorLog` (50-entry ring buffer in memory) for the "Report a problem" diagnostic bundle.
- **Error classification** via `classifyErrorKind(error)` buckets errors into a closed enum (network, timeout, not_found, permission, auth, rate_limit, etc.) for telemetry *without* sending the message.
- **Update errors** from app/extension checks are persistent (held in state, not auto-dismissed toasts) so the user can retry — a 4.5s auto-dismiss toast hides failures users need to see.
- **Backend command errors are stringified via `error_chain`** (not `to_string()`) to preserve the cause chain — reqwest's `Display` drops causes, and a `connection refused` error would otherwise read only as `error sending request for url (…)`.

## Cross-Cutting Concerns

**Logging:**
- Frontend: `console.error` (always), toasts (user-facing), error ring buffer (diagnostic).
- Backend: env_logger (per `RUST_LOG`), optional file (Settings toggle, truncated on launch). `collect_diagnostics` reads the last 200 lines for "Report a problem".

**Validation:**
- Frontend: TypeScript types, runtime shape checks for IPC data.
- Backend: `Result<T, String>` from every command. Path traversal guards on plugin file I/O (`plugin_files_*`).

**Authentication:**
- Subsonic: Token (preferred) or plaintext auth, stored in collection config (unencrypted, in profile folder — see CLAUDE.md).
- Last.fm: OAuth token from plugin storage.
- Gallery: Unauthenticated fetch (GitHub releases API, 60/hr limit per IP).

---

*Architecture analysis: 2026-08-14*
