# Coding Conventions

**Analysis Date:** 2026-08-14

## Naming Patterns

### Files

**TypeScript/React:**
- **Components:** PascalCase with `.tsx` extension (e.g., `TrackList.tsx`, `NowPlayingBar.tsx`, `DetailHero.tsx`)
- **Hooks:** camelCase with `use` prefix and `.ts` extension (e.g., `usePlayback.ts`, `useQueue.ts`, `useLikeActions.ts`)
- **Utils/Helpers:** camelCase with `.ts` extension (e.g., `errorLog.ts`, `normalize.ts`, `diagnosticReport.ts`)
- **Type files:** specific names like `types.ts`, `types/skin.ts`, `types/plugin.ts`
- **Tests:** co-located with `.test.ts` or `.test.tsx` suffix in `src/__tests__/` (e.g., `deleteTracks.test.ts`, `playActions.test.ts`)

**Rust:**
- **Modules:** snake_case (e.g., `scanner.rs`, `entity_image.rs`, `mpv_engine.rs`)
- **Functions:** snake_case (e.g., `resolve_subscribe_ref`, `is_absolute_ref`, `get_track_path`)
- **Tests:** inline `#[cfg(test)] mod tests { #[test] fn test_<name>() { } }` within module

### Functions

**TypeScript/React:**
- **Event handlers:** `handle<Action>` (e.g., `handleDeleteRequest`, `handleQueueRemove`, `handleDeleteConfirm`)
- **Hooks:** `use<Feature>` (e.g., `usePlayback`, `useQueue`, `useLikeActions`, `useContextMenuActions`)
- **Helpers/Pure functions:** verb-based camelCase (e.g., `nextTriState`, `sameSong`, `parseLibraryId`, `normalizeForMatch`, `dropPlayedHead`)
- **Getters/Checkers:** `is<Condition>` or `get<Resource>` or `check<State>` (e.g., `isLocalTrack`, `isVideoTrack`, `getPlaybackPosition`, `isCurrentPlayGeneration`)

**Rust:**
- **Constructors:** `new`, `new_in_memory` (e.g., `Database::new()`)
- **Getters:** typically just method name or `get_<field>` (e.g., `resolve_subscribe_ref`, `check_single`)
- **Boolean queries:** `is_<condition>` (e.g., `is_absolute_ref`, `is_local_file`)
- **Conversions:** `to_<type>` or `from_<type>` (e.g., `to_string()`)

### Variables and Enums

**TypeScript/React:**
- **State variables:** camelCase (e.g., `currentTrack`, `queueIndex`, `pendingEnqueue`, `selectedIndices`)
- **Refs:** camelCase with `Ref` suffix (e.g., `queueRef`, `inFlightRef`, `restoredRef`, `activeSlotRef`)
- **Callbacks:** `on<Event>` (e.g., `onContextMenu`, `onNavigateToArtistByName`, `onMoveMultiple`, `onAllowAll`)
- **Enums/Union types:** SCREAMING_SNAKE_CASE for constants (e.g., `POSITION_PERSIST_INTERVAL_MS`, `LIMITER_CEILING_DB`), SCREAMING_CASE for magic numbers
- **Type discriminators:** `kind`, `source`, `status` (e.g., `kind: "track"`, `source: "album"`, `status: "ok"`)

**Rust:**
- **Constants:** SCREAMING_SNAKE_CASE (e.g., `BUFFER_LIMIT`, `VIDEO_EXTENSIONS`, `AUDIO_EXTENSIONS`)
- **Module-level statics:** SCREAMING_SNAKE_CASE (e.g., `REGISTRY`, `CHECK_CONCURRENCY`)
- **Enum variants:** PascalCase (e.g., `DependencyDef`, `QueueMode::RepeatOne`)

### Types

**TypeScript/React:**
- **Interfaces:** PascalCase with `I` prefix or no prefix (codebase uses no prefix, e.g., `Track`, `QueueTrack`, `AppErrorEntry`, `PlaylistContext`)
- **Type aliases:** PascalCase or union notation (e.g., `HandlePlayOutcome = "play" | "bail" | "retry" | "fail"`, `View = "home" | "search" | "artists"`)
- **Discriminated unions:** use `kind` or `type` field with literal string values

**Rust:**
- **Structs:** PascalCase (e.g., `Database`, `Track`, `AppState`)
- **Enums:** PascalCase variants (e.g., `QueueMode`, `DependencyDef`, `UpdateError`)
- **Traits:** PascalCase ending in descriptive name (e.g., `ArtistImageProvider`, `AlbumImageProvider`)

