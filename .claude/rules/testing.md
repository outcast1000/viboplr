# Testing

## Commands

```bash
npm run test:all   # Rust + TypeScript + E2E (sequential)
npm test           # TypeScript unit tests (vitest run)
npm run test:watch # TypeScript tests in watch mode
npm run test:rust  # Rust tests (cd src-tauri && cargo test)
npm run test:e2e   # Playwright E2E tests
```

## Backend (Rust)

**Framework:** `cargo test` with `#[cfg(test)]` modules.

**Files with tests:** `db.rs`, `scanner.rs`, `tape.rs`, `plugins.rs`, `commands.rs`, `skins.rs`, `entity_image.rs`.

**Test dependencies:** `tempfile = "3"` for temporary files.

**Patterns:**
- All database tests use `Database::new_in_memory()` — no external DB needed
- Helper functions `test_db()` and `test_collection()` set up test state
- Test naming: `test_<what_it_verifies>()` (e.g., `test_upsert_and_get_track`, `test_artist_crud`)
- Tests cover: CRUD operations, deduplication, file detection, filename parsing

**Writing new Rust tests:**
```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        Database::new_in_memory().unwrap()
    }

    #[test]
    fn test_your_feature() {
        let db = test_db();
        // setup, act, assert
    }
}
```

## Frontend (TypeScript)

**Framework:** Vitest 4.1.0, configured in `vite.config.ts`.

**Test location:** `src/__tests__/`

**Existing test files:**
- `computeSelection.test.ts` — multi-select, range selection, Shift/Cmd+click
- `fallbackProviders.test.ts` — async provider resolution with timeouts
- `hooks-logic.test.ts` — extracted hook logic (shuffle, strategy selection, positioning)
- `informationTypes.test.ts` — cache decision logic
- `queueEntry.test.ts` — queue/track URL handling and scheme parsing
- `skinUtils.test.ts` — skin validation, CSS generation, CSS sanitization
- `utils.test.ts` — formatDuration, isVideoTrack, getInitials, shouldScrobble, etc.

**Patterns:**
- Test pure functions extracted from hooks — don't test React components directly
- Use `vi.fn()` for mocks
- Factory helpers like `makeTrack()`, `makeProvider()` for test data
- Tests excluded from E2E: `exclude: ["tests/e2e/**"]` in vitest config

**Writing new TypeScript tests:**
```typescript
import { describe, it, expect, vi } from "vitest";

describe("featureName", () => {
  it("does the expected thing", () => {
    const result = yourFunction(input);
    expect(result).toBe(expected);
  });
});
```

## End-to-End (Playwright)

**Framework:** Playwright 1.59.1

**Config:** `tests/e2e/playwright.config.js`
- Browser: Chromium
- Base URL: `http://localhost:1420`
- Timeout: 30s per test
- Auto-starts dev server (`npm run dev`), reuses if already running
- Screenshots on failure only

**Test location:** `tests/e2e/specs/`

**Existing test files:**
- `smoke.test.js` — app launches, sidebar items render, view switching, search input, settings panel
- `queue-url.test.js` — track playback, queue behavior, now playing bar updates, URL scheme stamping

**Mocks:** `tests/e2e/tauri-mock.js` mocks the Tauri IPC layer so tests run in a browser without the Rust backend.

**Writing new E2E tests:**
```javascript
const { test, expect } = require("@playwright/test");

test("description of what it tests", async ({ page }) => {
  await page.goto("/");
  // interact and assert
  await expect(page.locator(".sidebar")).toBeVisible();
});
```
