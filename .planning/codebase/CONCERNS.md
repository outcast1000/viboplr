# Codebase Concerns

<!-- refreshed: 2026-08-14 -->
**Analysis Date:** 2026-08-14

## Tech Debt

### Large Monolithic Files

**App.tsx (5468 lines):**
- Files: `src/App.tsx`
- Impact: Navigation, state debugging, and modifications are painful; contains top-level state, view routing, event wiring, modals, and playback logic all interleaved
- Fix approach: Extract modal state/rendering and view routing into separate container components; move plugin-specific wiring to dedicated hooks; consider splitting the ~150 state variables into domain-specific custom hooks

**usePlugins.ts (2864 lines):**
- Files: `src/hooks/usePlugins.ts`
- Impact: Plugin API builder + lifecycle + event dispatch all in one file; hard to follow the flow when adding a new API surface
- Fix approach: Extract `buildPluginAPI()` and context/runtime builders into separate modules; move event dispatch logic to its own file

**SettingsPanel.tsx (2057 lines):**
- Files: `src/components/SettingsPanel.tsx`
- Impact: Every settings tab in one component; adding or modifying a section requires scrolling through unrelated code
- Fix approach: Extract each tab (General, Playback, Providers, Debug) into its own component with shared hooks for common patterns

**usePlayback.ts (2347 lines):**
- Files: `src/hooks/usePlayback.ts`
- Impact: Dual A/B audio element architecture, crossfade, preload, rate management, and native engine branching all interleaved; dense but cohesive — this is borderline acceptable but watch for growth
- Fix approach: Monitor for growth; consider extracting crossfade logic to a separate effect hook if changes touch multiple concerns

**Backend db.rs (5597 lines) + commands.rs (4993 lines):**
- Files: `src-tauri/src/db.rs`, `src-tauri/src/commands/mod.rs`
- Impact: The Rust backend is two massive files with all entity CRUD, FTS, history, playlists, info types, providers in one file each; navigation and modification are expensive
- Fix approach: Split `db.rs` into `db/schema.rs`, `db/tracks.rs`, `db/artists.rs`, `db/albums.rs`, `db/history.rs`, `db/info_types.rs`; split `commands.rs` by domain into `commands/library.rs`, `commands/playback.rs`, `commands/plugins.rs`, `commands/downloads.rs`, `commands/images.rs`; both are mechanical but valuable

### Unwrap/Expect in User-Data Paths

**transcode_server.rs:**
- Files: `src-tauri/src/transcode_server.rs`
- Lines: 97 (`.unwrap()` on `child.stdout`), 127 (`.unwrap()` on `local_addr`)
- Impact: If stdout is missing or port binding fails in unusual ways, the app panics; these are internal session constraints so risk is low but not zero
- Fix approach: Replace with explicit error handling; `.unwrap_or_default()` for port (bind a second time on failure), check stdout presence before calling `.take()`

**lib.rs environment variables:**
- Files: `src-tauri/src/lib.rs`
- Lines: 541, 547, 552 (`.expect("HOME/APPDATA not set")`), 681, 685, 727 (`.expect()` on dir creation and DB init)
- Impact: Panics on missing HOME dir (impossible on macOS/Linux) or DB init failure (would be a genuine bug worth knowing about, but a panic kills the app); log better context instead
- Fix approach: Replace `expect()` on env vars with `.map_err()` returning a user-facing error; DB init failure should emit a user notification, not panic the main thread

### Fragile Parsers and Measurements

**perf-probe powermetrics plist parser (`scripts/perf-probe.mjs`):**
- Files: `scripts/perf-probe.mjs`, `src/__tests__/perfProbe.test.ts`
- Impact: The parser depends on quirks of macOS `powermetrics` output that are not documented and are easy to misread (all_tasks as system summary, coalitions keyed by id not pid, gputime omitted for idle coalitions). A future OS update could change the schema silently.
- Fix approach: The test (`perfProbe.test.ts`) pins the schema against a real fixture via `plutil` (macOS-only); keep that test passing; guard any macOS-tool changes with a pre-commit check; consider adding a second fixture from a newer OS version to catch drift early. Document the quirks inline so the next person doesn't break them while "simplifying"

