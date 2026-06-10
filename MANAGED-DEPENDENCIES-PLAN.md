# Managed Dependencies — Implementation Plan

## Overview

Evolve the existing dependency service (`src-tauri/src/dependencies.rs`) from
**check-and-instruct** into a full lifecycle manager: registration with reasons,
existence checks, requestor tracking (all existing), plus **installation** and
**update-to-latest** (new) for binaries that support it.

The service stays host-owned. The registry doubles as the `api.system.exec`
allow-list (`plugin_exec` → `allowed_names()`), so plugins must never be able to
*define* new dependencies — they only **reference** registry entries via the
existing `binaryDependencies` manifest field, contributing their name + reason to
the requestor list. Adding a new binary to the registry is a host release.

## Goals

1. One-click install of yt-dlp from inside the app (modal + Settings).
2. Detect when an installed yt-dlp is outdated; offer/perform update.
3. Optional silent auto-update of the app-managed yt-dlp copy (default ON).
4. Better runtime errors: a failing yt-dlp that is also outdated says so.
5. Keep ffmpeg (and any future "heavy" dep) instruct-only — no behavior change.

## Non-Goals

- Bundling/sidecar-ing binaries with the app installer.
- Managing binaries owned by a package manager (brew/winget/apt). We never
  overwrite those; we install our own copy alongside and prefer it.
- Letting plugins register arbitrary binaries (security: exec allow-list).
- Managing ffmpeg. No canonical official binary, large, GPL distribution
  questions, and old versions work fine. Stays instruct-only (`managed: None`).

## Current State (for orientation)

- `dependencies.rs` — static `REGISTRY` (`ffmpeg`, `yt-dlp`, debug-only
  `fictional-tool`), `DepStatus`, session-scoped `DepCache` (in `AppState`),
  `check_single()` (runs `--version`), `command_with_path()` (macOS PATH
  augmentation), `allowed_names()` (exec allow-list).
- `commands/media.rs` — `plugin_exec` (allow-list enforced), `check_dependencies`,
  `yt_dlp_check`, `ffmpeg_check`, `yt_dlp_stream_audio`.
- Frontend — `useDependencies.ts` (checkAll/checkDep/requireDep/promptDep),
  `DependencyModal.tsx` (copy install command, download page, re-check),
  `SettingsPanel.tsx` `DependenciesSection` (status list + Refresh).
- Plugins declare `binaryDependencies: [{ name, reason }]` in manifests; the
  YouTube plugin triggers the modal via the `require-dependency` UI action.

## Design

### 1. Registry extension (`dependencies.rs`)

```rust
pub struct ManagedSource {
    /// GitHub repo, e.g. "yt-dlp/yt-dlp"
    pub repo: &'static str,
    /// Release asset per platform; None = platform unsupported for managed install
    pub asset_macos: Option<&'static str>,    // "yt-dlp_macos" (universal2)
    pub asset_windows: Option<&'static str>,  // "yt-dlp.exe"
    pub asset_linux: Option<&'static str>,    // "yt-dlp_linux"
    /// Checksums asset name, e.g. "SHA2-256SUMS"
    pub checksums_asset: &'static str,
}

pub struct DependencyDef {
    // ... existing fields ...
    pub managed: Option<ManagedSource>,   // ffmpeg: None, yt-dlp: Some(...)
}
```

Version comparison: a pure `fn version_lt(installed: &str, latest: &str) -> bool`
that splits on `.`/`-` and compares numeric segments (yt-dlp tags are
`YYYY.MM.DD`, zero-padded, but numeric compare is robust either way; strip a
leading `v`). Unit-tested.

### 2. Managed binary location & resolution order

- Binaries install to `{app_data_dir}/bin/` — **one level above the profile
  dir**, shared across profiles (a profile-local yt-dlp copy makes no sense and
  wastes 30 MB per profile). `AppState.app_dir` is the *profile* dir, so add the
  bin dir as a new field or compute it once in `lib.rs` setup.
- `dependencies.rs` gets a `static MANAGED_BIN_DIR: OnceLock<PathBuf>` set once
  during `lib.rs` setup. `augmented_path()` / `command_with_path()` /
  `tokio_command_with_path()` **prepend** this directory to `PATH` (all
  platforms, not just macOS). Result: once a managed copy exists it wins over
  the system one; until then, system PATH behavior is unchanged. This also means
  `plugin_exec` and every internal consumer pick up the managed copy with zero
  call-site changes.
