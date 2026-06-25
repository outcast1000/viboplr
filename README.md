# Viboplr

A cross-platform desktop music player for macOS and Windows built with Tauri 2, React, and Rust.

Viboplr plays audio and video from local folders and remote music services. It acts as an orchestrator — a plugin system connects to streaming providers, metadata services, lyric databases, and image sources, while the core app handles playback, library management, and UI. It scans local folders in the background, reads metadata tags, and builds a searchable library backed by SQLite. The player prioritizes fast startup, instant playback, and quick search.

## Features

### Library Management
- **Local Folders**: Scan folders with background progress reporting and real-time file watching
- **Remote Collections**: Connect to remote music services via plugins (streaming, sync, browse)
- **Smart Metadata**: Reads tags via `lofty`, with intelligent filename parsing fallback
- **Full-Text Search**: SQLite FTS5-powered search across titles, artists, albums, genres, and filenames
- **Tags**: Genre metadata from files stored as tags with many-to-many track relationships

### Playback
- **Native Codecs**: HTML5 audio/video elements using OS-native codecs via Tauri's asset protocol
- **Queue Management**: Drag-and-drop reorder, play next, shuffle
- **Crossfade**: Configurable smooth transitions between tracks
- **Auto-Continue**: Automatic playback continuation when queue ends (by artist, tag, most played, liked, or random)
- **Radio**: Start an endless station from any track, artist, or tag
- **Likes**: Tri-state like/dislike for tracks (plus likes for artists, albums, and tags), durable across library, queue, and now playing
- **Mini Player**: Compact mode with essential controls
- **Waveform Seek Bar**: Visual waveform display for seeking

### Views
- **Home**: Default landing page — radio-station carousel plus shelves (recently played, most played, jump back in, recently added)
- **Now Playing**: Lean-back full-screen view with synced karaoke lyrics; video tracks expand into a theater mode with ambient glow
- **Artists / Albums / Tags**: Browsable with breadcrumb navigation and card art
- **History**: Tabbed view — All Time, Last 30 Days, Recent, Artists — with arrow key navigation
- **Playlists**: Save, load, and manage playlists with cover art and thumbnail tracking; export/import as M3U8 or `.mixtape`
- **Collections**: Manage local folders and remote service connections

### Service Orchestration
- **Streaming**: Plugins provide stream resolution from various services — the core app chains them with configurable priority and fallback
- **Scrobbling & Metadata**: Plugin-driven scrobble reporting, listening history import, similar artists/tracks, bios, and community tags with TTL-based caching
- **Downloads**: Download tracks in FLAC, AAC, or MP3 with embedded tags and cover art via a pluggable download provider chain
- **Lyrics**: Synced and plain lyrics from multiple plugin providers with timed highlighting and auto-scroll
- **Image Providers**: Plugin-based artist/album art resolution with configurable fallback chains

### Skins
- **8 Built-in Skins**: Default, OLED Black, Arctic Light, Forest, Silver, Ocean Blue, Viboplr, Sunset
- **Custom Skins**: Import JSON skin files or install from community gallery
- **15 Color Tokens**: Full UI theming via CSS custom properties
- **Custom CSS**: Optional per-skin CSS overrides (sanitized)

### Plugins
- **Plugin System**: The primary extension mechanism — JavaScript plugins provide streaming, metadata, lyrics, image resolution, downloads, context menu items, sidebar views, event hooks, settings panels, and scheduler tasks
- **Built-in Plugins**: Last.fm (scrobbling, history import, similar artists/tracks, bios, community tags), lyrics (LRCLIB, Lyrics.ovh, Google), and artwork (TheAudioDB, Deezer, iTunes, MusicBrainz, Google Images)
- **Gallery Plugins**: Streaming and more, installed from the in-app gallery — Spotify, TIDAL (Hi-Fi), YouTube (play + download), Genius (song explanations), and P2P sharing
- **Native & User Plugins**: Built-in plugins bundled with the app; user plugins in profile directory (user plugins override native)
- **Structured Views**: Plugins render via data model (track lists, card grids, stats, text) — no raw HTML injection
- **Plugin Management**: Enable/disable plugins, reorder providers, and configure settings via Settings tabs

