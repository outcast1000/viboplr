# External Integrations

**Analysis Date:** 2026-08-14

## APIs & External Services

**GitHub:**
- App self-updates: fetches `latest.json` manifest from GitHub releases (stable/beta channels via `outcast1000/viboplr`)
- Plugin/skin downloads: GitHub archive zips from user-provided repo URLs
- Extension update checks: GitHub releases API with retry logic on transient failures
- SDK/Client: `reqwest` HTTP client (0.13) with retry on connection/stream errors
- Config: `src-tauri/tauri.conf.json` has updater pubkey and stable endpoint; `commands/updates.rs` handles beta discovery via releases API

**Subsonic/Navidrome:**
- Music server synchronization and streaming
- Collections: `subsonic://` URL scheme, stored in collections table with host/username/password
- API: REST API via `reqwest`, supports both token and plaintext auth (`commands/collections.rs` → `sync.rs`)
- Credentials stored encrypted in SQLite (`collections` table: `password_token` + `salt` fields)
- Auth: MD5-based token authentication (`md5(password+salt)`) or plaintext fallback

**HTTP Manifest Catalogs:**
- Custom music source publishing/subscription system
- Collections: `manifest` kind, subscribes to `https://` JSON manifests
- Schema: JSON with metadata array, each track carries a URL (absolute or relative to manifest)
- Tracks ingested as library rows with `http(s)://` paths
- Auto-sync daily via collection auto-update mechanism
- Entry point: `viboplr://add-collection?kind=manifest&url=...` deep link

**Aptabase Analytics (Self-Hosted):**
- Anonymous usage telemetry via `tauri-plugin-aptabase`
- Host: `https://analytics.viboplr.com` (self-hosted Tauri instance, see `deploy/aptabase/`)
- Opt-out: user toggle in Settings > General; `telemetryEnabled` store flag (default: on)
- API key: `APTABASE_APP_KEY` env var at build time (A-SH-* format for self-hosted)
- Events: anonymous only, no PII (no user IDs, no titles, no paths) — see `src/telemetry.ts` for event tracking
- Implementation: `src-tauri/src/telemetry.rs` (register plugin only if key present)
- Frontend: `src/telemetry.ts` gates all track calls behind `telemetryEnabled`

## Data Storage

**Databases:**
- SQLite 3.x (bundled via rusqlite)
  - Location: `{app_data_dir}/profiles/{profile_name}/viboplr.db`
  - Tables: artists, albums, tags, tracks, collections, playlists, likes, history, lyrics, plugin_storage, etc.
  - Connection pool: single `Mutex<Connection>` with WAL mode, foreign keys on, 8MB cache
  - Startup: schema auto-creation via `init_tables()`, idempotent migrations via `run_migrations()`
  - Custom SQL functions: `filename_from_path()`, `strip_diacritics()`, `unicode_lower()` (all registered DETERMINISTIC for index optimization)
  - Client: rusqlite (Rust side); tauri-plugin-store for simple key-value persistence (`app-state.json`)

**File Storage:**
- Local filesystem only (no cloud storage)
  - User's music folder(s) via local collection kind (`file://` paths)
  - Subsonic remote streams via subsonic:// scheme (bytes downloaded on demand)
  - Manifest collection tracks via https:// (bytes downloaded on demand via transcode server or native playback)
- **Image cache:** `{app_data_dir}/images/` (artist/album/tag slugs + cover art)
- **Waveform cache:** `{app_data_dir}/waveforms/` (width-independent RMS peak data, md5-keyed)
- **Video frame cache:** `{app_data_dir}/video-frames/` (WebP thumbnails, format-agnostic)
- **Main playlist (queue):** `{app_data_dir}/main_playlist/` (manifest.json state, cover art, per-track thumbnails)
- **Plugin storage:** per-plugin directory in `{app_data_dir}/plugin-data/`
- **Logs:** `{app_data_dir}/viboplr.log` (optional, toggled in Settings, truncated per launch)

**Caching:**
- HTTP cache for manifest collections (Last-Modified / ETag headers, persisted in `manifest_http_cache` table)
- Image fetch failure tracking (`image_fetch_failures` table, prevents retry storms)
- Last.fm data cache (90-day TTL, `lastfm_cache` table) — backend-only, not used in current build
- Waveform computation cache (keyed by `v3::artist::title::duration`, invalidated when bucketing changes)
- Dependency version probes (session-scoped `DepCache`, persisted to `.probe-cache.json` in managed bin dir)

## Authentication & Identity

**Auth Provider:**
- None for the app itself (local/anonymous use)
- **Subsonic:** Username + Password → token (MD5 + salt) or plaintext
- **Last.fm:** API key + shared secret (MD5 signing) for scrobbling — backend-only, not used in current build
- **Plugin API key management:** plugins can store secrets in plugin-specific storage (`plugin_storage` table)