- `check_single()` additionally reports **origin**: extend `DepStatus::Installed`
  to `{ version, origin }` where `origin: "managed" | "system"` (determine by
  checking whether `{bin_dir}/{name}` exists — the PATH prepend guarantees it's
  the one being used). Serialized to the frontend for UI labeling.

### 3. Install/update flow (backend)

New module functions in `dependencies.rs` + thin commands in
`commands/media.rs`:

- `dependency_latest_version(name) -> Result<String, String>` — GET
  `https://api.github.com/repos/{repo}/releases/latest` via `reqwest`
  (already a dependency, `blocking` + `json` features present), parse
  `tag_name`. Cache result in-memory with a 24 h TTL (new
  `latest: Mutex<HashMap<String, (Instant, String)>>` on `DepCache`). Send a
  `User-Agent` header (GitHub API requires one).
- `dependency_install(app, name) -> Result<String, String>` (returns installed
  version). Runs in `spawn_blocking`:
  1. Resolve the platform asset from `ManagedSource`; error if `None` for this
     platform.
  2. Download `https://github.com/{repo}/releases/latest/download/{asset}` to
     `{bin_dir}/.{name}.download` (temp name), emitting
     `dependency-install-progress` events `{ name, downloaded, total }`
     (chunked read off the response body).
  3. Download `{checksums_asset}`, find the line for the asset
     (`<sha256>  <filename>` format), verify with `sha2` (already a
     dependency). Mismatch → delete temp file, error.
  4. `chmod +x` (unix), then **atomic rename** to `{bin_dir}/{name}`
     (`yt-dlp.exe` on Windows). Atomic rename handles the two-profiles-running
     case. Note: files downloaded by a non-browser process don't get the macOS
     quarantine xattr, so Gatekeeper does not block execution.
  5. `dep_cache.invalidate(name)`, re-run `check_single` to confirm, emit
     `dependency-installed` `{ name, version }`.
- `dependency_update(name)` — identical to install (latest-pointing URL), kept
  as a separate command only for log/UX wording. Implementation shares the
  install path.
- **Guard:** both commands validate `name` against `REGISTRY` entries with
  `managed.is_some()` — same spirit as the `plugin_exec` allow-list.

### 4. Outdated detection & auto-update

- `check_dependencies` stays fast/offline. Latest-version lookup is a separate
  concern so the Settings list never blocks on the network.
- `DependencyInfo` gains `latest_version: Option<String>` + `origin`, populated
  only when the 24 h cache already has an answer (no network on the hot path).
- New command `dependency_check_updates()` — for each managed def, fetch latest
  (respecting TTL cache), compare with installed. Returns
  `[{ name, installed, latest, outdated, origin }]`.
- **Auto-update task** (`lib.rs` setup, same `thread::spawn` pattern as other
  background tasks): ~30 s after startup, if the `autoUpdateManagedDeps` store
  setting is on (default **true**), for each managed dep where origin is
  `managed` and outdated → run the install flow silently, emit
  `dependency-updated` `{ name, from, to }` → frontend `addLog("yt-dlp updated
  to 2026.x.y")`. **Never auto-update `origin: "system"` copies** — those belong
  to the user's package manager; we only show the upgrade command for them.
- The frontend reads the setting from the app store and passes it to the task
  via an invoke at startup (or the task reads the store file directly like the
  logging settings already do in `lib.rs` — follow that existing pattern).

### 5. Runtime failure hint

In `yt_dlp_stream_audio` (and any future managed-dep exec error path): on
non-zero exit, consult the cached latest version (no fresh network call). If
known-outdated, append to the error: `"yt-dlp failed (installed 2024.10.22,
latest 2026.06.01 — update it in Settings > Dependencies): <stderr>"`. This is
the single highest-value surfacing moment — stale yt-dlp failures look like
app bugs to users.

### 6. Frontend

**`useDependencies.ts`**
- `DependencyInfo` gains `latestVersion?`, `origin?`.
- New: `installDep(name)` / `updateDep(name)` → invoke commands, track
  per-dep progress state from `dependency-install-progress` events, re-check on
  completion. Errors → `console.error` + surfaced in the calling UI.
- New: `checkUpdates()` → invoke `dependency_check_updates`.

**`DependencyModal.tsx`**
- When `dep` has a managed source for this platform (backend exposes
  `managedAvailable: bool` on `DependencyInfo`): primary button becomes
  **"Install for me"** with a progress bar during download (significant
  operation → progress indicator per conventions); the terminal command +
  Download Page demote to a "or install manually" section. On success the modal
  closes itself (dep is now installed).
