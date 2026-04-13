# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
# Install frontend dependencies
npm install

# Run in development (starts both Vite dev server + Tauri app)
npm run tauri dev

# Build for production
npm run tauri build

# Check Rust compilation only (faster iteration)
cd src-tauri && cargo check

# Check release build (verifies cfg(debug_assertions) gating)
cd src-tauri && cargo check --release

# Type-check frontend only
npx tsc --noEmit

# Run all tests
npm run test:all

# Run TypeScript tests only
npm test

# Run Rust tests only
npm run test:rust
```

## Architecture

Viboplr is a Tauri 2 desktop app: a Rust backend serves a React/TypeScript frontend rendered in a native webview.

### Conventions

This project has a `CONVENTIONS.md` file at the root that documents canonical implementations of repeated user actions and behavioral rules. Invoke the `/consistency` skill before writing any code to ensure all changes follow these conventions.

### Backend (src-tauri/src/)

- **lib.rs** — Tauri app setup, plugin registration, command handler registration. Debug-only commands are conditionally included via `#[cfg(debug_assertions)]` using separate `get_invoke_handler()` functions. Initializes `AppState` with all shared resources.
- **commands.rs** — All `#[tauri::command]` functions (~107 commands). Each takes `State<'_, AppState>` and delegates to `db.rs` or other modules. Commands return `Result<T, String>`. `AppState` holds: `Arc<Database>`, `app_dir`, `download_queue`, `track_download_manager`, `LastfmClient`, `lastfm_session`, `lastfm_importing`.
- **db.rs** — SQLite wrapper behind `Mutex<Connection>` (~67 public functions). Owns schema creation, CRUD for all entities, FTS5 search index, history recording, Last.fm API response cache. Registers custom SQL functions: `filename_from_path()`, `strip_diacritics()`, `unicode_lower()`.
- **scanner.rs** — Walks folder trees with `walkdir`, reads tags with `lofty`, falls back to regex-based filename parsing. Reads genre metadata from files and stores them as tags. Called from a background thread in `add_folder`.
- **watcher.rs** — Uses `notify` crate for real-time filesystem events, calling scanner functions for create/modify/remove.
- **models.rs** — Serde-serializable structs shared between commands and DB layer: Artist, Album, Tag, Track, Collection, HistoryEntry, HistoryMostPlayed, HistoryArtistStats, ScanProgress, SyncProgress, Tidal search/detail types, Last.fm API response types, LastfmImportProgress.
- **lastfm.rs** — Last.fm API client. Methods: `get_auth_url()`, `sign_params()` (MD5), `get_session()`, `update_now_playing()`, `scrobble()`, `get_recent_tracks()`, `love_track()`, `unlove_track()`, `get_similar_artists()`, `get_similar_tracks()`, `get_artist_info()`, `get_album_info()`, `get_track_top_tags()`, `get_artist_top_tags()`. Token-based auth with API signature hashing. Read-only methods use unsigned GET, write methods use signed POST.
- **subsonic.rs** — Subsonic/Navidrome API client. Auth methods: token (MD5) or legacy digest. Methods: `get_album_list()`, `get_album()`, `get_track_by_id()`, `get_cover_art()`.
- **tidal.rs** — TIDAL API client with instance failover and 24-hour TTL caching. Methods: search (tracks/artists/albums), `get_stream_url()`, `get_album()`, `get_artist()`, `get_artist_albums()`. Fetches instance URLs from Uptime Workers.
- **sync.rs** — Subsonic collection synchronization. Paginates albums, fetches full album data, creates/updates artists/albums/tracks, stores genres as tags.
- **downloader.rs** — Track download manager with queue/threading. `DownloadFormat` enum (Flac, Aac, Mp3). Supports Tidal and Subsonic sources. Writes ID3/Vorbis tags, embeds cover art. Status tracking with progress events.
- **entity_image.rs** — Image slug management. Filesystem-safe canonical slug generation with diacritic stripping.
- **composite_image.rs** — Generates tag composite images from overlapping circles of 1–3 artist images.
- **image_provider/** — Trait-based image provider chain. Artist chain: Tidal → Deezer → iTunes → AudioDB → MusicBrainz. Album chain: Embedded → Tidal → iTunes → Deezer → MusicBrainz.
- **skins.rs** — Skin file I/O: list, read, save, delete, import from path, fetch from URL. Gallery fetching from GitHub. Slug generation for skin filenames.
- **timing.rs** — Startup performance profiling (`StartupTimer`, `TimingEntry`).
- **seed.rs** — Debug-only module (`#[cfg(debug_assertions)]`). Seeds the database with fake data using a simple LCG PRNG.

### Frontend (src/)

- **App.tsx** — Single-file React app. Contains all state, views, playback controls, context menu, and sidebar. No routing library; views are toggled via a `View` union type: `"all" | "artists" | "albums" | "tags" | "liked" | "history" | "tidal" | "collections"`.
- **App.css** — All styles. Layout: sidebar + main content + fixed footer (now-playing bar). Uses CSS custom properties for all colors (skinnable) and a 7-level type scale (`--fs-2xs` through `--fs-2xl`).
- **skinUtils.ts** — Skin validation, CSS generation, customCSS sanitization.
- **types/skin.ts** — TypeScript type definitions for the skin system (SkinJson, SkinInfo, SkinColors, GallerySkinEntry).
- **skins/** — Built-in skin JSON files (8 skins) and index.

### Frontend Components (src/components/)

- **TrackList.tsx** — Table/list/tile view for tracks with column sorting and selection.
- **NowPlayingBar.tsx** — Footer playback controls, track info, seek bar.
- **QueuePanel.tsx** — Playback queue with drag-and-drop reordering.
- **Sidebar.tsx** — Navigation sidebar with view switching.
- **SettingsPanel.tsx** — Settings with tabs: General, Skins, TIDAL, Last.fm, Providers, About, Debug.
- **HistoryView.tsx** — History view with most played (all time / 30 days), top artists, recent plays. Exposes `reload()` via imperative handle.
- **TidalView.tsx** — TIDAL search/browse interface.
- **CollectionsView.tsx** — Collection management (local folders, Subsonic, TIDAL).
- **Breadcrumb.tsx** — Navigation breadcrumb with play/queue all actions and children slot.
- **ViewSearchBar.tsx** — Per-view search input.
- **CentralSearchDropdown.tsx** — Global search dropdown in caption bar.
- **ContextMenu.tsx** — Right-click context menu for tracks.
- **ViewModeToggle.tsx** — Table/list/tiles view mode toggle.
- **WaveformSeekBar.tsx** — Waveform visualization seek bar.
- **AlbumCardArt.tsx, ArtistCardArt.tsx, TagCardArt.tsx** — Entity card images.
- **AddServerModal.tsx, AddTidalModal.tsx, EditCollectionModal.tsx** — Collection modals.
- **TrackPropertiesModal.tsx** — Tabbed track properties modal (Info, Tags, Similar, Artist, Album) with Last.fm metadata, similar tracks with play/TIDAL/YouTube actions, and community tag suggestions.
- **UpgradeTrackModal.tsx** — TIDAL track upgrade modal.
- **FullscreenControls.tsx** — Video fullscreen overlay controls.
- **StatusBar.tsx, Icons.tsx, WindowControls.tsx** — Utility components.

### Frontend Hooks (src/hooks/)

- **usePlayback.ts** — Playback state (audio/video element, current track, play/pause/seek).
- **useQueue.ts** — Queue management (add, remove, reorder, play next).
- **useLibrary.ts** — Library data queries, column configuration, view modes.
- **useEventListeners.ts** — Tauri backend event subscriptions.
- **useImageCache.ts** — Entity image caching and on-demand fetching.
- **useAutoContinue.ts** — Auto-continue playback when queue ends.
- **useMiniMode.ts** — Mini player mode (MINI_HEIGHT = 52, auto-resize).
- **useVideoSplit.ts** — Video playback splitting.
- **useWaveform.ts** — Waveform data caching.
- **useGlobalShortcuts.ts** — Global keyboard shortcuts.
- **useViewSearchState.ts** — Per-view search state management.
- **useCentralSearch.ts** — Central search functionality.
- **useNavigationHistory.ts** — Navigation state history.
- **useSessionLog.ts** — Session logging.
- **useAppUpdater.ts** — App update checking and installation.
- **usePasteImage.ts** — Clipboard image paste handling.
- **useSkins.ts** — Skin management: load/apply/import/delete skins, gallery browsing, CSS injection.

### Key Patterns

- **IPC**: Frontend calls backend via `invoke<T>("command_name", { args })` from `@tauri-apps/api/core`. Backend emits events via `app.emit()`.
- **Events**: Backend emits typed events consumed by frontend `listen<T>()`: `scan-progress`, `scan-complete`, `sync-progress`, `sync-complete`, `download-progress`, `download-complete`, `download-error`, `lastfm-import-progress`, `lastfm-import-complete`, `lastfm-import-error`, `lastfm-auth-error`, `lastfm-similar-artists`, `lastfm-similar-tracks`, `lastfm-artist-info`, `lastfm-album-info`, `lastfm-track-tags`, `lastfm-artist-tags`, `deep-link-received`.
- **Playback**: Uses native HTML5 `<audio>` and `<video>` elements with Tauri's `convertFileSrc()` to serve local files via `asset://` protocol. Video formats determined by extension (mp4, m4v, mov, webm). No streaming or custom decoder.
- **Database concurrency**: Single `Mutex<Connection>` — all DB access is serialized. Background scanning, file watching, syncing, downloading, and Last.fm import run on separate threads.
- **Background tasks**: Long-running operations (scanning, syncing, downloading, Last.fm import) use `thread::spawn` with `AtomicBool` guards for cancellation and `app.emit()` for progress reporting.
- **FTS**: The `tracks_fts` virtual table is a contentless FTS5 table. It must be fully rebuilt (`db.rebuild_fts()`) after bulk inserts; it is not incrementally updated during scanning.
- **Tags**: Many-to-many relationship between tracks and tags via `track_tags` junction table. Genre metadata from file tags is stored as tags. A track can have multiple tags. The FTS index includes `tag_names` (comma-separated via `GROUP_CONCAT`).
- **Collections**: Support for multiple source types: local folders, Subsonic/Navidrome servers, TIDAL, and debug seed data. Each collection has sync state, credentials, and enable/disable toggle. Tracks belong to a collection via `collection_id`.
- **History**: Decoupled 3-table system (`history_artists`, `history_tracks`, `history_plays`) with canonical name matching (diacritics stripped + lowercase). Supports both real-time play recording (30-sec dedup) and batch import from Last.fm (exact-timestamp dedup). Tracks `library_track_id` for reconnection to library.
- **Image providers**: Trait-based fallback chain with failure caching (`image_fetch_failures` table). Artist/album images fetched from multiple providers. Tag images are composites generated from top artist images.
- **Debug gating**: The `seed` module and `seed_database` command are excluded from release builds via `#[cfg(debug_assertions)]`. The frontend seed button is gated by `import.meta.env.DEV`.
- **Context menu**: Right-click on a track opens a context menu with "Open Containing Folder" which calls `show_in_folder` (platform-specific: macOS/Windows/Linux).

### Database Schema

**Library tables**: `artists`, `albums`, `tags`, `track_tags`, `tracks`, `collections`, `tracks_fts` (FTS5 virtual table). Albums have a UNIQUE constraint on `(title, artist_id)`. Tracks are unique on `path` with upsert semantics. Tags use a many-to-many junction table (`track_tags`) with CASCADE deletes.

**History tables**: `history_artists` (canonical_name unique, play_count, library_artist_id), `history_tracks` (history_artist_id + canonical_title unique, play_count, library_track_id), `history_plays` (history_track_id, played_at).

**Support tables**: `image_fetch_failures` (caches failed image fetch attempts to avoid retrying), `lastfm_cache` (key-value cache for Last.fm API responses with 90-day TTL).
