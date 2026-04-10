---
name: drag-and-drop
description: Use when implementing any drag-and-drop interaction in the app — covers the required pattern for Tauri's WKWebView
---

# Drag-and-Drop in Viboplr

## The Rule

**Never use HTML5 Drag and Drop API** (`draggable` attribute, `onDragStart`, `onDragOver`, `onDrop`) in this app. It is unreliable in Tauri's WKWebView (macOS WebKit) when `user-select: none` is set on ancestor elements — which `.app` sets globally.

**Always use manual mouse-event drag** (`onMouseDown` + `window` `mousemove`/`mouseup` listeners).

## The Pattern

Follow the implementation in `src/components/TrackList.tsx` (`handleColMouseDown`, ~line 272). Key elements:

### State

```tsx
const dragRef = useRef<DragState | null>(null);     // what's being dragged
const dragOverRef = useRef<TargetId | null>(null);   // current drop target
const didDragRef = useRef(false);                     // distinguishes click from drag
const ghostRef = useRef<HTMLDivElement | null>(null); // floating ghost element
```

Use `useRef` (not `useState`) for drag tracking — avoids re-renders during mousemove.

### onMouseDown handler

```tsx
function handleMouseDown(e: React.MouseEvent, id: string) {
  if (e.button !== 0) return;  // left button only
  dragRef.current = { id };
  dragOverRef.current = null;
  didDragRef.current = false;

  function onMouseMove(ev: MouseEvent) { /* show ghost, find target via elementFromPoint */ }
  function onMouseUp() { /* remove ghost, apply reorder, cleanup */ }

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}
```

### Drop target identification

Use `data-*` attributes on drop targets and `document.elementFromPoint()` + parent traversal to find which target the cursor is over:

```tsx
function findTarget(el: Element | null): string | null {
  while (el) {
    const id = el.getAttribute("data-my-id");
    if (id !== null) return id;
    el = el.parentElement;
  }
  return null;
}

// In mousemove:
const target = document.elementFromPoint(ev.clientX, ev.clientY);
const overId = target ? findTarget(target) : null;
```

### Ghost element

Append to `document.body` (not a scrollable container) so it's never clipped by `overflow: hidden`:

```tsx
const ghost = document.createElement("div");
ghost.className = "my-drag-ghost";
ghost.textContent = label;
document.body.appendChild(ghost);
```

Style with `position: fixed; z-index: 9999; pointer-events: none;`.

### Click vs drag

Guard click handlers with `didDragRef`:

```tsx
onClick={() => { if (!didDragRef.current) handleClick(); }}
```

Reset `didDragRef` in a `setTimeout` in `onMouseUp` so the click event (which fires after mouseup) is suppressed:

```tsx
setTimeout(() => { didDragRef.current = false; }, 0);
```

### Cleanup in onMouseUp

Always remove window listeners, remove ghost, and reset refs — even if no valid drop occurred.

## Existing implementations

- **TrackList column reorder**: `src/components/TrackList.tsx` — `handleColMouseDown`
- **Provider priority pills**: `src/components/SettingsPanel.tsx` — `handlePillMouseDown` in `ProviderPrioritySection`
- **Queue reorder**: `src/components/QueuePanel.tsx` — uses the same mousedown/mousemove/mouseup pattern