## Code Style

### Formatting

**Tool:** No explicit eslint/prettier config found; the codebase follows **implicit conventions**:
- **Indentation:** 2 spaces (observed in all TS/TSX/Rust/JSON files)
- **Line length:** ~100-120 characters (observed from sample files)
- **Semicolons:** Present on all statements (TypeScript enforced by language)
- **Trailing commas:** Used in multi-line arrays/objects (modern JS style)

### Imports

**Import Order (TypeScript):**
1. React and React hooks (`import { useEffect, useRef, useState } from "react"`)
2. Third-party packages (`import { invoke } from "@tauri-apps/api/core"`)
3. Project types (`import type { Track, QueueTrack } from "../types"`)
4. Project utilities and helpers (`import { isVideoTrack, shouldScrobble } from "../utils"`)
5. Local hooks and components (`import { usePlayback } from "./usePlayback"`)
6. Relative imports from parent directories (`import { driveProgressMachine } from "../playback/progressMachine"`)

**Path aliases:** None observed in vite.config.ts; all imports use relative paths (`../`, `./`)

**Example from `usePlayback.ts` (lines 1-26):**
```typescript
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack, ResolvedTrackSource, EngineSource } from "../types";
import { isVideoTrack, shouldScrobble } from "../utils";
import { parseUrlScheme, isLocalTrack } from "../queueEntry";
import { needsTranscode } from "./useStreamResolution";
import { store } from "../store";
import { driveProgressMachine } from "../playback/progressMachine";
```

### Error Handling

**Mandatory Pattern:** Every `catch` block and `.catch()` handler MUST log the error with `console.error`.

**With context message:**
```typescript
invoke("write_frontend_log", { level: "info", message, section: "playback" })
  .catch((e) => console.error("Failed to persist migrated heroEffectMode:", e));
```

**Fire-and-forget (rare exception, requires comment explaining why):**
```typescript
// Comment explaining why the catch is empty — normally prohibited
.catch(() => {});
```

**Examples from codebase:**
- `src/heroEffectMode.ts`: `.catch((e) => console.error("Failed to persist migrated heroEffectMode:", e))`
- `src/videoFrameQueue.ts`: `console.error(\`Failed to check video frame cache (track ${trackId}):\`, e)`
- `src/App.tsx`: `.catch(console.error)` (most common shorthand)
- `src/hooks/useLikeActions.ts`: errors are caught with context in async functions

**No silent failures:** `.catch(() => {})` is banned except for documented fire-and-forget operations. Every error must be logged. See `conventions.md` "Error Logging" section for the exact rule.

### User Feedback

**For significant operations** (network, disk, >500ms):
- **Network searches/saves:** Use `notify()` from `useToasts` (toasts auto-dismiss in 4.5s, lightweight)
- **Multi-step operations:** Use loading states / disabled buttons / progress indicators
- **Failures:** Either notify with error via `notify()` or show error modal for critical failures
- **Fire-and-forget caching:** No feedback needed (e.g., waveform caching)

**Example from `useLikeActions.ts`:**
```typescript
interface UseLikeActionsDeps {
  // ...
  notify: (message: string) => void;
}
// Failure surfaced to user via notify callback
```

**Playback error feedback:** App.tsx owns the modal state (`reportProblem`); `PlaybackErrorModal` shows the failure and offers diagnostic report.

## Comments and Documentation

### Comment Style

**JSDoc/TSDoc:** Used for public functions and interfaces. Example from `usePlayback.ts` (lines 133-145):
```typescript
/**
 * Set a media element's playback rate the way a turntable behaves.
 *
 * `preservesPitch` defaults to TRUE, which time-stretches to hold the original
 * pitch — right for a podcast, wrong for a deck. A turntable resamples: 45 on a
 * 33 pressing plays faster AND higher, and that is the effect. The
 * webkit-prefixed name is what older Safari / some WKWebView builds honour, so
 * set both and let the unsupported one be ignored.
 *
 * Exported for the unit test — this is the one line that decides whether the
 * feature is a deck or a speed-reader, and it is invisible in a screenshot.
 */
export function applyRateTo(el: HTMLMediaElement | null, rate: number): void {
```

