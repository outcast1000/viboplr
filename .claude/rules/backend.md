# Backend (src-tauri/src/)

## Supported Formats

**Audio:** MP3, FLAC, AAC/M4A, WAV, ALAC, OPUS. WMA best-effort.
**Video:** MP4/M4V/MOV (H.264) on macOS+Windows. WebM (VP8/VP9) Windows only.

## Files

- **lib.rs** — Tauri app setup, plugin registration, command handler registration. Debug-only commands via `#[cfg(debug_assertions)]` using separate `get_invoke_handler()` functions. Initializes `AppState` with all shared resources. Constructs image provider fallback chains at startup.
- **commands.rs** — All `#[tauri::command]` functions (~107 commands). Each takes `State<'_, AppState>` and delegates to `db.rs` or other modules. Commands return `Result<T, String>`. `AppState` holds: `Arc<Database>`, `app_dir`, `download_queue`, `track_download_manager`, `LastfmClient`, `lastfm_session`, `lastfm_importing`.
- **db.rs** — SQLite wrapper behind `Mutex<Connection>` (~67 public functions). Owns schema creation, CRUD, FTS5 search index, history recording, Last.fm cache. Registers custom SQL functions: `filename_from_path()`, `strip_diacritics()`, `unicode_lower()`. Schema versioning via `db_version` table with `run_migrations()` on startup. `recompute_counts()` runs every startup.
- **scanner.rs** — Walks folder trees with `walkdir`, reads tags with `lofty`. Video files skip tag reading (filename = title). Falls back to regex-based filename parsing (4 patterns tried in order). Genres stored as tags.
- **watcher.rs** — Uses `notify` crate for real-time filesystem events on dedicated background thread.
- **models.rs** — Serde-serializable structs shared between commands and DB layer.
- **lastfm.rs** — Last.fm API client. Token-based auth with MD5 API signature hashing. Read-only methods use unsigned GET, write methods use signed POST. Methods include: auth, scrobble, now_playing, similar artists/tracks, artist/album/track info, top tags, love/unlove, recent tracks. 90-day TTL cache in `lastfm_cache` table.
- **subsonic.rs** — Subsonic/Navidrome API client. Tries token auth first (`md5(password+salt)`), falls back to plaintext.
- **tidal.rs** — TIDAL Hi-Fi API client with instance failover and 24-hour TTL caching. BTS manifest decoding (base64 JSON with CDN URLs). Stream URLs fetched at play time to avoid token expiration.
- **sync.rs** — Subsonic collection synchronization. Paginates `getAlbumList2`, fetches full album data, upserts artists/albums/tracks, stores genres as tags.
- **downloader.rs** — Track download manager with queue/threading. `DownloadFormat` enum (Flac, Aac, Mp3). Writes ID3/Vorbis tags, embeds cover art.
- **entity_image.rs** — Filesystem-safe canonical slug generation with diacritic stripping. Image paths use canonical slugs, not DB IDs.
- **composite_image.rs** — Generates tag composite images from overlapping circles of 1-3 artist images via `image` crate.
- **image_provider/** — Trait-based `ArtistImageProvider` / `AlbumImageProvider` with fallback chains. Artist: Tidal -> Deezer -> iTunes -> AudioDB -> MusicBrainz. Album: Embedded -> Tidal -> iTunes -> Deezer -> MusicBrainz. Adding a new provider: implement trait, add to chain in `lib.rs`.
- **plugins.rs** — Plugin management: directory scanning, file reading (with path traversal protection), storage, gallery install.
- **lyric_provider/** — Trait-based `LyricProvider` fallback chain. Currently: LRCLIB (lrclib.net). Returns synced (LRC) or plain text.
- **skins.rs** — Skin file I/O, gallery fetching from GitHub, slug generation.
- **tape.rs** — Tape export functionality.
- **timing.rs** — Startup performance profiling.
- **seed.rs** — Debug-only (`#[cfg(debug_assertions)]`). Fake data seeding.

## Collections

All music sources are unified under a Collections abstraction with `kind` discriminator:
- **`local`** — local folder, scanned for media files
- **`subsonic`** — Subsonic/Navidrome server, synced via REST API
- **`tidal`** — TIDAL instance via Hi-Fi API
- **`seed`** — debug-only fake data

Tracks belong to a collection via `collection_id`. Disabled collections are filtered via `ENABLED_COLLECTION_FILTER`. Track paths use URL schemes: `file://` (local), `subsonic://{collection_id}/{subsonic_id}`, `tidal://{collection_id}/{tidal_id}`.

## Background Tasks

Long-running operations use `thread::spawn` with `AtomicBool` guards for cancellation and `app.emit()` for progress reporting:
- **Scanning** — walks folder tree, reads tags, upserts tracks
- **File watching** — real-time filesystem events via `notify`
- **Syncing** — Subsonic album pagination + track import
- **Downloading** — queue-based with format conversion and tag writing
- **Last.fm import** — paginated scrobble history import (200/page, 200ms rate limit)
- **Image fetching** — LIFO queue (most recently requested = first processed) with 1100ms rate limit between downloads. Failure tracking in `image_fetch_failures` table.
- **Lyrics fetching** — provider chain with `AtomicI64` tracking currently-fetching track ID

## Playback Resolution

`get_track_path` returns different values based on track type:
- **Local:** filesystem path, frontend wraps with `convertFileSrc()` for `asset://`
- **Subsonic:** streaming URL `{server}/rest/stream.view?id={id}&{auth_params}`
- **TIDAL:** blocking HTTP call to Hi-Fi API, base64-decodes BTS manifest, returns CDN URL

## Database

Schema versioned via `db_version` table (currently version 12). `run_migrations()` applies ALTER TABLE statements on startup. `recompute_counts()` runs every startup for crash safety.

Full schema: `artists`, `albums`, `tags`, `track_tags`, `tracks`, `collections`, `history_artists`, `history_tracks`, `history_plays`, `image_fetch_failures`, `plugin_storage`, `lastfm_cache`, `lyrics`, `tracks_fts` (FTS5).

Key constraints: albums UNIQUE on `(title, artist_id)`, tracks UNIQUE on `path` with upsert, `track_tags` with CASCADE deletes. The `liked` column is excluded from upsert ON CONFLICT so re-scanning preserves likes.

## Profiles

Chrome-like profile isolation: `{app_data_dir}/profiles/{name}/`. Default profile is `default`. Set via `VIBOPLR_PROFILE` env var or `--profile` CLI arg. Non-default profiles show name in window title.
