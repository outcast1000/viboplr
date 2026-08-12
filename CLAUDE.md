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
npm run loc                               # code size now vs the last release (see below); `npm run bump` runs this
npm run loc -- save --ref v1.0.21         # back-fill one past release into benchmarks/loc-history.json
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

That test file holds the fixture as **JSON**, not as the plist, because CI runs `ubuntu-latest`
and `parsePlistStream` shells out to macOS-only `plutil` — which the parser *deliberately*
swallows, so on Linux the fixture silently became zero samples and every assertion failed. The
schema assertions are therefore pure and run everywhere; the single XML→JSON conversion test is
gated on `plutil` being present and asserts the parse deep-equals that JSON, so the fixture can't
drift from what `plutil` really emits. Anything else that shells out to a macOS binary must be
gated the same way — `npm run bump` runs its CI checks **locally** (i.e. on macOS), so it cannot
catch a Linux-only failure and the release workflow is the first thing that will.

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

### Code size tracking

`npm run bump` counts the code as **Step 7** and appends an entry to `benchmarks/loc-history.json`,
printing the delta against the previous release (totals, per language, per top-level directory, and
the biggest per-file movers). It is never fatal — a release must not fail over a metric — and it is
skipped for **betas**, which may be cut from any branch and would make the series jump around.

The counter (`scripts/lib/loc.mjs`) is a **port of the VS Code Counter extension**
(`uctakeoff.vscode-counter`), which produced the pre-existing snapshots under `.VSCodeCounter/`
(gitignored, main checkout only). The port exists because that extension has no CLI and `bump` must
run without VS Code installed. It is verified exact: re-counting `v0.9.122` reproduces the
2026-06-17 snapshot on all 443 files, byte for byte. **Do not "fix" the following** — each one moves
the numbers and silently breaks every historical delta:

- `.css` reports as **PostCSS**, not CSS (both grammars claim `.css`; the extension's
  last-writer-wins map landed on PostCSS).
- `.toml` and `.plist` are **not counted at all**, so `Cargo.toml`, `Cargo.lock` and `Info.plist`
  are invisible.
- A file ending in a newline scores one trailing **blank** line, and an empty line inside a template
  literal counts as **code** (the line type carries over while a block string is open).

Two deliberate divergences from the extension, both about reproducibility: files come from git
(tracked + untracked-not-ignored, minus anything `git check-ignore --no-index` matches — the
`--no-index` flag is load-bearing, or the 37 tracked-but-ignored `docs/superpowers/` files would
count), so the number is the same on any machine; and `benchmarks/loc-history.json` excludes itself,
or the metric would inflate by ~9 lines every release and list itself as a mover forever.

`src/__tests__/loc.test.ts` pins the line classifier. Run it before trusting a change to the counter
— it is the only automated guard that the series stays comparable.

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
