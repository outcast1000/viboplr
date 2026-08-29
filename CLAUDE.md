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
npm run lint                         # ESLint (gates on errors; see .claude/rules/conventions.md > Enforcement)
npm run lint:fix                     # ESLint with autofix
npm run test:all                     # All tests (lint + Rust + TS + E2E)
npm test                             # TypeScript tests only
npm run test:rust                    # Rust tests only
npm run test:e2e                     # Playwright E2E tests
cd src-tauri && cargo test bench_search_performance -- --ignored --nocapture  # DB benchmarks
npm run perf:probe -- run                 # macOS CPU/GPU/memory cost per scenario (needs sudo; see below)
npm run perf:probe -- run --auto          # same, unattended — drives the app itself (perf profile; see below)
npm run perf:probe -- save --note "..."   # append the last probe run to benchmarks/resource-usage.json
npm run app:smoke -- --expect-version 1.0.38 --save  # smoke-test the INSTALLED build + record startup (see below)
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

`run --auto` walks the six non-optional scenarios unattended. It drives the app through the
**`viboplr://probe` deep link** (`src/utils/probeControl.ts`), never through scripted keystrokes:
`osascript` keystrokes need the terminal granted Accessibility, they land on whatever app is
frontmost, and **Cmd-M in this app is *mute*** (`useInAppKeyboardShortcuts.ts`, `case "m"`) — so
scripting the obvious "minimize" chord would silently mute the audio whose decode cost
`playing-minimized` exists to measure. Minimize/restore therefore go through the Tauri window API
inside that route. Playback of a *specific* file goes through `open=<absolute path>`, which routes
to **`resolve_dropped_paths`** — the same command the Finder drag-and-drop path uses — so folder
walking, tag reading and the media filter behave exactly as they do for a real drop, and video needs
no separate handling. `playing-video` and `waveform` are therefore automatable, but only against
media this machine actually has: pass `--video <path>` / `--waveform <path>` and they run, omit them
and they're skipped with a note. **`collection-sync` has no `drive` and should not get one** — a
rescan is a library mutation, which is what the probe route is deliberately not allowed to trigger.

`open` takes a path from the URL while `dump` refuses to, and the asymmetry is the point: `dump`
*writes*, so a caller-named destination would be a write-anywhere primitive; `open` only *reads* a
file the user already has and plays it. Behind the same profile gate the worst case is a perf
profile making a sound. Relative paths are rejected — the app's cwd is wherever launchd started it.

Detail pages are reached with `artist=` / `album=` (+ optional `albumArtist=`) / `tag=`, not
`view=`: `artists`/`albums`/`tags` are detail views that mean nothing without a selected entity, and
the `view` handler clears the selection. They route through `useLibrary`'s `navigateTo*ByName`, so
an entity not yet in the loaded list still resolves via its `find_*_by_name` fallback. This is what
makes the **`detail-hero`** scenario possible, and that scenario is the point: `DetailHeroEffect`
stacks ~9 infinite animations (including `tv-noise` repainting a tiled layer ~3× a second) and is
the most animation-heavy surface in the app — it was simply unmeasurable before.

`fullscreen=on|off` dispatches through App's `toggleFullscreenForTrack`, so audio gets the
`AudioFullscreen` overlay and video gets its own path — the probe does not re-derive that branch.
"Am I fullscreen?" is one read covering all three surfaces (`audioFullscreen ||
playback.nativeFullscreen || document.fullscreenElement`), because native mpv video uses *window*
fullscreen and never sets a DOM `:fullscreen` element. It is also reported in the dump, so a test
can assert the state actually landed.

`quit=on` flushes the store and exits. `quitApp()` in `appControl.mjs` prefers it over
`osascript -e 'quit app'` for two reasons that both bit: an open modal can swallow Cmd-Q, and store
writes are debounced 500ms, so a quit landing inside that window drops the very persisted queue the
next run replays. It still falls back to osascript, then SIGTERM.

The route is **gated on the profile** — only `perf` / `perf-*` honours it, so a page that opens
`viboplr://probe?...` against a real user's default profile gets nothing. `--auto` launches the app
with `--profile perf` (`open` cannot set env vars, but `lib.rs` also reads `--profile` from argv,
and unlike `VIBOPLR_PROFILE` that leaves a trace in `ps`) and **asserts the profile before every
sample**. Without that assert a default-profile app would ignore every link and the run would
produce a full set of plausible, identical, wrong numbers. Set the profile up once by hand — add a
local collection and queue one track; it persists its own queue, so `play=on` replays the *same*
track every run, which is what makes the series comparable across releases.

`--settle` (default 10s) is the pause between reaching a state and starting to sample. It is not
padding: without it the launch, view switch or window animation lands inside the sampled window and
`idle-home` absorbs the cost of starting the app. The guided mode gets this for free because the
human only presses Enter once things look calm.

