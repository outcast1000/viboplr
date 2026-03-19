# Navigation History Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add browser-style back/forward navigation buttons that let users retrace their navigation through views and drill-downs.

**Architecture:** A new `useNavigationHistory` hook observes 4 navigation state values (`view`, `selectedArtist`, `selectedAlbum`, `selectedTag`) and maintains history/future stacks. Back/forward buttons are added to the existing search bar row. Keyboard shortcuts and mouse side buttons provide additional input methods.

**Tech Stack:** React hooks, TypeScript, CSS

**Spec:** `docs/superpowers/specs/2026-03-18-navigation-history-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/hooks/useNavigationHistory.ts` | Create | History hook: tracks NavState changes, manages history/future stacks, provides goBack/goForward |
| `src/App.tsx` | Modify | Wire hook, add toolbar buttons, add keyboard shortcuts, add mouse side button listener |
| `src/App.css` | Modify | Add `.nav-history-btn` styles |

---

## Task 1: Create `useNavigationHistory` hook

**Files:**
- Create: `src/hooks/useNavigationHistory.ts`

- [ ] **Step 1: Create the hook file with full implementation**

```ts
import { useEffect, useRef, useCallback, useState } from "react";
import type { View } from "../types";

export interface NavState {
  view: View;
  selectedArtist: number | null;
  selectedAlbum: number | null;
  selectedTag: number | null;
}

const MAX_HISTORY = 20;

function navStateEqual(a: NavState, b: NavState): boolean {
  return a.view === b.view
    && a.selectedArtist === b.selectedArtist
    && a.selectedAlbum === b.selectedAlbum
    && a.selectedTag === b.selectedTag;
}

export function useNavigationHistory(
  current: NavState,
  setters: {
    setView: (v: View) => void;
    setSelectedArtist: (id: number | null) => void;
    setSelectedAlbum: (id: number | null) => void;
    setSelectedTag: (id: number | null) => void;
  },
): {
  goBack: () => void;
  goForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
} {
  const [history, setHistory] = useState<NavState[]>([]);
  const [future, setFuture] = useState<NavState[]>([]);
  const skipNextPush = useRef(false);
  const prevState = useRef<NavState>(current);

  useEffect(() => {
    if (skipNextPush.current) {
      skipNextPush.current = false;
      prevState.current = current;
      return;
    }

    const prev = prevState.current;
    if (navStateEqual(prev, current)) return;

    setHistory(h => {
      const next = [...h, prev];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setFuture([]);
    prevState.current = current;
  }, [current.view, current.selectedArtist, current.selectedAlbum, current.selectedTag]);

  const goBack = useCallback(() => {
    setHistory(h => {
      if (h.length === 0) return h;
      const newHistory = [...h];
      const target = newHistory.pop()!;
      skipNextPush.current = true;
      setFuture(f => [...f, prevState.current]);
      prevState.current = target;
      setters.setView(target.view);
      setters.setSelectedArtist(target.selectedArtist);
      setters.setSelectedAlbum(target.selectedAlbum);
      setters.setSelectedTag(target.selectedTag);
      return newHistory;
    });
  }, [setters.setView, setters.setSelectedArtist, setters.setSelectedAlbum, setters.setSelectedTag]);

  const goForward = useCallback(() => {
    setFuture(f => {
      if (f.length === 0) return f;
      const newFuture = [...f];
      const target = newFuture.pop()!;
      skipNextPush.current = true;
      setHistory(h => [...h, prevState.current]);
      prevState.current = target;
      setters.setView(target.view);
      setters.setSelectedArtist(target.selectedArtist);
      setters.setSelectedAlbum(target.selectedAlbum);
      setters.setSelectedTag(target.selectedTag);
      return newFuture;
    });
  }, [setters.setView, setters.setSelectedArtist, setters.setSelectedAlbum, setters.setSelectedTag]);

  return {
    goBack,
    goForward,
    canGoBack: history.length > 0,
    canGoForward: future.length > 0,
  };
}
```

Write this to `src/hooks/useNavigationHistory.ts`.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to the new file.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useNavigationHistory.ts
git commit -m "feat: add useNavigationHistory hook for back/forward navigation"
```

---

## Task 2: Wire hook into App.tsx and add toolbar buttons

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add import**

At `src/App.tsx:23` (after the `usePasteImage` import), add:

```ts
import { useNavigationHistory } from "./hooks/useNavigationHistory";
```

- [ ] **Step 2: Call the hook**

At `src/App.tsx:216` (after the `usePasteImage` call, before the `useEffect` for context menu), add:

```ts
  const { goBack, goForward, canGoBack, canGoForward } = useNavigationHistory(
    {
      view: library.view,
      selectedArtist: library.selectedArtist,
      selectedAlbum: library.selectedAlbum,
      selectedTag: library.selectedTag,
    },
    {
      setView: library.setView,
      setSelectedArtist: library.setSelectedArtist,
      setSelectedAlbum: library.setSelectedAlbum,
      setSelectedTag: library.setSelectedTag,
    },
  );
