# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm install                          # Install frontend dependencies
npm run tauri dev                    # Dev mode (Vite + Tauri)
npm run tauri build                  # Production build
cd src-tauri && cargo check          # Rust compilation check
cd src-tauri && cargo check --release # Release build check (verifies cfg gating)
npx tsc --noEmit                     # TypeScript type-check
npm run test:all                     # All tests (Rust + TS + E2E)
npm test                             # TypeScript tests only
npm run test:rust                    # Rust tests only
npm run test:e2e                     # Playwright E2E tests
cd src-tauri && cargo test bench_search_performance -- --ignored --nocapture  # DB benchmarks
```

## Architecture

Viboplr is a Tauri 2 desktop app: a Rust backend serves a React/TypeScript frontend rendered in a native webview.

**Two track types:** `Track` (full library type with DB IDs) is used by library list views. `QueueTrack` (metadata-only, no `id`/`album_id`/`artist_id`) is used by queue, now-playing, and playlists. Queue/playback surfaces never rely on DB IDs — they use name-based image lookups and on-demand metadata resolution for library operations.

**Home view:** the default landing surface. A featured-track carousel plus a stack of horizontal shelves (built-in: Recently played, Most played · 30 days, Most played artists · 30 days, Recently added, Liked albums, Liked artists, Jump back in). Plugins contribute additional shelves via static `contributes.homeShelves` or the runtime `api.home.registerShelf` API. See `ui.md` for layout / shelf rendering and `plugins.md` for the plugin contribution surface.

Detailed rules are in `.claude/rules/`:
- `backend.md` — backend files, collections, background tasks, playback resolution, database, profiles
- `frontend.md` — frontend files, components, hooks, keyboard shortcuts, state persistence
- `conventions.md` — canonical action patterns and behavioral rules
- `plugins.md` — plugin system API, manifest format, display kinds, existing plugins
- `queue.md` — queue state, QueueTrack type, playback progression, mutations, persistence, duplicate detection
- `ui.md` — layout, entities, detail pages, information sections, context menus, skins
- `testing.md` — test frameworks, commands, patterns for Rust/TS/E2E