Note that `--auto` needs a **release build carrying the probe route installed where LaunchServices
resolves `Viboplr`** — the run prints the bundle it resolved and warns when it is not under
`/Applications`, since the process name cannot tell the builds apart.

Instruments/`xctrace` is unavailable unless full Xcode is installed (Command Line Tools alone
ships a stub that errors out).

### Built-app smoke test + startup series

`scripts/app-smoke.mjs` (`npm run app:smoke`) is the only check that touches **the artifact we
ship**. The Playwright suite drives the Vite dev server with `tests/e2e/tauri-mock.js` faking the
IPC layer and `cargo test --lib` never renders anything, so an entire class of bug ships green
today: libmpv missing from the bundle, a `viboplr://` scheme that didn't register, codesigning that
broke the webview, frontend assets left out, a migration that crashes on a real profile.

It launches the installed app under the `perf` profile and asks it to describe itself via
`viboplr://probe?dump=on`. **That the answer arrives at all is most of the test** — it means the
bundle launched, the webview mounted, React ran, the database opened and the URL scheme resolves to
this build. `checkDump` (`scripts/lib/appSmoke.mjs`, unit-tested in `src/__tests__/appSmoke.test.ts`)
then asserts version / profile / track count / view / both timing sets, returning *every* failure
rather than throwing on the first — "wrong version" and "the database never opened" are independent
facts and both should be visible without re-running a build.

The dump is written by `write_probe_dump` (`commands/app.rs`) to a **fixed filename in the profile
dir**; the URL carries no path, deliberately, because a URL that names its own destination is a
write-anywhere primitive. The profile gate is re-checked in Rust rather than trusted from the
frontend — any JS in the webview, including a plugin's, can invoke that command. `probeDumpPath`
(`scripts/lib/appControl.mjs`) recomputes the same location independently. The runner **deletes a
stale dump before launching**: the path is fixed, so last run's file is indistinguishable from this
run's, and an app that failed to start would otherwise be "verified" against the last good launch.

**It is not a `bump.mjs` step, and must not become one.** The release build happens in the GitHub
workflow (`tauri-action`, per-platform matrix) *after* the tag is pushed, so at bump time there is
no new bundle on the machine — a step there would launch whatever stale app is in `/Applications`
and pass. `bump.mjs` prints the command to run once CI publishes instead, and `--expect-version` is
what makes that safe to follow late: run it against the old build and it fails loudly.

`--save` appends to `benchmarks/startup-history.json`. **The backend and frontend spans stay
separate all the way through** — `timing.rs`'s origin is process start, `startupTiming.ts`'s is
script evaluation (which happens *inside* the backend span), so they are two clocks with no shared
zero and a combined "total startup" would read as authoritative and mean nothing. Per-phase
breakdowns ride along so a regression can be attributed without re-running; `startupDelta` reports
movers past 20ms in absolute milliseconds, not percentages, because startup phases are often
sub-millisecond where a percentage turns noise into a headline.

**One-time setup:** `npm run perf:setup -- --music /path/to/music` (then `-- --check` to verify).
Four things must be true or the run silently measures the wrong thing, and the script does all four:
onboarding dismissed (a fresh profile shows the wizard over everything), a collection added (no
collection → no artists → `detail-hero` has nothing to open), the queue seeded (`play=on` against an
empty queue is a no-op, so every `playing-*` scenario samples an idle app), and **`heroEffectMode`
pinned to a specific look** — `resolveHeroLook` reads a persisted mode where `disabled` renders no
effect at all and `random` picks a different look per run, so `detail-hero` would respectively report
the animation stack as free or produce a series that can't be compared.

Setup goes through the app's own probe verbs, not by editing its files: the app rewrites
`app-state.json` from memory on a debounce so anything written underneath it can be clobbered, and
the collection lives in the **database**, which a file edit cannot reach. `heroEffectMode` is the one
exception (a plain store key with no command behind it) and is written with the app stopped. Note
that the **queue is not a store key** — it lives in `main_playlist`, behind `main_playlist_read` — so
readiness is checked by asking the app for a dump, never by scraping its files.

**The run is self-configuring.** The dump carries `library.artistNames` and `queueLength`, so
`--auto` discovers an artist for `detail-hero` instead of needing one typed; an explicit `--artist`
still wins. `--video` / `--waveform` remain explicit, since which file to use is a real choice.

**Every scenario is verified before it is sampled.** `cmdRunAuto` dumps after the drive and compares
against the scenario's declared `expect` (view / playing / miniMode / fullscreen, plus "is anything
actually loaded"), skipping the sample on a mismatch. This is what stops the whole class of silent
wrong-state results — an empty queue, a scenario inheriting fullscreen from the one before it — from
looking like real numbers. Drives are therefore **fully declarative** (`stateQuery` sends every axis,
not just what changed): three scenarios are skippable, so a delta-style drive inherits whatever the
last one that *ran* left behind.

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
