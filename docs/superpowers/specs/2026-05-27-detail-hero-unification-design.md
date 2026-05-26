# Unified Detail Hero — Design

## Problem

The four detail pages — Artist, Album, Track, Tag — drifted apart. They already share `DetailHeroBackground` and `useDetailHeroImages`, but each owns its own near-duplicate header JSX and CSS:

- `.artist-detail-top / .artist-header / .artist-avatar / .artist-header-info`
- `.album-detail-top / .album-detail-header / .album-detail-art / .album-detail-info` (also reused by `TagDetail`)
- `.track-detail-top / .track-detail-header / .track-detail-art / .track-detail-info / .track-detail-meta / .track-detail-stats / .track-detail-youtube-row`

Visual differences accumulated: the track hero stuffs an "Album" / "Artist" art label, an inline YouTube row, and a stats line into the info column. Like buttons live inline in `<h2>` everywhere, but the primary play action is hidden as a hover overlay on the art image. Image actions are reachable only by hovering the art. Every page has its own meta line (`.artist-meta`, `.album-detail-artist-name`, `.track-detail-meta`).

The goal: one hero component, one CSS class set, consistent action affordances, refreshed look — without touching the working background-image system.

## Goals

- One `<DetailHero>` component used by all four detail pages
- Always-visible primary actions: `▶ Play`, `≡+ Enqueue`, `⋯` overflow — matching the Home carousel button language exactly
- A single overflow point (`⋯`) for image actions, YouTube actions, search providers, and plugin context-menu items
- A consistent meta row (chip pills) and a deliberate slot for plugin-driven stats (`<TitleLineInfo>`)
- No regression in canonical actions (play / enqueue / like / image refresh / YouTube)
- No changes to the existing background-image system or to the InformationSections / below-hero sections

## Non-goals

- Restructuring the order of below-hero content (Albums / Tracks / InformationSections). The `conventions.md` rules stay.
- Replacing `DetailHeroBackground`, `useDetailHeroImages`, `LikeDislikeButtons`, `ImageActions` (the latter is no longer rendered on the art, but the component itself is preserved for any other consumer).
- Changes to TrackDetailView's filmstrip / video frame card. The art slot still receives `<VideoFrameCard>` when video frames exist.

## Architecture

### New component

`src/components/DetailHero.tsx` (with co-located `DetailHero.css`).

```tsx
interface DetailHeroProps {
  // Background — passes straight through to existing DetailHeroBackground
  bgImages: string[];

  // Art slot — caller supplies the rendered element so video frames, placeholders, etc. just work
  art: React.ReactNode;
  artShape: "square" | "circle";

  // Title row
  eyebrow?: string;             // e.g. "Album · 2019", "Track · Amnesiac", "Artist", "Tag"
  title: string;
  liked?: number;               // -1 / 0 / 1 — undefined hides the like control
  onToggleLike?: () => void;
  onToggleDislike?: () => void; // omit on entities that don't support dislike
  entityLabel: "track" | "album" | "artist" | "tag";

  // Meta chips — strings render plain, objects render as clickable pills
  meta: Array<string | { label: string; onClick: () => void }>;

  // Primary actions
  onPlay?: () => void;          // omit/disabled when there's nothing to play
  onEnqueue?: () => void;
  overflowItems: ContextMenuItem[];  // image actions, youtube, search, plugin actions

  // Plugin-driven stats line (TitleLineInfo); rendered only if it has content
  titleLine?: React.ReactNode;
}
```

The internal layout:

```
.detail-hero (relative, min-height: 320px, padding 28px 32px, align-items: flex-end)
  <DetailHeroBackground images={bgImages} className="detail-hero-bg" />   ← UNCHANGED
  ::after  scrim                                                          ← matches today's
  .detail-hero-row
    .detail-hero-art (220×220, square or circle, box-shadow elevation, click → overflow)
      {art}
    .detail-hero-info
      .detail-hero-eyebrow         (small caps, --fs-2xs)
      h2.detail-hero-title         (--fs-2xl, weight 800, with inline LikeDislikeButtons)
      .detail-hero-meta-row        (chip pills)
      .detail-hero-actions         (.ds-btn--primary, .ds-btn--secondary, ⋯ button)
      .detail-hero-titleline       (TitleLineInfo slot; hidden when empty)
```

### CSS strategy

A new `DetailHero.css` introduces the `.detail-hero-*` class set. It picks up the same hero design tokens already in App.css (`--hero-scrim-rgb`, `--hero-text-primary`, `--hero-text-shadow`, `--hero-text-secondary`, `--hero-text-shadow-sm`, `--bg-primary-rgb`, `--bg-surface`, `--accent`). It uses the existing design system tokens for radius / spacing.

