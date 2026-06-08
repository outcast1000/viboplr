# Mini Player Quick Search — Design

**Date:** 2026-06-08
**Status:** Approved (pending implementation plan)

## Problem

The user often runs the app in mini player mode (a tiny, always-on-top, non-resizable window showing only the now-playing footer). Today there is no way to search from mini mode — global search (Cmd+K) lives in the CaptionBar, which is hidden in mini mode. The user wants to find and play something specific quickly without leaving the mini player.

## Goal

When the mini player window is focused and the user starts typing, a search panel appears inline. The user can find a track, album, or artist and play (or enqueue) it, then the panel collapses back to the resting player — all without leaving mini mode.

## Behavior

### Trigger
- In mini mode, when the window is focused, **no text input is focused**, and the user presses a **single printable character** (letter / number / punctuation), the search panel opens, seeded with that character.
- **Space and arrow keys remain player controls** (play/pause, seek, volume) until the panel is open. They do not wake search.
- Modifier combos (Cmd+Shift+M, etc.) keep their existing behavior.
- Ignore `e.isComposing` / IME dead keys — only simple printable `key` values trigger.

### Search panel
- Window expands downward (or upward if insufficient space below — same direction logic as hover-expand) into a fixed-height panel (~260px): search input row on top, scrollable grouped results below.
- Width is unchanged (stays at the user's current mini width: 280 / 400 / 550).
- Results are grouped **Tracks / Albums / Artists**, fetched via the existing `search_all` backend command with a 200 ms debounce.
- Slot allocation is **track-weighted** (the use case is "find a song fast").

### Selection & actions
- ↑ / ↓ move the highlight.
- **Track:** Enter = play now; Cmd/Ctrl+Enter = add to queue.
- **Album:** Enter = play all (replaces queue, with playlist context); Cmd/Ctrl+Enter = enqueue all.
- **Artist:** Enter = play all; Cmd/Ctrl+Enter = enqueue all.
- Album/artist actions route through the existing `usePlayActions` hook (`playAlbum` / `playArtist` / `enqueueAlbum` / `enqueueArtist`) — no reimplementation of track fetching or playlist context.
- There is **no detail-page navigation** in mini mode. Every pick is a play/enqueue action.

### Dismissal
- After any pick, the panel **collapses** back to the resting mini player, which now shows the newly-playing track.
- **Esc** closes and collapses.
- **Emptying the field** (deleting all characters) collapses back to the player.
- **Losing window focus leaves the panel open** (an always-on-top window is tabbed away from constantly; closing on blur would be jarring).
- Non-empty query with zero results shows a small "No results" line; the panel stays open.

## Approach

Dedicated, purpose-built units for the mini surface, with the genuinely shared search mechanics factored into one helper so logic is not duplicated.

### New / changed units

**`src/utils/searchSlots.ts` (new, pure)**
- Extract `search_all` slot allocation into a pure, unit-testable helper.
- Provide the existing balanced allocation (for `useCentralSearch`) and a track-weighted variant (for mini search). `useCentralSearch` is refactored to consume this helper (limited "fix as you go" tidy; no behavior change to global search).

**`src/hooks/useMiniSearch.ts` (new)**
- Owns `query`, `results`, `items`, `highlightedIndex`, `isOpen`, and `open(initialChar)`, `close()`, `setQuery`, `handleKeyDown`, `handleResultClick`.
- Calls `search_all` with a 200 ms debounce; uses the track-weighted slot helper.
- `actOnItem(item, enqueue)` is the divergence point from global search: track → play/enqueue; album → `playAlbum`/`enqueueAlbum`; artist → `playArtist`/`enqueueArtist`. Calls `close()` after acting (collapse-after-pick).
- Play/enqueue callbacks injected as options from `App.tsx`, wired to `useQueue` + `usePlayActions`.

**`src/components/MiniSearchPanel.tsx` (new)**
- Renders the search input + grouped results, sized for the mini window, styled with skin CSS custom properties and `.ds-*` classes (no hardcoded colors).
- Result-row images resolved via the same name-based chain used by the queue / now-playing bar (album → artist → placeholder).
- Rendered inside the mini-mode branch of `NowPlayingBar.tsx`, shown when `isOpen`.

**`src/hooks/useMiniMode.ts` (changed)**
- Add a search-panel size state plus `openSearchPanel()` / `closeSearchPanel()` that resize the window to the fixed panel height and restore the resting height on close, reusing the existing expand-direction (down/up) logic and monitor clamping.
- **Precedence over hover-expand:** opening search calls `cancelCollapseTimer()` and sets a guard; while the panel is open, `mini-cursor-entered` / `mini-cursor-left` events are ignored. Normal hover behavior resumes on close.
- Toggling out of mini mode (Cmd+Shift+M) while search is open closes search first, then runs the normal full-window restore.
- Extract the pure open/close height + direction decision so it can be unit-tested without Tauri (mirrors existing pure exports `cycleMiniWidth`, `clampToNearestMonitor`).

**`src/hooks/useInAppKeyboardShortcuts.ts` (changed)**
- In mini mode, when no input is focused and the key is a single printable character (not Space, not an arrow, not a modifier combo, not composing), `preventDefault` and call the mini-search open handler with that character. Everything else falls through unchanged.

### Data flow

```
keydown (printable, mini, no input focused)
  -> openSearchPanel()            [useMiniMode resizes window]
  -> useMiniSearch.open(char)     [seeds query, focuses input]
  -> debounced search_all -> results
  -> Up/Down/Enter/Cmd+Enter via handleKeyDown
  -> actOnItem -> useQueue.playTracks / usePlayActions.playAlbum|playArtist (or enqueue*)
  -> close() -> closeSearchPanel() [window resizes back] -> resting player shows new track
```

## Edge cases

- **Compact resting size (24px):** typing opens the full panel; on close, returns to 24px.
- **First-character seeding:** the seeded character must land in the input exactly once — seed `query`, then focus; the original keydown is `preventDefault`-ed so it does not also type into the input.
- **Empty query:** collapses the panel.
- **Non-local / external track results:** play through the normal stream-resolver chain; no special handling (queue is path-based).

## Testing

- **Unit (vitest):**
  - `searchSlots.ts` allocation — balanced and track-weighted variants.
  - A pure "should this keydown wake search?" predicate (printable vs Space / arrow / modifier / composing).
  - `actOnItem` routing — mock callbacks assert play vs enqueue vs `playAlbum` / `playArtist`.
  - Pure open/close height + direction decision extracted from `useMiniMode`.
- **E2E:** none new (mini-mode window resizing is not exercised by the Tauri mock). Existing smoke test must still pass.

## Out of scope (YAGNI)

- Detail-page navigation from mini search.
- Search history.
- Per-result context menus.
- Changing window width on search open.
- A settings toggle — just-start-typing is always on in mini mode.
