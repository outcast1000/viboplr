# Self-hosted Aptabase (usage analytics)

Anonymous usage analytics for the Viboplr desktop app, self-hosted next to the
marketing site on the VPS. Aptabase is privacy-first by design: no cookies, no
persistent device id, no PII — just an ephemeral session id plus coarse system
props (OS, app version, locale) and the events the app chooses to send.

This is **stateful infra you bring up once by hand**. It is intentionally *not*
wired into `.github/workflows/deploy-vps.yml` (that job only rsyncs `docs/`).

## What the app sends

Gated behind the in-app **Settings → General → "Anonymous usage statistics"**
toggle (default on / opt-out). Events (all anonymous, enum/count only):

- `app_installed` — once per install
- `app_started` — per launch (`{ channel, build, tracks_bucket, collections, plugins_enabled }`) → installs / DAU / MAU / retention / OS + version + library-size cohorts
- `track_played` `{ media: audio|video, source }`, `engine_selected` `{ engine }`, `collection_added` `{ kind }`, `plugin_installed` `{ id }`, `skin_applied`
- **Feature use:** `play` `{ source, count }` (source = play origin: album/artist/tag/radio/playlist/plugin/…), `radio_started`, `plugin_action` `{ plugin_id, action_id }`, `playlist_saved` `{ format, mode? }` (m3u / mixtape), `playlist_loaded` `{ format, mode? }` (m3u / m3u8 / mixtape), `nav_click` `{ view }` (sidebar navigation)
- **Reliability:** `playback_error` `{ engine, source, reason, error_kind }`, `engine_fallback` `{ code, error_kind }`, `stream_resolve_failed` `{ source, error_kind, providers_tried }`, `download_failed` `{ error_kind }`, `app_error` `{ scope, error_kind }` (uncaught frontend error / unhandled rejection; **capped at 20 per session** so a throwing render loop can't flood the backend or skew error rates), `scan_completed` `{ added_bucket, removed_bucket }`, `dependency_missing` `{ name }`

`tracks_bucket` / `*_bucket` are coarse ranges (`0`, `1-99`, `100-999`, `1k-10k`, `10k-50k`, `50k+`); `source` is a scheme class (`local` / `web` / `subsonic` / …). Never a title, path, URL, or query.

`error_kind` is a **closed enum** produced by `classifyErrorKind()` (`src/utils/errorKind.ts`) — one of `network`, `timeout`, `not_found`, `permission`, `auth`, `rate_limit`, `server`, `format`, `disk_full`, `cancelled`, `dependency`, `parse`, `unknown`. It exists so an error-rate spike says *what kind* of thing broke; the raw message is never sent and the classifier is unit-tested to guarantee it never echoes its input. Widening the enum is fine — passing text through is not. `scope` is likewise an enum (`window` / `rejection`).

Never sent: track/artist/album titles, file paths, library contents, error messages, stack traces, anything identifying a person. Users who want to send that detail do so deliberately via **Settings → Debug → Report a problem**, which builds a bundle they review and paste into a GitHub issue themselves (`src/utils/diagnosticReport.ts`) — a separate, explicitly-consented channel that never posts anywhere on its own.

## One-time setup on the VPS

1. **DNS**: add an `A` record `analytics.viboplr.com` → the VPS IP.
2. **Secrets**: `cp .env.example .env` and fill it in (see the generation
   commands in `.env.example`). Set `BASE_URL=https://analytics.viboplr.com`.
3. **Bring it up**:
   ```bash
   docker compose up -d
   ```
4. **Reverse proxy (Nginx Proxy Manager)**: add a Proxy Host
   - Domain: `analytics.viboplr.com`
   - Forward to: `aptabase` port `8080` (scheme `http`)
   - Request a Let's Encrypt cert (Force SSL + HTTP/2).
5. **Create the account + app**: open `https://analytics.viboplr.com`, register.
   If you left SMTP blank, grab the sign-in link from the logs:
   ```bash
   docker compose logs aptabase | grep -i "sign in\|magic\|http"
   ```
   Create an app (e.g. "Viboplr") and copy its **App Key** — it looks like
   `A-SH-1234567890` (`SH` = self-hosted).

## Wire the key into app builds

The app reads the key at **compile time** from the `APTABASE_APP_KEY` env var
(`option_env!` in `src-tauri/src/telemetry.rs`). With no key baked in, telemetry
is a complete no-op. Same convention as the Last.fm keys, because
`src-tauri/.cargo/config.toml` is **gitignored** (local-only, never in CI):

- **CI releases (GitHub Actions):** `release.yml`'s build job passes
  `APTABASE_APP_KEY: ${{ secrets.APTABASE_APP_KEY }}`. Add the repo secret once —
  **Settings → Secrets and variables → Actions → `APTABASE_APP_KEY` =
  `A-SH-0676964387`** — then cut a new tagged release. Without the secret, CI
  bakes no key and telemetry stays a silent no-op (this is the usual "it worked
  in dev but not in the release" cause).
- **Local builds:** add it to `src-tauri/.cargo/config.toml` under `[env]`
  (alongside the Last.fm keys), or set the env var for the build:
  `APTABASE_APP_KEY=A-SH-0676964387 npm run tauri build`.

The host in `telemetry.rs` (`APTABASE_HOST`) defaults to
`https://analytics.viboplr.com`; change it there if you move the instance.

## Maintenance

- Update: `docker compose pull && docker compose up -d`
- Logs: `docker compose logs -f aptabase`
- Backups: the Postgres (`pgdata`) and ClickHouse (`chdata`) volumes hold the
  dashboard config and the event history respectively.
