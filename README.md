# FastPlayer

A lightweight, cross-platform media player for macOS and Windows built with Tauri 2, React, and Rust.

FastPlayer plays audio and video files, scans local folders in the background, reads metadata tags, and builds a searchable library backed by SQLite. The player prioritizes fast startup, instant playback, and quick search.

## Features

- **Fast Scanning**: Background folder scanning with progress reporting
- **Smart Metadata**: Reads tags via `lofty`, with intelligent filename parsing fallback
- **Full-Text Search**: SQLite FTS5-powered search across titles, artists, albums, genres, and filenames
- **File Watching**: Automatic library updates when files change
- **Native Playback**: HTML5 audio/video elements using OS-native codecs
- **Cross-Platform**: macOS and Windows support

## Tech Stack

- **Frontend**: React + TypeScript + Vite
- **Backend**: Rust (Tauri 2)
- **Database**: SQLite with FTS5
- **Tag Reading**: lofty
- **File Watching**: notify

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

## Implementation Notes

### Search Index

The full-text search index uses a custom SQLite function `filename_from_path()` (implemented in Rust) to properly extract filenames from full paths. This ensures that filenames with characters appearing in directory paths are correctly indexed.

The search index is automatically rebuilt after folder scans, but can also be manually triggered via the `rebuild_search_index` command if needed.

### Supported Formats

**Audio**: MP3, FLAC, AAC/M4A, WAV, ALAC, OPUS, WMA (best-effort)

**Video**: MP4 (H.264) on both platforms; WebM (VP8/VP9) on Windows only

## Project Structure

```text
fastplayer/
├── src/              # React frontend
├── src-tauri/        # Rust backend
│   ├── src/
│   │   ├── main.rs   # Entry point
│   │   ├── lib.rs    # Tauri setup
│   │   ├── db.rs     # Database operations
│   │   ├── scanner.rs # Folder scanning
│   │   ├── watcher.rs # File watching
│   │   ├── commands.rs # Tauri commands
│   │   └── models.rs  # Data models
│   └── Cargo.toml
└── SPEC.md          # Detailed specification
```

## License

See SPEC.md for dependency licenses (all MIT or Apache-2.0, no GPL/LGPL).

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
