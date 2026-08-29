---
paths:
  - "src/__tests__/**"
  - "tests/**"
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.test.js"
---

# Testing

Commands live in `package.json` scripts (`test`, `test:rust`, `test:e2e`, `test:all`) — see `CLAUDE.md` for the ones that carry required flags.

## Backend (Rust)

**Framework:** `cargo test` with `#[cfg(test)]` modules. Find current coverage with `grep -rl '#\[cfg(test)\]' src-tauri/src`.

**Patterns:**
- All database tests use `Database::new_in_memory()` — no external DB needed
- Helper functions `test_db()` and `test_collection()` set up test state
- Test naming: `test_<what_it_verifies>()` (e.g., `test_upsert_and_get_track`, `test_artist_crud`)
- Tests cover: CRUD operations, deduplication, file detection, filename parsing

## Frontend (TypeScript)

**Framework:** Vitest, configured in `vite.config.ts`. **Test location:** `src/__tests__/`.

**Patterns:**
- Prefer testing pure functions extracted from hooks. When a behaviour genuinely lives in hook state and can't be extracted without inventing an abstraction, mount it with `renderHook` from `@testing-library/react` and drive it inside `act()` — see `useQueueClear.test.tsx` (queue clearing) and `useDetailHeroImages.test.tsx`. Rendering a whole component is still the last resort.
- Mock the Tauri seams at the module boundary: `vi.mock("@tauri-apps/api/core")` for `invoke`, plus `../utils/tauriEvents`, `@tauri-apps/plugin-dialog`, and `../telemetry` as needed.
- Use `vi.fn()` for mocks
- Factory helpers like `makeTrack()`, `makeProvider()` for test data
- E2E specs are excluded from the vitest run via `exclude: ["tests/e2e/**"]` in the vitest config

**Native menus:** every menu is a native OS menu with no DOM, so its items can't be clicked from any test layer. Build the specs in a pure `build*MenuSpecs()` function (`src/contextMenu/`) and assert *that* — item set, ordering, check state, and that each action fires the right callback. `buildContextMenuSpecs` and `buildQueueHeaderMenuSpecs` are the two examples; a new native menu should follow suit rather than shipping untestable.

## End-to-End (Playwright)

**Config:** `tests/e2e/playwright.config.js`. **Test location:** `tests/e2e/specs/`.

**Mocks:** `tests/e2e/tauri-mock.js` mocks the Tauri IPC layer so tests run in a browser without the Rust backend. E2E tests drive the dev server, not a built app — anything that only exists in a Tauri build (native menus, the mpv engine, file dialogs) cannot be asserted here. For that tier see **Built app** below.

## Built app (macOS)

`npm run app:smoke` is the only check that runs against **the bundle we ship**. It drives the installed app through the `viboplr://probe` deep link (`src/utils/probeControl.ts`) and reads back a state dump — see CLAUDE.md → "Built-app smoke test + startup series" for the mechanism and the constraints on the dump command.

Keep the *decisions* out of the runner. `scripts/lib/appSmoke.mjs` holds the pure checks (`checkDump`, `startupEntry`, `startupDelta`) and is unit-tested in `src/__tests__/appSmoke.test.ts`; `scripts/app-smoke.mjs` only launches, waits and prints. Same reasoning as the native-menu spec builders above — the part that decides whether a release is broken must be assertable without the thing it drives.

App launching/steering/quitting lives in `scripts/lib/appControl.mjs`, shared with `scripts/perf-probe.mjs`. A second script that needs to drive the app imports it rather than re-deriving `open`/`pgrep`/`osascript` handling.

**Adding a probe verb is adding shipped surface.** The route is gated only by profile name, so the bar is high. The rule is **nothing that could damage a real library** — deletes, downloads, writes to a caller-named path.

Two verbs deliberately sit on the other side of that line and the reasoning matters: `collection=<path>` and `onboarding=dismiss` mutate the profile, but a `perf` profile is a disposable harness profile with no real library in it, and the alternative was a setup script editing `app-state.json` behind the running app's back — which duplicates the store schema, races the app's own debounced flush, and cannot reach the database where collections actually live. They run once during `npm run perf:setup`, not during measurement. `collection-sync` still has no `drive` for exactly that reason: it would mutate on every *sample*.

`dump=on` deliberately takes **no path** — a URL naming its own write destination is a write-anywhere primitive. `open=` and `collection=` do take paths, because they only *read* one.

**Scope locators to a surface — several components are mounted more than once.** `FullscreenControls` is in the DOM alongside the docked `NowPlayingBar` (hidden by `.fs-controls { display: none }` until fullscreen), and it mounts its own copies of `SourceIndicator`, the seek ladder, the transport and the EQ cluster — deliberately, because inside DOM `:fullscreen` the browser paints only the fullscreened subtree, so these cannot be hoisted (see `ui.md`). A bare `page.locator('.now-source-icon')` therefore matches **two** nodes and fails Playwright's strict mode even when exactly one is visible — which is not a bug in the app and not something `toBeVisible()` can express. Anchor on the owning surface instead (`.now-playing …` for the docked bar, `.audio-fs .fs-controls …` for the fullscreen one). Reach for `.first()` only when either copy would genuinely do.

**Port 1420 is shared and `reuseExistingServer` is on.** If another checkout's `npm run dev` holds it, Playwright silently attaches to *that* build and reports its results as yours. Check the port is free (or that the server it reused is this worktree's) before trusting a run — a pass and a failure are equally meaningless otherwise.

**`test:e2e` writes into the repo.** `screenshots.test.js` drops raw `.png` intermediates into `docs/assets/screenshots/` (the tracked assets are the `.webp` that `scripts/convert-screenshots.mjs` produces). They're untracked byproducts; clean them up rather than committing them.