**Credentials Storage:**
- Encrypted in-database (`collections` table: `password_token` + `salt` for Subsonic)
- Never transmitted or logged
- User supplies via modals (`AddServerModal`, `EditCollectionModal`)

## Monitoring & Observability

**Error Tracking:**
- In-memory error log: 50-entry ring buffer (`errorLog` in App.tsx, inspectable via `window.__appErrors`)
- Diagnostic report: "Report a Problem" modal bundles logs + system info + user annotation
- Report generated by `utils/diagnosticReport.ts`, assembled by user, copied manually (no auto-transmission)
- Backend diagnostics: `commands/app.rs::collect_diagnostics` gathers OS/arch, app version, profile, logging state, log tail

**Logs:**
- **Frontend:** no persistent logging by default (errors captured in ring buffer)
- **Backend:** optional file logging (Settings > Debug > Logging), truncated on every launch
  - Location: `{app_data_dir}/viboplr.log`
  - Framework: `env_logger` + file writer (custom `CombinedLogger` in `logging.rs`)
- **Telemetry:** anonymous events only, gated by user opt-out (see Aptabase Analytics above)

## CI/CD & Deployment

**Hosting:**
- GitHub Releases (`outcast1000/viboplr`) - app binaries + `latest.json` manifest (macOS DMG + Windows NSIS installer, code-signed)
- Self-hosted Aptabase instance (VPS) - analytics backend (`analytics.viboplr.com`)
- GitHub raw content - plugin/skin downloads from user-provided repo URLs

**CI Pipeline:**
- GitHub Actions (inferred from release artifacts + updater config)
- Automatic update checks point to stable release channel; beta opt-in via Settings

**Deployment Flow:**
- App: `npm run tauri build` → platform bundle → signed and published to GitHub Releases
- libmpv: `node scripts/fetch-libmpv.mjs` downloads + verifies pinned artifacts → vendored in build
- Plugins: installed from gallery URLs or user-provided GitHub URLs → `{app_data_dir}/plugins/`
- Skins: installed from gallery or imported as ZIP → `{app_data_dir}/skins/`

## Environment Configuration

**Required env vars (build):**
- `APTABASE_APP_KEY` - Optional; telemetry disabled if absent (format: `A-SH-*` for self-hosted)

**Optional env vars (runtime, debugging):**
- `VIBOPLR_PROFILE` - Override default profile selection (default: `default`)
- `VIBOPLR_LIBMPV_PATH` - Override libmpv DLL/dylib lookup path (dev/testing only)
- `VIBOPLR_MPV_LOG_FILE` - Write mpv engine logs to file (diagnostic hook)
- `VIBOPLR_MPV_OPTS` - Raw mpv options string (`key=val;key=val`) applied at deck creation (diagnostic hook)

**Secrets location:**
- Environment variables (build time): `APTABASE_APP_KEY`
- Database encryption: Subsonic credentials stored in SQLite with salt
- No `.env` files committed; example patterns in `deploy/aptabase/.env.example` (not readable via git)

## Webhooks & Callbacks

**Incoming:**
- Deep links: `viboplr://add-collection?kind=manifest&url=...` (handled by Tauri deep-link plugin)
- Subsonic: `viboplr://add-server?host=...&username=...` (user-initiated setup, not server-pushed)

**Outgoing:**
- GitHub API: update checks and releases queries (read-only)
- Subsonic API: getAlbumList2, getAlbum, getArtists, etc. (read-only sync)
- Manifest URL: HTTP GET with If-Modified-Since / ETag (read-only, respects cache headers)
- Plugin streams: plugins may register custom `onResolveStreamByUri` handlers for new schemes
- Aptabase: anonymous event posts (telemetry only, opt-out available)

## Plugin System

**Extensibility:**
- Plugin architecture with sandboxed code execution (`new Function("api", code)`)
- Plugins can register: context menu items, sidebar views, search providers, information sections, image providers, stream resolvers, download providers, visualizers
- Plugin manifest (JSON): `name`, `version`, `description`, `minAppVersion`, `updateUrl`, `contributes`, `binaryDependencies`
- Location: `{app_data_dir}/plugins/{plugin_id}/` or bundled in `src-tauri/plugins/` for built-in extensions
- API: `ViboplrPluginAPI` surface including playback, queue, library, downloads, stream resolution, image caching, native menus
- Storage: per-plugin kv store in `plugin_storage` table

**Built-in Plugins/Integrations (Not Core):**
- Last.fm - Scrobbling and community metadata (external plugin)
- yt-dlp - YouTube stream extraction and format conversion (external plugin)
- Spotify - Search and playlist browsing (external plugin in `outcast1000/viboplr-spotify`)
- Vinyl Deck - Playback speed/pitch visualizer (external plugin)

---

*Integration audit: 2026-08-14*
