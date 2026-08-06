# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm install                          # Install frontend dependencies
npm run tauri dev                    # Dev mode (Vite + Tauri)
npm run tauri build                  # Production build (run fetch-libmpv first — the build bundles libmpv)
cd src-tauri && cargo check          # Rust compilation check
cd src-tauri && cargo check --release # Release build check
node scripts/fetch-libmpv.mjs        # Vendor pinned libmpv — REQUIRED before `tauri build` (bundled); dev/tests load it at runtime; engine tests self-skip without it
cd src-tauri && cargo test --lib     # All lib tests incl. native engine (engine compiled into every build)
node scripts/package-engine-component.mjs  # Package the downloadable libmpv engine component + update its lock
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

**Home view:** the default landing surface. A radio-station carousel plus a stack of horizontal shelves (built-in: Recently played, Most played · 30 days, Most played artists · 30 days, Recently added, Liked albums, Liked artists, Jump back in). Plugins contribute additional shelves via static `contributes.homeShelves` or the runtime `api.home.registerShelf` API. See `ui.md` for layout / shelf rendering and `plugins.md` for the plugin contribution surface.

## Do Not Reintroduce

Features that were deliberately removed. Re-adding them as core is a regression, not a fix:

- **P2P engine.** The libp2p engine (`src-tauri/src/p2p/`, `commands/p2p.rs`, the `api.p2p` plugin bridge) was removed. There is no `p2p_*` command and no `api.p2p` namespace. Peer transfer is a networking source like any other — it belongs in a plugin, per the plugin-first rule. Do not re-add `p2p-sharing` to the gallery `index.json`; the plugin still exists but has no host to answer it.
- **Core YouTube search.** There is no core "Find in YouTube" action and no `search_youtube` command. YouTube search/playback is owned entirely by the yt-dlp plugin. There is no per-track YouTube URL storage.

## Rules

Detailed rules are in `.claude/rules/`. Each file carries `paths:` frontmatter and loads only when you touch matching files — read the relevant one directly when you need it before opening code.

- `conventions.md` — canonical action patterns and behavioral rules (**always loaded**; applies everywhere)
- `backend.md` — backend files, collections, background tasks, playback resolution, database, profiles → `src-tauri/**`
- `frontend.md` — frontend files, components, hooks, keyboard shortcuts, state persistence → `src/**`
- `plugins.md` — plugin system API, manifest format, display kinds, existing plugins → plugin sources
- `queue.md` — queue state, QueueTrack type, playback progression, mutations, persistence, duplicate detection → queue/playback sources
- `ui.md` — layout, entities, detail pages, information sections, context menus, skins → components, CSS, skins
- `testing.md` — test frameworks, patterns for Rust/TS/E2E → test sources
- `site.md` — the public `docs/` marketing site, `features.json`→`features.html` generation, core-vs-plugin presentation → `docs/**`
