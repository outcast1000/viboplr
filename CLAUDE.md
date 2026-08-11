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
npm run perf:probe -- run                 # macOS CPU/GPU/memory cost per scenario (needs sudo; see below)
npm run perf:probe -- save --note "..."   # append the last probe run to benchmarks/resource-usage.json
```

### Host resource profiling (macOS)

`scripts/perf-probe.mjs` measures what the app costs the host. It exists because Viboplr is
**not one process** — WKWebView's `WebContent` / `GPU` / `Networking` XPC helpers reparent to
launchd (`PPID 1`), so a process-tree walk finds none of them and any measurement of the
`Viboplr` pid alone undercounts badly. Attribution goes through `powermetrics` **coalitions**:
the `com.alex.viboplr` coalition contains all four processes, so one `pgrep` for the app pid is
enough to discover the helpers. Memory uses `phys_footprint` (via `footprint`), never RSS, which
double-counts pages shared across those four processes.

**Compositing is billed to `com.apple.WindowServer`, not to the app**, so the app's own GPU
figure understates its true screen cost — which matters here because the window is transparent +
undecorated with `macOSPrivateApi`. The probe records WindowServer separately and reports it as
`ΔwsCPU` / `ΔwsGPU` against the app-quit baseline; read the app's `gpu` **plus** those deltas as
the real screen cost. Measured on a synthetic check, WindowServer's rise dwarfed the app's own
GPU number, so ignoring it would understate GPU load several-fold.

The powermetrics plist schema is unobvious and the parser depends on it — `all_tasks` is a
*system-wide summary dict* rather than a per-task array, coalitions key on `id` not `pid`, GPU
time exists only at coalition level *and is omitted outright when idle* (3 of 136 coalitions
carried it in one capture), and the one `<date>` node makes `plutil` reject the whole document
for JSON. `src/__tests__/perfProbe.test.ts` pins all of this against a recorded fixture; run it
before trusting a change to the parser.

Profile the **release** build; `probe` prints which one is running and every saved scenario
records a `build` field. Note that the process **name cannot tell the builds apart** — Tauri names
the bundle executable after the Cargo package (`name = "viboplr"`), not `productName`, so the
installed app runs `/Applications/Viboplr.app/Contents/MacOS/viboplr` in lowercase exactly like
the dev binary. `classifyBuild()` discriminates on the executable *path* (`/target/` → dev,
`.app/Contents/MacOS/` → release). Do not reintroduce a name-based check.

Scenarios are ordered so each isolates one extra cost. The `playing-minimized` vs
`playing-visible` pair is the load-bearing one: it splits libmpv decode cost from render cost,
and only the second is ours to optimize. Both tools need root; sudo is primed once per run.

Instruments/`xctrace` is unavailable unless full Xcode is installed (Command Line Tools alone
ships a stub that errors out).

## Architecture

Viboplr is a Tauri 2 desktop app: a Rust backend serves a React/TypeScript frontend rendered in a native webview.

**Two track types:** `Track` (full library type with DB IDs) is used by library list views. `QueueTrack` (metadata-only, no `id`/`album_id`/`artist_id`) is used by queue, now-playing, and playlists. Queue/playback surfaces never rely on DB IDs — they use name-based image lookups and on-demand metadata resolution for library operations.

**Home view:** the default landing surface. A radio-station carousel plus a stack of horizontal shelves (built-in: Recently played, Most played · 30 days, Most played artists · 30 days, Recently added, Liked albums, Liked artists, Jump back in). Plugins contribute additional shelves via static `contributes.homeShelves` or the runtime `api.home.registerShelf` API. See `ui.md` for layout / shelf rendering and `plugins.md` for the plugin contribution surface.

## Do Not Reintroduce

Features that were deliberately removed. Re-adding them as core is a regression, not a fix:

- **P2P engine.** The libp2p engine (`src-tauri/src/p2p/`, `commands/p2p.rs`, the `api.p2p` plugin bridge) was removed. There is no `p2p_*` command and no `api.p2p` namespace. Peer transfer is a networking source like any other — it belongs in a plugin, per the plugin-first rule. Do not re-add `p2p-sharing` to the gallery `index.json`; the plugin still exists but has no host to answer it.
- **Core YouTube search.** There is no core "Find in YouTube" action and no `search_youtube` command. YouTube search/playback is owned entirely by the yt-dlp plugin. There is no per-track YouTube URL storage. The older `youtube` plugin was **de-registered from the gallery** (2026-08-10) as `ytdlp` supersedes it — do not re-add `youtube` to the gallery `index.json`. Unlike `p2p-sharing` it still works, and installed copies keep auto-updating from their own `updateUrl`; only discovery was removed.

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
