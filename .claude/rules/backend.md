# Backend (src-tauri/src/)

## Supported Formats

**Audio:** MP3, FLAC, AAC/M4A, WAV, ALAC, OPUS. WMA best-effort.
**Video:** MP4/M4V/MOV (H.264) on macOS+Windows. WebM (VP8/VP9) Windows only.

## Files

- **lib.rs** — Tauri app setup, plugin registration, command handler registration. The full command list lives once in the `invoke_handler!` macro; the two `#[cfg]`-gated `get_invoke_handler()` variants differ only by the extra paths they pass in (e.g. debug-only `clear_database`), so they can't drift. Image-worker arms (artist/album/tag) share `resolve_image_via_bridge()` for the resolve→save→emit flow. Initializes `AppState` with all shared resources. Constructs image provider fallback chains at startup.
- **commands/** — All `#[tauri::command]` functions, split by area into submodules (`app`, `collections`, `downloads`, `extensions`, `history`, `images`, `library`, `main_playlist`, `media`, `mixtapes`, `p2p`, `playlists`, `plugin_files`, `plugins`, `skins_cmd`, `transcode`, `waveforms`, `youtube`). `commands/mod.rs` re-exports each submodule (`pub use <mod>::*`) and holds the shared `AppState` + helpers. Each command takes `State<'_, AppState>`, delegates to the `db/` layer or other modules, and returns `Result<T, String>`. `AppState` holds: `Arc<Database>`, `app_dir`, `download_queue`, `track_download_manager`, `LastfmClient`, `lastfm_session`, `lastfm_importing`.
- **db/** — SQLite wrapper behind `Mutex<Connection>`, split by entity into submodules (`albums`, `artists`, `collections`, `history`, `image_failures`, `likes`, `playlists`, `plugin_storage`, `providers`, `search`, `tags`, `tracks`). `db/mod.rs` owns the `Database` struct, schema creation (`init_tables`), `Database::new` / `new_in_memory`, and registers custom SQL functions: `filename_from_path()`, `strip_diacritics()`, `unicode_lower()`. Schema versioning via `db_version` table with `run_migrations()` on startup (PoC baseline squashed into `init_tables`; `db_version` starts at 1 and there are currently no migrations). `recompute_counts()` runs every startup. Likes live in `db/likes.rs` — see "Likes (entity_likes)" below.
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
- **main_playlist.rs** — Persistence layer for the live ("main") queue: reads/writes the manifest (`manifest.json`), state (`state.json`), cover (`cover.jpg`), and per-track thumbnails (`thumbs/`) in the main-playlist folder. Backs the `main_playlist_*` commands and the queue restore/persist contract in `queue.md`. `gc()` prunes orphaned cover/thumb files.
- **video_frames.rs** — Extracts representative frames from video tracks via `ffmpeg` (4 frames spread across the duration; at each position a short window is decoded and `ffmpeg`'s `thumbnail` filter picks the most representative, non-black frame) and caches them on disk. Output is WebP (`-quality 82`) when the resolved ffmpeg supports libwebp, else high-quality JPEG (`-q:v 2`); frames are scaled to a ~720px short edge. Backs the `get_video_frames` lookup used by the queue/now-playing image-resolution chain. Cache-only reads (`get_cached_frames`, format-agnostic); extraction is explicit.
- **tag_writer.rs** — Writes tag edits back to audio files (`TagUpdates`, only `Some` fields written). Backs the Edit Properties / bulk-edit flow.
- **transcode_server.rs** — Local HTTP transcode server (axum) with per-file sessions; non-blocking `start_sync` startup so window paint isn't gated on TCP bind. Serves on-the-fly transcoded streams.
- **browse_window.rs** — Embedded browse-window management (`open_browse_window`, `browse_window_eval`, `close_browse_window`, visibility) with an autoplay gate; backs the plugin `api.network.openBrowseWindow` bridge.
- **update_checker.rs** — Plugin/skin update checks (semver comparison helpers, gallery `update.json` resolution).
- **commands/updates.rs** — App self-update, channel-aware (`app_update_check` / `app_update_install` + `app-update-progress` event; the JS updater plugin can't override endpoints, so the flow lives in Rust). **Stable** (default): config-baked `releases/latest/download/latest[-mpv].json` — GitHub's "latest" skips prereleases, so betas are invisible. **Beta** (opt-in, `betaUpdates` store key, Settings > General): the newest non-draft release *including prereleases* is discovered via the GitHub releases API (newest-first order; must carry this build's manifest — `latest-mpv.json` for full builds via `cfg!`), and its manifest is fed to `updater_builder().endpoints(...)`. A newer stable outranks older betas, so beta users return to stable automatically; discovery failures fall back to the stable check. Signature verification uses the config pubkey on both channels.
- **logging.rs** — File-based logging (`CombinedLogger` = env_logger + optional file writer), toggled in Settings.
- **cursor_tracker.rs** / **cursor_tracker_win.rs** — Native cursor polling so the mini player can expand on hover without window focus (Windows uses a platform-specific poller).
- **p2p/** — libp2p-based peer-to-peer engine (host side of the `p2p-sharing` plugin): `swarm.rs` (the `NetworkBehaviour`: identify, ping, autonat, relay-client, dcutr hole-punching, request-response binary transfer), `protocols.rs`, `handler.rs`, `discovery.rs`, `mod.rs` (`P2pNode`, `P2pStatus`). Version-coupled to `viboplr-relay` — see "Relay version coupling" below. Commands live in `commands/p2p.rs` (`api.p2p.*` bridge).
- **timing.rs** — Startup performance profiling.
- **seed.rs** — Debug-only (`#[cfg(debug_assertions)]`). Fake data seeding.
- **dependencies.rs** — External binary dependency service (ffmpeg, yt-dlp). See "External Binary Dependencies" below.
- **mpv_engine/** — Native audio playback engine backed by libmpv, compiled only into the "full" build (`mpv-engine` Cargo feature). See "Native mpv Engine" below.

## Native mpv Engine (`mpv-engine` feature)

The full build carries a native playback engine (`src/mpv_engine/`) as a runtime-selectable alternative to the webview pipeline (Settings > Playback > "Playback engine"). Audio everywhere; **video natively on macOS** via `mpv_engine/video_layer.rs` — an `NSView` + `NSOpenGLContext` inserted BELOW the transparent WKWebView, driven by `mpv_render_context` on a dedicated render thread (deck 0 only, `vo=libmpv`, `hwdec=auto`). The frontend punches a CSS hole over the video container (`.mpv-video-hole` in TrackDetailView.css) and reports container bounds via `engine_set_video_bounds`, so DOM overlays still draw above the video. AppKit rules: view work + `[NSOpenGLContext update]` on the main thread only (off-main `update` traps — this was a real crash), GL render/flush on the render thread, serialized via `CGLLockContext`. On Windows/lean builds video stays on the browser+transcode path.

- **Dual decks** (two libmpv handles, ping-pong): gapless arms the next track on the *active* deck's playlist (mpv transitions sample-accurately); crossfade arms it *paused on the standby deck* and a Rust ramp thread fades deck volumes. If the active track EOFs with a crossfade arm still pending, the engine hard-cuts into the arm (safety net); if the *incoming* deck EOFs mid-fade, the fade is snapped and `engine-ended` fires.
- **DSP**: EQ maps to one ffmpeg `lavfi=[…]` graph (`mpv_engine/af.rs` — 10 `equalizer` biquads / `bass`+`treble` shelves / `alimiter`, mirroring `src/eqPresets.ts`; unit tests pin the constants). ReplayGain uses mpv-native `replaygain*` options (mpv reads the file tags itself). Both are cached on `EngineHandle` (pending) so Settings changes made before the engine exists apply at creation, and are applied to both decks.
- **IPC**: commands in `commands/mpv_engine.rs` are registered in **every** build — without the feature they return an error and `engine_capabilities` reports `mpv: false`, so the frontend gates on capability, not build flavor. Events (`engine-position` 4 Hz, `engine-duration`, `engine-track-changed {reason}`, `engine-ended`, `engine-state`, `engine-error {code}`) all carry `track_key` — the native equivalent of the frontend's play-generation guard.
- **Vendoring**: `scripts/fetch-libmpv.mjs` + `scripts/libmpv.lock.json` download pinned, SHA-256-verified libmpv artifacts into `src-tauri/vendor/libmpv/<platform>` (gitignored). Never point the lock at "latest" — upstream daily builds regress silently; bump deliberately and re-test. macOS post-processing rewrites the dylib's absolute luajit ref to `@rpath` and ad-hoc re-signs. `build.rs` supplies the link search path + rpaths (dev: vendor dir; bundled: `@executable_path/../Frameworks`).
- **Two builds**: lean (default, browser engine only) and "Viboplr Full" (`--features mpv-engine --config src-tauri/tauri.mpv-{macos,windows}.conf.json` — bundles the dylib/DLL, distinct productName, own updater channel `latest-mpv.json` assembled by `scripts/build-mpv-updater-manifest.mjs` in the release workflow).
- **Windows video (wid embedding, ships dark)**: `mpv_engine/video_layer_win.rs` creates a disabled child HWND at the bottom of the sibling z-order (below WebView2) and hands it to deck 0 via `wid` + `vo=gpu` — mpv renders itself, no render thread. **Not yet validated on real Windows**: capability reports `video: false` there unless `VIBOPLR_WIN_NATIVE_VIDEO=1`; the `WINVIDEO:` logs are temporary validation scaffolding. Validation checklist lives in the project memory.
- **TLS**: the vendored libmpv links a **static OpenSSL with no usable CA store** — without intervention every https source fails certificate verification. `ensure_ca_bundle()` exports the macOS system trust store to `{app_data_dir}/mpv-cacert.pem` (30-day cache, via `/usr/bin/security`) and sets `tls-ca-file` on both decks at engine creation. Verification is never disabled; on bundle failure https fails closed (per-track browser fallback). Windows builds likely use schannel — validate there.
- **Exclusive audio** (`engine_set_audio_exclusive`, Settings > Playback, native engine only): CoreAudio hog mode / WASAPI exclusive. While on, preload arming is **forced to same-deck gapless** (a second deck can't open the held device). Applies from the next AO open.
- **Live stream extras**: `engine_get_audio_info` returns the active deck's real decode facts (codec/samplerate/format/bitrate — the Now Playing "Quality" item tries this before lofty, covering remote streams); the event loop observes `media-title` and emits `engine-icy-title` (ICY StreamTitle for internet radio — the full Now Playing bar shows it in place of Artist · Album; frontend drops titles equal to the track's own title/URL basename). The ytdl hook is disabled (`ytdl=no`) — the app's stream resolvers own that job.
- **Frontend seam**: see frontend.md (`src/playback/nativeEngine.ts` bridge, `usePlayback` native session branches, per-track fallback to the browser engine on `engine-error`).

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
- **`manifest`** — a subscribed HTTP JSON catalog (e.g. an artist's published track list). Synced by `manifest_sync.rs` (`sync_manifest` = fetch JSON → `ingest_manifest` upsert+prune, mirroring `sync.rs`). Each track's direct `url` is stored verbatim as `tracks.path` (so the natively-playable `http(s)://` scheme streams the bytes on demand; **no** custom resolver). Added via `add_collection { kind: "manifest", url }` — reached from the `viboplr://add-collection?kind=manifest&url=…` deep link (App.tsx confirms with `AddMusicSourceModal` before subscribing, since a clicked link is untrusted). Defaults to `auto_update` on, daily, so it rides the generic collection auto-update loop in `lib.rs`. Because tracks are real DB rows, they appear in FTS search / Home / browse with no extra wiring.
- **`seed`** — debug-only fake data

Plugins can register additional collection kinds.

**Publishing (inverse of `manifest`):** `music_publish.rs` + the `export_music_source` command bundle a whole local collection or an explicit track-id selection into a self-contained, hostable folder (`index.html` + `manifest.json` + `tracks/<copied files>` + `PUBLISH.md`), with track URLs built from a user-supplied base URL. Only local files are bundled (remote/missing tracks are skipped and reported). Reached via Collections → **Publish** (whole local collection) or the **Publish as music source…** track / multi-track context-menu action; UI is `PublishSourceModal`. GitHub support is copy-paste `gh`/`git` commands (no in-app GitHub auth).

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

Full schema: `artists`, `albums`, `tags`, `track_tags`, `tracks`, `collections`, `entity_likes`, `history_artists`, `history_tracks`, `history_plays`, `image_fetch_failures`, `playlists`, `playlist_tracks`, `plugin_storage`, `lastfm_cache`, `lyrics`, `tracks_fts` (FTS5). (Plugin-system tables — `information_types`, `information_values`, `image_providers`, `stream_resolvers`, `download_providers`, `plugin_schedules` — are documented in `plugins.md`.)

Key constraints: albums UNIQUE on `(title, artist_id)`, tracks UNIQUE on `path` with upsert, `track_tags` with CASCADE deletes. The `liked` column on `tracks` is excluded from upsert ON CONFLICT so re-scanning preserves likes.

### Likes (entity_likes)

`entity_likes` is the **durable, ID-less source of truth** for like/dislike state across tracks, artists, albums, and tags. Schema: `(kind, entity_key, liked, metadata, updated_at)` with PK `(kind, entity_key)`. Logic lives in `db/likes.rs`.

- **Entity keys** are name-based and diacritic-normalized (`strip_diacritics(lowercase(...))` via `norm_segment`), built by `build_entity_key(kind, name_or_title, artist_name)`: `track:{artist}:{title}`, `album:{artist}:{title}`, `artist:{name}`, `tag:{name}`. Because keys are metadata-based, likes survive for non-library and `id`-less `QueueTrack`s.
- `set_entity_like` upserts a row (or **deletes** it when `liked == 0`). The `tracks.liked` column is kept as a mirror for library list rendering, but `entity_likes` is authoritative.
- `get_track_like_states(&[(title, artist)])` batch-reads track like states from `entity_likes` (0 when no row). Used on startup to reconcile the restored queue / now-playing tracks, whose `QueueTrack`s carry no DB id — `tracksFromManifest` hardcodes `liked: 0`, so the restore path patches it from this command.
- Commands: `set_entity_like_state` (frontend `useLikeActions` calls this with `{ kind, entity, likeState }`), `get_track_like_states` (in `commands/library.rs`).

## Profiles

Chrome-like profile isolation: `{app_data_dir}/profiles/{name}/`. Default profile is `default`. Set via `VIBOPLR_PROFILE` env var or `--profile` CLI arg. Non-default profiles show name in window title.

## Relay version coupling

The standalone `viboplr-relay` repository must use the exact same `libp2p` version (and feature flags overlapping with the relay/identify/autonat protocols) as `src-tauri/Cargo.toml`. Mismatched versions can silently break hole-punching for end users.

When bumping `libp2p` here, open a coordinated PR in `viboplr-relay` to bump it to the same version. Do not merge one without the other.
