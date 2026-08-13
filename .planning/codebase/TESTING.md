# Testing Patterns

**Analysis Date:** 2026-08-14

## Test Framework & Configuration

### Frontend (TypeScript)

**Framework:** Vitest with `@testing-library/react`

**Config location:** `vite.config.ts` (lines 10-13):
```typescript
test: {
  exclude: ["tests/e2e/**", "node_modules/**", ".claude/**"],
  environment: "jsdom",
}
```

**Test directory:** `src/__tests__/` (co-located relative to source)

**Run commands:**
```bash
npm test                    # Run all TS tests
npm run test:watch         # Watch mode
npm run test:all           # All tests (Rust + TS + E2E)
```

### Backend (Rust)

**Framework:** Built-in `cargo test` with `#[cfg(test)]` inline modules

**Run commands:**
```bash
npm run test:rust          # All Rust tests
cd src-tauri && cargo test --lib  # Library tests only
```

**Test pattern:** Inline `#[cfg(test)] mod tests { }` within each module

### End-to-End (Playwright)

**Framework:** Playwright with browser automation

**Config location:** `tests/e2e/playwright.config.js`

**Test directory:** `tests/e2e/specs/`

**Run command:**
```bash
npm run test:e2e           # Playwright E2E tests
```

**Mocking:** `tests/e2e/tauri-mock.js` mocks Tauri IPC layer so tests run in a browser without the Rust backend.

---

## Frontend Test Structure (TypeScript)

### Naming Convention

**Files:** `<Feature>.test.ts` or `<Feature>.test.tsx` in `src/__tests__/`

**Examples:**
- `deleteTracks.test.ts` — tests for utility functions in `utils/deleteTracks.ts`
- `playActions.test.ts` — tests for functions in `hooks/usePlayActions.ts`
- `utils.test.ts` — tests for general utilities
- `playbackErrors.test.ts` — tests for error classification
- `reducedMotion.test.ts` — tests for accessibility preferences

### Test Suite Structure

**Pattern (describe + it):** Using Vitest's `describe` and `it`

Example from `deleteTracks.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { partitionTrackIds, buildDeleteConfirmPayload } from "../utils/deleteTracks";
import type { Track } from "../types";

describe("partitionTrackIds", () => {
  it("surfaces ids not in the loaded page as missingIds instead of dropping them", () => {
    const loaded = [t(1, "file:///a.mp3")];
    const { loaded: inPage, missingIds } = partitionTrackIds([1, 2, 3], loaded);
    expect(inPage.map(x => x.id)).toEqual([1]);
    expect(missingIds).toEqual([2, 3]);
  });

  it("fetches nothing when every id is already loaded", () => {
    const loaded = [t(1, "file:///a.mp3"), t(2, "file:///b.mp3")];
    const { loaded: inPage, missingIds } = partitionTrackIds([1, 2], loaded);
    expect(inPage.map(x => x.id)).toEqual([1, 2]);
    expect(missingIds).toEqual([]);
  });
});
```

**Factories for test data:** Helper functions create test objects with reasonable defaults

From `deleteTracks.test.ts` (lines 5-26):
```typescript
function t(id: number, path: string | null, title = `Track ${id}`): Track {
  return {
    id,
    key: `lib:${id}`,
    path,
    title,
    artist_id: null,
    artist_name: null,
    album_id: null,
    album_title: null,
    year: null,
    track_number: null,
    duration_secs: null,
    format: null,
    file_size: null,
    collection_id: null,
    collection_name: null,
    liked: 0,
    added_at: null,
    modified_at: null,
  };
}
```

### Pure Function Testing

**Preferred approach:** Test pure functions extracted from hooks, not hooks themselves

**Examples:**
- `playActions.test.ts` tests pure functions: `extractDescription()`, `buildAlbumContext()`, `buildArtistContext()`, `buildTagContext()`
- `deleteTracks.test.ts` tests pure utilities: `partitionTrackIds()`, `buildDeleteConfirmPayload()`

These are fast, reliable, and don't require React setup.

### Hook Testing (When Necessary)

**When to mount a hook:** Only when behavior **genuinely lives in hook state** and cannot be extracted

