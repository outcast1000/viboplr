# Detail Hero Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace four near-duplicate detail-page hero blocks (Artist / Album / Track / Tag) with a single shared `<DetailHero>` component that exposes always-visible `▶ Play / ≡+ Enqueue / ⋯` actions matching the Home carousel buttons. The existing `DetailHeroBackground` (image collage + scrim) is reused unchanged.

**Architecture:** Add three new files: `DetailHero.tsx` (presentation), `HeroOverflowMenu.tsx` (small dropdown — patterned after `ImageActions`), `heroOverflow.ts` (pure helper that assembles overflow items per entity). Add `enqueueTracks` to `DetailViewActions` so all four detail components can route one-click enqueue through the existing `handleEnqueue` flow (which already runs `findDuplicates` and surfaces the duplicate banner). Each detail component swaps its hero JSX for `<DetailHero>`. Legacy hero CSS in `App.css` and `TrackDetailView.css` is deleted.

**Tech Stack:** React + TypeScript (Vite), CSS in `App.css` + co-located component CSS, vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-05-27-detail-hero-unification-design.md`

---

## File Structure

**New files:**
- `src/components/DetailHero.tsx` — presentation component
- `src/components/DetailHero.css` — styles for `.detail-hero-*` and `.hero-overflow-*`
- `src/components/HeroOverflowMenu.tsx` — small dropdown rendering `HeroOverflowItem[]`
- `src/utils/heroOverflow.ts` — `buildHeroOverflowItems()` + `HeroOverflowItem` type
- `src/__tests__/heroOverflow.test.ts` — vitest unit tests for the helper

**Modified files:**
- `src/contexts/DetailViewContext.tsx` — add `enqueueTracks: (tracks: Track[]) => void`
- `src/App.tsx` — wire `enqueueTracks: contextMenuActions.handleEnqueue`
- `src/components/AlbumDetail.tsx` — render `<DetailHero>`
- `src/components/ArtistDetailContent.tsx` — render `<DetailHero>`
- `src/components/TagDetail.tsx` — render `<DetailHero>`
- `src/components/TrackDetailView.tsx` — render `<DetailHero>`; drop inline meta/stats/youtube blocks
- `src/App.css` — remove `.artist-detail-*`, `.album-detail-*`, `.detail-art-play`, `.artist-bio-stats`, `.artist-meta`; rewrite sibling selectors
- `src/components/TrackDetailView.css` — remove `.track-detail-{top,bg,header,art,art-img,art-frames,art-label,art-placeholder,info,info h2,meta,link,sep,stats,youtube-*}`; rewrite `.track-detail-top + .section-wide` selectors

---

## Task 1: Add `enqueueTracks` to `DetailViewActions`

**Files:**
- Modify: `src/contexts/DetailViewContext.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the action to the interface**

In `src/contexts/DetailViewContext.tsx`, in the `DetailViewActions` interface, add a new line right after `playAlbum`:

```ts
  playEntityAll: (kind: "artist" | "album" | "tag", name: string, artistName?: string, opts?: { tracks?: Track[]; entityId?: number }) => void;
  playAlbum: (albumId: number, opts?: { tracks?: Track[]; startIndex?: number }) => void;
  enqueueTracks: (tracks: Track[]) => void;
```

In the dependency array of the `useMemo` inside `DetailViewProvider`, append `actions.enqueueTracks` after `actions.playAlbum`:

```ts
    actions.playTracks, actions.playEntityAll, actions.playAlbum, actions.enqueueTracks,
```

- [ ] **Step 2: Wire it in `App.tsx`**

In `src/App.tsx`, locate the `detailViewActions` object literal (around line 2476). Add a single line right after `playAlbum: playActions.playAlbum,`:

```tsx
    playAlbum: playActions.playAlbum,
    enqueueTracks: contextMenuActions.handleEnqueue,
```

In the dep-array of the same `useMemo` (around line 2519), append `contextMenuActions.handleEnqueue` to the line that already lists `playActions.playAlbum`:

```tsx
    queueHook.playTracks, handlePlayEntityAll, playActions.playAlbum, contextMenuActions.handleEnqueue,
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/contexts/DetailViewContext.tsx src/App.tsx
git commit -m "feat(detail): expose enqueueTracks on DetailViewActions"
```

---

## Task 2: Add `buildHeroOverflowItems()` helper (TDD)

**Files:**
- Create: `src/utils/heroOverflow.ts`
- Test: `src/__tests__/heroOverflow.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/heroOverflow.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildHeroOverflowItems } from "../utils/heroOverflow";

const noop = () => {};

describe("buildHeroOverflowItems", () => {
  it("orders image actions then a divider then plugin items", () => {
    const items = buildHeroOverflowItems({
      entityKind: "album",
      imageActions: {
        onRefresh: noop,
        onSetFromFile: noop,
        onPasteFromClipboard: noop,
        onRemove: noop,
        onSearchImage: noop,
        webSearches: [{ id: "google", label: "Google", onClick: noop }],
      },
      pluginItems: [{ kind: "action", id: "scrobble", label: "Scrobble album", onClick: noop }],
    });

    const labels = items.map(i => i.kind === "divider" ? "---" : i.label);
    expect(labels).toEqual([
      "Retrieve image",
      "Set image…",
      "Paste image",
      "Remove image",
      "Search image",
      "Search Google",
      "---",
      "Scrobble album",
    ]);
  });

  it("omits image actions that are not provided", () => {
    const items = buildHeroOverflowItems({
      entityKind: "tag",
      imageActions: { onPasteFromClipboard: noop, onSetFromFile: noop },
      pluginItems: [],
    });

    expect(items.map(i => i.kind === "divider" ? "---" : i.label)).toEqual([
      "Set image…",
      "Paste image",
    ]);
  });

  it("renders YouTube section with Find/Set when no url is set (track)", () => {
    const items = buildHeroOverflowItems({
      entityKind: "track",
      imageActions: { onRefresh: noop },
      youtube: { url: null, onFind: noop, onSetUrl: noop },
      pluginItems: [],
    });

    expect(items.map(i => i.kind === "divider" ? "---" : i.label)).toEqual([
      "Retrieve image",
      "---",
      "Find in YouTube",
      "Set YouTube URL",
    ]);
  });

  it("renders YouTube section with Edit/Remove when url is set (track)", () => {
    const items = buildHeroOverflowItems({
      entityKind: "track",
      imageActions: { onRefresh: noop },
      youtube: { url: "https://youtu.be/x", onFind: noop, onSetUrl: noop, onClear: noop },
      pluginItems: [],
    });

    const labels = items.map(i => i.kind === "divider" ? "---" : i.label);
    expect(labels).toContain("Find in YouTube");
    expect(labels).toContain("Edit YouTube URL");
    expect(labels).toContain("Remove YouTube URL");
    expect(labels).not.toContain("Set YouTube URL");
  });

  it("invokes the action onClick when activated", () => {
    const onRefresh = vi.fn();
    const items = buildHeroOverflowItems({
      entityKind: "artist",
      imageActions: { onRefresh },
      pluginItems: [],
    });
    const refresh = items.find(i => i.kind === "action" && i.id === "image-refresh");
    expect(refresh?.kind).toBe("action");
    if (refresh && refresh.kind === "action") refresh.onClick();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("inserts a divider between sections only when both sides have items", () => {
    const noPluginNoYoutube = buildHeroOverflowItems({
      entityKind: "tag",
      imageActions: { onPasteFromClipboard: noop },
      pluginItems: [],
    });
    expect(noPluginNoYoutube.some(i => i.kind === "divider")).toBe(false);

    const noImageOnly = buildHeroOverflowItems({
      entityKind: "track",
      imageActions: {},
      youtube: { url: null, onFind: noop, onSetUrl: noop },
      pluginItems: [],
    });
    expect(noImageOnly.some(i => i.kind === "divider")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npm test -- heroOverflow`

