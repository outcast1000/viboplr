# Viboplr

A cross-platform desktop music player for macOS and Windows built with Tauri 2, React, and Rust.

Viboplr plays audio and video from local folders, Subsonic/Navidrome servers, and TIDAL. It scans local folders in the background, reads metadata tags, and builds a searchable library backed by SQLite. The player prioritizes fast startup, instant playback, and quick search.

## Features

### Library Management
- **Local Folders**: Scan folders with background progress reporting and real-time file watching
- **Subsonic/Navidrome**: Connect to remote music servers with token or digest authentication
- **TIDAL**: Search, browse, and stream from the TIDAL catalog with instance failover
- **Smart Metadata**: Reads tags via `lofty`, with intelligent filename parsing fallback
- **Full-Text Search**: SQLite FTS5-powered search across titles, artists, albums, genres, and filenames
- **Tags**: Genre metadata from files stored as tags with many-to-many track relationships

### Playback
- **Native Codecs**: HTML5 audio/video elements using OS-native codecs via Tauri's asset protocol
- **Queue Management**: Drag-and-drop reorder, play next, shuffle
- **Crossfade**: Configurable smooth transitions between tracks
- **Auto-Continue**: Automatic playback continuation when queue ends (by artist, tag, most played, liked, or random)
- **Mini Player**: Compact mode with essential controls
- **Waveform Seek Bar**: Visual waveform display for seeking

### Views
- **All Tracks**: Full library with table, list, and tile view modes
- **Artists / Albums / Tags**: Browsable with breadcrumb navigation and card art
- **Liked Tracks**: Filtered view of liked tracks
- **History**: Most played (all time / last 30 days), top artists, recent plays
- **Collections**: Manage local folders, Subsonic servers, and TIDAL sources
- **TIDAL**: Search and browse the TIDAL catalog

### Integrations
- **Last.fm Scrobbling**: Real-time now-playing updates and scrobble reporting
- **Last.fm History Import**: Import complete scrobble history with progress tracking and cancellation
- **Last.fm Metadata**: Similar artists/tracks, artist bios, album wiki, community tag suggestions — all cached with 90-day TTL
- **Last.fm Love Sync**: Like/unlike tracks synced to Last.fm love/unlove
- **TIDAL Streaming**: Search, browse albums/artists, and stream tracks
- **Downloads**: Download tracks from Subsonic/TIDAL in FLAC, AAC, or MP3 with embedded tags and cover art
- **YouTube URL Storage**: Associate YouTube URLs with tracks

### Skins
- **8 Built-in Skins**: Default, OLED Black, Arctic Light, Forest, Silver, Ocean Blue, Viboplr, Sunset
- **Custom Skins**: Import JSON skin files or install from community gallery
- **13 Color Tokens**: Full UI theming via CSS custom properties
- **Custom CSS**: Optional per-skin CSS overrides (sanitized)

### Other
- **Track Properties Modal**: Tabbed view with metadata, tags, similar tracks (with play/TIDAL/YouTube actions), artist bio, album wiki
- **Entity Images**: Automatic artist/album art from Tidal, Deezer, iTunes, AudioDB, MusicBrainz, and embedded tags
- **Tag Composite Images**: Auto-generated from top artist images
- **Search Providers**: Configurable external search (Google, Last.fm, YouTube, Genius, custom)
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
| Scrobbling | Last.fm API | Now-playing, scrobble, history import |
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
│   ├── types/
│   │   └── skin.ts             # Skin system type definitions
│   ├── skins/              # Built-in skin JSON files (8 skins)
│   │   ├── index.ts            # Skin registry
│   │   ├── default.json
│   │   └── ...
│   ├── components/         # UI components (~28 files)
│   │   ├── TrackList.tsx       # Track table/list/tile views
│   │   ├── NowPlayingBar.tsx   # Playback footer controls
│   │   ├── QueuePanel.tsx      # Queue management
│   │   ├── Sidebar.tsx         # Navigation sidebar
│   │   ├── SettingsPanel.tsx   # Settings (General, Skins, TIDAL, Last.fm, Providers, About, Debug)
│   │   ├── HistoryView.tsx     # Play history view
│   │   ├── TidalView.tsx       # TIDAL search/browse
│   │   ├── CollectionsView.tsx # Collection management
│   │   └── ...
│   └── hooks/              # React hooks (~17 files)
│       ├── usePlayback.ts      # Playback state
│       ├── useQueue.ts         # Queue management
│       ├── useLibrary.ts       # Library queries
│       ├── useSkins.ts         # Skin management and CSS injection
│       └── ...
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── main.rs             # Entry point
│   │   ├── lib.rs              # Tauri setup, plugin/command registration
│   │   ├── commands.rs         # ~107 Tauri commands + AppState
│   │   ├── db.rs               # SQLite operations (~67 public functions)
│   │   ├── models.rs           # Shared data models
│   │   ├── scanner.rs          # Folder scanning
│   │   ├── watcher.rs          # File watching
│   │   ├── lastfm.rs           # Last.fm API client (scrobble, love, similar, metadata)
│   │   ├── subsonic.rs         # Subsonic API client
│   │   ├── tidal.rs            # TIDAL API client
│   │   ├── sync.rs             # Subsonic collection sync
│   │   ├── skins.rs            # Skin file I/O and gallery fetching
│   │   ├── downloader.rs       # Track download manager
│   │   ├── entity_image.rs     # Image slug management
│   │   ├── composite_image.rs  # Tag composite image generation
│   │   ├── image_provider/     # Image provider fallback chain (6 providers)
│   │   ├── timing.rs           # Startup profiling
│   │   └── seed.rs             # Debug-only test data seeding
│   └── Cargo.toml
├── SPEC.md                 # Detailed specification
└── CLAUDE.md               # AI assistant guidance
```

## License

All Rust dependencies are MIT or Apache-2.0 licensed (no GPL/LGPL). See SPEC.md for details.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