The legacy classes get removed:
- `.artist-detail-top`, `.artist-detail-bg`, `.artist-header`, `.artist-avatar`, `.artist-avatar-img`, `.artist-header-info h2`, `.artist-meta` (kept only if used outside the hero — verify in implementation)
- `.album-detail-top`, `.album-detail-bg`, `.album-detail-header`, `.album-detail-art`, `.album-detail-art-img`, `.album-detail-art-placeholder`, `.album-detail-info h2`, `.album-detail-artist-name`
- `.track-detail-top`, `.track-detail-bg`, `.track-detail-header`, `.track-detail-art`, `.track-detail-art-img`, `.track-detail-art-label`, `.track-detail-art-placeholder`, `.track-detail-info`, `.track-detail-meta`, `.track-detail-stats`, `.track-detail-youtube-row`, `.track-detail-link`, `.track-detail-sep`
- `.detail-art-play` and the on-art `ImageActions` styling rooted under the above selectors (the on-art image-action menu is removed from the hero)
- `.artist-bio-stats` (replaced by `.detail-hero-titleline`; verify no other consumer)

The art-shape variants live as `.detail-hero-art--square` / `.detail-hero-art--circle`.

The selectors `.artist-detail-top + .section-wide` and `.album-detail-top + .section-wide` (App.css:541-548) become `.detail-hero + .section-wide`.

### Per-entity wiring

| Entity | Eyebrow | Art (shape, source) | Meta chips | TitleLine | Overflow items |
|---|---|---|---|---|---|
| Album | `Album · {year}` (omit `· {year}` if absent) | square, album cover (placeholder SVG when missing) | artist name (clickable), `{track_count} tracks`, total duration | `<TitleLineInfo entity={album}>` | image: Refresh / Replace / Search providers / Paste; plugin items for `album` |
| Artist | `Artist` | circle, artist image (initials fallback) | `{track_count} tracks`, `{album_count} albums`, monthly listeners (when supplied by plugin info — pass-through, not new fetch) | `<TitleLineInfo entity={artist}>` | image: Refresh / Replace / Search / Paste; plugin items for `artist` |
| Track | `Track · {album_title}` if album exists, else `Track` | square album art; falls back to artist image; `<VideoFrameCard>` if video frames cached | artist (clickable → artist page), album (clickable → album page), year, `{format} · {bitrate} kbps` | `<TitleLineInfo entity={track}>` (listeners / scrobbles / last.fm link) | image: actions for whichever image is shown (album or artist); YouTube: Find / Set URL / Edit / Remove; plugin items for `track` |
| Tag | `Tag` | square, tag composite image (first-letter fallback) | `{track_count} tracks` (artist count derived from `new Set(sortedTracks.map(t => t.artist_name)).size` if non-zero) | `<TitleLineInfo entity={tag}>` | image: Refresh / Replace / Paste; plugin items for `tag` |

### Helper

`buildHeroOverflowItems(args)` — pure function in `src/utils/heroOverflow.ts` (or co-located with `DetailHero.tsx`). Takes:

```ts
{
  entityKind: "track" | "album" | "artist" | "tag";
  imageActions: { onRefresh?: () => void; onReplace?: () => void; onPaste?: () => void; providers?: SearchProvider[] };
  youtube?: { url?: string | null; onFind: () => void; onSetUrl: () => void; onClear?: () => void };  // track only
  pluginItems: ContextMenuItem[];
}
```

Returns the assembled `ContextMenuItem[]` ordered: image actions → search provider submenu → (track only) YouTube section → divider → plugin items.

This is the only logic worth unit-testing on this change.

## Behavior

### Play

- Album / Artist / Tag: routes through `actions.playEntityAll(kind, name, artistName?, { tracks, entityId })` — same canonical call existing pages use today (e.g., `AlbumDetail.handlePlayAll`, `ArtistDetailContent.handlePlayAll`).
- Track: routes through the existing `onPlay` prop on `TrackDetailView`.
- `PlaylistContext` is set with `name` (album title / artist name / tag name) and the cover image path — same data each page already passes to `playEntityAll`. No change in queue-banner behavior.
- Disabled state: when `sortedTracks.length === 0`, the Play button renders disabled (`.ds-btn[disabled]`). Same condition that hides today's `.detail-art-play` button.

### Enqueue

- New affordance for album / artist / tag detail pages.
- Wraps `actions.enqueueTracks` with a `findDuplicates()` check, surfacing the existing duplicate banner exactly the way `useContextMenuActions` does today.
- Track variant enqueues the single track.
- Same disabled rule as Play.

### Overflow (`⋯`)

- The hero owns a small `HeroOverflowMenu` dropdown (anchored to the `⋯` button, dismiss on outside click + Escape) — patterned after the existing `ImageActions` dropdown but generic. There is no shared in-app `<ContextMenu>` component to reuse; the app's right-click menu is wired in `App.tsx` via `useContextMenuActions` and is not addressable from a child component.
- Items provided by `buildHeroOverflowItems`. The art element gets `cursor: pointer` and an `onClick` that opens the same menu — replacing today's hover-only image action menu on the art image.