Expected: FAIL — `Cannot find module '../utils/heroOverflow'`.

- [ ] **Step 3: Implement `heroOverflow.ts`**

Create `src/utils/heroOverflow.ts`:

```ts
export type HeroOverflowItem =
  | { kind: "action"; id: string; label: string; onClick: () => void; iconKey?: string; danger?: boolean }
  | { kind: "divider" };

export interface HeroWebSearch {
  id: string;
  label: string;        // displayed as "Search {label}" — caller passes provider name
  onClick: () => void;
}

export interface HeroImageActions {
  onRefresh?: () => void;            // "Retrieve image" — re-fetch via provider chain
  onSetFromFile?: () => void;        // "Set image…" — open file picker
  onPasteFromClipboard?: () => void; // "Paste image"
  onRemove?: () => void;             // "Remove image" — only when an image exists
  onSearchImage?: () => void;        // "Search image" — Google Images
  webSearches?: HeroWebSearch[];     // Per-provider web searches
}

export interface HeroYoutubeActions {
  url: string | null | undefined;
  onFind: () => void;
  onSetUrl: () => void;
  onClear?: () => void;              // only when url exists
}

export interface HeroOverflowArgs {
  entityKind: "track" | "album" | "artist" | "tag";
  imageActions: HeroImageActions;
  youtube?: HeroYoutubeActions;       // honored only when entityKind === "track"
  pluginItems: HeroOverflowItem[];
}

export function buildHeroOverflowItems(args: HeroOverflowArgs): HeroOverflowItem[] {
  const out: HeroOverflowItem[] = [];

  // Image actions (in display order)
  const ia = args.imageActions;
  if (ia.onRefresh)            out.push({ kind: "action", id: "image-refresh",       label: "Retrieve image", onClick: ia.onRefresh,            iconKey: "refresh" });
  if (ia.onSetFromFile)        out.push({ kind: "action", id: "image-set",           label: "Set image…", onClick: ia.onSetFromFile,        iconKey: "image" });
  if (ia.onPasteFromClipboard) out.push({ kind: "action", id: "image-paste",         label: "Paste image",    onClick: ia.onPasteFromClipboard, iconKey: "paste" });
  if (ia.onRemove)             out.push({ kind: "action", id: "image-remove",        label: "Remove image",   onClick: ia.onRemove,             iconKey: "remove", danger: true });
  if (ia.onSearchImage)        out.push({ kind: "action", id: "image-search",        label: "Search image",   onClick: ia.onSearchImage,        iconKey: "google" });
  for (const s of ia.webSearches ?? []) {
    out.push({ kind: "action", id: `web-search-${s.id}`, label: `Search ${s.label}`, onClick: s.onClick });
  }

  // YouTube (track only)
  if (args.entityKind === "track" && args.youtube) {
    const ytItems: HeroOverflowItem[] = [];
    ytItems.push({ kind: "action", id: "youtube-find", label: "Find in YouTube", onClick: args.youtube.onFind, iconKey: "youtube" });
    if (args.youtube.url) {
      ytItems.push({ kind: "action", id: "youtube-edit", label: "Edit YouTube URL", onClick: args.youtube.onSetUrl });
      if (args.youtube.onClear) {
        ytItems.push({ kind: "action", id: "youtube-clear", label: "Remove YouTube URL", onClick: args.youtube.onClear, danger: true });
      }
    } else {
      ytItems.push({ kind: "action", id: "youtube-set", label: "Set YouTube URL", onClick: args.youtube.onSetUrl });
    }
    if (out.length > 0 && ytItems.length > 0) out.push({ kind: "divider" });
    out.push(...ytItems);
  }

  // Plugin items
  if (args.pluginItems.length > 0) {
    if (out.length > 0) out.push({ kind: "divider" });
    out.push(...args.pluginItems);
  }

  return out;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm test -- heroOverflow`

Expected: PASS — all six test cases.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/heroOverflow.ts src/__tests__/heroOverflow.test.ts
git commit -m "feat(detail-hero): add buildHeroOverflowItems helper with tests"
```

---

## Task 3: Build `HeroOverflowMenu` dropdown

**Files:**
- Create: `src/components/HeroOverflowMenu.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/HeroOverflowMenu.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { HeroOverflowItem } from "../utils/heroOverflow";

interface Props {
  items: HeroOverflowItem[];
  triggerLabel?: string;
}