**Inline comments:** Explain *why*, not *what*. Example from `usePlayback.ts` (lines 42-52):
```typescript
// Master-bus limiter ceiling (dBFS) engaged for a simple-mode bass/treble boost.
// The limiter catches boosted peaks ~1 dB below full scale instead of clipping —
// so the boost stays loud rather than dropping the whole signal's level.
const LIMITER_CEILING_DB = -1;

// How often the ~4 Hz playback position is persisted to the store. Each
// store.set is a webview↔Rust IPC round-trip, so mirroring every tick cost
// ~14k invokes per hour of playback; restore precision only needs "roughly
// where I was", and the exact boundaries (pause/stop/track change) flush
// immediately via persistPositionNow.
```

**Module-level comments:** Document contract/behavior. Example from `errorLog.ts` (lines 1-12):
```typescript
// In-memory ring buffer of app errors, for the diagnostic report.
//
// Uncaught frontend errors are forwarded to the backend log file (App.tsx's
// window `error` / `unhandledrejection` handlers), but that file only exists
// when Settings → Debug → "Enable logging" is on, which defaults to OFF. So
// for virtually every real user the one thing worth reporting is written
// nowhere. This buffer always retains the last few errors in memory so
// "Report a problem" has something to show even with logging off.
```

**Rust doc comments:** Using `///` for public items. Example from `bundle_ref.rs` (lines 14-33):
```rust
/// Does `src` carry a URL scheme (`scheme:` / `scheme://`)? Per RFC 3986 a scheme
/// is `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` followed by `:`. If so the ref
/// is **absolute**; otherwise it's a **relative** path resolved against the base.
pub fn is_absolute_ref(src: &str) -> bool {
```

## Function Design

### Size Guidelines

**General:** Functions should be small and focused. A complex function like `usePlayback` is broken into **pure helpers** that are exported and unit-tested separately:
- `isCurrentPlayGeneration()` — pure, testable
- `decideHandlePlayOutcome()` — pure, testable  
- `isActiveMediaElement()` — pure, testable
- `canDriveTransitionMachine()` — pure, testable
- `crossfadeGainPair<T>()` — pure, generic, testable

### Return Values

**Explicit over implicit:**
- Return `null` or a union type (`T | null`) to indicate absence
- Return `Result<T, String>` for fallible operations in Rust (implicit in `#[tauri::command]` which returns `Result<T, String>`)
- Return objects with descriptive names (`{ loaded, missingIds }` instead of `[loaded, missingIds]`)

**Named return shapes:** Example from `deleteTracks.test.ts`:
```typescript
const { loaded: inPage, missingIds } = partitionTrackIds([1, 2, 3], loaded);
```

### Parameters

**Dependency injection pattern:** Hooks and functions receive a `deps` object instead of individual parameters when multiple related values are needed. Example from `useLikeActions.ts`:
```typescript
interface UseLikeActionsDeps {
  library: LibraryDeps;
  playback: PlaybackDeps;
  queueHook: QueueDeps;
  plugins: PluginsDeps;
  notify: (message: string) => void;
}

export function useLikeActions(deps: UseLikeActionsDeps) {
  const { library, playback, queueHook, plugins, notify } = deps;
```

**Refs for state access in callbacks:** When a function needs to read queue state inside event handlers or `setTimeout` callbacks, use refs instead of closure-captured state. This prevents stale reads. Example from `useLikeActions.ts`:
```typescript
const inFlightRef = useRef<Set<string>>(new Set());
if (inFlightRef.current.has(id)) return;
```

## Module Organization

### Hooks

**Location:** `src/hooks/` with corresponding exports

**Pattern:** Each hook is a pure function accepting a `deps` object and returning methods/state. Example `usePlayback.ts`:
- Owns audio element management
- Exports multiple handler methods
- Uses refs to access queue state in callbacks
- Manages playback-related state and side effects

### Components

**Location:** `src/components/` organized by feature area

**Pattern:** Presentational components receive primitive props and callbacks, own no app state
- `App.tsx` — root component, owns all app state
- `NowPlayingBar.tsx` — presents props, fires callbacks to App
- `QueuePanel.tsx` — right sidebar, owns only local UI state (selection, collapsed)

**Example:** `QueuePanel` receives `queue`, `queueIndex`, `onMoveMultiple`, etc. as props and calls them for mutations; `App.tsx` owns the actual state updates.

### Utilities

**Location:** `src/utils/` for general helpers, inline in hooks for hook-specific logic

**Pure functions preferred:** Utilities in `src/utils/` are pure and unit-tested (no side effects, no React state)
- `src/utils/deleteTracks.ts` — pure `partitionTrackIds()`, `buildDeleteConfirmPayload()`
- `src/utils/normalize.ts` — pure `normalizeForMatch()`
- `src/utils/errorLog.ts` — simple ring buffer operations

## Context and State Patterns

### React State

**Store pattern (tauri-plugin-store):** Persistent state lives in `store` and is read via `store.get()` / written via `store.set()` at strategic points.

**App-wide state:** Owned by `App.tsx` and passed down via props or hooks. Examples:
- `library` state (tracks, artists, albums, tags)
- `queue` and `queueIndex`
- `playback` (currentTrack, paused, etc.)
- View mode (`view` union type)

**Restoration:** App.tsx calls `readPersistedSettings()` on mount to hydrate state, guarded by `restoredRef` to prevent overwrites of persisted data with defaults.

### Refs

**Purpose:** When state must be read inside callbacks/event handlers to avoid closure staleness.

**Pattern:** Ref is paired with state and updated on every render:
```typescript
const [queue, setQueue] = useState<QueueTrack[]>([]);
const queueRef = useRef<QueueTrack[]>([]);

useEffect(() => {
  queueRef.current = queue;
}, [queue]);

// In event handler:
const current = queueRef.current; // Always fresh
```

### Module-Level State

**Singletons:** `errorLog.ts` and `resolverLog.ts` use module-level mutable buffers. Accessed via `window.__appErrors` and `window.__resolverLog` in devtools.

**The `store`:** Global singleton for persistent state, wrapped by Tauri's `@tauri-apps/plugin-store`.

## Testing Conventions

See TESTING.md for detailed test patterns.

## Canonical Actions (from conventions.md)

When implementing repeated actions, follow the exact patterns defined in `.claude/rules/conventions.md`:
- **Delete Tracks:** Via `useContextMenuActions.ts` → `handleDeleteRequest()` / `performDelete()`
- **Like/Unlike:** Via `useLikeActions.ts` → `handleToggleLike()` / `handleToggleDislike()`
- **Play/Enqueue:** Via `useQueue.ts` → `playTracks()` / `enqueueTracks()`
- **Queue management:** Via `useContextMenuActions.ts` → `handleQueueRemove()` / `handleQueueMoveToTop()`
- **Tag editing:** Via `TagEditor.tsx` (shared component) + `useTagActions.ts`

**Do NOT reimplement** these flows elsewhere in the codebase. Always route through the canonical implementation.

## Where to Add New Code

### New Component
- **Location:** `src/components/`
- **Naming:** PascalCase.tsx
- **Pattern:** Receive props, call callbacks; own no app state unless it's ephemeral UI state (e.g., collapsed/expanded)
- **Styling:** In `src/components/<Component>.css` or inline in `src/App.css`

### New Hook
- **Location:** `src/hooks/`
- **Naming:** `use<Feature>.ts`
- **Pattern:** Accept `deps` object, return methods/values
- **Testing:** Co-located test file in `src/__tests__/<HookName>.test.ts`

### New Utility
- **Location:** `src/utils/<Feature>.ts`
- **Pattern:** Pure functions, no side effects, no React state
- **Testing:** Unit test in `src/__tests__/<Feature>.test.ts`

### New Command (Rust)
- **Location:** `src-tauri/src/commands/` split by area
- **Signature:** `pub async fn <name>(State<'_, AppState>) -> Result<T, String>`
- **Pattern:** Parse input, delegate to `db/` layer or modules
- **Testing:** Unit tests in `#[cfg(test)] mod tests` within the file

### New Database Operation (Rust)
- **Location:** `src-tauri/src/db/<entity>.rs`
- **Pattern:** Methods on `Database` struct via `impl` blocks
- **Testing:** Tests in `#[cfg(test)] mod tests` within the module

## Conventions NOT Followed (Divergence from Written Rules)

**The project's written conventions in `.claude/rules/conventions.md` define canonical implementations. The actual codebase follows these rules closely with only one documented exception:**

- **Error logging guideline states:** "Every `catch` block and `.catch()` handler must log the error with `console.error`. **Exception:** Fire-and-forget operations where failure has no user impact AND the operation is not the primary action."

The codebase adheres strictly to this rule. All observed error handling includes context messages, and fire-and-forget operations are rare and commented.

---

*Convention analysis: 2026-08-14*