**LOC counter (`scripts/loc.mjs`, `src/__tests__/loc.test.ts`):**
- Files: `scripts/loc.mjs`, `src/__tests__/loc.test.ts`
- Impact: The counter is a port of the VS Code Counter extension and must reproduce historical snapshots *exactly*. Three delicate rules that must not be "fixed": `.css` reports as PostCSS (not CSS); `.toml` and `.plist` are not counted at all; empty lines inside template literals count as code (line type carries over). Breaking any of these silently corrupts the historical delta series.
- Fix approach: The test (`loc.test.ts`) pins the line classifier and validates reproduction of a historical snapshot; keep that test passing. Document the three exceptions in comments so they survive a code review looking to "optimize" the classifier

### N+1 Query Patterns

**plugin_apply_tags (command):**
- Files: `src-tauri/src/commands/mod.rs` (line 2928 area)
- Impact: Applies N tags in N separate DB transactions; on a 40-tag bulk edit this is 80 lock acquisitions instead of 1
- Fix approach: Batch tag application into a single transaction; build one INSERT statement for all tags and commit once

**bulk_update_tracks (command):**
- Files: `src-tauri/src/commands/mod.rs` (line 917 area)
- Impact: Updates N tracks with individual DB queries instead of a batch statement
- Fix approach: Collect all updates and execute as a single transaction with one UPDATE statement per field touched

## Known Bugs

### Empty Catch Blocks (documented but not all have comments)

**Justified catches with explanations:**
- `App.tsx:2046` — Deep link check on startup; no URLs is the common case
- `App.tsx:2101` — Cleanup_temp_mixtapes; cleanup-only, fire-and-forget
- `App.tsx:2555,2560` — Error logger itself must not fail (would loop forever)
- `hooks/useImageResolver.ts:65` — Error already reported in response payload
- `hooks/useWaveform.ts:177` — Cache miss is not an error, fire-and-forget
- `hooks/usePlayback.ts:39` — Log-trail only, no user impact on failure
- `hooks/useInformationTypes.ts:229,264` — Plugin info type fetch timeouts, acceptable
- `hooks/useDependencies.ts:123` — Log-trail only
- `hooks/usePlugins.ts:459` — Plugin log message failure, acceptable

**Status:** All have comments explaining why; this is correctly done per conventions.md

### Slow yt-dlp Probe

- Files: `src-tauri/src/dependencies.rs`, project notes mention 16s on this Mac
- Impact: On some machines, `yt-dlp --version` takes ~16s (OS-level block, not a bug in yt-dlp). Every first-session dependency check incurs this, and older probe caches can outlive a yt-dlp update, requiring manual invalidation
- Fix approach: Already done — the probe is now single-flight (concurrent callers wait on one probe), timeout-bounded (60s), and the result is persisted locally keyed by file identity (mtime+size), so an unchanged binary is never re-probed. Second and later sessions skip it entirely unless the binary changes. No further mitigation needed; document this in release notes if doing a yt-dlp pin bump

### Plugin .unwrap() Calls in Manifest Parsing

- Files: `src-tauri/src/plugins.rs` (lines 42-43 in zip validation)
- Impact: `archive.by_index(i).map(|f| f.name() == "manifest.json").unwrap_or(false)` could panic on a malformed zip (though `.unwrap_or(false)` makes it safe)
- Fix approach: The pattern is already safe; the `.unwrap_or(false)` guards the panic. No change needed, but consider replacing with `archive.by_index(i).ok().and_then(|f| (f.name() == "manifest.json").then_some(()))` for clarity

## Security Considerations

### Path Traversal Protection in Plugin Installation

- Files: `src-tauri/src/plugins.rs` (lines 64-67)
- Mitigation: `if name.contains("..") || name.starts_with('/')` blocks directory traversal in zip files; extracted files are validated before write
- Status: **Implemented correctly**; no vulnerability found

### Plugin ID Sanitization

