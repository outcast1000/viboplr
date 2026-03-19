# Navigation History: Back/Forward Buttons

**Issue:** #2 — Add back and forward navigation buttons for view history
**Date:** 2026-03-18

## Overview

Add browser-style back/forward navigation to Viboplr. Users can navigate between views and drill-downs, then use back/forward to retrace their steps. History is ephemeral (in-memory only, resets on restart).

## Navigation State

A navigation checkpoint is a snapshot of the 4 values that define "where the user is":

```ts
interface NavState {
  view: View;
  selectedArtist: number | null;
  selectedAlbum: number | null;
  selectedTag: number | null;
}
```

### What creates a history entry

- Switching views via sidebar (Tracks, Artists, Albums, Tags, Liked, History, TIDAL)
- Drilling into an artist, album, or tag
- Clicking breadcrumb links to go up a level

### What does NOT create a history entry

- Typing in the search bar
- Changing sort order or column visibility
- Playback actions (play, pause, queue)

## Hook: `useNavigationHistory`

New file: `src/hooks/useNavigationHistory.ts`

### Interface

```ts
function useNavigationHistory(
  current: NavState,
  setters: {
    setView: (v: View) => void;
    setSelectedArtist: (id: number | null) => void;
    setSelectedAlbum: (id: number | null) => void;
    setSelectedTag: (id: number | null) => void;
  }
): {
  goBack: () => void;
  goForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
}
```

### Internal State

- `history: NavState[]` — past states (stack, max 20 entries)
- `future: NavState[]` — forward states (cleared on new navigation)
- `skipNextPush: React.MutableRefObject<boolean>` — flag to prevent recording when restoring from history
- `MAX_HISTORY = 20` — configurable constant

### Behavior

1. A `useEffect` watches `{ view, selectedArtist, selectedAlbum, selectedTag }`.
2. When any value changes:
   - If `skipNextPush` is true: reset the flag, do nothing else.
   - Otherwise: push the **previous** state onto `history` (capped at `MAX_HISTORY`), clear `future`.
3. `goBack()`: Set `skipNextPush = true`, pop from `history`, push current state to `future`, call all 4 setters with the popped state.
4. `goForward()`: Set `skipNextPush = true`, pop from `future`, push current state to `history`, call all 4 setters with the popped state.

### Edge cases

- Duplicate detection: if the new state equals the current state (same view + selections), skip the push. This prevents double entries from navigation handlers that set multiple values in sequence (React batches state updates, so the effect fires once per render).
- Initial state: no history entry is created for the initial load.

## UI: Toolbar Buttons

Back/forward buttons are added to the existing `.search-bar` div in `App.tsx`, before the search input:

```
[ ← ] [ → ]  [ ___Search..._______________ ]
```

- Simple `<button>` elements with SVG chevron arrows
- `disabled` attribute when `!canGoBack` / `!canGoForward`
- Styled with `.nav-history-btn` class in `App.css`
- Match existing app aesthetic: dark surface background, accent color on hover, muted when disabled

## Keyboard Shortcuts

Added to the existing `keydown` handler in `App.tsx`:

| Shortcut | Action |
|----------|--------|
| `Cmd+[` | Go back |
| `Cmd+]` | Go forward |
| `Alt+ArrowLeft` | Go back |
| `Alt+ArrowRight` | Go forward |

Both Cmd and Alt shortcuts work on all platforms.

## Mouse Side Buttons

A `mouseup` event listener on `window`, added via `useEffect` in `App.tsx`:

- Button 3 (mouse back) → `goBack()`
- Button 4 (mouse forward) → `goForward()`

## File Changes

| File | Change |
|------|--------|
| `src/hooks/useNavigationHistory.ts` | New hook (entire file) |
| `src/App.tsx` | Call hook, add toolbar buttons, add keyboard/mouse handlers |
| `src/App.css` | Add `.nav-history-btn` styles |

No backend changes required. No new dependencies.

## Acceptance Criteria (from issue)

- [x] Back and forward navigation buttons are present and functional
- [x] Back navigates to the previous view in navigation history
- [x] Forward navigates forward only if the user has moved back in the stack
- [x] The history stack holds a configurable number of entries (default: 20)
- [x] History is ephemeral and resets on app restart (no persistence)