export function HeroOverflowMenu({ items, triggerLabel = "More options" }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="hero-overflow-wrapper" ref={wrapperRef}>
      <button
        className="ds-btn ds-btn--secondary hero-overflow-trigger"
        title={triggerLabel}
        aria-label={triggerLabel}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
      >
        &#x22EF;
      </button>
      {open && (
        <div className="hero-overflow-dropdown" role="menu">
          {items.map((item, i) => (
            item.kind === "divider"
              ? <div key={`d-${i}`} className="hero-overflow-divider" />
              : (
                <button
                  key={item.id}
                  className={`hero-overflow-item${item.danger ? " hero-overflow-item--danger" : ""}`}
                  role="menuitem"
                  onClick={() => { setOpen(false); item.onClick(); }}
                >
                  {item.label}
                </button>
              )
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/HeroOverflowMenu.tsx
git commit -m "feat(detail-hero): add HeroOverflowMenu dropdown"
```

---

## Task 4: Build `DetailHero` component + CSS

**Files:**
- Create: `src/components/DetailHero.tsx`
- Create: `src/components/DetailHero.css`

- [ ] **Step 1: Write `DetailHero.tsx`**

Create `src/components/DetailHero.tsx`:

```tsx
import type { ReactNode } from "react";
import { DetailHeroBackground } from "./DetailHeroBackground";
import { HeroOverflowMenu } from "./HeroOverflowMenu";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import type { HeroOverflowItem } from "../utils/heroOverflow";
import "./DetailHero.css";

export interface DetailHeroChip {
  label: string;
  onClick?: () => void;
}

interface DetailHeroProps {
  bgImages: string[];
  bgClassName?: string;

  art: ReactNode;
  artShape: "square" | "circle";

  eyebrow?: string;
  title: string;

  // Like/dislike: pass `liked` only when the entity supports it; pass undefined to hide.
  liked?: number;
  onToggleLike?: () => void;
  onToggleDislike?: () => void;
  likeDisabled?: boolean;
  entityLabel: "track" | "album" | "artist" | "tag";

  meta: Array<string | DetailHeroChip>;

  onPlay?: () => void;
  onEnqueue?: () => void;
  playDisabled?: boolean;
  enqueueDisabled?: boolean;

  overflowItems: HeroOverflowItem[];

  titleLine?: ReactNode;
}

export function DetailHero({
  bgImages, bgClassName,
  art, artShape,
  eyebrow, title,
  liked, onToggleLike, onToggleDislike, likeDisabled, entityLabel,
  meta,
  onPlay, onEnqueue, playDisabled, enqueueDisabled,
  overflowItems,
  titleLine,
}: DetailHeroProps) {
  const showLike = liked !== undefined && (onToggleLike || likeDisabled);

  return (
    <div className="detail-hero">
      <DetailHeroBackground images={bgImages} className={bgClassName ?? "detail-hero-bg"} />
      <div className="detail-hero-row">
        <div className={`detail-hero-art detail-hero-art--${artShape}`}>
          {art}
        </div>
        <div className="detail-hero-info">
          {eyebrow && <div className="detail-hero-eyebrow">{eyebrow}</div>}
          <h2 className="detail-hero-title">
            <span className="detail-hero-title-text">{title}</span>
            {showLike && (
              <LikeDislikeButtons
                liked={liked ?? 0}
                onToggleLike={onToggleLike ?? (() => {})}
                onToggleDislike={onToggleDislike ?? (() => {})}
                size={16}
                variant="glass"
                entityLabel={entityLabel}
                disabled={likeDisabled}
              />
            )}
          </h2>
          {meta.length > 0 && (
            <div className="detail-hero-meta-row">
              {meta.map((m, i) => {
                const chip = typeof m === "string" ? { label: m } : m;
                const className = `detail-hero-chip${chip.onClick ? " detail-hero-chip--clickable" : ""}`;
                return (
                  <span
                    key={`${chip.label}-${i}`}
                    className={className}
                    onClick={chip.onClick}
                  >
                    {chip.label}
                  </span>
                );
              })}
            </div>
          )}
          <div className="detail-hero-actions">
            <button
              className="ds-btn ds-btn--primary"
              onClick={onPlay}
              disabled={playDisabled || !onPlay}
            >
              <span aria-hidden>▶</span> Play
            </button>
            <button
              className="ds-btn ds-btn--secondary"
              onClick={onEnqueue}
              disabled={enqueueDisabled || !onEnqueue}
            >
              <span aria-hidden>≡+</span> Enqueue
            </button>
            <HeroOverflowMenu items={overflowItems} />
          </div>
          {titleLine && <div className="detail-hero-titleline">{titleLine}</div>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `DetailHero.css`**

Create `src/components/DetailHero.css`:

```css
.detail-hero {
  position: relative;
  min-height: 320px;
  padding: 28px 32px;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
}

.detail-hero::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(to right,
      rgba(var(--hero-scrim-rgb), var(--hero-scrim-strength)) 0%,
      rgba(var(--hero-scrim-rgb), calc(var(--hero-scrim-strength) * 0.45)) 60%,
      rgba(var(--hero-scrim-rgb), calc(var(--hero-scrim-strength) * 0.27)) 100%),
    linear-gradient(to bottom,
      transparent 0%,
      rgba(var(--bg-primary-rgb), 0.2) 70%,
      rgba(var(--bg-primary-rgb), 0.85) 100%);
  pointer-events: none;
  z-index: 0;
}

.detail-hero-bg { position: absolute; inset: 0; z-index: 0; }

.detail-hero-row {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-end;
  gap: 24px;
  width: 100%;
}

.detail-hero-art {
  width: 220px;
  height: 220px;
  flex-shrink: 0;
  background: var(--bg-surface);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-2xl);
  font-weight: 700;
  color: var(--text-secondary);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  position: relative;
  overflow: hidden;
}

.detail-hero-art--square { border-radius: 8px; }
.detail-hero-art--circle { border-radius: 50%; }

.detail-hero-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.detail-hero-info {
  flex: 1;
  min-width: 0;
  padding-bottom: 4px;
}

.detail-hero-eyebrow {
  font-size: var(--fs-2xs);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 600;
  color: var(--hero-text-secondary);
  text-shadow: var(--hero-text-shadow-sm);
  margin-bottom: 8px;
}

.detail-hero-title {
  font-size: var(--fs-2xl);
  font-weight: 800;
  color: var(--hero-text-primary);
  text-shadow: var(--hero-text-shadow);
  margin: 0 0 10px 0;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  line-height: 1.05;
}

.detail-hero-meta-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.detail-hero-chip {
  font-size: var(--fs-xs);
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(var(--overlay-base), 0.1);
  color: var(--hero-text-secondary);
  text-shadow: var(--hero-text-shadow-sm);
  white-space: nowrap;
}

.detail-hero-chip--clickable { cursor: pointer; }
.detail-hero-chip--clickable:hover {
  background: rgba(var(--overlay-base), 0.18);
  color: var(--hero-text-primary);
}

.detail-hero-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}

.detail-hero-actions .ds-btn[disabled] {
  opacity: 0.45;
  cursor: not-allowed;
}

.detail-hero-titleline {
  margin-top: 12px;
  font-size: var(--fs-xs);
  color: var(--hero-text-secondary);
  text-shadow: var(--hero-text-shadow-sm);
}

/* HeroOverflowMenu */
.hero-overflow-wrapper {
  position: relative;
  display: inline-flex;
}

.hero-overflow-trigger {
  width: 38px;
  padding: 0;
  justify-content: center;
}

.hero-overflow-dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  z-index: 100;
  min-width: 200px;
  padding: 4px 0;
}

.hero-overflow-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--text-primary);
  padding: 6px 12px;
  font-size: var(--fs-xs);
  cursor: pointer;
  white-space: nowrap;
}

.hero-overflow-item:hover { background: var(--bg-tertiary); }
.hero-overflow-item--danger { color: var(--error); }

.hero-overflow-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

/* Tighten the spacing between the hero and the section that follows. */
.detail-hero + .section-wide {
  margin-top: -28px;
  position: relative;
  z-index: 1;
}

.detail-hero + .section-wide .info-section-content {
  background: transparent;
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/DetailHero.tsx src/components/DetailHero.css
git commit -m "feat(detail-hero): add DetailHero presentation component"
```

---

## Task 5: Migrate `AlbumDetail`

**Files:**
- Modify: `src/components/AlbumDetail.tsx`

- [ ] **Step 1: Update imports**

In `src/components/AlbumDetail.tsx`:

- Remove imports of `ImageActions`, `LikeDislikeButtons`, `DetailHeroBackground`
- Add: `import { DetailHero } from "./DetailHero";`
- Add: `import { buildHeroOverflowItems, type HeroOverflowItem } from "../utils/heroOverflow";`
- Add: `import { invoke } from "@tauri-apps/api/core";` (already imported via `convertFileSrc` line; keep it). If `invoke` is not yet imported, change `import { convertFileSrc } from "@tauri-apps/api/core";` to `import { invoke, convertFileSrc } from "@tauri-apps/api/core";`
- Add: `import { open as openFileDialog } from "@tauri-apps/plugin-dialog";`
- Add: `import { openUrl } from "@tauri-apps/plugin-opener";`
- Add: `import { buildSearchUrl } from "../searchProviders";`

- [ ] **Step 2: Add image-action and overflow handlers above the `return`**

Just above `return (`, add:

```tsx
  const handleRefreshImage = useCallback(() => {
    actions.requestFetchImage("album", name, artistName);
  }, [actions.requestFetchImage, name, artistName]);

  const handleSetImageFromFile = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      await invoke("set_entity_image", { kind: "album", name, artistName: artistName ?? null, sourcePath: selected });
      actions.invalidateImage("album", name, artistName);
    } catch (e) { console.error("Failed to set album image:", e); }
  }, [actions.invalidateImage, name, artistName]);

  const handlePasteImage = useCallback(async () => {
    try {
      await invoke("paste_entity_image_from_clipboard", { kind: "album", name, artistName: artistName ?? null });
      actions.invalidateImage("album", name, artistName);
    } catch (e) { console.error("Failed to paste album image:", e); }
  }, [actions.invalidateImage, name, artistName]);

  const handleRemoveImage = useCallback(async () => {
    try {
      await invoke("remove_entity_image", { kind: "album", name, artistName: artistName ?? null });
      actions.invalidateImage("album", name, artistName);
    } catch (e) { console.error("Failed to remove album image:", e); }
  }, [actions.invalidateImage, name, artistName]);

  const handleSearchImageGoogle = useCallback(() => {
    const q = encodeURIComponent(displayArtist ? `${displayArtist} ${name}` : name);
    openUrl(`https://www.google.com/search?tbm=isch&q=${q}`).catch(e => console.error("Failed to open image search:", e));
  }, [displayArtist, name]);

  const overflowItems: HeroOverflowItem[] = buildHeroOverflowItems({
    entityKind: "album",
    imageActions: {
      onRefresh: handleRefreshImage,
      onSetFromFile: handleSetImageFromFile,
      onPasteFromClipboard: handlePasteImage,
      onRemove: albumImagePath ? handleRemoveImage : undefined,
      onSearchImage: handleSearchImageGoogle,
      webSearches: albumProviders
        .filter(p => p.albumUrl)
        .map(p => ({
          id: p.id,
          label: p.name,
          onClick: () => {
            const url = buildSearchUrl(p.albumUrl!, { artist: displayArtist ?? "", title: name });
            if (url) openUrl(url).catch(e => console.error("Failed to open search URL:", e));
          },
        })),
    },
    pluginItems: [],
  });

  const handleEnqueueAll = useCallback(() => {
    actions.enqueueTracks(sortedTracks.filter(t => t.liked !== -1));
  }, [actions.enqueueTracks, sortedTracks]);

  const eyebrow = album?.year ? `Album · ${album.year}` : "Album";
  const meta: Array<string | { label: string; onClick: () => void }> = [];
  if (displayArtist) meta.push({ label: displayArtist, onClick: () => actions.navigateToArtist(album?.artist_id ?? 0, displayArtist ?? undefined) });
  if (isLibrary && album?.track_count) meta.push(`${album.track_count} tracks`);
```

- [ ] **Step 3: Replace the hero JSX**

In the `return`, replace this whole block:

```tsx
      <div className="album-detail-top">
        <DetailHeroBackground images={heroImages} className="album-detail-bg" />
        <div className="album-detail-header">
          ...everything inside album-detail-header...
        </div>
      </div>
```

with:

```tsx
      <DetailHero
        bgImages={heroImages}
        bgClassName="detail-hero-bg"
        art={
          albumImagePath ? (
            <img src={convertFileSrc(albumImagePath)} alt={name} />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 48, height: 48, opacity: 0.5 }}>
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )
        }
        artShape="square"
        eyebrow={eyebrow}
        title={name}
        liked={isLibrary ? album?.liked ?? 0 : undefined}
        onToggleLike={isLibrary ? handleToggleAlbumLike : undefined}
        onToggleDislike={isLibrary ? handleToggleAlbumDislike : undefined}
        entityLabel="album"
        meta={meta}
        onPlay={sortedTracks.length > 0 ? handlePlayAll : undefined}
        onEnqueue={sortedTracks.length > 0 ? handleEnqueueAll : undefined}
        overflowItems={overflowItems}
        titleLine={<TitleLineInfo entity={infoEntity} invokeInfoFetch={actions.invokeInfoFetch} />}
      />
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Run dev and verify**

Run: `npm run tauri dev` (or refresh if already running). Visit an album detail page. Confirm:
- Hero renders with album cover, eyebrow `Album · YYYY` (or `Album` if no year), title with like/dislike, artist chip clickable, track count chip
- ▶ Play and ≡+ Enqueue work; Enqueue surfaces the duplicate banner if applicable
- ⋯ menu shows: Retrieve image, Set image…, Paste image, Remove image (when image exists), Search image, Search {provider} for each enabled provider
- TitleLineInfo content renders below the actions when available

- [ ] **Step 6: Commit**

```bash
git add src/components/AlbumDetail.tsx
git commit -m "refactor(album-detail): use DetailHero"
```

---

## Task 6: Migrate `ArtistDetailContent`

**Files:**
- Modify: `src/components/ArtistDetailContent.tsx`

- [ ] **Step 1: Update imports**

Remove `ImageActions`, `LikeDislikeButtons`, `DetailHeroBackground` imports. Add:

```tsx
import { invoke, convertFileSrc } from "@tauri-apps/api/core";   // replace existing convertFileSrc-only import
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { buildSearchUrl } from "../searchProviders";
import { DetailHero } from "./DetailHero";
import { buildHeroOverflowItems, type HeroOverflowItem } from "../utils/heroOverflow";
```

- [ ] **Step 2: Add image-action handlers and overflow assembly**

Above the `return`:

```tsx
  const handleRefreshImage = useCallback(() => {
    actions.requestFetchImage("artist", name);
  }, [actions.requestFetchImage, name]);

  const handleSetImageFromFile = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      await invoke("set_entity_image", { kind: "artist", name, artistName: null, sourcePath: selected });
      actions.invalidateImage("artist", name);
    } catch (e) { console.error("Failed to set artist image:", e); }
  }, [actions.invalidateImage, name]);

  const handlePasteImage = useCallback(async () => {
    try {
      await invoke("paste_entity_image_from_clipboard", { kind: "artist", name, artistName: null });
      actions.invalidateImage("artist", name);
    } catch (e) { console.error("Failed to paste artist image:", e); }
  }, [actions.invalidateImage, name]);

  const handleRemoveImage = useCallback(async () => {
    try {
      await invoke("remove_entity_image", { kind: "artist", name, artistName: null });
      actions.invalidateImage("artist", name);
    } catch (e) { console.error("Failed to remove artist image:", e); }
  }, [actions.invalidateImage, name]);

  const handleSearchImageGoogle = useCallback(() => {
    openUrl(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(name)}`)
      .catch(e => console.error("Failed to open image search:", e));
  }, [name]);

  const overflowItems: HeroOverflowItem[] = buildHeroOverflowItems({
    entityKind: "artist",
    imageActions: {
      onRefresh: handleRefreshImage,
      onSetFromFile: handleSetImageFromFile,
      onPasteFromClipboard: handlePasteImage,
      onRemove: artistImagePath ? handleRemoveImage : undefined,
      onSearchImage: handleSearchImageGoogle,
      webSearches: actions.searchProviders
        .filter(p => p.artistUrl)
        .map(p => ({
          id: p.id,
          label: p.name,
          onClick: () => {
            const url = buildSearchUrl(p.artistUrl!, { artist: name });
            if (url) openUrl(url).catch(e => console.error("Failed to open search URL:", e));
          },
        })),
    },
    pluginItems: [],
  });

  const handleEnqueueAll = useCallback(() => {
    actions.enqueueTracks(sortedTracks.filter(t => t.liked !== -1));
  }, [actions.enqueueTracks, sortedTracks]);

  const meta: Array<string | { label: string; onClick: () => void }> = [];
  if (isLibrary && artist?.track_count) meta.push(`${artist.track_count} tracks`);
  if (albums.length > 0) meta.push(`${albums.length} albums`);
```

- [ ] **Step 3: Replace the hero JSX**

Replace the block from `<div className="artist-detail-top">` through the matching closing `</div>` of `artist-header`:

```tsx
      <DetailHero
        bgImages={heroImages}
        bgClassName="detail-hero-bg"
        art={
          artistImagePath
            ? <img src={convertFileSrc(artistImagePath)} alt={name} />
            : <span style={{ fontSize: "var(--fs-xl)", fontWeight: 700, color: "var(--accent)" }}>{getInitials(name)}</span>
        }
        artShape="circle"
        eyebrow="Artist"
        title={name}
        liked={isLibrary ? artist?.liked ?? 0 : undefined}
        onToggleLike={isLibrary ? handleToggleArtistLike : undefined}
        onToggleDislike={isLibrary ? handleToggleArtistDislike : undefined}
        entityLabel="artist"
        meta={meta}
        onPlay={sortedTracks.length > 0 ? handlePlayAll : undefined}
        onEnqueue={sortedTracks.length > 0 ? handleEnqueueAll : undefined}
        overflowItems={overflowItems}
        titleLine={<TitleLineInfo entity={infoEntity} invokeInfoFetch={actions.invokeInfoFetch} />}
      />
```

- [ ] **Step 4: Type-check + verify**

Run: `npx tsc --noEmit`. Visit an artist detail page; confirm circular avatar, eyebrow `Artist`, action row, ⋯ menu items.

- [ ] **Step 5: Commit**

```bash
git add src/components/ArtistDetailContent.tsx
git commit -m "refactor(artist-detail): use DetailHero"
```

---

## Task 7: Migrate `TagDetail`

**Files:**
- Modify: `src/components/TagDetail.tsx`

- [ ] **Step 1: Update imports**

Remove `ImageActions`, `LikeDislikeButtons`, `DetailHeroBackground` imports. Add:

```tsx
import { invoke, convertFileSrc } from "@tauri-apps/api/core";   // replace convertFileSrc-only import
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { DetailHero } from "./DetailHero";
import { buildHeroOverflowItems, type HeroOverflowItem } from "../utils/heroOverflow";
import { TitleLineInfo } from "./TitleLineInfo";
```

- [ ] **Step 2: Add image-action handlers, enqueue, and play handlers**

Above the `return`:

```tsx
  const handleSetImageFromFile = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      await invoke("set_entity_image", { kind: "tag", name, artistName: null, sourcePath: selected });
      actions.invalidateImage("tag", name);
    } catch (e) { console.error("Failed to set tag image:", e); }
  }, [actions.invalidateImage, name]);

  const handlePasteImage = useCallback(async () => {
    try {
      await invoke("paste_entity_image_from_clipboard", { kind: "tag", name, artistName: null });
      actions.invalidateImage("tag", name);
    } catch (e) { console.error("Failed to paste tag image:", e); }
  }, [actions.invalidateImage, name]);

  const handleRemoveImage = useCallback(async () => {
    try {
      await invoke("remove_entity_image", { kind: "tag", name, artistName: null });
      actions.invalidateImage("tag", name);
    } catch (e) { console.error("Failed to remove tag image:", e); }
  }, [actions.invalidateImage, name]);

  const overflowItems: HeroOverflowItem[] = buildHeroOverflowItems({
    entityKind: "tag",
    imageActions: {
      onSetFromFile: handleSetImageFromFile,
      onPasteFromClipboard: handlePasteImage,
      onRemove: tagImagePath ? handleRemoveImage : undefined,
    },
    pluginItems: [],
  });

  const artistCount = new Set(sortedTracks.map(t => t.artist_name).filter(Boolean)).size;

  const handlePlayAll = useCallback(() => {
    actions.playEntityAll("tag", name, undefined, {
      tracks: sortedTracks.filter(t => t.liked !== -1),
      entityId: tag?.id,
    });
  }, [actions.playEntityAll, name, sortedTracks, tag]);

  const handleEnqueueAll = useCallback(() => {
    actions.enqueueTracks(sortedTracks.filter(t => t.liked !== -1));
  }, [actions.enqueueTracks, sortedTracks]);

  const meta: string[] = [];
  if (isLibrary && tag?.track_count) meta.push(`${tag.track_count} tracks`);
  if (artistCount > 0) meta.push(`${artistCount} artists`);