### Context additions

`DetailViewActions` (in `src/contexts/DetailViewContext.tsx`) gains:

```ts
enqueueTracks: (tracks: Track[]) => void;   // wraps findDuplicates + enqueue + duplicate banner, same flow as useContextMenuActions.handleEnqueue
```

The provider in `App.tsx` populates it by delegating to the existing `handleEnqueue` helper that already lives in `useContextMenuActions`. No new logic — a thin wrapper.

### Like / Dislike

- Inline in the title via `<LikeDislikeButtons variant="glass">`. Wired to `useEntityDetail`'s `handleToggleLike` / `handleToggleDislike` (album/artist/tag) or to the props on `TrackDetailView` (track). No change in behavior; just relocated into the new component.

### Background

- Pass `heroImages` straight through to `DetailHeroBackground` and let `::after` paint the same scrim gradient currently on `.artist-detail-top::after` / `.album-detail-top::after`. Spec `12px` blur / `0.6s ease-out` opacity / 80% feather mask all stay inside `DetailHeroBackground.css` — untouched.

## Files affected

- **New**: `src/components/DetailHero.tsx`, `src/components/DetailHero.css`, `src/components/HeroOverflowMenu.tsx`, `src/utils/heroOverflow.ts`
- **New test**: `src/__tests__/heroOverflow.test.ts`
- **Modified**:
  - `src/contexts/DetailViewContext.tsx` — add `enqueueTracks` to `DetailViewActions`
  - `src/App.tsx` — wire `enqueueTracks` into the `DetailViewActions` payload (delegates to the existing `handleEnqueue` already present)
  - `src/components/AlbumDetail.tsx` — replace hero JSX with `<DetailHero>`
  - `src/components/ArtistDetailContent.tsx` — same
  - `src/components/TagDetail.tsx` — same
  - `src/components/TrackDetailView.tsx` — same; `track-detail-art-label`, `track-detail-stats`, `track-detail-youtube-row` replaced by chips + TitleLine + overflow items
  - `src/App.css` — delete legacy hero classes (artist / album / track variants)
- **Untouched**:
  - `src/components/DetailHeroBackground.tsx` / `DetailHeroBackground.css`
  - `src/hooks/useDetailHeroImages.ts`
  - `src/components/InformationSections.tsx` and below-hero sections
  - `src/components/TitleLineInfo.tsx`
  - `src/components/LikeDislikeButtons.tsx`
  - `src/components/ImageActions.tsx` (component remains, just no longer rendered on the art)

## Skin compatibility

- All colors via existing tokens: `var(--bg-surface)`, `var(--accent)`, `var(--text-*)`, `var(--hero-text-primary)`, `var(--hero-text-secondary)`, `var(--hero-text-shadow)`, `var(--hero-text-shadow-sm)`, `var(--hero-scrim-rgb)`, `var(--bg-primary-rgb)`.
- Buttons use `.ds-btn .ds-btn--primary` / `.ds-btn--secondary` so they inherit any skin overrides automatically.
- Chips use `rgba(var(--overlay-base), 0.1)` for the bg — same opaqueness pattern other glass UI uses, switches between light and dark skins.

## Testing

- **Unit (TS)** — `heroOverflow.test.ts`: covers (a) album/artist/tag overflow contains image actions + plugin items; (b) track overflow includes YouTube section with the right entries based on whether `youtube_url` is present; (c) plugin items are appended after the divider.
- **Manual** — verify per `conventions.md` "Detail Page Consistency" rule: each of the 4 detail pages renders the new hero, plays/enqueues, opens overflow, like/dislike toggles work, ImageActions handlers fire from the menu, YouTube modal still works, video frames render in the art slot, light + dark skin both look right.
- **No new E2E**. Existing `smoke.test.js` already exercises detail navigation.

## Migration notes

- Old persisted store keys (`artistDetailHeaderTabOrder`, `artistDetailBelowTabOrder`, `albumDetailBelowTabOrder`, `tagDetailBelowTabOrder`, `trackDetailTabOrder`) belong to InformationSections, not the hero — they are unaffected.
- Removing the legacy CSS classes is safe: a final grep for each class name across `src/` confirms no consumer remains. The only known cross-cutting selectors are `.artist-detail-top + .section-wide` / `.album-detail-top + .section-wide` (App.css:541-548) which get rewritten to `.detail-hero + .section-wide`.
- `ImageActions` keeps its public interface; the `DetailHero` overflow assembles items by calling the same handlers that `ImageActions` exposes today (`onRefresh`, `onImageChanged`, `providers`).
