# Information Sections UX Improvements — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four UX issues with the information sections system: remove destructive cache invalidation, add manual refresh, show empty sections visibly, and keep "View on" links consistent.

**Architecture:** All changes are frontend-only (React/TypeScript). The type system gets a new `"empty"` state kind, the cache action logic stops hiding sections, the component renders dimmed tabs and a refresh button, and the version-change wipeout in `usePlugins.ts` is deleted.

**Tech Stack:** React, TypeScript, CSS custom properties, Tauri IPC (`invoke`).

**Spec:** `docs/superpowers/specs/2026-04-10-info-sections-ux-design.md`

---

### Task 1: Update InfoSection state union — replace `"hidden"` with `"empty"`

**Files:**
- Modify: `src/types/informationTypes.ts:74-82`

- [ ] **Step 1: Replace `"hidden"` with `"empty"` in the state union**

Change the `InfoSection` interface state union from:

```typescript
state:
  | { kind: "loaded"; data: unknown; stale: boolean }
  | { kind: "loading" }
  | { kind: "hidden" }; // not_found or fresh error
```

to:

```typescript
state:
  | { kind: "loaded"; data: unknown; stale: boolean }
  | { kind: "loading" }
  | { kind: "empty" };
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: Errors in `useInformationTypes.ts` and `InformationSections.tsx` referencing `"hidden"` — these will be fixed in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add src/types/informationTypes.ts
git commit -m "refactor(info-types): replace hidden state with empty for visible empty sections"
```

---

### Task 2: Update cache action logic — return `"empty"` instead of `"hidden"`

**Files:**
- Modify: `src/hooks/useInformationTypes.ts:13,28,112-113,187-188,197-198`

- [ ] **Step 1: Replace `CacheAction` type and `decideCacheAction` return value**

At line 13, change the `CacheAction` type:

```typescript
type CacheAction = "render" | "render_and_refetch" | "loading" | "empty";
```

At line 28, change the return value from `"hidden"` to `"empty"`:

```typescript
return stale ? "loading" : "empty";
```

- [ ] **Step 2: Handle `"empty"` action in `loadSections`**

At lines 112-113, replace:

```typescript
if (action === "hidden") continue;
```

with:

```typescript
if (action === "empty") {
  newSections.push({
    typeId,
    name,
    displayKind: displayKind as DisplayKind,
    state: { kind: "empty" },
  });
  continue;
}
```

- [ ] **Step 3: Update fetch completion to set empty state instead of removing section**

At lines 187-188, replace:

```typescript
} else if (mountedRef.current && entityKeyRef.current === entityKey && result.status !== "ok") {
  setSections((prev) => prev.filter((s) => s.typeId !== typeId));
```

with:

```typescript
} else if (mountedRef.current && entityKeyRef.current === entityKey && result.status !== "ok") {
  setSections((prev) => {
    const next = [...prev];
    const existing = next.find((s) => s.typeId === typeId);
    if (existing) {
      existing.state = { kind: "empty" };
    }
    return next;
  });
```

At lines 197-198, replace the error handler removal:

```typescript
if (mountedRef.current && entityKeyRef.current === entityKey) {
  setSections((prev) => prev.filter((s) => s.typeId !== typeId));
```

with:

```typescript
if (mountedRef.current && entityKeyRef.current === entityKey) {
  setSections((prev) => {
    const next = [...prev];
    const existing = next.find((s) => s.typeId === typeId);
    if (existing) {
      existing.state = { kind: "empty" };
    }
    return next;
  });
```

- [ ] **Step 4: Verify TypeScript compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: Remaining errors only in `InformationSections.tsx` (fixed in Task 4).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useInformationTypes.ts
git commit -m "feat(info-types): return empty state instead of hiding sections with no data"
```

---

### Task 3: Remove version-change cache wipeout

**Files:**
- Modify: `src/hooks/usePlugins.ts:660-663`

- [ ] **Step 1: Remove the cache deletion loop but keep version tracking**

Inside the version-change detection block, remove only the inner loop that calls `info_delete_values_for_type` (lines 661-663). Keep the version comparison, `newVersions` accumulation, and the store persist — version tracking is useful for future features.

Remove these 3 lines:

```typescript
            for (const it of st.manifest.contributes.informationTypes) {
              await invoke("info_delete_values_for_type", { typeId: it.id }).catch(() => {});
            }
```

The block should now read:

```typescript
        // Track plugin info versions (no longer invalidates cache)
        const storedVersions = (await store.get<Record<string, string>>("pluginInfoVersions")) ?? {};
        const newVersions: Record<string, string> = { ...storedVersions };
        let versionsDirty = false;
        for (const st of states) {
          if (st.status !== "active" || !st.manifest.contributes?.informationTypes?.length) continue;
          const prev = storedVersions[st.id];
          if (prev !== st.manifest.version) {
            newVersions[st.id] = st.manifest.version;
            versionsDirty = true;
          }
        }
        if (versionsDirty) {
          await store.set("pluginInfoVersions", newVersions);
        }
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: No new errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePlugins.ts
git commit -m "fix(plugins): remove version-change cache wipeout that deleted shared type data"
```

---

### Task 4: Add refresh button, empty section rendering, and consistent "View on" link

**Files:**
- Modify: `src/components/InformationSections.tsx:49,136,148-155,168-176,180-198`
- Modify: `src/components/InformationSections.css` (append new styles)

- [ ] **Step 1: Destructure `refresh` from the hook**

At line 49, change:

```typescript
const { sections, reloadCache } = useInformationTypes({ entity, exclude, invokeInfoFetch });
```

to:

```typescript
const { sections, refresh, reloadCache } = useInformationTypes({ entity, exclude, invokeInfoFetch });
```

- [ ] **Step 2: Add `"empty"` class to dimmed tabs**

At line 171, change the tab className to include an empty class when the section is empty. Replace the entire `tabs.map` block (lines 168-176):

```typescript
        {tabs.map(tab => (
          <div
            key={getTabId(tab)}
            className={`info-sections-tab${getTabId(tab) === resolvedTab ? " active" : ""}${tab.kind === "plugin" && tab.section.state.kind === "empty" ? " empty" : ""}`}
            onClick={() => { setActiveTab(getTabId(tab)); setCollapsed(false); }}
          >
            {tab.name}
          </div>
        ))}
