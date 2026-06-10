# Backend (src-tauri/src/)

## Supported Formats

**Audio:** MP3, FLAC, AAC/M4A, WAV, ALAC, OPUS. WMA best-effort.
**Video:** MP4/M4V/MOV (H.264) on macOS+Windows. WebM (VP8/VP9) Windows only.

## Files

- **lib.rs** — Tauri app setup, plugin registration, command handler registration. Debug-only commands via `#[cfg(debug_assertions)]` using separate `get_invoke_handler()` functions. Initializes `AppState` with all shared resources. Constructs image provider fallback chains at startup.
- **commands.rs** — All `#[tauri::command]` functions (~107 commands). Each takes `State<'_, AppState>` and delegates to `db.rs` or other modules. Commands return `Result<T, String>`. `AppState` holds: `Arc<Database>`, `app_dir`, `download_queue`, `track_download_manager`, `LastfmClient`, `lastfm_session`, `lastfm_importing`.
- **db.rs** — SQLite wrapper behind `Mutex<Connection>` (~67 public functions). Owns schema creation, CRUD, FTS5 search index, history recording, Last.fm cache. Registers custom SQL functions: `filename_from_path()`, `strip_diacritics()`, `unicode_lower()`. Schema versioning via `db_version` table with `run_migrations()` on startup (PoC baseline squashed into `init_tables`; `db_version` starts at 1 and there are currently no migrations). `recompute_counts()` runs every startup.
- **scanner.rs** — Walks folder trees with `walkdir`, reads tags with `lofty`. Video files skip tag reading (filename = title). Falls back to regex-based filename parsing (4 patterns tried in order). Genres stored as tags.
- **models.rs** — Serde-serializable structs shared between commands and DB layer.
- **lastfm.rs** — Last.fm API client. Token-based auth with MD5 API signature hashing. Read-only methods use unsigned GET, write methods use signed POST. Methods include: auth, scrobble, now_playing, similar artists/tracks, artist/album/track info, top tags, love/unlove, recent tracks. 90-day TTL cache in `lastfm_cache` table.
- **subsonic.rs** — Subsonic/Navidrome API client. Tries token auth first (`md5(password+salt)`), falls back to plaintext.
- **sync.rs** — Subsonic collection synchronization. Paginates `getAlbumList2`, fetches full album data, upserts artists/albums/tracks, stores genres as tags.
- **downloader.rs** — Track download manager with queue/threading. `DownloadFormat` enum (Flac, Aac, Mp3). Writes ID3/Vorbis tags, embeds cover art.
- **entity_image.rs** — Filesystem-safe canonical slug generation with diacritic stripping. Image paths use canonical slugs, not DB IDs.
- **composite_image.rs** — Generates tag composite images from overlapping circles of 1-3 artist images via `image` crate.
- **image_provider/** — Trait-based `ArtistImageProvider` / `AlbumImageProvider` with fallback chains. Artist/Album: Embedded (album only, Rust-native) -> plugin image providers in priority order (user-configurable via Settings > Providers). Adding a new provider: implement trait, add to chain in `lib.rs`.
- **plugins.rs** — Plugin management: directory scanning, file reading (with path traversal protection), storage, gallery install.
- **lyric_provider/** — Trait-based `LyricProvider` fallback chain. Currently: LRCLIB (lrclib.net). Returns synced (LRC) or plain text.
- **skins.rs** — Skin file I/O, gallery fetching from GitHub, slug generation.
- **mixtape.rs** — Mixtape export/import functionality.
- **timing.rs** — Startup performance profiling.
- **seed.rs** — Debug-only (`#[cfg(debug_assertions)]`). Fake data seeding.
- **dependencies.rs** — External binary dependency service (ffmpeg, yt-dlp). See "External Binary Dependencies" below.

## External Binary Dependencies

External CLI binaries the app/plugins shell out to (currently `ffmpeg`, `yt-dlp`) are governed by the static `REGISTRY` in `dependencies.rs`. Each `DependencyDef` carries: version-check args + parser, per-platform install commands (the instruct-only fallback), internal consumers (shown as the "who needs this" list), and an optional `ManagedSource`.

**The registry is also the `api.system.exec` allow-list** — `plugin_exec` rejects any program not in `allowed_names()`. Plugins therefore **reference** registry entries via the `binaryDependencies` manifest field (name + reason → requestor list); they cannot add new binaries. Adding a binary = a host release.

**Existence check:** `check_single()` runs the binary's version flag, caches the result (session-scoped `DepCache` in `AppState`), and reports `DepOrigin` (`Managed` = the app-installed copy in the shared bin dir, `System` = found on PATH).

**Managed install/update** (only deps with a `ManagedSource`, currently just yt-dlp — ffmpeg is instruct-only with `managed: None`):
- Binaries install to `{app_data_dir}/bin/` (shared across profiles, set via `set_managed_bin_dir` in `lib.rs` setup). `command_with_path()` / `augmented_path()` **prepend** this dir to PATH and resolve the program explicitly, so a managed copy wins over the system one everywhere (internal consumers + `plugin_exec`) with no call-site changes.
- `install_managed()` downloads the platform asset from the pinned GitHub releases repo, verifies SHA-256 against the release's checksums file, and atomically renames into place. Commands: `dependency_install`, `dependency_uninstall_managed` (deletes the managed copy → PATH falls back to any system install), `dependency_check_updates` (in `commands/media.rs`); progress via `dependency-install-progress` events.
- **"Let Viboplr manage" handoff:** a `system`-origin dep can be taken over by installing a managed copy alongside it — because the managed bin dir is PATH-prepended, the managed copy immediately wins resolution; the orphaned system copy is left for the user's package manager to remove. The reverse ("Stop managing") calls `dependency_uninstall_managed`. Both are surfaced in Settings.
- **Latest-version lookups** (`latest_version()`) hit the GitHub API at most once per dep per 24h — TTL-cached on `DepCache`, **failures cached too** so a flaky network can't exhaust the 60 req/h unauthenticated limit. `check_dependencies` stays offline/fast (cache-only).
- **Auto-update** (`auto_update_managed()`, background thread in `lib.rs`): ~30s after startup then daily, silently reinstalls outdated **managed-origin** copies when `autoUpdateManagedDeps` is on (default true, read straight from the store file). **Never touches `System`-origin copies** — those belong to the user's package manager; the UI only shows the upgrade command for them. Emits `dependency-updated`.
- yt-dlp failures in `yt_dlp_stream_audio` append an "outdated" hint when the cached latest version is newer than installed (no fresh network call) — stale yt-dlp is the common failure and looks like an app bug otherwise.

Frontend: `useDependencies.ts` (install/update/progress/checkUpdates), `DependencyModal.tsx` ("Install for me" when managed, else copy-command + download-page), Settings > Dependencies (origin labels, outdated badges, Install/Update buttons, system upgrade-command copy, auto-update toggle).

## Collections

All music sources are unified under a Collections abstraction with `kind` discriminator:
- **`local`** — local folder, scanned for media files
- **`subsonic`** — Subsonic/Navidrome server, synced via REST API
- **`seed`** — debug-only fake data

Plugins can register additional collection kinds.

Tracks belong to a collection via `collection_id`. Disabled collections are filtered via `ENABLED_COLLECTION_FILTER`. Track paths use URL schemes: `file://` (local), `subsonic://{collection_id}/{subsonic_id}`. Plugins register custom URL schemes (e.g., `{scheme}://{id}`).

**Track type classification:** Use `is_remote()` on `Track` (Rust) or `isLocalTrack()` / `isRemoteTrack()` (TypeScript, from `queueEntry.ts`) to classify tracks. These use an allow-list pattern: only `file://` is local, everything else is remote. Do not add new deny-list checks for specific schemes.

## Background Tasks

Long-running operations use `thread::spawn` with `AtomicBool` guards for cancellation and `app.emit()` for progress reporting:
- **Scanning** — walks folder tree, reads tags, upserts tracks
- **Syncing** — Subsonic album pagination + track import
- **Downloading** — queue-based with format conversion and tag writing
- **Last.fm import** — paginated scrobble history import (200/page, 200ms rate limit)
- **Image fetching** — LIFO queue (most recently requested = first processed) with 1100ms rate limit between downloads. Failure tracking in `image_fetch_failures` table.
- **Lyrics fetching** — provider chain with `AtomicI64` tracking currently-fetching track ID

## Playback Resolution

`get_track_path` returns different values based on track type:
- **Local:** filesystem path, frontend wraps with `convertFileSrc()` for `asset://`
- **Subsonic:** streaming URL `{server}/rest/stream.view?id={id}&{auth_params}`
- **Plugin schemes:** resolved via plugin `onResolveStreamByUri` handlers

## Database

Schema versioned via `db_version` table. The full PoC migration history was squashed into the `init_tables` baseline, so `db_version` starts at 1 and `run_migrations()` is currently a no-op kept as the extension point for future schema changes (add `if version < N { ... }` blocks). `recompute_counts()` runs every startup for crash safety (called from `Database::new`).

Full schema: `artists`, `albums`, `tags`, `track_tags`, `tracks`, `collections`, `history_artists`, `history_tracks`, `history_plays`, `image_fetch_failures`, `plugin_storage`, `lastfm_cache`, `lyrics`, `tracks_fts` (FTS5).

Key constraints: albums UNIQUE on `(title, artist_id)`, tracks UNIQUE on `path` with upsert, `track_tags` with CASCADE deletes. The `liked` column is excluded from upsert ON CONFLICT so re-scanning preserves likes.

## Profiles

Chrome-like profile isolation: `{app_data_dir}/profiles/{name}/`. Default profile is `default`. Set via `VIBOPLR_PROFILE` env var or `--profile` CLI arg. Non-default profiles show name in window title.

## Relay version coupling

The standalone `viboplr-relay` repository must use the exact same `libp2p` version (and feature flags overlapping with the relay/identify/autonat protocols) as `src-tauri/Cargo.toml`. Mismatched versions can silently break hole-punching for end users.

When bumping `libp2p` here, open a coordinated PR in `viboplr-relay` to bump it to the same version. Do not merge one without the other.
