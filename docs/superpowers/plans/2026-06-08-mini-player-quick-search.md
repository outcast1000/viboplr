# Mini Player Quick Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user start typing over the focused mini player to open an inline search panel, find a track/album/artist, and play or enqueue it — then collapse back to the resting player.

**Architecture:** A dedicated `useMiniSearch` hook (search state + play/enqueue routing) feeds a `MiniSearchPanel` component rendered inside `NowPlayingBar`'s mini branch. `useMiniMode` gains a search-panel window-resize state. `useInAppKeyboardShortcuts` wakes search on a printable keypress in mini mode. Genuinely shared search mechanics (slot allocation) are extracted into a pure `searchSlots.ts` helper consumed by both `useCentralSearch` and `useMiniSearch`.

**Tech Stack:** React + TypeScript, Tauri 2 window APIs (`@tauri-apps/api/window`, `dpi`), Vitest for unit tests. Backend command `search_all` already exists.

---

## File Structure

- **Create** `src/utils/searchSlots.ts` — pure slot-allocation (balanced + track-weighted). One responsibility: decide how many of each entity type to show.
- **Modify** `src/hooks/useCentralSearch.ts` — consume `searchSlots.ts` instead of its inline `allocateSlots`.
- **Create** `src/hooks/useMiniSearch.ts` — mini-mode search state + play/enqueue routing.
- **Modify** `src/hooks/useMiniMode.ts` — add pure `searchPanelGeometry()` decision + `openSearchPanel()`/`closeSearchPanel()`, plus a `searchOpenRef` guard that suppresses hover-expand.
- **Create** `src/components/MiniSearchPanel.tsx` — the panel UI (input + grouped results).
- **Create** `src/components/MiniSearchPanel.css` — panel styling (skin vars only).
- **Modify** `src/components/NowPlayingBar.tsx` — render `MiniSearchPanel` in the mini branch; add props.
- **Modify** `src/hooks/useInAppKeyboardShortcuts.ts` — printable-key trigger in mini mode; add deps.
- **Modify** `src/App.tsx` — instantiate `useMiniSearch`, wire it to `NowPlayingBar` and the keyboard hook.
- **Modify** `src/__tests__/hooks-logic.test.ts` — add unit tests (or create `src/__tests__/miniSearch.test.ts`).

---

### Task 1: Extract pure slot-allocation helper

**Files:**
- Create: `src/utils/searchSlots.ts`
- Test: `src/__tests__/searchSlots.test.ts`
- Modify: `src/hooks/useCentralSearch.ts:18-38` (replace inline `allocateSlots`), `src/hooks/useCentralSearch.ts:82` (call site)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/searchSlots.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { allocateSlotsBalanced, allocateSlotsTrackWeighted } from "../utils/searchSlots";

describe("allocateSlotsBalanced", () => {
  it("caps at 7 total with the original min floors (2/2/3)", () => {
    expect(allocateSlotsBalanced(5, 1, 10)).toEqual({ artists: 2, albums: 1, tracks: 4 });
  });

  it("never exceeds available counts", () => {
    const s = allocateSlotsBalanced(1, 0, 2);
    expect(s).toEqual({ artists: 1, albums: 0, tracks: 2 });
  });

  it("distributes leftover slots to the fuller categories", () => {
    const s = allocateSlotsBalanced(10, 10, 10);
    expect(s.artists + s.albums + s.tracks).toBe(7);
  });
});

