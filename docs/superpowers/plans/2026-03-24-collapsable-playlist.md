# Collapsable Playlist Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the playlist (queue) panel to collapse to a 56px strip with vertical text, mirroring the sidebar collapse pattern.

**Architecture:** Add `queueCollapsed` state to App.tsx, pass it to QueuePanel which conditionally renders a collapsed strip or the full panel. CSS grid rules handle the width transition. State persists via the app store.

**Tech Stack:** React, TypeScript, CSS Grid, @tauri-apps/plugin-store

**Spec:** `docs/superpowers/specs/2026-03-24-collapsable-playlist-design.md`

---

### Task 1: Add store default

**Files:**
- Modify: `src/store.ts:38` (add after `sidebarCollapsed`)

- [ ] **Step 1: Add `queueCollapsed` default to store**

In `src/store.ts`, add `queueCollapsed: false` after the `sidebarCollapsed: false` line (line 38):

```typescript
    sidebarCollapsed: false,
    queueCollapsed: false,
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/store.ts
git commit -m "feat(queue): add queueCollapsed store default (#79)"
```

---

### Task 2: Add CSS grid rules and collapsed strip styles

**Files:**
- Modify: `src/App.css` (add after line 63 for grid rules, add after the `.queue-panel` block around line 3297 for strip styles)

- [ ] **Step 1: Add grid rules for collapsed queue**

After the `.app.sidebar-collapsed.queue-open` rule (line 61-63 in `src/App.css`), add:

```css
.app.queue-open.queue-collapsed {
  grid-template-columns: 220px 1fr 56px;
}

.app.sidebar-collapsed.queue-open.queue-collapsed {
  grid-template-columns: 56px 1fr 56px;
}
```

- [ ] **Step 2: Add collapsed strip styles**

After the `.queue-panel` block (around line 3297), add:

```css
.queue-panel.collapsed {
  overflow: hidden;
}

.queue-collapsed-strip {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  cursor: pointer;
  gap: 8px;
  transition: background 0.15s;
}

.queue-collapsed-strip:hover {
  background: var(--bg-hover);
}

.queue-collapsed-label {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--text-secondary);
}

.queue-collapsed-count {
  font-size: 11px;
  color: var(--text-secondary);
}
```

- [ ] **Step 3: Verify no CSS syntax errors**