**Pattern:** Using `renderHook` from `@testing-library/react` with `act()`

**Example locations:** (grep for `renderHook`):
- `src/__tests__/useQueueClear.test.tsx` — queue clearing with state mutations
- `src/__tests__/useDetailHeroImages.test.tsx` — async image resolution

**Avoid:** Rendering entire components; this is slower and tests more than the hook itself.

### Mocking

**Tauri seams:** Mock at the module boundary with `vi.mock()`

Common patterns:
```typescript
vi.mock("@tauri-apps/api/core");      // Mock invoke
vi.mock("../utils/tauriEvents");      // Mock event listeners
vi.mock("@tauri-apps/plugin-dialog"); // Mock file dialogs
vi.mock("../telemetry");              // Mock analytics
```

**Test factories:** Use `makeTrack()`, `makeProvider()`, etc. for test data
- These factories default all fields to sensible values
- Only override what the test needs to vary

**Spy and assert:** Use `vi.fn()` to create spy functions that track calls

Example from `useLikeActions.ts` dependencies:
```typescript
notify: (message: string) => void;  // This gets a vi.fn() in tests
```

### Assertion Patterns

**Format:** Use Vitest/Vitest assertions (`expect()`)

**Common patterns:**
```typescript
expect(result).toEqual([1, 2]);           // Exact equality
expect(result).toBeNull();                // Null check
expect(result!.title).toBe("OK Computer"); // Property check
expect(result.length).toBeGreaterThan(0);  // Numeric comparison
expect(() => fn()).toThrow();              // Error expectation
```

### Example Test File

`src/__tests__/playActions.test.ts` (lines 1-75):
```typescript
import { describe, it, expect } from "vitest";
import {
  extractDescription,
  buildAlbumContext,
  buildArtistContext,
  buildTagContext,
  type InfoRow,
} from "../hooks/usePlayActions";

describe("extractDescription", () => {
  it("extracts summary from ok row matching the info type", () => {
    const rows: InfoRow[] = [
      [1, "artist_bio", JSON.stringify({ summary: "English rock band", full: "Full bio text" }), "ok", 1700000000],
    ];
    expect(extractDescription(rows, "artist_bio")).toBe("English rock band");
  });

  it("falls back to full when summary is empty", () => {
    const rows: InfoRow[] = [
      [1, "album_wiki", JSON.stringify({ summary: "", full: "Full review" }), "ok", 1700000000],
    ];
    expect(extractDescription(rows, "album_wiki")).toBe("Full review");
  });

  it("returns null when info type not found", () => {
    const rows: InfoRow[] = [
      [1, "artist_bio", JSON.stringify({ summary: "Bio" }), "ok", 1700000000],
    ];
    expect(extractDescription(rows, "album_wiki")).toBeNull();
  });
});
```

---

## Backend Test Structure (Rust)

### Test Module Pattern

**Location:** Inline within each `.rs` file

