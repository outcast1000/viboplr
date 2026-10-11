# Vibo

**The music player you can just talk to, built by talking to an AI.**

Vibo is a free, open-source desktop music player for macOS and Windows, and it is AI-native in both directions:

- **Driven by AI.** A built-in [MCP](https://modelcontextprotocol.io) server lets Claude, or any AI assistant, run your music library. Ask it to build playlists, fix tags, organise folders, download tracks, or tell you what you played most last March.
- **Built by AI.** Every line of code was written by an AI coding assistant (Claude Code). The human role is tech lead and product owner: decide what to build, define how it behaves, review, test, and push back until it's right. [The story →](https://viboplr.com/story.html)

Under the hood it's a Tauri 2 app with a Rust backend and a React frontend. It plays audio and video from local folders and Subsonic/Navidrome servers, and works as an orchestrator: a plugin system connects streaming providers, metadata services, lyric databases and image sources, while the core handles playback, the library and the UI. Its SQLite library starts fast, plays instantly and searches big collections in milliseconds.

## AI Control (MCP)

Vibo ships its own MCP server, so an AI assistant gets real, typed tools for your music library instead of screen-scraping. Turn on **Settings → AI control**, press **Copy config** (Claude Desktop) or **Copy command** (Claude Code), and paste it into your client.

> *"Tag everything by Boards of Canada as ambient, and file the compilations under Various Artists."*
> *"Sort the loose files in my Music folder into Artist/Album."*
> *"Make me a playlist of songs I loved and haven't played this year."*

- **Listen**: search, play, queue, skip, start radio, like, and drive the window and views
- **Curate**: create and edit playlists, edit tags in bulk, rename listening history
- **Ask**: read-only SQL over the library and play history ("what did I play most last March?"), lyrics, bios, and reviews
- **Care for the collection**: write tags into the files, file compilations under an album artist, save lyrics and cover files, move and rename files into a clean layout
- **Get music**: download a track from its own source (Subsonic or a direct URL) or through a download plugin, and upgrade a file in place (MP3 → FLAC) after a side-by-side quality check
- **Use plugins**: every installed plugin can expose its own tools (read a Spotify playlist, search Soulseek, …), surfaced as `<pluginId>__<tool>`

**Bounded by design.** It's off by default, binds to `127.0.0.1` only, and every request needs a bearer token that never reaches the model. Reading and playback need nothing more than the toggle. Anything that touches files (tag writes, file management, downloads, plugin actions) has its own permission switch, and all of them start off. Moves and file swaps are planned first and applied only on a second, confirming call. Every applied write is logged. The API can never delete tracks, playlists or files, and can never install extensions.

The tool catalog lives in [`mcp/tools.mjs`](mcp/tools.mjs). Setup details are in [`mcp/README.md`](mcp/README.md), and the HTTP surface is documented in [`skills/viboplr-control/SKILL.md`](skills/viboplr-control/SKILL.md).

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

Vibo is also an experiment in how software gets made. It's a full-featured player (bit-perfect gapless playback, synced lyrics, radio, mixtapes, skins, a sandboxed plugin runtime, its own MCP server) built by one person directing an AI coding assistant, with every line of code written by the AI.

The repository is set up for that way of working, and it is the same setup a contributor's assistant picks up:

- **[`CLAUDE.md`](CLAUDE.md)** is the project brief: build commands, architecture, and the features that were removed on purpose and must not come back.
- **[`.claude/rules/`](.claude/rules)** holds the detailed rules, loaded only when matching files are touched: `conventions.md` (the canonical implementation of every repeated user action, plus cross-cutting rules), and `backend`, `frontend`, `queue`, `plugins`, `ui`, `testing` and `site`.
- **[`.claude/skills/`](.claude/skills)** contains repeatable workflows such as releasing, code-health and CSS audits, DB benchmarks, and the drag-and-drop pattern for WKWebView.
- **Guardrails are machine-checked.** ESLint enforces the conventions that matter (no silent `catch`, no ref writes during render), and `npm run test:all` runs lint, Rust, TypeScript and Playwright E2E tests before anything ships.

The two halves meet in the product: an app written by an AI, designed from day one to be operated by one.

## Features

### Library Management
- **Local Folders**: Scan folders with background progress reporting and real-time file watching
- **Music Servers**: Subsonic / Navidrome collections synced into the same library
- **Remote Collections**: Connect to streaming services via plugins (streaming, sync, browse)
- **Publish & Subscribe**: Export local tracks as a self-contained, hostable music source (manifest + files), and subscribe to published manifests as collections
- **Smart Metadata**: Reads tags via `lofty`, with intelligent filename parsing fallback
- **Full-Text Search**: SQLite FTS5-powered search across titles, artists, albums, genres, and filenames — accent- and case-insensitive
- **Tags**: Genre metadata from files stored as tags with many-to-many track relationships

### Playback
- **Native mpv Engine**: The default engine, built on bundled libmpv — native decode of every supported format, sample-accurate gapless playback, and exclusive (bit-perfect) audio output; native video rendering on macOS and Windows
- **Browser Engine Fallback**: HTML5 audio/video via the system webview — used automatically when mpv can't play a track
- **10-Band Equalizer & ReplayGain**: Simple bass/treble or advanced parametric EQ, plus tag-based volume normalization
- **Crossfade & Gapless**: Configurable crossfade up to 10s; at 0, tracks transition gapless
- **Playback Speed**: Turntable-style speed control (pitch follows tempo)
- **Queue Management**: Drag-and-drop reorder, play next, shuffle, duplicate detection
- **Auto-Continue**: Automatic playback continuation when the queue ends (by artist, tag, most played, liked, or random — user-weighted)
- **Radio**: Start an endless station from any track, artist, or tag
- **Likes**: Tri-state like/dislike for tracks (plus likes for artists, albums, and tags), durable across library, queue, and now playing; export/import as a portable file
- **Mini Player**: Compact always-on-top mode with essential controls
- **Waveform Seek Bar**: Visual waveform display for seeking; video tracks get storyboard seek previews

### Views
- **Home**: Default landing page — radio-station carousel plus shelves (recently played, most played, jump back in, recently added, liked; plugins can add more)
- **Now Playing**: Lean-back full-screen view with synced karaoke lyrics and plugin visualizers; video tracks expand into a theater mode
- **Artists / Albums / Tags / Tracks**: Detail pages with hero headers, breadcrumb navigation, and plugin information sections
- **History**: Tabbed view — All Time, Last 30 Days, Recent, Artists — with arrow key navigation
- **Playlists**: Save, load, and manage playlists with cover art and thumbnail tracking; export/import as M3U8 or `.mixtape` bundles
- **Collections**: Manage local folders, music servers, and subscribed sources

### Service Orchestration
- **Streaming**: Plugins provide stream resolution from various services — the core app chains them with configurable priority and fallback
- **Scrobbling & Metadata**: Plugin-driven scrobble reporting, listening history import, similar artists/tracks, bios, and community tags with TTL-based caching
- **Downloads**: Download tracks with embedded tags and cover art — the downloader always follows the track's source (Subsonic, direct URL, or the owning plugin)
- **Lyrics**: Synced and plain lyrics from multiple plugin providers with timed highlighting, auto-scroll, and per-track timing offset
- **Image Providers**: Plugin-based artist/album art resolution with configurable fallback chains

### Skins
- **8 Built-in Skins**: Default, OLED Black, Arctic Light, Forest, Silver, Ocean Blue, Vibo, Sunset
- **Custom Skins**: Import JSON skin files or install from the community gallery
- **19 Color Tokens**: Full UI theming via CSS custom properties
- **Custom CSS**: Optional per-skin CSS overrides (sanitized)

### Plugins
- **Plugin System**: The primary extension mechanism — JavaScript plugins provide streaming, metadata, lyrics, image resolution, downloads, context menu items, sidebar views, home shelves, now-playing info items, visualizers, event hooks, settings panels, and scheduler tasks
- **Built-in Plugins**: Last.fm (scrobbling, history import, similar artists/tracks, bios, community tags), lyrics (LRCLIB, Lyrics.ovh), and artwork (TheAudioDB, Deezer, iTunes, MusicBrainz)
- **Gallery Plugins**: Installed from the in-app gallery — Spotify, TIDAL (Hi-Fi), YouTube via yt-dlp (search, play, download), Genius (song explanations), qBittorrent, visualizers, and more
- **Structured Views**: Plugins render via a data model (track lists, card grids, stats, text) — no raw HTML injection
- **Plugin Management**: Enable/disable plugins, toggle individual contributions, reorder providers, auto-update, and configure settings via the Extensions view

### Other
- **Profiles**: Chrome-like isolated profiles (library, settings, plugins per profile)
- **Onboarding Wizard**: First-run setup — usage profile, skin, sources, recommended plugins, companion tools
- **Managed Dependencies**: External tools plugins rely on (ffmpeg, yt-dlp) are detected, installed, and auto-updated by the app
- **Entity Images**: Automatic artist/album art via plugin-based provider chain with configurable priority
- **Tag Composite Images**: Auto-generated from top artist images
- **Context Menus**: Native OS right-click menus everywhere, with plugin-registered actions on every track surface
- **Report a Problem**: One-click diagnostic bundle (reviewed and submitted by the user — nothing is auto-sent)
- **Auto Updates**: Built-in update checking and installation (stable and opt-in beta channels)
- **Cross-Platform**: macOS and Windows

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| App shell | Tauri 2 | Native window, small binary |
| Backend | Rust | Scanning, DB, sync, playback engine, API clients |
| Frontend | TypeScript + React + Vite | UI, playback control, state management |
| Playback | libmpv (bundled) + HTML5 fallback | Native decode, gapless, exclusive output; webview codecs as fallback |
| Database | SQLite via `rusqlite` + FTS5 | Embedded media library with full-text search |
| Tag reading | `lofty` | ID3v1/v2, Vorbis, FLAC, MP4, Opus tags |
| File watching | `notify` | Cross-platform filesystem events |
| Integrations | Plugin system | Streaming, scrobbling, metadata, lyrics, images |
| AI control | `axum` control API + Node MCP server | Localhost, token-protected API presented to assistants as MCP tools |
| State persistence | `tauri-plugin-store` v2 | Save/restore UI state across restarts |

## Supported Formats

**Audio** (all decoded natively by the bundled mpv engine): MP3, FLAC, AAC/M4A, ALAC, WAV, OPUS, WMA, OGG/OGA, SPX, AIFF, APE, WavPack, TTA, DSF/DFF (DSD), Musepack, MKA, CAF. On the browser fallback engine, only the webview-native formats play.

**Video**: MP4/M4V/MOV (H.264) on both platforms; WebM (VP8/VP9) on Windows only via the browser engine. The mpv engine renders video natively on macOS and Windows.

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

The marketing/docs website is the `docs/` folder. You can deploy it to your own VPS using the included script.

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