Run: `npx tsc --noEmit`
Expected: No errors (CSS isn't type-checked but this ensures no TS regressions)

- [ ] **Step 4: Commit**

```bash
git add src/App.css
git commit -m "feat(queue): add CSS grid rules and collapsed strip styles (#79)"
```

---

### Task 3: Add collapsed rendering to QueuePanel

**Files:**
- Modify: `src/components/QueuePanel.tsx:50-68` (interface), `src/components/QueuePanel.tsx:72-76` (destructure), `src/components/QueuePanel.tsx:238-310` (render)

- [ ] **Step 1: Add props to interface**

In `src/components/QueuePanel.tsx`, add to the `QueuePanelProps` interface (after `onClose` at line 63):

```typescript
  collapsed: boolean;
  onToggleCollapsed: () => void;
```

- [ ] **Step 2: Destructure new props**

Update the destructuring at line 72-76 to include `collapsed, onToggleCollapsed`:

```typescript
export function QueuePanel({
  queue, queueIndex, queuePanelRef, playlistName,
  pendingEnqueue, onAllowAll, onSkipDuplicates, onCancelEnqueue,
  onPlay, onRemove, onMoveMultiple, onClear, onClose, onSavePlaylist, onLoadPlaylist, onContextMenu, externalDropTarget,
  collapsed, onToggleCollapsed,
}: QueuePanelProps) {
```

- [ ] **Step 3: Add collapsed class to aside element**

Change line 239 from:

```tsx
    <aside className="queue-panel" ref={queuePanelRef} tabIndex={-1} onKeyDown={handleKeyDown}>
```

to:

```tsx
    <aside className={`queue-panel${collapsed ? " collapsed" : ""}`} ref={queuePanelRef} tabIndex={-1} onKeyDown={handleKeyDown}>
```

- [ ] **Step 4: Add collapsed strip rendering**

Right after the opening `<aside>` tag and before the `<div className="queue-header">`, add an early return for collapsed state:

```tsx
      {collapsed ? (
        <div className="queue-collapsed-strip" onClick={onToggleCollapsed}>
          <span className="queue-collapsed-label">Playlist</span>
          <span className="queue-collapsed-count">{queue.length}</span>
        </div>
      ) : (
        <>
```

And wrap the closing of the existing content (before `</aside>`) with:

```tsx
        </>
      )}
```

This means the full panel content (header, pending banner, list, info bar) is wrapped in a fragment inside the `else` branch of the ternary.

- [ ] **Step 5: Add collapse button to header**

In the `queue-header-actions` div (line 242-247), add a collapse button before the close button:

```tsx
          <button className="ctrl-btn" onClick={onToggleCollapsed} title="Collapse playlist">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
              <polyline points="11 9 8 12 11 15" />
            </svg>
          </button>
```

This mirrors the sidebar collapse icon but with the vertical line on the right and arrow pointing left (toward collapse).

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Errors about missing props in App.tsx (expected — we'll wire them in Task 4)

- [ ] **Step 7: Commit**

```bash
git add src/components/QueuePanel.tsx
git commit -m "feat(queue): add collapsed strip rendering and collapse button (#79)"
```

---

### Task 4: Wire state in App.tsx

**Files:**
- Modify: `src/App.tsx:120` (state), `src/App.tsx:306` (store restore), `src/App.tsx:375` (apply restored value), `src/App.tsx:1063-1069` (toggle function), `src/App.tsx:1232` (className), `src/App.tsx:2435-2468` (QueuePanel props)

- [ ] **Step 1: Add state**

After `sidebarCollapsed` state at line 120, add:

```typescript
  const [queueCollapsed, setQueueCollapsed] = useState(false);
```

- [ ] **Step 2: Add store restore**

In the big `Promise.all` restore block, `sidebarCollapsed` is fetched at line 325:

```typescript
          store.get<boolean>("sidebarCollapsed"),
```

Add after the `store.get<boolean>("sidebarCollapsed")` line (line 325) and before `store.get<string | null>("downloadFormat")`:

```typescript
          store.get<boolean>("queueCollapsed"),
```

Then update the destructuring at line 293. In the `const [v, sq, sa, sal, ...]` array, add `savedQueueCollapsed` immediately after `savedSidebarCollapsed`:

```
...savedSidebarCollapsed, savedQueueCollapsed, savedDownloadFormat...
```

Also update the `timeAsync` label from `"store.restore (35 keys)"` to `"store.restore (36 keys)"`.

- [ ] **Step 3: Restore the value**

After `if (savedSidebarCollapsed) setSidebarCollapsed(true);` (line 375), add:

```typescript
        if (savedQueueCollapsed) setQueueCollapsed(true);
```

- [ ] **Step 4: Add toggle function**

After `handleToggleSidebar` (line 1063-1069), add:

```typescript
  function handleToggleQueueCollapsed() {
    setQueueCollapsed(prev => {
      const next = !prev;
      store.set("queueCollapsed", next);
      return next;
    });
  }
```

- [ ] **Step 5: Add `queue-collapsed` class to app div**

Find the `<div className={`app ...`}>` element (around line 1232). In the template literal, add ` ${queueCollapsed ? "queue-collapsed" : ""}` after the `queue-open` ternary. The full className becomes:

```tsx
<div className={`app ${appRestoring ? "app-restoring" : ""} ${playback.currentTrack && isVideoTrack(playback.currentTrack) ? "video-mode" : ""} ${queueHook.showQueue ? "queue-open" : ""} ${queueCollapsed ? "queue-collapsed" : ""} ${mini.miniMode ? "mini-mode" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} onClick={() => setContextMenu(null)}>
```

- [ ] **Step 6: Pass props to QueuePanel**

In the QueuePanel usage (line 2435-2468), add the new props after `externalDropTarget`:

```tsx
          collapsed={queueCollapsed}
          onToggleCollapsed={handleToggleQueueCollapsed}
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Run all tests**

Run: `npm run test:all`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx
git commit -m "feat(queue): wire collapsable playlist state and persistence (#79)"
```