- Files: `src-tauri/src/plugins.rs` (lines 10-19, `sanitize_plugin_id`)
- Mitigation: Rejects plugin IDs containing `..`, `/`, `\` before touching the filesystem
- Status: **Implemented correctly**; used on every delete/install/update path

### ffmpeg Command Injection

- Files: `src-tauri/src/transcode_server.rs`
- Mitigation: File path is passed as a positional argument to ffmpeg, not via shell; seek value is formatted as a float string, not user-controlled
- Status: **Implemented correctly**; no shell injection possible

### Static Aptabase Key Handling

- Files: `src-tauri/src/telemetry.rs`
- Risk: The Aptabase app key is compile-time injected via `APTABASE_APP_KEY` env var; if absent or malformed the plugin is not registered and telemetry is a complete no-op
- Status: **Correct design**; the key is a public ingestion key (not a secret), and the system degrades safely

## Performance Bottlenecks

### No List Virtualization

- Files: `src/components/TrackList.tsx`, `src/components/QueuePanel.tsx`, `src/components/HistoryView.tsx`
- Impact: Libraries with 20,000+ tracks render as 20,000+ DOM nodes; scrolling and sorting are slow
- Fix approach: Adopt `@tanstack/react-virtual` with `React.memo` on row components to render only visible rows; impacts scroll UX significantly (10x+ speedup on large lists expected)

### No React.memo on Row Components

- Files: All list view row renderers in `src/components/`
- Impact: Every parent state change (like checking a track) re-renders every row in every list, even unchanged ones
- Fix approach: Extract row components (`TrackRow`, `QueueRow`, etc.) with `React.memo` and pass only per-row data + callbacks; pair with `useCallback` on handlers

### No useCallback/useMemo in List Handlers

- Files: List-view components that pass inline handlers to rows
- Impact: New function instances on every render trigger row re-render even with `React.memo`
- Fix approach: Wrap handlers in `useCallback` with correct dependencies; defer any derived data computation to `useMemo`

## Fragile Areas

### Video Frame Extraction (untested paths)

- Files: `src-tauri/src/video_frames.rs`
- Impact: Frames are extracted via `ffmpeg` with a 4-frame per-duration sampling strategy; the test is ignored (`#[ignore]`d) and the feature is only exercised in real use
- Fix approach: The test exists but is behind `#[ignore]` because it shells out to ffmpeg; run it manually on video files before committing changes. Add a fixture-based unit test for frame-count logic

### Windows Video Embedding (single-config validation)

- Files: `src-tauri/src/mpv_engine/video_layer_win.rs`
- Impact: Window embedding is implemented and working but validated on **one config** (RTX 3060 Ti, 100% DPI, single monitor); fractional DPI scales and multi-monitor bounds are coded but untested
- Fix approach: Test on a multi-monitor setup with fractional scaling (laptops often have 125% DPI); debug hooks exist (`VIBOPLR_MPV_LOG_FILE`, `VIBOPLR_MPV_OPTS`) to diagnose issues

### macOS Cursor Polling for Mini Player

- Files: `src-tauri/src/cursor_tracker.rs`
- Impact: The mini player expands on hover without taking focus using native cursor polling; this is macOS-specific and could break on future OS updates
- Fix approach: Test on each major macOS release; the implementation is straightforward enough that breaking changes would be caught early

## Scaling Limits

### SQLite Full-Text Search (FTS5) Lacks Typo Tolerance

- Files: `src-tauri/src/db/search.rs`
- Impact: User searches must be exact (or use SQL wildcards); "beethoven" doesn't match "beethovn"
- Scaling limit: As library size grows, this becomes more frustrating
- Improvement path: Evaluate Tantivy (Rust FTS library with fuzzy matching, stemming, BM25 ranking) as documented in `TODO.md`; maintain Tantivy index in parallel with SQLite, search Tantivy by default and fall back to FTS5. No schema change needed; Tantivy is in-process and fits Tauri desktop architecture

### Image Download Rate Limiting (1100ms between requests)

- Files: `src-tauri/src/lib.rs` (lines 811, 951 area)
- Impact: Hardcoded 1100ms between image downloads; large libraries with many new releases crawl slowly
- Fix approach: Move to a configurable setting (Settings → Advanced) with sensible defaults; expose as a rate-limit per artist/album/tag so users can tune for their network

## Scaling Concerns

### Single-Thread Expression Index Recomputation

- Files: `src-tauri/src/db/mod.rs`
- Impact: `recompute_counts()` runs at every startup for crash safety; for large libraries this can take seconds and block the UI briefly
- Fix approach: Run in the background on app startup; show a "Syncing library..." toast if it takes > 1 second

## Dependency Management Risks

### yt-dlp Version/Release Checking

- Files: `src-tauri/src/dependencies.rs`, both Rust backend and any plugin
- Risk: The host owns version checking and update management (`dependencies.rs`); plugins must NOT call GitHub themselves, because that exhausts rate limits and produces incorrect version info
- **Rule enforced by:** `plugin_exec` only allows binaries in the host's dependency registry
- Status: **Correct**; plugins are blocked from their own binary management

### Plugin Manifest Compatibility