- No managed source → exactly today's modal.

**`SettingsPanel.tsx` `DependenciesSection`**
- Each row adds: origin label (`managed by Viboplr` / `system`), latest-version
  badge when outdated (`Installed 2024.10.22 → 2026.06.01 available`), and an
  action button:
  - not installed + managed available → **Install**
  - managed + outdated → **Update**
  - system + outdated → show the platform upgrade command
    (`brew upgrade yt-dlp`) with a Copy button — never a managed overwrite.
- "Refresh" button also calls `checkUpdates()`.
- New toggle in the same group: **"Keep managed dependencies up to date
  automatically"** → `autoUpdateManagedDeps` store key, default on.
- All new UI uses `.ds-*` classes and skin custom properties.

### 7. What does NOT change

- Plugin manifest format (`binaryDependencies` already carries name + reason).
- The `require-dependency` UI action and `promptDep`/`requireDep` API.
- `plugin_exec` allow-list semantics.
- ffmpeg UX (instruct-only modal, brew/winget/apt commands).
- The debug-only `fictional-tool` (give it `managed: None`; optionally add a
  second debug-only managed fake later if modal testing needs it).

## Implementation Steps

1. **`dependencies.rs`:** `ManagedSource`, `managed` field on `DependencyDef`
   (yt-dlp populated, others `None`), `version_lt`, `MANAGED_BIN_DIR` OnceLock,
   PATH prepend in the three command builders, `origin` on
   `DepStatus::Installed`, latest-version TTL cache on `DepCache`.
   Unit tests: version compare (incl. `v` prefix, unequal segment counts),
   checksum-line parsing, asset selection per platform, origin detection.
2. **`commands/media.rs`:** `dependency_install`, `dependency_update`,
   `dependency_check_updates`, latest-version plumbing into
   `check_dependencies` (cache-only), managed-name guard. Register in both
   `lib.rs` invoke-handler lists (debug + release — verify with
   `cargo check --release`).
3. **`lib.rs`:** set `MANAGED_BIN_DIR` (`app_data_dir.join("bin")`,
   `create_dir_all`), spawn the auto-update background task.
4. **Runtime hint:** outdated suffix in `yt_dlp_stream_audio` error path.
5. **Frontend hook:** extend `useDependencies.ts` (install/update/progress/
   checkUpdates).
6. **`DependencyModal.tsx`:** "Install for me" + progress + manual fallback.
7. **`SettingsPanel.tsx`:** origin labels, outdated badges, Install/Update
   buttons, upgrade-command row for system copies, auto-update toggle.
8. **Docs:** update `.claude/rules/backend.md` (dependencies module section)
   and `PLUGIN-API-REFERENCE.md` if it documents `binaryDependencies`.

Steps 1–4 (backend) are shippable and testable before any frontend work; the
auto-update task alone already delivers most of the user value.

## Testing

- **Rust:** pure-function unit tests per `testing.md` (version compare,
  checksum parse, asset pick, registry invariants — extend the existing
  `test_registry_has_install_instructions` style). No network in tests.
- **Manual:** delete `{app_data_dir}/bin/yt-dlp` → modal install flow;
  plant an old binary → auto-update + Settings badge; brew-installed copy →
  origin "system", upgrade-command row, never overwritten.
- **TS:** if any non-trivial pure logic lands in the hook (e.g. progress
  reduction), extract and test in `src/__tests__/`.

## Risks / Notes

- **GitHub rate limits:** unauthenticated API = 60 req/h/IP. One
  `releases/latest` call per managed dep per 24 h is far under; the TTL cache
  must also apply to failures (treat a failed lookup as "unknown", retry next
  TTL window) so a flaky network doesn't hammer the API.
- **Windows file lock:** can't rename over a running `yt-dlp.exe`. yt-dlp runs
  are short; on rename failure, log + retry on next auto-update cycle rather
  than erroring at the user.
- **yt-dlp macOS asset** is universal2 (`yt-dlp_macos`) — covers arm64 + x64
  with one asset name. Linux: `yt-dlp_linux` is x86_64; aarch64 Linux users
  fall back to instruct-only (asset resolution returns unsupported → modal
  shows manual instructions, same as today).
- **Trust/provenance:** downloads pinned to the `yt-dlp/yt-dlp` repo constant
  + SHA-256 verification from the same release. Checksums-from-same-source
  verifies integrity (truncated/corrupted download), not authorship — same
  trust model as the plugin/skin galleries.
