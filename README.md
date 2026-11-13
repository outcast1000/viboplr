# Vibo

A music player for macOS and Windows. It plays the music you already have: folders on your disk and Subsonic or Navidrome servers, in one library and one queue. Free and open source (GPL-3.0).

Website: [viboplr.com](https://viboplr.com) · [Download](https://viboplr.com/download.html) · [Features](https://viboplr.com/features.html) · [Help](https://viboplr.com/help.html)

- **Fast and light.** Rust backend, SQLite library with full-text search, and the system's own webview instead of a bundled browser engine. The download is about 30 MB, playback engine included. Searching a 20,000-track test library takes under 40 ms (`cd src-tauri && cargo test bench_search_performance -- --ignored --nocapture`).
- **Plugins.** Anything that talks to an outside service is a plugin: Last.fm, online lyrics, cover art, YouTube through yt-dlp, Spotify browsing, Soulseek and others. A plugin is a `manifest.json` and an `index.js` in plain JavaScript, with no build step. See [writing a plugin](https://viboplr.com/plugin-dev.html).
- **AI control and an API.** An optional local server lets an AI assistant (over MCP) or your own scripts (over HTTP) run the player. It is off by default. See [below](#ai-control-and-the-control-api).

## What it does

- **Library:** local folders, scanned in the background and watched for changes; Subsonic and Navidrome servers in the same library. Tags are read from the files, and an album belongs to its album artist, so compilations stay one album. Search ignores accents and case.
- **Playback:** audio and video through a bundled libmpv. Gapless playback, crossfade up to 10 seconds, bit-perfect and exclusive output, ReplayGain, a 10-band equalizer, playback speed.
- **Listening:** radio from any song, artist or tag, built from your library; auto-continue when the queue ends; a home screen with recent plays, mixes and albums you haven't played in a while; synced lyrics; a mini player.
- **Editing:** bulk tag edits written into the files; likes and play history that survive a rescan; likes export to a file.
- **Playlists:** saved playlists, M3U8 import and export, and `.mixtape` files that carry the music with them.
- **Skins:** 8 built-in, more in the [skin gallery](https://viboplr.com/skins.html). A skin is 19 colors and optional CSS.
- **Other:** separate profiles, native context menus, a "Report a problem" bundle you review before sending, and update checks with an opt-in beta channel. Nothing installs without your click.

The full list is on the [features page](https://viboplr.com/features.html).

## AI control and the control API

Turn on **Settings → AI control**. Vibo starts a server on `127.0.0.1` only; every request needs an access token.

- **MCP.** A bundled MCP server presents the app to Claude Desktop, Claude Code or any MCP client as typed tools. Settings has **Copy config** (Claude Desktop) and **Copy command** (Claude Code). The assistant can search the library, play and queue music, edit playlists and tags, start radio, run read-only SQL over the library and play history, and call installed plugins' own tools (`<pluginId>__<tool>`).
- **HTTP.** The same server is a plain JSON API for your own scripts. [`skills/viboplr-control/SKILL.md`](skills/viboplr-control/SKILL.md) documents every endpoint.

Reading and playback need only the main switch. Writing tags into files, managing files, downloading, plugin actions, deleting and clicking in the window each have their own switch, all off at first. File moves, file swaps and deletions return a plan first and are applied only by a second call that sends the plan back; deleted tracks go to the trash. The token never reaches the model. The API cannot delete playlists, and extensions are installed only through the app's own dialog.

The tool catalog is [`mcp/tools.mjs`](mcp/tools.mjs); setup details are in [`mcp/README.md`](mcp/README.md).

## Architecture

```mermaid
flowchart TB
    A["AI assistant<br/>Claude Desktop · Claude Code · Cursor · any MCP client"]
    MCP["MCP server (Node, bundled)<br/>mcp/viboplr-mcp.mjs · tool catalog mcp/tools.mjs"]

    subgraph App["Vibo app (Tauri 2)"]
        subgraph Rust["Rust backend"]
            API["Control API<br/>axum · 127.0.0.1 · bearer token · permission switches"]
            CORE["Library core<br/>scanner · watcher · Subsonic sync<br/>downloads · file ops · scoped fetch<br/><i>music folders · servers · internet</i>"]
            DB[("SQLite + FTS5<br/>library · history · likes")]
            MPV["mpv engine<br/>bundled libmpv<br/><i>audio device · video</i>"]
        end
        subgraph Web["Webview: React + TypeScript"]
            DISP["Control-API dispatcher<br/>useControlApi.ts"]
            UI["UI"]
            ACT["Canonical actions<br/>queue · playlists · tags · likes · radio"]
            HOST["Plugin host<br/>permission checks"]
        end
        subgraph Plugins["Plugins: sandboxed Web Workers"]
            PL["Streaming · metadata · lyrics · artwork<br/>downloads · plugin tools"]
        end
    end

    A <-->|"MCP over stdio"| MCP
    MCP <-->|"HTTP + token"| API
    API -->|"reads"| DB
    API <-->|"mutations & playback<br/>(control-api-request event)"| DISP
    UI --> ACT
    DISP --> ACT
    DISP -->|"plugin tools"| HOST
    ACT -->|"Tauri invoke"| CORE
    ACT -->|"Tauri invoke"| MPV
    HOST <-->|"api.* RPC"| PL
    PL -.->|"api.assistant.host<br/>same tool catalog"| HOST
    HOST -->|"scoped fetch"| CORE
    CORE --> DB
```

- **Rust backend** owns everything stateful or native: the SQLite library, folder scanning and watching, Subsonic sync, file operations and downloads, the libmpv playback engine, and the localhost control API.
- **The webview** (React + TypeScript) renders the UI and holds the *canonical actions*, the one code path for each user action (enqueue, like, tag, start radio, …).
- **The control API answers pure reads from the database directly.** Everything else (playback, the live queue, every mutation) is bridged into the webview and runs through those same canonical actions. A request from an assistant therefore takes the same path as a click, and the UI, plugin events and persisted state stay in sync.
- **The MCP server** is a thin, dependency-free translation layer. It discovers the running app, holds the token, and presents `tools.mjs` as typed tools. Capability decisions belong to the Rust API alone.
- **Plugins** run in their own Web Workers with no Tauri IPC, no DOM and no network globals. Their only way out is the `api.*` proxy, which the plugin host checks against each manifest's declared permissions. Network access goes through a host-scoped fetch in Rust. Plugins can also contribute MCP tools, and in-app agent plugins reach the same tool catalog through `api.assistant.host`.

## Built with AI

The code was written by an AI coding assistant, directed and reviewed by one person. The repository is set up for that, and a contributor's assistant picks up the same setup:

- [`CLAUDE.md`](CLAUDE.md): build commands, architecture, and features that were removed on purpose.
- [`.claude/rules/`](.claude/rules): detailed rules, loaded when matching files are touched. `conventions.md` holds the one implementation of each repeated user action.
- [`.claude/skills/`](.claude/skills): repeatable workflows (releasing, code-health and CSS audits, DB benchmarks).
- ESLint enforces the conventions that matter, and `npm run test:all` runs lint, Rust, TypeScript and Playwright tests.

## Tech stack

| Layer | Technology |
|-------|-----------|
| App shell | Tauri 2 |
| Backend | Rust |
| Frontend | TypeScript, React, Vite |
| Playback | libmpv (bundled) |
| Database | SQLite via `rusqlite`, FTS5 full-text search |
| Tag reading | `lofty` |
| File watching | `notify` |
| Control API | `axum` on 127.0.0.1, plus a Node MCP server |
| Plugins | JavaScript, with declared permissions |

## Supported formats

**Audio:** MP3, FLAC, AAC/M4A, ALAC, WAV, Opus, WMA, OGG/OGA, SPX, AIFF, APE, WavPack, TTA, DSF/DFF (DSD), Musepack, MKA, CAF.

**Video:** MP4/M4V/MOV, WebM, MKV, AVI, WMV.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full guide.

### Prerequisites

- Node.js 18+
- Rust 1.70+
- Platform-specific Tauri requirements ([see Tauri docs](https://tauri.app/v2/guides/prerequisites/))

### Running in Development

```bash
npm install
npm run tauri dev
```

### Building for Production

```bash
node scripts/fetch-libmpv.mjs   # vendor the pinned libmpv (bundled into the build)
npm run tauri build
```

### Useful Commands

```bash
# Check Rust compilation only (faster iteration)
cd src-tauri && cargo check

# Check release build (verifies cfg(debug_assertions) gating)
cd src-tauri && cargo check --release

# Type-check frontend only
npx tsc --noEmit

# Lint
npm run lint

# Run all tests (lint + Rust + TS + E2E)
npm run test:all
```

## Deploy the Static Website to a VPS

The website is the `docs/` folder. You can deploy it to your own VPS using the included script.

### 1) One-time VPS setup

- Create a web root folder on your VPS (example: `/var/www/viboplr-site`)
- Point your web server (Nginx/Apache/Caddy) at that folder
- Set up SSH key auth from your machine to the VPS user

### 2) Deploy from this repo

Run with explicit arguments:

```powershell
npm run deploy:site:vps -- -Host your.vps.ip.or.domain -User youruser -RemotePath /var/www/viboplr-site
```

Or set environment variables once (PowerShell):

```powershell
$env:VPS_HOST = "your.vps.ip.or.domain"
$env:VPS_USER = "youruser"
$env:VPS_PATH = "/var/www/viboplr-site"
$env:VPS_PORT = "22"
npm run deploy:site:vps
```

The deploy script archives `docs/`, uploads it over SSH, and publishes it into your VPS target directory. If `rsync` is available on the VPS, it performs a synced deploy with `--delete`; otherwise it replaces the directory contents.

### 3) Automatic deploy via GitHub Actions

The workflow `.github/workflows/deploy-vps.yml` deploys `docs/` to your VPS over SSH (private-key auth) on every push to `main` that touches `docs/`, and can also be run manually from the Actions tab.

Add these repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Description | Example |
|--------|-------------|---------|
| `VPS_SSH_PRIVATE_KEY` | The private key (full contents, including header/footer lines) whose public key is in the VPS user's `~/.ssh/authorized_keys` | `-----BEGIN OPENSSH PRIVATE KEY-----` ... |
| `VPS_HOST` | VPS hostname or IP | `your.vps.ip.or.domain` |
| `VPS_USER` | SSH user on the VPS | `youruser` |
| `VPS_PATH` | Absolute web root path on the VPS | `/var/www/viboplr-site` |
| `VPS_PORT` | SSH port (optional, defaults to `22`) | `22` |

Generate a dedicated deploy key pair (recommended) and authorize it on the VPS:

```bash
ssh-keygen -t ed25519 -C "viboplr-deploy" -f viboplr-deploy -N ""
ssh-copy-id -i viboplr-deploy.pub youruser@your.vps.ip.or.domain
```

Then paste the contents of the private key file (`viboplr-deploy`) into the `VPS_SSH_PRIVATE_KEY` secret. The workflow pins the host key via `ssh-keyscan` and uses `rsync -az --delete` for a clean synced deploy.

## License

Vibo is free software, licensed under the **GNU General Public License v3.0 or later** (GPL-3.0-or-later). You may use, study, modify, and redistribute it, but any distributed derivative must also be released under the GPL. See the [LICENSE](LICENSE) file for the full text.

Copyright (C) 2026 outcast1000.

All Rust and JavaScript dependencies are permissively licensed (MIT or Apache-2.0), so they impose no additional restrictions. libmpv is loaded at runtime as a separate library, and the app invokes `ffmpeg` and `yt-dlp` as separate external processes (not linked), so their licenses do not affect Vibo's.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
