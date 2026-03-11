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
- **db.rs** — SQLite wrapper behind `Mutex<Connection>`. Owns schema creation, CRUD for artists/albums/genres/tracks/folders, FTS5 full-text search index. Registers a custom `filename_from_path()` SQL function.
- **scanner.rs** — Walks folder trees with `walkdir`, reads tags with `lofty`, falls back to regex-based filename parsing. Called from a background thread in `add_folder`.
- **watcher.rs** — Uses `notify` crate for real-time filesystem events, calling scanner functions for create/modify/remove.
- **models.rs** — Serde-serializable structs (Artist, Album, Genre, Track, FolderInfo, ScanProgress) shared between commands and DB layer.
- **seed.rs** — Debug-only module (`#[cfg(debug_assertions)]`). Seeds the database with fake artists/albums/tracks using a simple LCG PRNG (no external dependencies).

### Frontend (src/)

- **App.tsx** — Single-file React app. Contains all state, views (all tracks, artists, albums), search, playback controls, and the sidebar. No routing library; views are toggled via a `View` union type.
- **App.css** — All styles. The layout is a sidebar + main content + fixed footer (now-playing bar).

### Key Patterns

- **IPC**: Frontend calls backend via `invoke<T>("command_name", { args })` from `@tauri-apps/api/core`. Backend emits events (e.g., `scan-progress`, `scan-complete`) via `app.emit()`.
- **Playback**: Uses native HTML5 `<audio>` and `<video>` elements with Tauri's `convertFileSrc()` to serve local files via `asset://` protocol. No streaming or custom decoder.
- **Database concurrency**: Single `Mutex<Connection>` — all DB access is serialized. Background scanning and file watching run on separate threads.
- **FTS**: The `tracks_fts` virtual table is a contentless FTS5 table. It must be fully rebuilt (`db.rebuild_fts()`) after bulk inserts; it is not incrementally updated during scanning.
- **Debug gating**: The `seed` module and `seed_database` command are excluded from release builds via `#[cfg(debug_assertions)]`. The frontend seed button is gated by `import.meta.env.DEV`.

### Database Schema

Tables: `artists`, `albums`, `genres`, `tracks`, `folders`, `tracks_fts` (FTS5 virtual table). Albums have a UNIQUE constraint on `(title, artist_id)`. Tracks are unique on `path` with upsert semantics.