**Pattern (from `bundle_ref.rs` lines 66-118):**
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_absolute_ref() {
        assert!(is_absolute_ref("https://cdn/x.mp3"));
        assert!(is_absolute_ref("subsonic://c/1"));
        assert!(!is_absolute_ref("tracks/01-x.flac"));
        assert!(!is_absolute_ref(""));
    }

    #[test]
    fn test_absolute_passthrough() {
        assert_eq!(
            resolve_subscribe_ref("https://h/a/manifest.json", "https://cdn.example.com/x.mp3"),
            Some("https://cdn.example.com/x.mp3".to_string())
        );
    }

    #[test]
    fn test_guardrail_drops_non_http() {
        assert_eq!(resolve_subscribe_ref("https://h/a/manifest.json", "file:///etc/passwd"), None);
    }
}
```

### Naming Convention

**Pattern:** `test_<what_it_verifies>()` 

**Examples (from backend.md):**
- `test_upsert_and_get_track`
- `test_artist_crud`
- `test_is_absolute_ref`
- `test_normalized_lookups_use_the_expression_indexes` (pinned property-based test)
- `test_format_clauses_cover_every_scanned_video_extension` (schema coverage)
- `test_only_recoverable_statuses_are_retried` (update logic)

### Database Tests

**Setup:** In-memory database with helper functions

**Pattern (from testing.md in `.claude/rules/testing.md`):**
- All database tests use `Database::new_in_memory()` — no external DB needed
- Helper functions `test_db()` and `test_collection()` set up test state
- Tests cover: CRUD operations, deduplication, file detection, filename parsing

### Test Coverage

**Scope (from testing.md):** Find with `grep -rl '#\[cfg(test)\]' src-tauri/src`

**Current test locations (sample):**
- `browse_window.rs` — window management tests
- `bundle_ref.rs` — ref resolution + security guardrails
- `entity_image.rs` — image slug generation
- `downloader.rs` — download logic
- `dependencies.rs` — binary dependency checking

**Not all modules have tests** — focus is on critical logic (URL resolution, database integrity, dependency management).

---

## End-to-End Test Structure (Playwright)

### Configuration

**File:** `tests/e2e/playwright.config.js`

**Setup pattern (from `home.test.js`):**
```javascript
test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });  // Inject Tauri mock
  await page.goto('/');                               // Navigate to app
  await page.waitForSelector('.sidebar');             // Wait for layout
});
```

**Mock path:** `tests/e2e/tauri-mock.js` mocks the entire Tauri IPC layer

### Scope & Limitations

**What works:**
- React component rendering
- DOM navigation and clicks
- User input and keyboard events
- Client-side state changes
- View/modal interactions

**What does NOT work:**
- Native menus (no DOM, cannot be clicked)
- Native file dialogs
- mpv native engine (not in browser)
- Backend invokes (mocked to return fake data)
- Tauri-only features

### Test Pattern

**File:** `tests/e2e/specs/<Feature>.test.js`

**Example from `home.test.js` (lines 14-26):**
```javascript
test('Home is the first sidebar item and renders the home view', async ({ page }) => {
  const home = page.locator('.nav .nav-btn').filter({ hasText: 'Home' });
  await expect(home).toBeVisible();

  const firstBtn = page.locator('.nav .nav-btn').first();
  await expect(firstBtn).toContainText('Home');

  await home.click();

  await expect(page.locator('.home-view')).toBeVisible();
  await expect(page.locator('.home-view-header button').filter({ hasText: 'Refresh' })).toBeVisible();
});
```

### Assertion Patterns

**Playwright assertions:**
```javascript
await expect(selector).toBeVisible();
await expect(selector).toContainText('Text');
await expect(selector).toHaveText('Exact text');
await expect(selector).toHaveClass('class-name');
```

**Modal dismiss convention test (from `home.test.js` line 46):**
```javascript
// Per the modal-dismiss convention, only the explicit action closes it.
await modal.locator('button').filter({ hasText: 'Done' }).click();
await expect(modal).not.toBeVisible();
```

---

## Native Menu Testing

**Note:** Native menus have no DOM, so they **cannot be tested via UI automation**

**Approach:** Build the spec in a **pure builder function** and test *that*

**Pattern (from testing.md in `.claude/rules/testing.md`):**
```typescript
// src/contextMenu/buildContextMenuSpecs.ts
export function buildContextMenuSpecs(target, deps): MenuItemSpec[] {
  // Pure function that builds the menu items
  // No side effects, no React state
}
```

**Test the builder (src/__tests__/contextMenu.test.ts):**
```typescript
describe("buildContextMenuSpecs", () => {
  it("includes delete item for local tracks", () => {
    const specs = buildContextMenuSpecs(
      { kind: "track", isLocal: true, trackId: 1 },
      deps
    );
    const deleteItem = specs.find(s => s.label === "Delete");
    expect(deleteItem).toBeDefined();
  });

  it("excludes delete item for remote tracks", () => {
    const specs = buildContextMenuSpecs(
      { kind: "track", isLocal: false, trackId: 1 },
      deps
    );
    const deleteItem = specs.find(s => s.label === "Delete");
    expect(deleteItem).toBeUndefined();
  });
});
```

**Existing examples:**
- `src/contextMenu/buildContextMenuSpecs.tsx` — builds queue and track context menus (pure)
- `src/contextMenu/buildQueueHeaderMenuSpecs.ts` — builds the queue header `⋯` menu (pure)
- Tests: `contextMenu.test.ts` (if exists) or `queueHeaderMenu.test.ts`

---

## Test Coverage & Gaps

### Well-Tested Areas

**Frontend:**
- Pure utilities: `deleteTracks`, `playActions`, `errorKind`, `normalize`
- Hook-specific logic: `useQueue` (clear), `useDetailHeroImages` (async resolution)
- PlayActions contexts (album/artist/tag) and manifest roundtrips

**Backend:**
- URL resolution and security (`bundle_ref`)
- Entity image slug generation (`entity_image`)
- Database operations (CRUD, dedup, filename parsing)

### Gaps

**Frontend:**
- Modal interactions (but modals test their *props* via unit tests, not E2E)
- Native menus only tested via builder functions (cannot automate)
- Keyboard shortcuts (limited E2E coverage)

**Backend:**
- Some collection types (plugin-registered kinds)
- Streaming and network error paths (harder to mock)

**E2E:**
- Real backend operations (mocked)
- Native features (menus, dialogs, mpv)

---

## Adding New Tests

### When to Write Tests

**Required:**
- Pure utility functions (always testable)
- Error handling and edge cases
- Complex state mutations (queue operations)
- Public hooks that are reused

**Recommended but not always done:**
- Component rendering (test props/callbacks instead)
- E2E user flows (focused on critical paths)

### Where to Put Tests

**Frontend:**
- Pure functions: `src/__tests__/<Feature>.test.ts`
- Hooks (if tested): `src/__tests__/<HookName>.test.tsx`
- Components: Prefer testing via props/callback spies; render as last resort

**Backend:**
- Inline in the same module: `#[cfg(test)] mod tests { }`