- Files: `src-tauri/src/plugins.rs`, `src/usePlugins.ts`
- Risk: A plugin with `minAppVersion` higher than the installed app version loads anyway (the check filters it from activation, but it sits in the plugins directory). On next app upgrade, the plugin activates without user knowing versions changed.
- Fix approach: The version check is already in place; ensure it's enforced in `plugin_list_installed` and audit on every app startup

## Test Coverage Gaps

### Renderer Tests (No DOM assertions for many paths)

- Files: `src/components/` — large components lack unit tests
- What's not tested: `DetailHero.tsx`, `NowPlayingBar.tsx`, `NowPlayingView.tsx` interaction flows (these are integration-tested via E2E but not unit-tested)
- Risk: Refactors can silently break layout logic; the fullscreen/non-fullscreen rendering rules in `NowPlayingView` are especially fragile
- Priority: **Medium** — these are mostly presentational and breaking changes show up visually in E2E; unit tests would catch logic errors (e.g., incorrect conditional rendering)

### Database Transaction Rollback

- Files: `src-tauri/src/db/mod.rs`
- What's not tested: Partial failures in multi-statement transactions (e.g., one tag write fails, others commit)
- Risk: If a transaction fails mid-way, the database can be left in an inconsistent state
- Priority: **Low** — SQLite transactions are atomic within a connection; the risk is if a higher-level operation doesn't wrap correctly (no evidence of this)

### Plugin Event Handler Error Propagation

- Files: `src/usePlugins.ts`
- What's not tested: What happens if a plugin's `onAction`, `onTrackStarted`, or other handler throws
- Risk: A misbehaving plugin could crash the app or silently fail without feedback
- Priority: **Medium** — handlers are wrapped in try-catch but only `console.error` is logged; user doesn't know the failure happened

## Missing Critical Features

### Typo-Tolerant Search

- Problem: SQLite FTS5 does not support typo tolerance; users must type exact names
- Blocks: Users with typos get "no results" instead of close matches
- Workaround: Use SQL wildcard prefixes (`LIKE '...'`) but this is slow on large libraries and requires user knowledge
- Planned solution: Tantivy integration (see `TODO.md`)

## Dead Code

### TIDAL Types (never imported)

- Files: `src/types.ts`
- Types: `TidalSearchResult`, `TidalTrack`, `TidalPlaylist`, etc.
- Impact: Type definitions for TIDAL moved to the `tidal-browse` plugin; the core type definitions are now dead weight
- Fix approach: Delete `TidalSearchResult`, `TidalTrack`, `TidalPlaylist` from `src/types.ts`

### resolve_cover_url Command

- Files: `src-tauri/src/commands/mod.rs` (line 2682 area)
- Impact: Never called anywhere; contains a stale TODO
- Fix approach: Delete this command and its test

### record_play (DB-only)

- Files: `src-tauri/src/db/mod.rs` (lines 2417, 2515)
- Impact: `record_play` and `record_history_play` are test-only; production uses `record_play_by_metadata`
- Fix approach: Gate behind `#[cfg(test)]` or move to the test module to clarify intent

### AppState Unused Fields

- Files: `src-tauri/src/commands/mod.rs`
- Fields: `app_data_dir`, `update_checker_cancel` are never read after initialization
- Fix approach: Remove or annotate with `#[allow(dead_code)]` if they're intended for future use

## Error Handling Issues

### Silent Plugin API Entity Lookups

- Files: `src/usePlugins.ts` (lines 258-267)
- Impact: Plugin API entity lookups (getTrackById, getArtistById, etc.) `.catch(() => null)` swallow all errors without logging
- Fix approach: Add `console.error` before returning null so failures surface in diagnostic reports

### Download Provider Chain Errors

- Files: `src/useDownloadOrchestration.ts` (estimated in error handling)
- Impact: Download provider chain walks providers and swallows errors without logging each failure
- Fix approach: `console.error` before `continue` so the user's diagnostic report shows why each provider was skipped

### Download Conflict Check Errors

- Files: `src/components/download/SingleTrackDownload.tsx` (line ~358 area)
- Impact: Error checking for file-exists conflicts is silently swallowed
- Fix approach: Add `console.error` to surface the issue

### Information Type Fetch Errors

- Files: `src/hooks/useInformationTypes.ts` (line ~245)
- Impact: Main info type fetch error handler lacks `console.error`
- Fix approach: Add logging to distinguish network errors from provider-specific failures

---

*Concerns audit: 2026-08-14*