### Other
- **Track Properties Modal**: Tabbed view with metadata, tags, similar tracks, artist bio, album info
- **Entity Images**: Automatic artist/album art via plugin-based provider chain with configurable priority
- **Tag Composite Images**: Auto-generated from top artist images
- **Search Providers**: Configurable external search providers (custom and built-in)
- **Context Menu**: Right-click with "Open Containing Folder", search providers, properties
- **Auto Updates**: Built-in update checking and installation
- **Cross-Platform**: macOS and Windows

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| App shell | Tauri 2 | Native window, small binary |
| Backend | Rust | Scanning, DB, sync, downloads, API clients |
| Frontend | TypeScript + React + Vite | UI, playback, state management |
| Playback | HTML5 `<audio>` / `<video>` | OS-native codecs via webview |
| Database | SQLite via `rusqlite` + FTS5 | Embedded media library with full-text search |
| Tag reading | `lofty` | ID3v1/v2, Vorbis, FLAC, MP4, Opus tags |
| File watching | `notify` | Cross-platform filesystem events |
| Integrations | Plugin system | Streaming, scrobbling, metadata, lyrics, images |
| State persistence | `tauri-plugin-store` v2 | Save/restore UI state across restarts |

## Development

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

# Run all tests
npm run test:all
```

### Supported Formats

**Audio**: MP3, FLAC, AAC/M4A, WAV, ALAC, OPUS, WMA (best-effort)

**Video**: MP4 (H.264) on both platforms; WebM (VP8/VP9) on Windows only

## Project Structure

```text
viboplr/
├── src/                    # React frontend
│   ├── App.tsx             # Main app (state, views, layout)
│   ├── App.css             # All styles (CSS custom properties for skinning)
│   ├── types.ts            # Shared TypeScript types
│   ├── skinUtils.ts        # Skin validation, CSS generation, sanitization
│   ├── skins/              # Built-in skin JSON files (8 skins)
│   │   ├── index.ts            # Skin registry
│   │   ├── default.json
│   │   └── ...
│   ├── components/         # UI components (~46 files)
│   │   ├── TrackList.tsx       # Track table/list/tile views
│   │   ├── NowPlayingBar.tsx   # Playback footer controls
│   │   ├── QueuePanel.tsx      # Queue management
│   │   ├── Sidebar.tsx         # Navigation sidebar
│   │   ├── SettingsPanel.tsx   # Settings (General, Skins, Plugins, Providers, Debug)
│   │   ├── HistoryView.tsx     # Play history view
│   │   ├── CollectionsView.tsx # Collection management
│   │   ├── PlaylistsView.tsx  # Saved playlists grid/detail
│   │   ├── PluginViewRenderer.tsx # Plugin structured view rendering
│   │   ├── InformationSections.tsx # Plugin-provided metadata tabs
│   │   └── ...
│   ├── types/
│   │   ├── skin.ts             # Skin system type definitions
│   │   ├── plugin.ts           # Plugin system type definitions
│   │   └── informationTypes.ts # Info entity, fetch result, display kind types
│   └── hooks/              # React hooks (~27 files)
│       ├── usePlayback.ts      # Playback state
│       ├── useQueue.ts         # Queue management
│       ├── useLibrary.ts       # Library queries
│       ├── useSkins.ts         # Skin management and CSS injection
│       ├── usePlugins.ts       # Plugin discovery, loading, and runtime
│       └── ...
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── main.rs             # Entry point
│   │   ├── lib.rs              # Tauri setup, plugin/command registration
│   │   ├── commands.rs         # ~186 Tauri commands + AppState
│   │   ├── db.rs               # SQLite operations (~117 public functions)
│   │   ├── models.rs           # Shared data models
│   │   ├── scanner.rs          # Folder scanning
│   │   ├── watcher.rs          # File watching
│   │   ├── subsonic.rs         # Subsonic API client
│   │   ├── sync.rs             # Subsonic collection sync
│   │   ├── skins.rs            # Skin file I/O and gallery fetching
│   │   ├── downloader.rs       # Track download manager
│   │   ├── entity_image.rs     # Image slug management
│   │   ├── composite_image.rs  # Tag composite image generation
│   │   ├── plugins.rs          # Plugin management and file I/O
│   │   ├── image_provider/     # Image provider Rust-JS bridge
│   │   ├── lyric_provider/     # Lyric provider fallback chain
│   │   ├── timing.rs           # Startup profiling
│   │   └── seed.rs             # Debug-only test data seeding
│   ├── plugins/            # Built-in plugins (15+ plugins)
│   └── Cargo.toml
├── SPEC.md                 # Detailed specification
└── CLAUDE.md               # AI assistant guidance
```

## License

Viboplr is free software, licensed under the **GNU General Public License v3.0 or later** (GPL-3.0-or-later). You may use, study, modify, and redistribute it, but any distributed derivative must also be released under the GPL. See the [LICENSE](LICENSE) file for the full text.

Copyright (C) 2026 outcast1000.

All Rust and JavaScript dependencies are permissively licensed (MIT or Apache-2.0), so they impose no additional restrictions. The app invokes `ffmpeg` and `yt-dlp` as separate external processes (not linked), so their licenses do not affect Viboplr's. See SPEC.md for the dependency breakdown.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