```

- [ ] **Step 3: Add refresh button after the tabs**

After the closing of `tabs.map` (after the new `)}`) and before the closing `</div>` of `.info-sections-tabs`, add the refresh button. The button is only shown for plugin tabs and when not collapsed.

Replace the entire `.info-sections-tabs` div (lines 159-177) with:

```tsx
      <div className="info-sections-tabs">
        <svg
          className={`section-chevron info-sections-collapse${collapsed ? " collapsed" : ""}`}
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          onClick={() => setCollapsed(c => !c)}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        {tabs.map(tab => (
          <div
            key={getTabId(tab)}
            className={`info-sections-tab${getTabId(tab) === resolvedTab ? " active" : ""}${tab.kind === "plugin" && tab.section.state.kind === "empty" ? " empty" : ""}`}
            onClick={() => { setActiveTab(getTabId(tab)); setCollapsed(false); }}
          >
            {tab.name}
          </div>
        ))}
        {!collapsed && activeEntry.kind === "plugin" && (
          <svg
            className="info-sections-refresh"
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            onClick={() => refresh(activeEntry.typeId)}
          >
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        )}
      </div>
```

- [ ] **Step 4: Render empty section content**

Replace the content rendering block (lines 180-198) with code that handles the `"empty"` state and extracts `_meta` for both loaded and empty sections:

```tsx
      {!collapsed && (
        <>
          <div className="info-section-content">
            {activeEntry.kind === "custom" ? (
              activeEntry.content
            ) : (() => {
              const s = activeEntry.section;
              const Renderer = renderers[s.displayKind];
              return s.state.kind === "loading" ? (
                <div className="info-section-skeleton" />
              ) : s.state.kind === "loaded" && s.state.data && Renderer ? (
                <Renderer data={s.state.data} onEntityClick={onEntityClick} onAction={handleAction} resolveEntity={resolveEntity} context={positionSecs != null ? { positionSecs } : undefined} />
              ) : s.state.kind === "empty" ? (
                <div className="info-section-empty">No data available</div>
              ) : null;
            })()}
          </div>
          {meta?.url && meta?.providerName && (
            <a className="info-section-view-on" href="#" onClick={(e) => { e.preventDefault(); openUrl(meta.url!); }}>
              View on {meta.providerName}
            </a>
          )}
        </>
      )}
```

Note: The `meta` extraction at lines 148-155 already handles both loaded (extracts `_meta`) and non-loaded (undefined) sections correctly. No change needed there.

- [ ] **Step 5: Add CSS styles for empty tabs and refresh button**

Append the following to `src/components/InformationSections.css`:

```css
/* ── Empty section state ── */

.info-sections-tab.empty {
  opacity: 0.25;
}

.info-sections-tab.empty:hover {
  opacity: 0.5;
}

.info-section-empty {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  opacity: 0.4;
  padding: 8px 0;
}

/* ── Refresh button ── */

.info-sections-refresh {
  margin-left: auto;
  flex-shrink: 0;
  cursor: pointer;
  opacity: 0.4;
  transition: opacity 0.15s ease;
}

.info-sections-refresh:hover {
  opacity: 0.8;
}
```

- [ ] **Step 6: Verify TypeScript compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/InformationSections.tsx src/components/InformationSections.css
git commit -m "feat(info-sections): add refresh button, dimmed empty tabs, and empty state message"
```

---

### Task 5: Manual integration test

No automated test infrastructure exists for these UI components. Test manually in the running app.

- [ ] **Step 1: Start the app**

Run: `npm run tauri dev`

- [ ] **Step 2: Verify version-change wipeout is gone**

Navigate to an artist that previously had an "About" section (e.g., one fetched by Last.fm or Genius). Confirm the "About" section still appears with cached data — it should NOT disappear after the AllMusic plugin was added.

- [ ] **Step 3: Verify empty sections appear dimmed**

Navigate to an artist where a provider returns `not_found` for a section. The tab should appear at lower opacity (0.25). Clicking the dimmed tab should show "No data available" in the content area.

- [ ] **Step 4: Verify refresh button**

Click the refresh button (circular arrow icon at the right end of the tab bar). The section should show the skeleton loading state, then reload with fresh data. Verify the button is hidden when the section is collapsed.

- [ ] **Step 5: Verify "View on" link**

For a loaded section, confirm the "View on {providerName}" link appears at the bottom. For an empty section, confirm the link does NOT appear (expected — no `_meta` available).

- [ ] **Step 6: Verify AllMusic plugin integration**

Temporarily disable Last.fm and Genius `artist_bio` providers in Settings > Providers, then navigate to an artist. The "About" section should show the AllMusic biography with "View on AllMusic" link. Re-enable both providers afterward.