```

- [ ] **Step 3: Replace the hero JSX**

Replace the block from `<div className="album-detail-top">` through its matching closing tag (the inner `album-detail-header` and the outer wrapper) with:

```tsx
      <DetailHero
        bgImages={heroImages}
        bgClassName="detail-hero-bg"
        art={
          tagImagePath
            ? <img src={convertFileSrc(tagImagePath)} alt={name} />
            : <span style={{ fontSize: "var(--fs-2xl)", fontWeight: 700 }}>{name[0]?.toUpperCase() ?? "#"}</span>
        }
        artShape="square"
        eyebrow="Tag"
        title={name}
        liked={isLibrary ? tag?.liked ?? 0 : undefined}
        onToggleLike={isLibrary ? handleToggleTagLike : undefined}
        onToggleDislike={isLibrary ? handleToggleTagDislike : undefined}
        entityLabel="tag"
        meta={meta}
        onPlay={sortedTracks.length > 0 ? handlePlayAll : undefined}
        onEnqueue={sortedTracks.length > 0 ? handleEnqueueAll : undefined}
        overflowItems={overflowItems}
        titleLine={<TitleLineInfo entity={infoEntity} invokeInfoFetch={actions.invokeInfoFetch} />}
      />
```

- [ ] **Step 4: Type-check + verify**

Run: `npx tsc --noEmit`. Visit a tag detail page; confirm hero, action row, ⋯ menu items.

- [ ] **Step 5: Commit**

```bash
git add src/components/TagDetail.tsx
git commit -m "refactor(tag-detail): use DetailHero"
```

---

## Task 8: Migrate `TrackDetailView`

**Files:**
- Modify: `src/components/TrackDetailView.tsx`

- [ ] **Step 1: Update imports**

Remove `ImageActions` and `DetailHeroBackground` imports. Keep `LikeDislikeButtons` only if it's used elsewhere in the file — at the time of writing, the only `<LikeDislikeButtons>` usage is in the hero. Remove it. Add:

```tsx
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { buildSearchUrl } from "../searchProviders";
import { DetailHero } from "./DetailHero";
import { buildHeroOverflowItems, type HeroOverflowItem } from "../utils/heroOverflow";
```

`invoke`, `convertFileSrc`, `openUrl` are already imported — leave them as-is.

- [ ] **Step 2: Add image-action handlers, overflow assembly, eyebrow, meta, and titleLine**

Above the `return`, add the following block. It picks the active image kind (album takes precedence over artist) so image actions affect the artwork actually shown:

```tsx
  const heroImageKind: "album" | "artist" | null =
    isLibrary && albumImagePath && track.album_title ? "album"
    : isLibrary && track.artist_name ? "artist"
    : null;

  const heroImageEntityName =
    heroImageKind === "album" ? track.album_title!
    : heroImageKind === "artist" ? track.artist_name!
    : null;

  const heroImageArtistArg =
    heroImageKind === "album" ? (track.artist_name ?? undefined) : undefined;

  const handleRefreshImage = useCallback(() => {
    if (!heroImageKind || !heroImageEntityName) return;
    actions.requestFetchImage(heroImageKind, heroImageEntityName, heroImageArtistArg);
  }, [actions.requestFetchImage, heroImageKind, heroImageEntityName, heroImageArtistArg]);

  const handleSetImageFromFile = useCallback(async () => {
    if (!heroImageKind || !heroImageEntityName) return;
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      await invoke("set_entity_image", {
        kind: heroImageKind,
        name: heroImageEntityName,
        artistName: heroImageKind === "album" ? (track.artist_name ?? null) : null,
        sourcePath: selected,
      });
      actions.invalidateImage(heroImageKind, heroImageEntityName, heroImageArtistArg);
    } catch (e) { console.error("Failed to set track-related image:", e); }
  }, [actions.invalidateImage, heroImageKind, heroImageEntityName, heroImageArtistArg, track.artist_name]);

  const handlePasteImage = useCallback(async () => {
    if (!heroImageKind || !heroImageEntityName) return;
    try {
      await invoke("paste_entity_image_from_clipboard", {
        kind: heroImageKind,
        name: heroImageEntityName,
        artistName: heroImageKind === "album" ? (track.artist_name ?? null) : null,
      });
      actions.invalidateImage(heroImageKind, heroImageEntityName, heroImageArtistArg);
    } catch (e) { console.error("Failed to paste track-related image:", e); }
  }, [actions.invalidateImage, heroImageKind, heroImageEntityName, heroImageArtistArg, track.artist_name]);

  const handleRemoveImage = useCallback(async () => {
    if (!heroImageKind || !heroImageEntityName) return;
    try {
      await invoke("remove_entity_image", {
        kind: heroImageKind,
        name: heroImageEntityName,
        artistName: heroImageKind === "album" ? (track.artist_name ?? null) : null,
      });
      actions.invalidateImage(heroImageKind, heroImageEntityName, heroImageArtistArg);
    } catch (e) { console.error("Failed to remove track-related image:", e); }
  }, [actions.invalidateImage, heroImageKind, heroImageEntityName, heroImageArtistArg, track.artist_name]);

  const handleSearchImageGoogle = useCallback(() => {
    if (!heroImageKind || !heroImageEntityName) return;
    const q = heroImageKind === "album" && track.artist_name
      ? `${track.artist_name} ${heroImageEntityName}`
      : heroImageEntityName;
    openUrl(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`)
      .catch(e => console.error("Failed to open image search:", e));
  }, [heroImageKind, heroImageEntityName, track.artist_name]);

  const trackProviders = getProvidersForContext(actions.searchProviders, "track");

  const overflowItems: HeroOverflowItem[] = buildHeroOverflowItems({
    entityKind: "track",
    imageActions: heroImageKind ? {
      onRefresh: handleRefreshImage,
      onSetFromFile: handleSetImageFromFile,
      onPasteFromClipboard: handlePasteImage,
      onRemove: (heroImageKind === "album" ? !!albumImagePath : !!artistImagePath) ? handleRemoveImage : undefined,
      onSearchImage: handleSearchImageGoogle,
      webSearches: trackProviders
        .filter(p => p.trackUrl)
        .map(p => ({
          id: p.id,
          label: p.name,
          onClick: () => {
            const url = buildSearchUrl(p.trackUrl!, { artist: track.artist_name ?? "", title: track.title });
            if (url) openUrl(url).catch(e => console.error("Failed to open search URL:", e));
          },
        })),
    } : {},
    youtube: {
      url: track.youtube_url,
      onFind: () => onWatchOnYoutube?.(),
      onSetUrl: () => setYoutubeUrlEdit(track.youtube_url ?? ""),
      onClear: track.youtube_url && isLibrary ? async () => {
        try {
          await invoke("clear_track_youtube_url", { trackId });
          onUpdateTrack({ youtube_url: null });
        } catch (e) { console.error("Failed to clear YouTube URL:", e); }
      } : undefined,
    },
    pluginItems: [],
  });

  const eyebrow = track.album_title ? `Track · ${track.album_title}` : "Track";

  const heroMeta: Array<string | { label: string; onClick: () => void }> = [];
  if (track.artist_name) {
    heroMeta.push({ label: track.artist_name, onClick: () => actions.navigateToArtist(track.artist_id ?? 0, track.artist_name!) });
  }
  if (track.album_title) {
    heroMeta.push({ label: track.album_title, onClick: () => actions.navigateToAlbum(track.album_id ?? 0, track.artist_id, track.album_title!, track.artist_name ?? undefined) });
  }
  if (track.year) heroMeta.push(String(track.year));
  if (track.format) heroMeta.push(`${track.format.toUpperCase()}${audioProps?.bitrate ? ` · ${audioProps.bitrate} kbps` : ""}`);

  const titleLine = trackInfo && (trackInfo.listeners || trackInfo.playcount) ? (
    <span>
      {trackInfo.listeners && <>{parseInt(trackInfo.listeners).toLocaleString()} listeners</>}
      {trackInfo.playcount && (
        <>{trackInfo.listeners ? <> &middot; </> : null}{parseInt(trackInfo.playcount).toLocaleString()} scrobbles</>
      )}
      {trackInfo.url && (
        <> &middot; <a className="track-detail-lastfm-link" onClick={() => openUrl(trackInfo.url!)} title="View on Last.fm"><IconLastfm size={12} /></a></>
      )}
    </span>
  ) : undefined;

  const handleEnqueueTrack = useCallback(() => {
    actions.enqueueTracks([track]);
  }, [actions.enqueueTracks, track]);
```

- [ ] **Step 3: Replace the hero JSX**

Replace this entire block:

```tsx
      <div className="track-detail-top">
        <DetailHeroBackground images={heroImages} className="track-detail-bg" />
        <div className="track-detail-header">
          ...everything inside track-detail-header (art, info, meta, stats, youtube row)...
        </div>
      </div>
```

with:

```tsx
      <DetailHero
        bgImages={heroImages}
        bgClassName="detail-hero-bg"
        art={
          videoFrames.frames ? (
            <VideoFrameCard
              frames={videoFrames.frames}
              alt={track.title}
              className="track-detail-art-frames"
              timestamps={videoFrames.timestamps}
              onFrameClick={onPlayAt}
            />
          ) : (albumImagePath || artistImagePath) ? (
            <img src={convertFileSrc((albumImagePath ?? artistImagePath)!)} alt={track.album_title ?? track.artist_name ?? ""} />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 48, height: 48, opacity: 0.5 }}>
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )
        }
        artShape="square"
        eyebrow={eyebrow}
        title={track.title}
        liked={track.liked}
        onToggleLike={onToggleLike}
        onToggleDislike={onToggleDislike}
        likeDisabled={!isLibrary}
        entityLabel="track"
        meta={heroMeta}
        onPlay={onPlay}
        onEnqueue={isLibrary ? handleEnqueueTrack : undefined}
        overflowItems={overflowItems}
        titleLine={titleLine}
      />
```

The YouTube URL editor modal (`youtubeUrlEdit !== null` block) further down in the file stays unchanged — it's now opened via the ⋯ menu.

- [ ] **Step 4: Type-check + verify**

Run: `npx tsc --noEmit`.

Verify in dev:
- Track detail renders new hero with eyebrow `Track · {album}`, title, like/dislike, artist+album+year+format chips, ▶ Play / ≡+ Enqueue / ⋯
- For library tracks ⋯ shows: Retrieve image, Set image…, Paste image, Remove image (when image exists), Search image, Search {provider} per provider, divider, Find in YouTube, plus Edit/Remove (or Set) YouTube URL based on `track.youtube_url`
- For non-library tracks ⋯ shows the YouTube section only (no image actions; Enqueue button is disabled — `onEnqueue` is undefined)
- Video tracks render `<VideoFrameCard>` in the art slot — frame click still seeks via `onPlayAt`
- TitleLine shows listeners/scrobbles + Last.fm link when available
- The standalone YouTube URL editor modal still opens via Set/Edit menu items and saves correctly

- [ ] **Step 5: Commit**

```bash
git add src/components/TrackDetailView.tsx
git commit -m "refactor(track-detail): use DetailHero"
```

---

## Task 9: Remove legacy hero CSS

**Files:**
- Modify: `src/App.css`
- Modify: `src/components/TrackDetailView.css`

- [ ] **Step 1: Verify no other consumers of legacy classes**

Run:

```bash
grep -rnE "artist-detail-top|artist-detail-bg|artist-header|artist-avatar|artist-header-info|artist-meta\b|artist-bio-stats|album-detail-top|album-detail-bg|album-detail-header|album-detail-art|album-detail-info|album-detail-artist-name|track-detail-top|track-detail-bg|track-detail-header|track-detail-art\b|track-detail-art-img|track-detail-art-label|track-detail-art-placeholder|track-detail-info|track-detail-meta|track-detail-stats|track-detail-youtube|track-detail-link|track-detail-sep|detail-art-play" src/ tests/
```

Expected: matches only inside `src/App.css` and `src/components/TrackDetailView.css` (CSS files). If a `.tsx` or test still references one, fix it before deleting CSS. The class `track-detail-art-frames` is still used (it's the className passed to `<VideoFrameCard>`); keep that rule.

- [ ] **Step 2: Delete from `src/App.css`**

Open `src/App.css` and delete every rule whose primary selector starts with one of:

- `.artist-detail-top`, `.artist-detail-top::after`
- `.artist-detail-bg`
- `.artist-header` (the rule for `.artist-header { display: flex; … }`)
- `.artist-avatar`, `.artist-avatar > .artist-image-menu-wrapper`, `.artist-avatar > .artist-image-menu-wrapper .artist-image-menu-trigger`, `.artist-avatar:hover > …`, `.artist-avatar-img`
- `.artist-header-info h2`
- `.artist-meta` (small standalone rule — search the file for `.artist-meta {`)
- `.artist-bio-stats`
- `.album-detail-top`, `.album-detail-top::after`
- `.album-detail-bg`
- `.album-detail-header`
- `.album-detail-art`, `.album-detail-art > .artist-image-menu-wrapper`, `.album-detail-art > .artist-image-menu-wrapper .artist-image-menu-trigger`, `.album-detail-art:hover > …`, `.album-detail-art-img`, `.album-detail-art-placeholder`
- `.album-detail-info h2`
- `.album-detail-artist-name`, `.album-detail-artist-name:hover`
- `.detail-art-play` (search the file)

Then find this combined selector block (around lines 541–548):

```css
.artist-detail-top + .section-wide,
.album-detail-top + .section-wide {
  ...
}
.artist-detail-top + .section-wide .info-section-content,
.album-detail-top + .section-wide .info-section-content {
  ...
}
```

Delete both rules entirely. Their replacement (`.detail-hero + .section-wide`) lives in `DetailHero.css` (added in Task 4).

Do NOT touch:
- `.artist-detail`, `.album-detail` (the outer scrollable container — still used)
- `.artist-section`, `.section-title`, `.section-wide`
- `.artist-image-menu-wrapper`, `.artist-image-menu-trigger`, `.artist-image-menu-dropdown`, etc. (still used by the standalone `ImageActions` component if any other surface uses it; we keep the styles even if the four detail pages no longer render `ImageActions`)
- `.artist-play-btn` (used elsewhere, search before deciding)

- [ ] **Step 3: Delete from `src/components/TrackDetailView.css`**

Open `src/components/TrackDetailView.css`. Delete:

- `.track-detail-top`, `.track-detail-top::after`
- `.track-detail-bg`
- `.track-detail-header`
- `.track-detail-art`, `.track-detail-art > .artist-image-menu-wrapper`, `.track-detail-art > .artist-image-menu-wrapper .artist-image-menu-trigger`, `.track-detail-art:hover > …`
- `.track-detail-art-img`
- `.track-detail-art-label`, `.track-detail-art:hover .track-detail-art-label`
- `.track-detail-art-placeholder`
- `.track-detail-info`, `.track-detail-info h2`
- `.track-detail-meta`
- `.track-detail-link`, `.track-detail-link:hover`
- `.track-detail-sep`
- `.track-detail-stats`
- `.track-detail-top + .section-wide`, `.track-detail-top + .section-wide > .information-sections`, `.track-detail-top + .section-wide .info-section-content` (around lines 573–595)
- `.track-detail-youtube-row`, `.track-detail-youtube-btn`, `.track-detail-youtube-btn:hover`, `.track-detail-youtube-action`, `.track-detail-youtube-action:hover` (around lines 827–870)

Keep `.track-detail-art-frames`, `.track-detail-art-frames .video-frame-card-img` — still applied to the `<VideoFrameCard>` className.

Keep all other rules (`.track-detail-empty`, `.track-detail-stats-row`, `.track-detail-stats-cell`, etc., the modal styles, scrobble entries, details rows, tags, etc.).

- [ ] **Step 4: Type-check + visual verify**

Run: `npx tsc --noEmit`. Then `npm run tauri dev`. Visit each detail page (artist, album, tag, track) — confirm hero looks correct, sibling section spacing matches, no missing-style artifacts. Try one light skin and one dark skin.

- [ ] **Step 5: Commit**

```bash
git add src/App.css src/components/TrackDetailView.css
git commit -m "refactor(detail-hero): remove legacy hero CSS"
```

---

## Task 10: Final verification

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 2: Vitest**

Run: `npm test`

Expected: all green, including the new `heroOverflow.test.ts`.

- [ ] **Step 3: Manual UI verification (per `conventions.md` skin compatibility rule)**

In dev, with both a dark and a light skin applied, on each of the four detail pages confirm:

- Hero background slices visible, scrim readable
- Title + chips legible against the bg
- ▶ Play, ≡+ Enqueue, ⋯ all behave correctly; disabled states render with reduced opacity when `sortedTracks` is empty (or for non-library tracks: Enqueue disabled)
- Like / dislike click feedback works (and is disabled-but-visible for non-library track in TrackDetailView)
- ⋯ menu opens, dismisses on outside click and on Escape
- Image refresh / set / paste / remove from ⋯ all update the art (verify the loading + invalidation flow)
- For tracks: Find / Set / Edit / Remove YouTube URL items all open the editor modal or perform the action correctly
- TitleLine shows when plugin info is available, hidden when not

- [ ] **Step 4: Final commit (only if anything was tweaked)**

```bash
git status
# If clean, no further commit. Otherwise:
git add -A
git commit -m "fix(detail-hero): polish from verification pass"
```
