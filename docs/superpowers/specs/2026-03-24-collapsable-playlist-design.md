# Collapsable Playlist Panel

**Issue:** #79
**Date:** 2026-03-24

## Summary

Add the ability to collapse the playlist (queue) panel to a narrow 56px strip showing vertical "Playlist" text and track count, mirroring the existing sidebar collapse pattern. The collapsed state persists across sessions.

## Current Behavior

The playlist panel is a binary show/hide toggle controlled by `showQueue`. When visible, it occupies 300px as grid column 3. There is no intermediate collapsed state.

## Design

### State & Persistence

- New `queueCollapsed: boolean` state in App.tsx, default `false`.
- Add `queueCollapsed: false` to store defaults in `src/store.ts`.
- Restored from store key `"queueCollapsed"` during app launch, around where `sidebarCollapsed` is restored.
- Saved to store on toggle.
- `toggleQueueCollapsed` function toggles the boolean and persists it.

### Grid Layout Changes

Current grid classes:

| Class combo | grid-template-columns |
|---|---|
| `.app` | `220px 1fr` |
| `.app.queue-open` | `220px 1fr 300px` |
| `.app.sidebar-collapsed` | `56px 1fr` |
| `.app.sidebar-collapsed.queue-open` | `56px 1fr 300px` |

New additions:

| Class combo | grid-template-columns |
|---|---|
| `.app.queue-open.queue-collapsed` | `220px 1fr 56px` |
| `.app.sidebar-collapsed.queue-open.queue-collapsed` | `56px 1fr 56px` |

The `grid-template-columns` transition already exists on `.app` for sidebar collapse — the playlist collapse will benefit from the same transition.

### QueuePanel Changes

**Props added:** `collapsed: boolean`, `onToggleCollapsed: () => void`.

Track count is derived from the existing `queue.length` prop internally — no separate `trackCount` prop needed.

**When `collapsed` is true**, render a collapsed strip instead of the full panel:

```html
<aside class="queue-panel collapsed">
  <div class="queue-collapsed-strip" onClick={onToggleCollapsed}>
    <span class="queue-collapsed-label">Playlist</span>
    <span class="queue-collapsed-count">{queue.length}</span>
  </div>
</aside>
```

When collapsed and queue is empty, show "0" as the count. Clicking expands to show the empty state message.

**Collapse button in header:** Add a collapse button (right-pointing arrow, matching the sidebar collapse icon style — 16x16 SVG) to `queue-header-actions`, before the close button. Clicking it sets `queueCollapsed = true`.

### CSS

New rules:

- `.queue-panel.collapsed` — width handled by grid; hide overflow.
- `.queue-collapsed-strip` — `display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; cursor: pointer;`
- `.queue-collapsed-label` — `writing-mode: vertical-rl; text-orientation: mixed; font-size: 13px; font-weight: 600; letter-spacing: 1px;`
- `.queue-collapsed-count` — `font-size: 11px; color: var(--text-secondary); margin-top: 8px;`

### Keyboard Shortcut Behavior

`Cmd+P` toggles `showQueue` (show/hide the panel entirely). This behavior is unchanged. When the panel is open and collapsed, `Cmd+P` hides it. When toggled back on, it remembers the collapsed state from store.

### Mini Mode

Mini mode hides the queue panel entirely (`.app.mini-mode .queue-panel { display: none; }`), so the collapsed state has no visual effect in mini mode. The persisted state is respected when exiting mini mode.

### Files Changed

1. **src/store.ts** — Add `queueCollapsed: false` to defaults.
2. **src/App.tsx** — Add `queueCollapsed` state, restore from store, add `queue-collapsed` class to `.app` div, pass props to QueuePanel.
3. **src/App.css** — Add `.queue-open.queue-collapsed` grid rules, collapsed strip styles.
4. **src/components/QueuePanel.tsx** — Accept `collapsed`/`onToggleCollapsed` props, render collapsed strip or full panel, add collapse button to header.

## Out of Scope

- Drag-to-resize the playlist panel width.
- Animation of the collapsed strip content (fade in/out).
- Changing the keyboard shortcut behavior.