describe("allocateSlotsTrackWeighted", () => {
  it("prioritises tracks: gives tracks the larger share", () => {
    const s = allocateSlotsTrackWeighted(10, 10, 10);
    expect(s.artists + s.albums + s.tracks).toBe(7);
    expect(s.tracks).toBeGreaterThanOrEqual(s.artists);
    expect(s.tracks).toBeGreaterThanOrEqual(s.albums);
  });

  it("still shows a couple of artists/albums when tracks are scarce", () => {
    const s = allocateSlotsTrackWeighted(5, 5, 1);
    expect(s.tracks).toBe(1);
    expect(s.artists + s.albums).toBeGreaterThan(0);
    expect(s.artists + s.albums + s.tracks).toBeLessThanOrEqual(7);
  });

  it("never exceeds available counts", () => {
    expect(allocateSlotsTrackWeighted(0, 0, 3)).toEqual({ artists: 0, albums: 0, tracks: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/searchSlots.test.ts`
Expected: FAIL — cannot find module `../utils/searchSlots`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/searchSlots.ts`:

```typescript
// Pure slot-allocation for the central / mini search surfaces.
// Decides how many of each entity type to display given a fixed total budget.

export interface SearchSlots {
  artists: number;
  albums: number;
  tracks: number;
}

const MAX_TOTAL = 7;

// Balanced: original central-search behaviour. Floors of 2 artists / 2 albums /
// 3 tracks, then leftover slots go to whichever category has more results.
export function allocateSlotsBalanced(
  artistCount: number,
  albumCount: number,
  trackCount: number,
): SearchSlots {
  let a = Math.min(artistCount, 2);
  let b = Math.min(albumCount, 2);
  let t = Math.min(trackCount, 3);

  let remaining = MAX_TOTAL - (a + b + t);
  while (remaining > 0) {
    let distributed = false;
    if (trackCount > t) { t++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (albumCount > b) { b++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (artistCount > a) { a++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (!distributed) break;
  }
  return { artists: a, albums: b, tracks: t };
}

// Track-weighted: mini search is "find a song fast". Floors of 1 artist /
// 1 album / 4 tracks, then leftover slots prefer tracks first.
export function allocateSlotsTrackWeighted(
  artistCount: number,
  albumCount: number,
  trackCount: number,
): SearchSlots {
  let a = Math.min(artistCount, 1);
  let b = Math.min(albumCount, 1);
  let t = Math.min(trackCount, 4);

  let remaining = MAX_TOTAL - (a + b + t);
  while (remaining > 0) {
    let distributed = false;
    if (trackCount > t) { t++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (artistCount > a) { a++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (albumCount > b) { b++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (!distributed) break;
  }
  return { artists: a, albums: b, tracks: t };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/searchSlots.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Refactor `useCentralSearch` to consume the helper**

In `src/hooks/useCentralSearch.ts`, delete the inline `allocateSlots` function (lines 18-38) and add an import at the top (after the existing imports on line 4):

```typescript
import { allocateSlotsBalanced } from "../utils/searchSlots";
```

Then change the call site (currently line 82) from:

```typescript
        const slots = allocateSlots(raw.artists.length, raw.albums.length, raw.tracks.length);
```

to:

```typescript
        const slots = allocateSlotsBalanced(raw.artists.length, raw.albums.length, raw.tracks.length);
```

- [ ] **Step 6: Verify type-check and the full TS test suite still pass**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS, no type errors. (Central search behaviour is unchanged — same algorithm, new home.)

- [ ] **Step 7: Commit**

```bash
git add src/utils/searchSlots.ts src/__tests__/searchSlots.test.ts src/hooks/useCentralSearch.ts
git commit -m "refactor: extract pure searchSlots helper, add track-weighted variant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: "Should this keypress wake mini search?" predicate

**Files:**
- Create: `src/utils/miniSearchTrigger.ts`
- Test: `src/__tests__/miniSearchTrigger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/miniSearchTrigger.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { shouldWakeMiniSearch } from "../utils/miniSearchTrigger";

// Minimal shape of the fields shouldWakeMiniSearch reads off a KeyboardEvent.
function ev(partial: Partial<{
  key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean;
}>) {
  return { key: "a", ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...partial };
}

describe("shouldWakeMiniSearch", () => {
  it("wakes on a single printable letter", () => {
    expect(shouldWakeMiniSearch(ev({ key: "d" }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(true);
  });

  it("wakes on a digit and punctuation", () => {
    expect(shouldWakeMiniSearch(ev({ key: "7" }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(true);
    expect(shouldWakeMiniSearch(ev({ key: "!" }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(true);
  });

  it("does NOT wake on Space", () => {
    expect(shouldWakeMiniSearch(ev({ key: " " }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
  });

  it("does NOT wake on arrows or named keys", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape", "Tab", "Backspace"]) {
      expect(shouldWakeMiniSearch(ev({ key }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
    }
  });

  it("does NOT wake with a modifier held", () => {
    expect(shouldWakeMiniSearch(ev({ key: "d", metaKey: true }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
    expect(shouldWakeMiniSearch(ev({ key: "d", ctrlKey: true }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
    expect(shouldWakeMiniSearch(ev({ key: "d", altKey: true }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
  });

  it("does NOT wake while composing (IME / dead keys)", () => {
    expect(shouldWakeMiniSearch(ev({ key: "a", isComposing: true }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
  });

  it("does NOT wake when not in mini mode, an input is focused, or search already open", () => {
    expect(shouldWakeMiniSearch(ev({ key: "d" }), { miniMode: false, inputFocused: false, searchOpen: false })).toBe(false);
    expect(shouldWakeMiniSearch(ev({ key: "d" }), { miniMode: true, inputFocused: true, searchOpen: false })).toBe(false);
    expect(shouldWakeMiniSearch(ev({ key: "d" }), { miniMode: true, inputFocused: false, searchOpen: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/miniSearchTrigger.test.ts`
Expected: FAIL — cannot find module `../utils/miniSearchTrigger`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/miniSearchTrigger.ts`:

```typescript
// Pure predicate: should a keydown wake the mini-player search panel?
//
// A single printable character (letter/digit/punctuation) wakes search.
// Space, arrows, named keys, modifier combos, and IME composition do not —
// Space/arrows stay player controls in mini mode.

interface TriggerKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}

interface TriggerState {
  miniMode: boolean;
  inputFocused: boolean;
  searchOpen: boolean;
}

export function shouldWakeMiniSearch(e: TriggerKeyEvent, state: TriggerState): boolean {
  if (!state.miniMode || state.inputFocused || state.searchOpen) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.isComposing) return false;
  // A printable character has a single-code-point `key`. Named keys
  // ("ArrowLeft", "Enter", "Tab", " ") are longer than 1 char — except Space,
  // whose key is a single " ", so exclude it explicitly.
  if (e.key === " ") return false;
  return [...e.key].length === 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/miniSearchTrigger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/miniSearchTrigger.ts src/__tests__/miniSearchTrigger.test.ts
git commit -m "feat: add shouldWakeMiniSearch trigger predicate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `useMiniSearch` hook (state + play/enqueue routing)

**Files:**
- Create: `src/hooks/useMiniSearch.ts`
- Test: `src/__tests__/miniSearchActions.test.ts`

The hook's `actOnItem` routing is the testable core. We extract it as a pure function `routeMiniSearchAction` so it can be unit-tested without React.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/miniSearchActions.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { routeMiniSearchAction } from "../hooks/useMiniSearch";
import type { Track, Album, Artist, SearchResultItem } from "../types";

function makeTrack(): Track {
  return {
    id: 1, key: "lib:1", path: "file:///a.mp3", title: "Song", artist_id: 2,
    artist_name: "Artist", album_id: 3, album_title: "Album", year: 2020,
    duration_secs: 100, format: "mp3", collection_id: 1, collection_name: "Local",
    liked: 0, track_number: null, disc_number: null, play_count: 0, last_played_at: null,
    youtube_url: null, added_at: null, file_size: null, bitrate: null, sample_rate: null,
    bit_depth: null, channels: null,
  } as unknown as Track;
}
const album: Album = { id: 3, title: "Album", artist_id: 2, artist_name: "Artist", year: 2020, track_count: 10, liked: 0 } as Album;
const artist: Artist = { id: 2, name: "Artist", track_count: 20, liked: 0 } as Artist;

function deps() {
  return {
    onPlayTrack: vi.fn(), onEnqueueTrack: vi.fn(),
    playAlbum: vi.fn(), enqueueAlbum: vi.fn(),
    playArtist: vi.fn(), enqueueArtist: vi.fn(),
  };
}

describe("routeMiniSearchAction", () => {
  it("track + play → onPlayTrack", () => {
    const d = deps();
    const t = makeTrack();
    routeMiniSearchAction({ kind: "track", data: t } as SearchResultItem, false, d);
    expect(d.onPlayTrack).toHaveBeenCalledWith(t);
    expect(d.onEnqueueTrack).not.toHaveBeenCalled();
  });

  it("track + enqueue → onEnqueueTrack", () => {
    const d = deps();
    const t = makeTrack();
    routeMiniSearchAction({ kind: "track", data: t } as SearchResultItem, true, d);
    expect(d.onEnqueueTrack).toHaveBeenCalledWith(t);
  });

  it("album + play → playAlbum(id); + enqueue → enqueueAlbum(id)", () => {
    const d = deps();
    routeMiniSearchAction({ kind: "album", data: album } as SearchResultItem, false, d);
    expect(d.playAlbum).toHaveBeenCalledWith(3);
    routeMiniSearchAction({ kind: "album", data: album } as SearchResultItem, true, d);
    expect(d.enqueueAlbum).toHaveBeenCalledWith(3);
  });

  it("artist + play → playArtist(id); + enqueue → enqueueArtist(id)", () => {
    const d = deps();
    routeMiniSearchAction({ kind: "artist", data: artist } as SearchResultItem, false, d);
    expect(d.playArtist).toHaveBeenCalledWith(2);
    routeMiniSearchAction({ kind: "artist", data: artist } as SearchResultItem, true, d);
    expect(d.enqueueArtist).toHaveBeenCalledWith(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/miniSearchActions.test.ts`
Expected: FAIL — cannot find `routeMiniSearchAction` in `../hooks/useMiniSearch`.

- [ ] **Step 3: Write the implementation**

Create `src/hooks/useMiniSearch.ts`:

```typescript
// Mini-player quick search: search state + play/enqueue routing.
//
// Distinct from useCentralSearch (which navigates to detail pages). In mini
// mode there are no detail pages, so every pick is a play/enqueue action:
// tracks play/enqueue directly; albums/artists route through usePlayActions.
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, SearchAllResults, SearchResultItem } from "../types";
import { allocateSlotsTrackWeighted } from "../utils/searchSlots";

const DEBOUNCE_MS = 200;
const PER_TYPE_LIMIT = 7;
const EMPTY_RESULTS: SearchAllResults = { artists: [], albums: [], tracks: [] };

export interface MiniSearchActionDeps {
  onPlayTrack: (track: Track) => void;
  onEnqueueTrack: (track: Track) => void;
  playAlbum: (albumId: number) => void;
  enqueueAlbum: (albumId: number) => void;
  playArtist: (artistId: number) => void;
  enqueueArtist: (artistId: number) => void;
}

// Pure routing core — unit-tested without React.
export function routeMiniSearchAction(
  item: SearchResultItem,
  enqueue: boolean,
  deps: MiniSearchActionDeps,
): void {
  switch (item.kind) {
    case "track":
      if (enqueue) deps.onEnqueueTrack(item.data);
      else deps.onPlayTrack(item.data);
      break;
    case "album":
      if (enqueue) deps.enqueueAlbum(item.data.id);
      else deps.playAlbum(item.data.id);
      break;
    case "artist":
      if (enqueue) deps.enqueueArtist(item.data.id);
      else deps.playArtist(item.data.id);
      break;
  }
}

interface UseMiniSearchOptions extends MiniSearchActionDeps {
  // Called whenever the panel should open/close so useMiniMode can resize the window.
  onOpenPanel: () => void;
  onClosePanel: () => void;
}

export function useMiniSearch(opts: UseMiniSearchOptions) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchAllResults>(EMPTY_RESULTS);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Keep the latest opts in a ref so callbacks stay stable.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const items: SearchResultItem[] = useMemo(() => {
    const list: SearchResultItem[] = [];
    for (const t of results.tracks) list.push({ kind: "track", data: t });
    for (const a of results.albums) list.push({ kind: "album", data: a });
    for (const a of results.artists) list.push({ kind: "artist", data: a });
    return list;
  }, [results]);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setResults(EMPTY_RESULTS);
    setHighlightedIndex(-1);
    optsRef.current.onClosePanel();
  }, []);

  const open = useCallback((initialChar: string) => {
    setQuery(initialChar);
    setResults(EMPTY_RESULTS);
    setHighlightedIndex(-1);
    setIsOpen(true);
    optsRef.current.onOpenPanel();
  }, []);

  // Debounced search. Empty query collapses the panel.
  useEffect(() => {
    if (!isOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (!q) {
      // Field emptied → collapse back to the player.
      close();
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const raw = await invoke<SearchAllResults>("search_all", {
          query: q,
          artistLimit: PER_TYPE_LIMIT,
          albumLimit: PER_TYPE_LIMIT,
          trackLimit: PER_TYPE_LIMIT,
        });
        const slots = allocateSlotsTrackWeighted(raw.artists.length, raw.albums.length, raw.tracks.length);
        setResults({
          artists: raw.artists.slice(0, slots.artists),
          albums: raw.albums.slice(0, slots.albums),
          tracks: raw.tracks.slice(0, slots.tracks),
        });
        setHighlightedIndex(-1);
      } catch (e) {
        console.error("Mini search failed:", e);
        setResults(EMPTY_RESULTS);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, isOpen, close]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev < items.length - 1 ? prev + 1 : prev));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : -1));
          break;
        case "Enter":
          e.preventDefault();
          if (highlightedIndex >= 0 && highlightedIndex < items.length) {
            routeMiniSearchAction(items[highlightedIndex], e.metaKey || e.ctrlKey, optsRef.current);
            close();
          } else if (items.length > 0) {
            // No explicit highlight → act on the first result.
            routeMiniSearchAction(items[0], e.metaKey || e.ctrlKey, optsRef.current);
            close();
          }
          break;
        case "Escape":
          e.preventDefault();
          close();
          break;
      }
    },
    [items, highlightedIndex, close],
  );

  const handleResultClick = useCallback(
    (item: SearchResultItem, enqueue: boolean) => {
      routeMiniSearchAction(item, enqueue, optsRef.current);
      close();
    },
    [close],
  );

  return { query, setQuery, results, items, isOpen, highlightedIndex, open, close, handleKeyDown, handleResultClick };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/miniSearchActions.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (If the `makeTrack` cast in the test surfaces a missing field, the `as unknown as Track` cast absorbs it — the test only exercises routing, not field completeness.)

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useMiniSearch.ts src/__tests__/miniSearchActions.test.ts
git commit -m "feat: add useMiniSearch hook with play/enqueue routing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `useMiniMode` search-panel sizing

**Files:**
- Modify: `src/hooks/useMiniMode.ts` (add constants near 8-16; add pure `searchPanelGeometry`; add `searchOpenRef`, `openSearchPanel`, `closeSearchPanel`; guard hover; export from return)
- Test: `src/__tests__/hooks-logic.test.ts` (append a describe block)

The window-resize side effects need Tauri, so we extract the **decision** (target height + grow direction + new Y) as a pure function and test that. The imperative resize reuses the existing pattern from `expandMini`/`collapseMini`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/hooks-logic.test.ts` (add the import to the existing `useMiniMode` import line at the top — change line 2 to include `searchPanelGeometry`):

```typescript
// at top, extend the existing import:
// import { isPositionOnScreen, clampToNearestMonitor, searchPanelGeometry } from "../hooks/useMiniMode";

describe("searchPanelGeometry", () => {
  const monitor = { x: 0, y: 0, w: 1920, h: 1080 };

  it("grows down when there is room below", () => {
    const g = searchPanelGeometry({ logicalY: 100, restingHeight: 52, monitor });
    expect(g.direction).toBe("down");
    expect(g.height).toBe(260);
    expect(g.newY).toBe(100); // position unchanged when growing down
  });

  it("grows up (shifting Y) when there is no room below", () => {
    // Window near the bottom: 1080 - (1040 + 52) = -12 room below → grow up.
    const g = searchPanelGeometry({ logicalY: 1040, restingHeight: 52, monitor });
    expect(g.direction).toBe("up");
    expect(g.height).toBe(260);
    // newY = logicalY - (height - restingHeight) = 1040 - (260 - 52) = 832
    expect(g.newY).toBe(832);
  });

  it("treats a null monitor as unlimited space below (grows down)", () => {
    const g = searchPanelGeometry({ logicalY: 1040, restingHeight: 52, monitor: null });
    expect(g.direction).toBe("down");
    expect(g.newY).toBe(1040);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/hooks-logic.test.ts`
Expected: FAIL — `searchPanelGeometry` is not exported.

- [ ] **Step 3: Add the constant and pure function**

In `src/hooks/useMiniMode.ts`, add after line 16 (after `MINI_HOVER_COLLAPSE_DELAY`):

```typescript
const MINI_SEARCH_PANEL_HEIGHT = 260;
```

Then add this exported pure function near the other pure exports (e.g. after `clampToNearestMonitor`, around line 49):

```typescript
export interface SearchPanelGeometryInput {
  logicalY: number;       // current window top, logical px
  restingHeight: number;  // 52 (normal) or 24 (compact)
  monitor: MonitorRect | null;
}

export interface SearchPanelGeometry {
  height: number;
  direction: "down" | "up";
  newY: number;           // window top after resize
}

// Decide the search-panel window geometry: prefer growing down; if the panel
// would overflow the bottom of the monitor, grow up and shift the top edge.
export function searchPanelGeometry(input: SearchPanelGeometryInput): SearchPanelGeometry {
  const height = MINI_SEARCH_PANEL_HEIGHT;
  const extra = height - input.restingHeight;
  const spaceBelow = input.monitor
    ? (input.monitor.y + input.monitor.h) - (input.logicalY + input.restingHeight)
    : Infinity;
  if (spaceBelow >= extra) {
    return { height, direction: "down", newY: input.logicalY };
  }
  return { height, direction: "up", newY: input.logicalY - extra };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/hooks-logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the imperative open/close + hover guard**

In `useMiniMode`, add a ref next to the other refs (after line 151, `expandingRef`):

```typescript
  const searchOpenRef = useRef(false);
  const searchDirectionRef = useRef<"down" | "up">("down");
```

Add these two callbacks after `collapseMini` (after line 224):

```typescript
  const openSearchPanel = useCallback(async () => {
    if (!miniModeRef.current || searchOpenRef.current) return;
    cancelCollapseTimer();
    searchOpenRef.current = true;
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const pos = await win.outerPosition();
      const size = await win.innerSize();
      const logicalY = pos.y / factor;
      const logicalW = size.width / factor;
      const bounds = await getLogicalMonitorBounds();
      const monitor = bounds.find(m =>
        pos.x / factor >= m.x && pos.x / factor < m.x + m.w &&
        logicalY >= m.y && logicalY < m.y + m.h
      ) || bounds[0] || null;
      const restingHeight = currentRestingHeight();
      const geo = searchPanelGeometry({ logicalY, restingHeight, monitor });
      searchDirectionRef.current = geo.direction;
      await win.setMinSize(new LogicalSize(MINI_MIN_WIDTH, geo.height));
      if (geo.direction === "up") {
        await win.setPosition(new LogicalPosition(pos.x / factor, geo.newY));
      }
      await win.setSize(new LogicalSize(logicalW, geo.height));
    } catch (err) {
      console.error("openSearchPanel failed:", err);
    }
  }, [cancelCollapseTimer, currentRestingHeight]);

  const closeSearchPanel = useCallback(async () => {
    if (!miniModeRef.current || !searchOpenRef.current) return;
    searchOpenRef.current = false;
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const pos = await win.outerPosition();
      const size = await win.innerSize();
      const logicalW = size.width / factor;
      const restingHeight = currentRestingHeight();
      const extra = MINI_SEARCH_PANEL_HEIGHT - restingHeight;
      await win.setSize(new LogicalSize(logicalW, restingHeight));
      if (searchDirectionRef.current === "up") {
        await win.setPosition(new LogicalPosition(pos.x / factor, pos.y / factor + extra));
      }
      await win.setMinSize(new LogicalSize(MINI_MIN_WIDTH, restingHeight));
    } catch (err) {
      console.error("closeSearchPanel failed:", err);
    }
  }, [currentRestingHeight]);
```

Suppress hover-expand while the panel is open. In the hover controller effect (around line 401-407), change the `onExpand`/`onCollapse` handlers so they no-op when search is open:

```typescript
    const controller = makeHoverController({
      expandDelayMs: MINI_HOVER_EXPAND_DELAY,
      collapseDelayMs: MINI_HOVER_COLLAPSE_DELAY,
      onExpand: () => { if (!searchOpenRef.current) expandMini(); },
      onCollapse: () => { if (!searchOpenRef.current) collapseMini(); },
      isExpanded: () => miniExpandedRef.current,
    });
```

In `toggleMiniMode`, when leaving mini mode, ensure search is closed first. At the start of the `else` branch (currently line 266, `cancelCollapseTimer();`), add:

```typescript
        if (searchOpenRef.current) { searchOpenRef.current = false; }
```

(The window will be resized by the full-restore logic that follows, so we only need to clear the flag.)

Finally, add the new functions and ref accessor to the return object (line 454-458):

```typescript
  return {
    miniMode, setMiniMode, miniModeRef, fullSizeRef, toggleMiniMode, miniExpanded,
    cancelCollapseTimer, miniRestingSize, setMiniRestingSize,
    miniWidthSize, setMiniWidthSize,
    openSearchPanel, closeSearchPanel, searchOpenRef,
  };
```

- [ ] **Step 6: Type-check and run full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useMiniMode.ts src/__tests__/hooks-logic.test.ts
git commit -m "feat: add search-panel window sizing to useMiniMode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `MiniSearchPanel` component + styles

**Files:**
- Create: `src/components/MiniSearchPanel.tsx`
- Create: `src/components/MiniSearchPanel.css`

No new unit test (presentational); verified via type-check and the build. Reuses the central-search image-resolution pattern.

- [ ] **Step 1: Write the component**

Create `src/components/MiniSearchPanel.tsx`:

```typescript
import { useRef, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track, Album, Artist, SearchAllResults, SearchResultItem } from "../types";
import "./MiniSearchPanel.css";

interface MiniSearchPanelProps {
  query: string;
  onQueryChange: (q: string) => void;
  results: SearchAllResults;
  items: SearchResultItem[];
  highlightedIndex: number;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onResultClick: (item: SearchResultItem, enqueue: boolean) => void;
  getAlbumImage: (title: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
}

function ArtistImg({ artist, getArtistImage }: { artist: Artist; getArtistImage: (n: string) => string | null }) {
  const p = getArtistImage(artist.name);
  if (p) return <img className="mini-result-img mini-result-img-round" src={convertFileSrc(p)} alt="" />;
  return <span className="mini-result-img-fallback mini-result-img-round">{(artist.name[0] ?? "?").toUpperCase()}</span>;
}

function AlbumImg({ album, getAlbumImage, getArtistImage }: {
  album: Album; getAlbumImage: (t: string, a?: string | null) => string | null; getArtistImage: (n: string) => string | null;
}) {
  const p = getAlbumImage(album.title, album.artist_name) || (album.artist_name ? getArtistImage(album.artist_name) : null);
  if (p) return <img className="mini-result-img" src={convertFileSrc(p)} alt="" />;
  return <span className="mini-result-img-fallback">{(album.title[0] ?? "?").toUpperCase()}</span>;
}

function TrackImg({ track, getAlbumImage, getArtistImage }: {
  track: Track; getAlbumImage: (t: string, a?: string | null) => string | null; getArtistImage: (n: string) => string | null;
}) {
  const p = (track.album_title ? getAlbumImage(track.album_title, track.artist_name) : null)
    || (track.artist_name ? getArtistImage(track.artist_name) : null);
  if (p) return <img className="mini-result-img" src={convertFileSrc(p)} alt="" />;
  return <span className="mini-result-img-fallback">{(track.title[0] ?? "?").toUpperCase()}</span>;
}

export function MiniSearchPanel({
  query, onQueryChange, results, items, highlightedIndex,
  onKeyDown, onResultClick, getAlbumImage, getArtistImage,
}: MiniSearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Focus the input as soon as the panel mounts, and place the cursor at the end
  // of the seeded first character.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, []);

  useEffect(() => {
    if (highlightedIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(".mini-result.highlighted") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  // Item ordering matches useMiniSearch.items: tracks, then albums, then artists.
  const trackOffset = 0;
  const albumOffset = results.tracks.length;
  const artistOffset = results.tracks.length + results.albums.length;
  const hasResults = items.length > 0;

  return (
    <div className="mini-search-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="mini-search-input-wrapper">
        <svg className="mini-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search…"
          autoComplete="off" autoCorrect="off" spellCheck={false}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className="mini-search-results" ref={listRef}>
        {results.tracks.length > 0 && <div className="mini-search-section">Tracks</div>}
        {results.tracks.map((track, i) => (
          <div
            key={`t-${track.id}`}
            className={`mini-result ${trackOffset + i === highlightedIndex ? "highlighted" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); onResultClick({ kind: "track", data: track }, e.metaKey || e.ctrlKey); }}
          >
            <div className="mini-result-art"><TrackImg track={track} getAlbumImage={getAlbumImage} getArtistImage={getArtistImage} /></div>
            <div className="mini-result-info">
              <div className="mini-result-title">{track.title}</div>
              <div className="mini-result-subtitle">{track.artist_name}{track.artist_name && track.album_title ? " · " : ""}{track.album_title}</div>
            </div>
          </div>
        ))}

        {results.albums.length > 0 && <div className="mini-search-section">Albums</div>}
        {results.albums.map((album, i) => (
          <div
            key={`al-${album.id}`}
            className={`mini-result ${albumOffset + i === highlightedIndex ? "highlighted" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); onResultClick({ kind: "album", data: album }, e.metaKey || e.ctrlKey); }}
          >
            <div className="mini-result-art"><AlbumImg album={album} getAlbumImage={getAlbumImage} getArtistImage={getArtistImage} /></div>
            <div className="mini-result-info">
              <div className="mini-result-title">{album.title}</div>
              <div className="mini-result-subtitle">{album.artist_name}{album.artist_name && album.year ? " · " : ""}{album.year ?? ""}</div>
            </div>
          </div>
        ))}

        {results.artists.length > 0 && <div className="mini-search-section">Artists</div>}
        {results.artists.map((artist, i) => (
          <div
            key={`ar-${artist.id}`}
            className={`mini-result ${artistOffset + i === highlightedIndex ? "highlighted" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); onResultClick({ kind: "artist", data: artist }, e.metaKey || e.ctrlKey); }}
          >
            <div className="mini-result-art"><ArtistImg artist={artist} getArtistImage={getArtistImage} /></div>
            <div className="mini-result-info">
              <div className="mini-result-title">{artist.name}</div>
              <div className="mini-result-subtitle">Artist · {artist.track_count} tracks</div>
            </div>
          </div>
        ))}

        {query.trim() && !hasResults && <div className="mini-search-empty">No results</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the styles**

Create `src/components/MiniSearchPanel.css` (skin custom properties only — no hardcoded colors):

```css
.mini-search-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  color: var(--text-primary);
}

.mini-search-input-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  height: 44px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.mini-search-icon { color: var(--text-tertiary); flex: 0 0 auto; }
.mini-search-input-wrapper input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: var(--fs-sm);
}
.mini-search-input-wrapper input::placeholder { color: var(--text-tertiary); }

.mini-search-results { flex: 1; overflow-y: auto; padding: 4px 0; }

.mini-search-section {
  font-size: var(--fs-2xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-tertiary);
  padding: 6px 12px 2px;
}

.mini-result {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  cursor: pointer;
  border-radius: var(--ds-radius);
}
.mini-result:hover, .mini-result.highlighted { background: var(--bg-hover); }

.mini-result-art { flex: 0 0 auto; width: 28px; height: 28px; }
.mini-result-img { width: 28px; height: 28px; border-radius: var(--ds-radius); object-fit: cover; }
.mini-result-img-round { border-radius: 50%; }
.mini-result-img-fallback {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: var(--ds-radius);
  background: var(--bg-tertiary); color: var(--text-secondary);
  font-size: var(--fs-xs); font-weight: 600;
}

.mini-result-info { min-width: 0; flex: 1; }
.mini-result-title {
  font-size: var(--fs-xs); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mini-result-subtitle {
  font-size: var(--fs-2xs); color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.mini-search-empty {
  padding: 16px 12px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: var(--fs-xs);
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (the component isn't imported anywhere yet — that's fine; TS still checks the file).

- [ ] **Step 4: Commit**

```bash
git add src/components/MiniSearchPanel.tsx src/components/MiniSearchPanel.css
git commit -m "feat: add MiniSearchPanel component and styles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire panel into NowPlayingBar's mini branch

**Files:**
- Modify: `src/components/NowPlayingBar.tsx` (import; props interface ~88-154; destructure ~156-177; render in mini `<footer>` ~250-408)

- [ ] **Step 1: Add the import**

At the top of `src/components/NowPlayingBar.tsx`, after the existing component imports, add:

```typescript
import { MiniSearchPanel } from "./MiniSearchPanel";
import type { SearchAllResults, SearchResultItem } from "../types";
```

(If `SearchAllResults` / `SearchResultItem` are already imported from `../types` in this file, extend that existing import instead of adding a duplicate.)

- [ ] **Step 2: Add props to the interface**

In `NowPlayingBarProps` (after `onContextMenu` on line 153, before the closing brace on line 154), add:

```typescript
  miniSearch?: {
    isOpen: boolean;
    query: string;
    results: SearchAllResults;
    items: SearchResultItem[];
    highlightedIndex: number;
    onQueryChange: (q: string) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onResultClick: (item: SearchResultItem, enqueue: boolean) => void;
  };
  getAlbumImage?: (title: string, artistName?: string | null) => string | null;
  getArtistImage?: (name: string) => string | null;
```

- [ ] **Step 3: Destructure the new props**

In the destructured parameter list (after `onContextMenu,` on line 176), add:

```typescript
  miniSearch,
  getAlbumImage,
  getArtistImage,
```

- [ ] **Step 4: Render the panel in the mini footer**

In the mini-mode `return` (the `<footer className={...now-playing-mini...}>` block starting at line 251), when `miniSearch?.isOpen` is true we render the panel **instead of** the player rows. Wrap the existing mini content. Change the opening of the footer's children: replace the line that currently begins the content (line 263, `{miniExpanded || miniRestingSize === "normal" ? (`) so the whole existing conditional is guarded by search state.

Specifically, insert immediately after the `<footer ...>` opening tag (after line 262) the search branch, and make the existing content the `else`:

```tsx
        {miniSearch?.isOpen && getAlbumImage && getArtistImage ? (
          <MiniSearchPanel
            query={miniSearch.query}
            onQueryChange={miniSearch.onQueryChange}
            results={miniSearch.results}
            items={miniSearch.items}
            highlightedIndex={miniSearch.highlightedIndex}
            onKeyDown={miniSearch.onKeyDown}
            onResultClick={miniSearch.onResultClick}
            getAlbumImage={getAlbumImage}
            getArtistImage={getArtistImage}
          />
        ) : (
          <>
```

Then close that fragment + ternary at the very end of the footer's existing children — immediately before the closing `</footer>` on line 408, add:

```tsx
          </>
        )}
```

The existing two top-level child groups in the footer are: (a) the `{miniExpanded || miniRestingSize === "normal" ? (...) : (...)}` block (lines 263-349) and (b) the `{miniExpanded && (<>...</>)}` block (lines 350-407). Both move inside the new `<>...</>` else-fragment. Verify by reading the file after editing that the JSX nests correctly (one `<>` opened after `<footer>`, one `</>` closed before `</footer>`).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Build the frontend to catch JSX nesting errors**

Run: `npm run build` (Vite build; do NOT run `tauri build`)
Expected: build succeeds. If JSX nesting is wrong, the build fails with a clear parse error — fix the fragment placement.

- [ ] **Step 7: Commit**

```bash
git add src/components/NowPlayingBar.tsx
git commit -m "feat: render MiniSearchPanel in NowPlayingBar mini branch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Wire the keyboard trigger

**Files:**
- Modify: `src/hooks/useInAppKeyboardShortcuts.ts` (import; `KeyboardShortcutDeps` ~18-38; handler ~45)

- [ ] **Step 1: Add the import and deps**

At the top of `src/hooks/useInAppKeyboardShortcuts.ts`, after the existing imports, add:

```typescript
import { shouldWakeMiniSearch } from "../utils/miniSearchTrigger";
```

In `KeyboardShortcutDeps` (after `handleToggleSidebar: () => void;` on line 37, before the closing brace), add:

```typescript
  // Mini-player quick search.
  miniSearchOpen: boolean;
  openMiniSearch: (initialChar: string) => void;
```

- [ ] **Step 2: Add the trigger at the top of the handler**

In `handleKeyDown`, right after the `isInput` computation (after line 48), add:

```typescript
      if (
        shouldWakeMiniSearch(e, {
          miniMode: d.mini.miniMode,
          inputFocused: isInput,
          searchOpen: d.miniSearchOpen,
        })
      ) {
        e.preventDefault();
        d.openMiniSearch(e.key);
        return;
      }
```

This sits before all existing shortcut branches, so a printable key in mini mode opens search and returns; Space/arrows/named keys fall through to the existing logic unchanged.

- [ ] **Step 3: Type-check (expected to fail at the call site)**

Run: `npx tsc --noEmit`
Expected: FAIL — `App.tsx`'s `useInAppKeyboardShortcuts({...})` call is now missing the two required props. This is fixed in Task 8.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useInAppKeyboardShortcuts.ts
git commit -m "feat: wake mini search on printable keypress in mini mode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Wire everything together in App.tsx

**Files:**
- Modify: `src/App.tsx` (import ~63; instantiate `useMiniSearch` after `usePlayActions` ~764; pass to `useInAppKeyboardShortcuts` ~1945-1960; pass to `<NowPlayingBar>` ~3348)

- [ ] **Step 1: Add the import**

In `src/App.tsx`, after the `useCentralSearch` import (line 63), add:

```typescript
import { useMiniSearch } from "./hooks/useMiniSearch";
```

- [ ] **Step 2: Instantiate the hook**

Immediately after the `playActions = usePlayActions({...})` block (after line 764), add:

```typescript
  const miniSearch = useMiniSearch({
    onPlayTrack: (track) => { queueHook.playTracks([track], 0); },
    onEnqueueTrack: (track) => { handleEnqueueRef.current([track]); },
    playAlbum: (albumId) => { playActions.playAlbum(albumId); },
    enqueueAlbum: (albumId) => { playActions.enqueueAlbum(albumId); },
    playArtist: (artistId) => { playActions.playArtist(artistId); },
    enqueueArtist: (artistId) => { playActions.enqueueArtist(artistId); },
    onOpenPanel: () => { mini.openSearchPanel(); },
    onClosePanel: () => { mini.closeSearchPanel(); },
  });
```

(Notes: `playTracks`/`enqueueTracks` here mirror how `useCentralSearch` is wired on lines 606-611. `handleEnqueueRef` is the same ref used by `usePlayActions` wiring on line 756. If `handleEnqueueRef` is not yet defined at this point in the file, use `queueHook.enqueueTracks` directly to match line 609's central-search behaviour.)

- [ ] **Step 3: Pass the two new keyboard deps**

In the `useInAppKeyboardShortcuts({...})` call (lines 1945-1960), add these two entries (e.g. after `handleToggleSidebar,` on line 1959):

```typescript
    miniSearchOpen: miniSearch.isOpen,
    openMiniSearch: (initialChar) => miniSearch.open(initialChar),
```

- [ ] **Step 4: Sync the searchOpen guard ref**

The keyboard handler reads `miniSearch.isOpen` through the deps ref (refreshed each render), and `useMiniMode` reads its own `searchOpenRef` for the hover guard — both update together because `openSearchPanel`/`closeSearchPanel` are called from the same `open`/`close` flow. No extra wiring needed. Add a one-line comment above the `useMiniSearch` call documenting this:

```typescript
  // Mini search drives both useMiniMode's window resize (via onOpen/ClosePanel)
  // and the keyboard trigger's "already open?" guard (via miniSearch.isOpen).
```

- [ ] **Step 5: Pass props to NowPlayingBar**

In the `<NowPlayingBar ... />` element, after the `onContextMenu={...}` prop, add:

```tsx
        miniSearch={{
          isOpen: miniSearch.isOpen,
          query: miniSearch.query,
          results: miniSearch.results,
          items: miniSearch.items,
          highlightedIndex: miniSearch.highlightedIndex,
          onQueryChange: miniSearch.setQuery,
          onKeyDown: miniSearch.handleKeyDown,
          onResultClick: miniSearch.handleResultClick,
        }}
        getAlbumImage={albumImageCache.getImage}
        getArtistImage={artistImageCache.getImage}
```

(`albumImageCache.getImage` / `artistImageCache.getImage` are the same accessors passed to `usePlayActions` on lines 761-762.)

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS — the Task 7 call-site error is now resolved.

- [ ] **Step 7: Run the full TS test suite**

Run: `npx vitest run`
Expected: PASS (all suites, including the new searchSlots / miniSearchTrigger / miniSearchActions / searchPanelGeometry tests).

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wire mini player quick search end to end

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Manual verification & docs

**Files:**
- Modify: `.claude/rules/frontend.md` (Keyboard Shortcuts section) — document the mini-mode trigger.

- [ ] **Step 1: Manual smoke test in the running app**

Run: `npm run tauri dev`
Then verify:
1. Enter mini mode (Cmd+Shift+M). Window shrinks to the strip.
2. Press a letter (e.g. `d`). Window grows into the search panel; the input is focused and contains `d`.
3. Type more; results appear (tracks first, then albums, artists).
4. ↑/↓ move the highlight; **Enter** on a track plays it; the panel collapses back to the resting player showing the new track.
5. Re-open, highlight an album, **Enter** → plays the whole album (queue banner shows the album). Re-open, **Cmd+Enter** on an album → enqueues without replacing.
6. **Esc** closes and collapses. Deleting all characters collapses. Clicking another app leaves the panel open.
7. Press **Space** (panel closed) → still toggles play/pause. Arrows still seek/volume.
8. Near the bottom of the screen, opening search grows the window **up** instead of off-screen.

Expected: all behaviours match. If any fails, fix before committing docs.

- [ ] **Step 2: Document the shortcut**

In `.claude/rules/frontend.md`, under the "## Keyboard Shortcuts" section, add a line:

```markdown
Mini mode: any printable character (when no input is focused) opens the mini-player quick-search panel; Space/arrows remain player controls.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/frontend.md
git commit -m "docs: document mini-player quick-search keyboard trigger

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** trigger (Task 2, 7), panel layout/expand (Task 4, 5, 6), track-weighted results (Task 1, 3), play/enqueue routing incl. album/artist via usePlayActions (Task 3, 8), collapse-after-pick + Esc + empty-field collapse (Task 3), leave-open-on-blur (no blur handler added — Task 5 panel has none, satisfying the requirement), grow up/down + monitor clamp (Task 4), compact-size handling (Task 4 uses `currentRestingHeight`), first-char-once seeding (Task 3 `open` seeds query; Task 5 focuses without re-typing; Task 7 `preventDefault`s the original key), shared helper (Task 1). All covered.
- **Out of scope** items from the spec (no detail nav, no history, no context menu, no width change, no settings toggle) are not implemented — correct.
- **Type consistency:** `openSearchPanel`/`closeSearchPanel`/`searchOpenRef` defined in Task 4 and consumed in Task 8; `routeMiniSearchAction`/`useMiniSearch` signatures consistent across Task 3 and Task 8; `MiniSearchPanel` props match between Task 5 and Task 6; `shouldWakeMiniSearch` signature consistent Task 2/7. Item ordering (tracks→albums→artists) consistent between `useMiniSearch.items` (Task 3) and `MiniSearchPanel` offsets (Task 5).
