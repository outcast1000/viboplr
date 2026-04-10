# Information Sections UX Improvements

## Summary

Four changes to the information sections system:
1. Remove the version-change cache wipeout that deletes all cached values when a plugin version changes
2. Add a refresh button to the tab bar for manual re-fetching
3. Show sections with no data in a dimmed state instead of hiding them
4. Show "View on {providerName}" consistently across all plugin sections, including empty ones

## Motivation

Adding a new plugin (AllMusic) that shares a type ID (`artist_bio`) with existing plugins triggers the version-change invalidation, which deletes all cached values for that type across all providers. This causes the "About" section to disappear until a fresh fetch completes. The broader fix is removing the wipeout, giving users a manual refresh, and making sections always visible so missing data is transparent rather than invisible.

## Files to Modify

- `src/hooks/usePlugins.ts` — Remove version invalidation block
- `src/hooks/useInformationTypes.ts` — New `"empty"` cache action, preserve `_meta` in empty states
- `src/components/InformationSections.tsx` — Refresh button, empty state rendering, consistent "View on" link
- `src/components/InformationSections.css` — Styles for dimmed tabs, empty state, refresh button
- `src/types/informationTypes.ts` — Add `"empty"` kind to `InfoSection` state union

## Change 1: Remove Version-Change Cache Wipeout

**File:** `src/hooks/usePlugins.ts:653-665`

Delete the block that detects plugin version changes and calls `info_delete_values_for_type`. Keep the `pluginInfoVersions` store update so version tracking still works (useful for future features), but remove the cache deletion loop.

Cached values will expire naturally via TTL. Users can manually refresh individual sections via the new refresh button.

## Change 2: Add Refresh Button

**File:** `src/components/InformationSections.tsx`

Add a small refresh icon button (circular arrow SVG) in the tab bar, aligned to the right. Clicking it calls `refresh(typeId)` from `useInformationTypes` for the currently active plugin tab. The component currently destructures only `{ sections, reloadCache }` from the hook — it needs to also destructure `refresh`. The button is only shown for plugin tabs (not custom tabs). The button is hidden when the section is collapsed.

While a refresh is in progress, the section shows the skeleton loading state. The `refresh` function already exists in `useInformationTypes.ts:212-231` — it deletes the cached value and re-runs the fetch chain.

**File:** `src/components/InformationSections.css`

Style the refresh button: small (14x14), secondary text color, low opacity (0.4), hover to 0.8, cursor pointer. Positioned at the right end of the tab bar with `margin-left: auto`.

## Change 3: Show Empty Sections Dimmed

### State changes

**File:** `src/types/informationTypes.ts`

Add `"empty"` to the `InfoSection` state kind union and remove `"hidden"` (nothing will return it after this change):
```typescript
state:
  | { kind: "loading" }
  | { kind: "loaded"; data: unknown; stale: boolean }
  | { kind: "empty" }
```

Also remove the `"hidden"` CacheAction from `useInformationTypes.ts` — replace all uses with `"empty"`.

**File:** `src/hooks/useInformationTypes.ts`

In `decideCacheAction`: when status is `not_found` or `error` and not stale, return `"empty"` instead of `"hidden"`. When stale, return `"loading"` as before (triggers re-fetch).

In `loadSections`: for `"empty"` action, push a section with `state: { kind: "empty" }` (same as `"loading"` but different render).

When the fetch chain completes with a non-ok result (lines 187-188), instead of removing the section entirely, update it to `{ kind: "empty" }`.

### Rendering

**File:** `src/components/InformationSections.tsx`

- Tabs for empty sections render with a dimmed class (lower opacity, e.g., 0.25)
- When an empty section is active, the content area shows a subtle "No data available" message in `var(--text-secondary)` at low opacity
- The "View on {providerName}" link still renders if `_meta` is available (see Change 4)

**File:** `src/components/InformationSections.css`

```css
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
```

## Change 4: Consistent "View on {providerName}"

Currently, `_meta` is only extracted from loaded data (`state.kind === "loaded"`). The `InfoFetchResult` type only carries `value` on `status: "ok"` — `not_found` and `error` results have no value field. So `_meta` is only available when data is successfully loaded.

For loaded sections, `_meta` is already extracted and the "View on" link renders. No change needed there.

For empty sections, `_meta` is not available since no successful fetch occurred. The "View on" link simply won't render for empty sections. This is acceptable — there's no meaningful provider URL to link to when no data was found.

**File:** `src/components/InformationSections.tsx`

Move the `_meta` extraction and "View on {providerName}" link rendering so it works for both loaded and empty sections uniformly. For loaded sections, extract `_meta` from the data as before. For empty sections, `meta` will be `undefined` and the link won't render. No special handling needed — the existing conditional `{meta?.url && meta?.providerName && ...}` already handles this.

## Testing

- Verify adding a new plugin no longer wipes cached values for shared type IDs
- Verify the refresh button triggers a fresh fetch and shows loading state
- Verify sections with `not_found` status appear as dimmed tabs with "No data available"
- Verify "View on {providerName}" appears for sections that have provider metadata
- Verify dimmed tabs become active when clicked and show the empty state content
