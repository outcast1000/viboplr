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
- Test pure functions extracted from hooks — don't test React components directly
- Use `vi.fn()` for mocks
- Factory helpers like `makeTrack()`, `makeProvider()` for test data
- E2E specs are excluded from the vitest run via `exclude: ["tests/e2e/**"]` in the vitest config

## End-to-End (Playwright)

**Config:** `tests/e2e/playwright.config.js`. **Test location:** `tests/e2e/specs/`.

**Mocks:** `tests/e2e/tauri-mock.js` mocks the Tauri IPC layer so tests run in a browser without the Rust backend. E2E tests drive the dev server, not a built app — anything that only exists in a Tauri build (native menus, the mpv engine, file dialogs) cannot be asserted here.
