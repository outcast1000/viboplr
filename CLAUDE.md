# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
# Install frontend dependencies
npm install

# Run in development (starts both Vite dev server + Tauri app)
npm run tauri dev

# Build for production
npm run tauri build

# Check Rust compilation only (faster iteration)
cd src-tauri && cargo check

# Check release build (verifies cfg(debug_assertions) gating)
cd src-tauri && cargo check --release

# Type-check frontend only
npx tsc --noEmit
```

There are no tests in this project currently.

## Architecture

FastPlayer is a Tauri 2 desktop app: a Rust backend serves a React/TypeScript frontend rendered in a native webview.

### Backend (src-tauri/src/)

- **lib.rs** — Tauri app setup, plugin registration, command handler registration. Debug-only commands are conditionally included via `#[cfg(debug_assertions)]` using separate `get_invoke_handler()` functions.
- **commands.rs** — All `#[tauri::command]` functions. Each takes `State<'_, AppState>` (which holds `Arc<Database>`) and delegates to `db.rs`. Commands return `Result<T, String>`.
- **db.rs** — SQLite wrapper behind `Mutex<Connection>`. Owns schema creation, CRUD for artists/albums/tags/tracks/folders, FTS5 full-text search index. Registers a custom `filename_from_path()` SQL function.
- **scanner.rs** — Walks folder trees with `walkdir`, reads tags with `lofty`, falls back to regex-based filename parsing. Reads genre metadata from files and stores them as tags. Called from a background thread in `add_folder`.
- **watcher.rs** — Uses `notify` crate for real-time filesystem events, calling scanner functions for create/modify/remove.
- **models.rs** — Serde-serializable structs (Artist, Album, Tag, Track, FolderInfo, ScanProgress) shared between commands and DB layer.
- **seed.rs** — Debug-only module (`#[cfg(debug_assertions)]`). Seeds the database with fake artists/albums/tracks/tags using a simple LCG PRNG (no external dependencies).

### Frontend (src/)

- **App.tsx** — Single-file React app. Contains all state, views (all tracks, artists, albums, tags), search, playback controls, context menu, and the sidebar. No routing library; views are toggled via a `View` union type (`"all" | "artists" | "albums" | "tags"`).
- **App.css** — All styles. The layout is a sidebar + main content + fixed footer (now-playing bar).

### Key Patterns

- **IPC**: Frontend calls backend via `invoke<T>("command_name", { args })` from `@tauri-apps/api/core`. Backend emits events (e.g., `scan-progress`, `scan-complete`) via `app.emit()`.
- **Playback**: Uses native HTML5 `<audio>` and `<video>` elements with Tauri's `convertFileSrc()` to serve local files via `asset://` protocol. Video formats determined by extension (mp4, m4v, mov, webm). No streaming or custom decoder.
- **Database concurrency**: Single `Mutex<Connection>` — all DB access is serialized. Background scanning and file watching run on separate threads.
- **FTS**: The `tracks_fts` virtual table is a contentless FTS5 table. It must be fully rebuilt (`db.rebuild_fts()`) after bulk inserts; it is not incrementally updated during scanning.
- **Tags**: Many-to-many relationship between tracks and tags via `track_tags` junction table. Genre metadata from file tags is stored as tags. A track can have multiple tags. The FTS index includes `tag_names` (comma-separated via `GROUP_CONCAT`).
- **Debug gating**: The `seed` module and `seed_database` command are excluded from release builds via `#[cfg(debug_assertions)]`. The frontend seed button is gated by `import.meta.env.DEV`.
- **Context menu**: Right-click on a track opens a context menu with "Open Containing Folder" which calls `show_in_folder` (platform-specific: macOS/Windows/Linux).

### Database Schema

Tables: `artists`, `albums`, `tags`, `track_tags`, `tracks`, `folders`, `tracks_fts` (FTS5 virtual table). Albums have a UNIQUE constraint on `(title, artist_id)`. Tracks are unique on `path` with upsert semantics. Tags use a many-to-many junction table (`track_tags`) with CASCADE deletes.