```

- [ ] **Step 3: Add refs for goBack/goForward so the keydown handler can access them**

Right after the hook call, add refs (the keydown handler has `[]` deps so it needs refs):

```ts
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;
  const goForwardRef = useRef(goForward);
  goForwardRef.current = goForward;
```

- [ ] **Step 4: Add keyboard shortcuts to the existing keydown handler**

In the `handleKeyDown` function at `src/App.tsx:462`, the handler currently checks `if (!(e.ctrlKey || e.metaKey)) return;` on line 463. We need to handle `Alt+Arrow` shortcuts which don't have ctrlKey/metaKey. Restructure the guard:

Replace line 463:
```ts
      if (!(e.ctrlKey || e.metaKey)) return;
```

With:
```ts
      // Alt+Arrow: navigation history
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === "ArrowLeft") { e.preventDefault(); goBackRef.current(); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); goForwardRef.current(); return; }
        return;
      }

      if (!(e.ctrlKey || e.metaKey)) return;
```

Then add two cases inside the existing switch statement (before the closing `}` of the switch, around line 557):

```ts
        case "[":
          e.preventDefault();
          goBackRef.current();
          break;
        case "]":
          e.preventDefault();
          goForwardRef.current();
          break;
```

- [ ] **Step 5: Add mouse side button listener**

After the keydown `useEffect` (after line 563), add a new `useEffect`:

```ts
  // Mouse side buttons for navigation history
  useEffect(() => {
    function handleMouseUp(e: MouseEvent) {
      if (e.button === 3) { e.preventDefault(); goBackRef.current(); }
      if (e.button === 4) { e.preventDefault(); goForwardRef.current(); }
    }
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);
```

- [ ] **Step 6: Add back/forward buttons to the search bar**

At `src/App.tsx:989`, the search bar div starts. Add the buttons before the `<input>`:

```tsx
        <div className="search-bar">
          <button
            className="nav-history-btn"
            disabled={!canGoBack}
            onClick={goBack}
            title="Go back (Alt+Left)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            className="nav-history-btn"
            disabled={!canGoForward}
            onClick={goForward}
            title="Go forward (Alt+Right)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </button>
          <input
```

The existing `<input>` element (lines 990-1009) follows after these two buttons unchanged.

- [ ] **Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wire navigation history hook, add toolbar buttons and shortcuts"
```

---

## Task 3: Add CSS styles for navigation buttons

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Add button styles**

After the `.search-bar input:focus` rule (around line 854 in `src/App.css`), add:

```css
.nav-history-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  width: 30px;
  height: 30px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  flex-shrink: 0;
}

.nav-history-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--accent-dim);
}

.nav-history-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
```

- [ ] **Step 2: Verify app renders correctly**

Run: `npm run tauri dev`
Expected: Back/forward buttons appear left of the search bar. Both are initially disabled (no navigation history yet). Clicking sidebar items enables the back button.

- [ ] **Step 3: Commit**

```bash
git add src/App.css
git commit -m "feat: add styles for navigation history buttons"
```

---

## Task 4: Manual verification

- [ ] **Step 1: Test basic back/forward**

1. Start the app with `npm run tauri dev`
2. Click "Artists" in sidebar → click an artist → click an album
3. Click back button: should return to artist view
4. Click back again: should return to artists list
5. Click forward: should go to the artist again

- [ ] **Step 2: Test keyboard shortcuts**

1. Press `Cmd+[` (or `Ctrl+[`): should go back
2. Press `Cmd+]` (or `Ctrl+]`): should go forward
3. Press `Alt+Left`: should go back
4. Press `Alt+Right`: should go forward

- [ ] **Step 3: Test mouse side buttons**

1. Press mouse back button (button 3): should go back
2. Press mouse forward button (button 4): should go forward

- [ ] **Step 4: Test forward stack clearing**

1. Navigate: Tracks → Artists → Albums
2. Go back to Artists
3. Click Tags in sidebar (new navigation)
4. Forward button should be disabled (future cleared)

- [ ] **Step 5: Test disabled states**

1. On fresh start, both buttons should be disabled
2. After first navigation, only back should be enabled
3. Forward should only enable after going back

- [ ] **Step 6: Verify search/sort don't create history entries**

1. Navigate to Artists view
2. Type in search bar, change sort
3. Click back: should go to the previous view, not to "Artists before search"