**E2E:**
- `tests/e2e/specs/<Feature>.test.js`

### Test File Template

**TS/TSX (from existing pattern):**
```typescript
import { describe, it, expect } from "vitest";
import { myFunction } from "../utils/myFeature";

describe("myFunction", () => {
  it("does the expected thing", () => {
    const result = myFunction(input);
    expect(result).toEqual(expected);
  });

  it("handles edge case", () => {
    const result = myFunction(edgeCase);
    expect(result).toBeNull();
  });
});
```

**Rust:**
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_does_the_expected_thing() {
        let result = my_function(input);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_handles_edge_case() {
        let result = my_function(edge_case);
        assert!(result.is_err());
    }
}
```

---

## Running Tests

**All tests:**
```bash
npm run test:all
```

**Frontend only:**
```bash
npm test
npm run test:watch          # Watch mode for development
```

**Backend only:**
```bash
npm run test:rust
cd src-tauri && cargo test --lib   # Library tests
```

**E2E only:**
```bash
npm run test:e2e
```

**Specific test file:**
```bash
npm test deleteTracks.test.ts
```

---

## Mocking Best Practices

### Tauri APIs

**Mock `invoke`:**
```typescript
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: any) => {
    if (cmd === "delete_tracks") return { deleted: args.trackIds.length };
    throw new Error(`Unmocked command: ${cmd}`);
  }),
}));
```

**Mock events:**
```typescript
vi.mock("../utils/tauriEvents", () => ({
  subscribe: vi.fn(),
  combineUnlisten: vi.fn(() => () => {}),
}));
```

### Test Data

**Use factories** to create consistent test objects:
```typescript
function makeTrack(overrides?: Partial<Track>): Track {
  return {
    id: 1,
    title: "Test Track",
    artist_name: "Test Artist",
    path: "file:///test.mp3",
    ...overrides,
  };
}

// In test:
const track = makeTrack({ title: "My Track" });
```

### Avoid Over-Mocking

**Don't mock:**
- Pure function inputs/outputs (they're deterministic)
- Business logic you want to test
- Implementation details

**Do mock:**
- External services (Tauri, network)
- Side effects (file I/O, timers)
- Dependencies needed only for setup

---

*Testing analysis: 2026-08-14*
