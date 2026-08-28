---
paths:
  - "src/components/**"
  - "src/**/*.css"
  - "src/skins/**"
  - "src/types/skin.ts"
  - "src/skinUtils.ts"
---

# UI

## Entity System

The app has 5 core entity types that appear across many surfaces. Every entity type uses shared rendering, shared CSS classes, and shared context menus — regardless of where it appears.

### Entity Types

| Entity | Key Fields | Where it appears |
|--------|-----------|-----------------|
| **Track** | id, path, title, artist_name, album_title, duration_secs, liked (-1/0/1), format, collection_id | Library (tracks tab), Album detail, Tag detail, Artist detail, Queue, plugin views, similar tracks, central search results |
| **Artist** | id, name, track_count, liked | Library (artists tab), central search results, similar artists, plugin views |
| **Album** | id, title, artist_name, year, track_count, liked | Library (albums tab), artist detail, central search results, plugin views |
| **Playlist** | id, name, track_count | Playlists view, plugin views |
| **Tag** | id, name, track_count, liked | Library (tags tab) |

Track paths use URL schemes: `file://` (local), `subsonic://`, and plugin-registered schemes.

### Three Rendering Modes

Every entity list supports three view modes using shared CSS classes. The styling must be consistent across all surfaces — a track in the Library must look identical to a track in a playlist or a plugin view.

| Mode | CSS Class | Layout | Context Menu |
|------|-----------|--------|--------------|
| **Table** | `.entity-table` | Grid columns, sortable headers | Right-click on row |
| **List** | `.entity-list` | Rows with thumbnails, two-line layout (title + subtitle) | Right-click on row |
| **Tiles** | `.entity-grid` | Card grid (`repeat(auto-fill, minmax(160px, 1fr))`) | Via `...` button overlay on card (see Tile Card Structure below) |

### Context Menu Consistency

The app must detect what kind of entity it is rendering and show the appropriate context menu with all applicable actions — including plugin-registered actions.

**Core principle:** An entity's context menu is the same regardless of where it appears. A track in the library, in a playlist, or in a plugin view all get the same base actions plus all registered plugin actions.

**How it works:**
1. Each surface renders entities using the shared CSS classes and wires up `onContextMenu` handlers
2. The handler builds a `PluginContextMenuTarget` with available data (id, title, artist, etc.)
3. `ContextMenu.tsx` renders base actions for the entity kind plus all `pluginMenuItems` registered via `contributes.contextMenuItems` in plugin manifests
4. For entities without a library ID (e.g., external search results), the target still carries title/artist so plugins can act on metadata alone

**Registering new actions:** Both internal features and plugins register context menu items via `contributes.contextMenuItems` in their manifest with `targets: ["track", "album", "artist", "multi-track", "playlist"]`. New actions automatically appear in all context menus for that entity type across every surface — unless the user turned that individual item off in Extensions → plugin detail → Contributions, which `usePlugins` applies to `plugins.menuItems` before any surface sees it (see `plugins.md` "Per-Contribution Visibility").

**When adding a new surface that shows entities:** Use the shared CSS classes, wire up context menus with `pluginMenuItems` and `onPluginAction`, and ensure all three view modes work. Do not create one-off styling — reuse the existing `.entity-table`, `.entity-list`, and `.entity-grid` patterns.

### Tile Card Structure

Every tile card follows a common pattern with three interactive zones:

1. **Image area** — fills the top of the card. Contains:
   - **Play button** — centered overlay, appears on hover (dark semi-transparent backdrop, white play icon). Clicking plays the entity's tracks immediately (with `stopPropagation`).
   - **Like button(s)** — top-right corner overlay, appears on hover. Tracks have both like (heart) and dislike (X) buttons; other entities have just the heart.
2. **Body area** — below the image. Contains title, optional subtitle, and a `...` menu button (right-aligned, appears on hover). Clicking the `...` opens the context menu (with `stopPropagation`).
3. **Click on card** (outside play/like/menu buttons) — navigates to the entity's detail view.

**Per-entity differences:**

| Entity | Card Class | Image Shape | Subtitle | Like Buttons |
|--------|-----------|-------------|----------|-------------|
| Album | `.album-card` | Square | artist - year | Heart |
| Artist | `.artist-card` | Circular (border-radius: 50%), 12px margin | None (name only, centered) | Heart |
| Tag | `.tag-card` | Square with 8px border-radius, 8px margin | Track count, centered | Heart |
| Track | `.album-card` | Square (album art) | artist - duration | Heart + Dislike |
| Playlist | `.playlist-card` | Square (wider grid: 180px min) | track count - saved date | None |

**Shared styling patterns:**
- Cards use `var(--bg-secondary)` background, `var(--bg-hover)` on hover, 8px border-radius
- Overlay buttons use `opacity: 0` by default, `opacity: 1` on card hover, with 0.15s transitions
- Like buttons: 24px circular, `rgba(var(--overlay-inverse), 0.5)` background, red on hover/active
- Play button: `.ds-card-play` — a 52px circular `var(--accent)` FAB pinned bottom-right of the image, glyph in `var(--accent-text)` via `currentColor`. (It is not a centered dark-backdrop overlay; that was an earlier design.)
- **No hardcoded colors anywhere in these overlays.** Chrome on a skin surface uses `rgba(var(--overlay-base|--overlay-inverse), α)`; anything painted **on artwork** uses `--scrim-rgb` / `--on-image-rgb` / `--hero-text-*` instead, because the `--overlay-*` pair *flips* under `[data-skin-type="light"]` and would turn a dark scrim white beneath always-light text. See `base.css` for the full rule.
- Title uses `--fs-sm` weight 600, subtitle uses `--fs-xs` `var(--text-secondary)`, both with ellipsis overflow

## Layout

The app uses CSS Grid (`.app` in App.css):
```
grid-template-columns: 220px 1fr [queue-width]
grid-template-rows:    auto  1fr  auto

┌─────────────────────────────────────────────┐
│ Caption Bar (row 1, all columns)            │
├──────────┬──────────────────────┬───────────┤
│ Sidebar  │ Main Content         │ Queue     │
│ (col 1)  │ (col 2)              │ (col 3)  │
│ 220px    │ 1fr                  │ 300px    │
│ or 56px  │                      │ or 40px  │
├──────────┴──────────────────────┴───────────┤
│ Now Playing Bar (row 3, all columns)        │
└─────────────────────────────────────────────┘
```

Dynamic states: `.sidebar-collapsed` (56px), `.queue-open` (adds col 3), `.queue-collapsed` (40px strip).

## Caption Bar

**Component:** `CaptionBar.tsx` (full width, `-webkit-app-region: drag`)

Contents left-to-right:
- Window controls (macOS left)
- Brand logo ("iboPLR" with gradient)
- `CentralSearchDropdown` (global search with results preview — library rows, then an on-demand "Search “x” on <plugin>" section per plugin catalog the user hasn't hidden in Extensions → Contributions; see `plugins.md` "Global Search")
- Spacer (draggable)
- Help button (keyboard shortcuts)
- Mini player button
- Window controls (Windows/Linux right)

## Sidebar

**Component:** `Sidebar.tsx` (column 1, all rows)

Navigation items (top to bottom):
- **Home** (Cmd+0) — curated landing surface (`HomeView`), default startup view
- Library (Cmd+1) — unified search/browse view rendered by `SearchView` with tabs for Tracks, Artists, Albums, Tags
- History (Cmd+2)
- **Now Playing** (Cmd+3) — lean-back view of the current track (`NowPlayingView`). Its sidebar icon reflects playback state: a spinning disc (`SpinningDisc`) for audio, a `FilmStrip` for video, both frozen when paused.
- Playlists
- Plugin sidebar items (below separator)
- Bottom: Collections (with sync-error badge — an `error` dot when an **enabled** collection has a `last_sync_error`; `collectionAlertLabel` prop, derived by the pure `collectionAlert()` in `utils/collectionAlert.ts`, which also supplies the `title`/`aria-label` text. It exists because `last_sync_error` renders only inside CollectionsView, a destination nobody visits unprompted — so a server going down was discoverable only by playback failing, with the explanation one click away on a page the user had no reason to open. Disabled collections are skipped: they aren't syncing, so nothing the user does would clear the dot), Extensions (with update count badge), Settings (with update badge — one dot, `accent` when an update is ready and `error` when the last update attempt failed; `updateBadge` prop, derived by `updateBadgeFor` in `useAppUpdater`. Colour can't be the only signal, so the dot carries a `title`/`aria-label` naming its state.)

App startup always lands on Home. The previously-selected view is **not** persisted — `view` is neither read nor written from the app store, and selected entities (artist/album/tag) are not restored on startup either. Within a session, opening an entity navigates to its detail page as usual.

Active state: animated `.sidebar-indicator` follows active nav button via JS-computed transform.

## Main Content

**Container:** `.main` (column 2, rows 2-3)

Views are toggled via `library.view` (`View` union type). When an entity is selected, its detail view replaces the list. Views:

| View | List Component | Detail Component |
|------|---------------|-----------------|
| `home` | `HomeView` (default startup view; renders only when `view === "home"`) | — |
| `search` (Library) | `SearchView` (always mounted; tabs for Tracks/Artists/Albums/Tags, with empty query showing the full library) | — |
| `artists` | — (entered only via entity selection from Library) | `ArtistDetail` |
| `albums` | — (entered only via entity selection from Library) | `AlbumDetail` (hero + `TrackList`) |
| `tags` | — (entered only via entity selection from Library) | Tag header + `TrackList` |
| Track detail | — (entered only via track selection) | `TrackDetailView` |
| `nowplaying` | `NowPlayingView` (lean-back view of the current track) | — |
| `history` | `HistoryView` | — |
| `playlists` | `PlaylistsView` | Playlist detail |
| `collections` | `CollectionsView` | — |
| `extensions` | extensions panel | — |
| `settings` | settings panel | — |
| `plugin:*` | `PluginViewRenderer` | — |

### View Modes

See "Entity System > Three Rendering Modes" above. Toggled via `ViewModeToggle` in `Breadcrumb`. View mode persisted per entity type (`artistViewMode`, `albumViewMode`, etc.).

## Home View

**Components:** `HomeView.tsx` (composes the page + owns the inline shelf-visibility popover) + `HomeHero.tsx` + `HomeShelf.tsx`. State owned by `useHome.ts`.

**Purpose:** the default landing surface — a curated overview of the user's library and external sources.

**Layout:** radio-station hero carousel at the top, followed by a vertical stack of horizontal-scrolling shelves. Top-right page header has `[⟳ Refresh]` and `[⚙ Shelves]` ghost buttons.

**Radio-station hero:** auto-rotating carousel of up to 7 radio stations. `useHome` picks the seeds via `pick_radio_seeds` and resolves a cover for each (album image first, artist image fallback) into the `RadioStation` (`{ seed, coverUrl }`) shape. Same look as the rest of the hero (blurred backdrop, arrows + dots, auto-advance every 8s, pauses on hover). `Play` (or clicking the art) starts that station via `contextMenuActions.startRadio` (which calls `build_radio_for_track` and plays the result with a `Radio: <title>` / `source: "radio"` context). Radio is play-only — there is no Enqueue. The station seeds resolve independently of the shelves and are persisted in the home snapshot (`radioStations`).

**Built-in shelves** (in this order):

| Shelf id | Title | Item type | Source |
|---|---|---|---|
| `builtin:recently-played` | Recently played | track | `get_history_recent` |
| `builtin:most-played-30d` | Most played · 30 days | track | `get_history_most_played_since` (now − 30 days) |
| `builtin:most-played-artists-30d` | Most played artists · 30 days | artist | `get_history_most_played_artists_since`, resolved against library by name |
| `builtin:recently-added` | Recently added albums | album | `get_albums` with `sort: "added_desc"` |
| `builtin:recently-added-tracks` | Recently added tracks | track | `get_tracks` with `sortField: "added"`, `sortDir: "desc"` — track-based so videos (no `album_id`) and loose singles surface; off by default |
| `builtin:liked-albums` | Liked albums | album | `get_albums` filtered by `liked === 1` |
| `builtin:liked-artists` | Liked artists | artist | `get_artists` filtered by `liked === 1` |
| `builtin:jump-back-in` | Jump back in | mixed (album/artist) | reads `recentlyVisitedEntities` ring buffer (recorded by `recordVisit` from `src/utils/recentlyVisited.ts`) |

Plugin-contributed shelves are merged in alongside the built-ins. See `plugins.md` "Home Shelves" for the contribution surface.

**Refresh model:** `useHome` hydrates from a persisted snapshot on mount and only re-fetches automatically when that snapshot is older than 24 hours (or missing). The toolbar `[⟳ Refresh]` button forces an on-demand refresh regardless of age. Resolvers run in parallel via `Promise.all`. Plugin handlers have a 5-second timeout. Shelves that return `empty` / `error` / time out are filtered out for that cycle (so absence is not a hard error).

**Visibility popover:** `[⚙ Shelves]` opens a checklist of every registered shelf (built-in + plugin). Toggling persists to `homeShelfVisibility: Record<string, boolean>` in the app store. An **absent key means "no opinion yet"**, and `isShelfVisible()` then falls back to that shelf's `defaultVisible` in `BUILTIN_SHELF_DESCRIPTORS` (plugin shelves default to visible). Only some built-ins are visible by default — it is not "all visible".

**Profile-seeded shelves:** a usage profile can switch a shelf on via `ProfilePreset.profileShelves` (`onboardingSteps.ts`), applied by `HomeView` through the pure `seedProfileShelfVisibility(profile, visibility)`. Currently only **Video → `builtin:recently-added-tracks`**, which is the sole built-in that can surface videos at all: videos carry no `album_id`, so the default-visible "Recently added albums" can never show one. Two rules, both load-bearing:
- **Only fills keys that are unset.** The wizard is re-runnable from Settings, so a profile that re-asserted its shelves every run would silently undo a shelf the user had deliberately switched off.
- **Seeded from `HomeView`, not from the wizard's close handler.** `HomeView` owns `visibility` state and persists it; a store write from outside would be clobbered by that persist effect the next time the user toggled anything, since the effect writes this component's own (stale) state. Going through `setVisibility` keeps one owner and persists by the same path as a manual toggle. `seedProfileShelfVisibility` returns `null` when there is nothing to fill, and the effect returns the previous object so React bails out — so it can run on every profile change without churn.

**Empty state (`HomeEmptyState` in `HomeView.tsx`):** because every shelf that resolves `empty` is filtered out, a Home with no content would otherwise render as a blank page with only the two header buttons — and since Home is the startup view, that blank page is the first screen of every fresh install. When `ordered.length === 0` Home renders one of four panels instead, in priority order:

1. **Indexing** — a scan/sync is running (`resyncProgress`, passed down as `indexing`). Shows progress; the shelves are empty only because the library is still filling.
2. **Plugins-only** (`collectionCount === 0` **and** `pluginViews.length > 0`) — a streaming setup (e.g. yt-dlp + Spotify). Nothing is missing: a collection will never exist, so branch 3 would tell a correctly-configured user forever that their setup is unfinished and push them at a folder picker they chose not to use. Offers one button per plugin sidebar view (first is primary) and demotes *Add more sources* / *Add a local folder* to a ghost row.
3. **No music sources** (`collectionCount === 0`, no plugin views) — the true first-run. Offers *Add a music folder* / *Connect a server* / *Browse plugins*, plus re-running the setup wizard.
4. **Configured but bare** — sources exist and every shelf came back empty. Explains that content shelves are built from listening history, and offers Customize.

`pluginViews` is `App.tsx`'s `pluginViewList` — `plugins.sidebarItems` reshaped, deliberately **unfiltered**. There is no manifest signal for "this plugin is a music source": a browse-only plugin (Spotify) contributes no stream resolver, so capability can't stand in for intent, and a utility plugin with a view is listed too. Don't add a capability filter without a real declaration to filter on.

Gating: every branch waits on a local `settled` flag (a completed `useHome` load, or a short grace period after `hydrated` with nothing loading). `hydrated` is exposed by `useHome` for exactly this. The wait matters in both directions — the panel must not flash before the first fetch, and it must not wait for a fetch that a still-fresh snapshot skips. The `collectionCount === 0` branches are gated too: `collectionCount` is 0 until the collections fetch resolves, so an ungated check would flash "Let's find your music" at every cold start for users who do have music.

**Card kinds:** four `displayKind` values, all rendered by `HomeShelf.tsx`. The renderer uses a single `resolveImagePath` helper that handles http/data URIs directly and runs local paths through `convertFileSrc` (preserving any `#v=...` cache-busting fragment so plugin-cached covers refresh when content changes):

| displayKind | Click action |
|---|---|
| `album-cards` | with `libraryId` → navigate to album detail; without → `playTracks(items.tracks, 0, { name })` |
| `artist-cards` | with `libraryId` → navigate to artist detail; without → no-op |
| `playlist-cards` | `playTracks(items.tracks, 0, { name, coverUrl, source: "playlist" })` |
| `track-rows` | `playTracks([track], 0)` (no playlist context) |

Both the card body-click and its play button route through the one handler (`App.tsx` `handleHomeShelfItemPlay`) via the pure `resolveShelfPlayAction`, so radio seeds and lazy plugin cards behave the same either way.

**Lazy plugin cards:** a plugin card can arrive without its full track list (see `plugins.md` "Home Shelves"). Two shapes:
- **Empty `tracks`** — the host awaits the shelf's `onResolvePlay` behind the blocking `PluginLoadingModal`, then plays. Nothing can start yet, so the modal is the honest UI.
- **`partial: true` with a head** — the host plays the shipped head **immediately** and appends the resolved remainder behind the music (`playWithBackfill`, see conventions.md). No modal; instead the queue panel renders a trailing **"Filling in the rest…"** row (the `backfillPending` flag off `useQueue`) for as long as the tail is outstanding, so a one-track queue never looks finished when it isn't. A failed tail leaves the head playing plus a toast.

Radio stations play straight away too: `startRadio` resolves the banner cover *after* playback starts and patches it into `playlistContext` (guarded on the context still being that station), rather than holding the first note behind two `get_entity_image` round-trips.

Track-row cards have an additional async image fallback: `track.image_url` → album image (by name) → artist image (by name) → first-letter placeholder, all via the same `useImageCache` chain used elsewhere.

## Queue Panel

**Component:** `QueuePanel.tsx` (column 3, all rows)

Two states:
- **Expanded:** Header (title + a single `⋯` overflow native menu: load / save ▸ / share ▸ / prefer video / clear) + scrollable queue list + info bar (count + duration)
- **Collapsed:** 40px strip showing count & duration, click to expand

Queue items show: thumbnail, a like/dislike indicator before the title (driven by `QueueTrack.liked`, using `var(--error)` to match the other like buttons), title + duration, artist + album, and an inline play/locate icon. The hover-action tray's primary button is a **Play** button on non-current rows, but a **play/pause toggle** on the currently-playing row (wired to `onTogglePlayPause` → `playback.handlePause`), so the current track can be paused/resumed directly from the queue.

Features: drag-and-drop reorder, multi-select (Shift/Cmd+Click), right-click context menu, duplicate detection on enqueue, resizable width via drag handle.

### Playlist Context

When tracks are played from a specific source (album, artist, tag, playlist, plugin view, etc.), a `PlaylistContext` is attached to the queue. This gives the queue panel awareness of *what* the user is playing.

```typescript
interface PlaylistContext {
  name: string;              // e.g., album title, artist name, playlist name
  coverPath?: string | null; // local image path (for library entities)
  coverUrl?: string | null;  // remote image URL (for plugins)
}
```

**How it works:**
- `playTracks(tracks, startIndex, context?)` accepts an optional `PlaylistContext` as the third argument
- When context is set, the queue panel shows a **context banner** at the top: cover image + name + track count + duration
- When context is null, the queue panel shows a plain info bar at the bottom instead
- Context is persisted to the app store as `playlistContext` and restored on startup

**Every play action must pass context when it knows the source.** Examples from the codebase:

| Source | Context passed |
|--------|---------------|
| Album "Play All" | `{ name: album.title, coverPath: albumImagePath }` |
| Artist "Play All" | `{ name: artist.name, coverPath: artistImagePath }` |
| Tag "Play All" | `{ name: tag.name, coverPath: tagImagePath }` |
| Saved playlist load | `{ name: result.playlist_name }` |
| Plugin `requestAction("play-tracks")` | `{ name: payload.playlistName, coverUrl: payload.coverUrl }` |
| Double-click single track | No context (null) |

**For plugins:** Use `api.ui.requestAction("play-tracks", { tracks, startIndex, playlistName, coverUrl })` to play tracks with context. The `playlistName` and `coverUrl` fields are extracted and passed as context automatically.

**Track image URLs:** Each track in the payload can carry an `image_url` field. When playing tracks from external sources (plugin views), include the image URL so the now playing bar and queue can display artwork without needing a library image lookup.

## Now Playing Bar

**Component:** `NowPlayingBar.tsx` (row 3, all columns)

**Full mode:**
- Seek bar (waveform visualization or segmented bar) with elapsed | total time. For a **network** source the bar also carries a buffered edge — blocks past the point the stream has downloaded are drawn fainter (`bufferedPct`, from `usePlayback.buffer`) — and a stall renders the shared `BufferingChip` centred over the seek track. Both seek surfaces that can be streamed take `bufferedPct`: `SegmentedSeekBar` (what a streamed *audio* track gets) and `FilmstripSeekBar` (what a streamed *video* gets — a plugin-supplied storyboard means a streamed source, so this is the case that needs it most; frames past the edge are marked with a **hatch**, deliberately not a second darkening step — see "Filmstrip seek bar" below). `WaveformSeekBar` deliberately does **not** — a waveform only exists for `file://` sources and a buffer only for network ones, so the two can never co-occur. Both are absent for local files by design: no engine reports a buffer for them, and `bufferedPct = null` renders exactly as it did before the feature existed.
- **The fullscreen bar runs the identical seek ladder** — storyboard filmstrip → waveform → segmented → nothing (unknown duration) — off the same `bufferedPct`, so a track never changes its seek surface just because the window went fullscreen. It also shows the same `BufferingChip` and the same hover bubble, **including the ± offset from the play position**. `FullscreenControls` used to fall to a flat accent fill (`.fs-seek-fill` / `.fs-seek-buffered`, now deleted) for anything without a storyboard or waveform, which meant streamed audio — the most common fullscreen-visualizer case — got a plain bar there and a segmented one in the window. The two differ **only** in layout: the fullscreen bar overlays its time labels inside the 28px track (edge-to-edge over video), the windowed bar flanks a 34px track with them. Don't reintroduce a fullscreen-only seek rendering — the ladder itself is one component (`SeekLadder`), as is the hover bubble (`SeekHoverBubble`).
- **What the two bars share, and why they are still two components.** The transport, the queue-mode group, the volume cluster, the equalizer cluster and the seek ladder/bubble all live in shared components (`TransportControls.tsx`, `SeekSurface.tsx`, `EqButton.tsx`) — the bars are *arrangements* of the same controls, not two implementations. They cannot be merged into one component for three reasons: (1) the fullscreen bar must be a **child of the element that got `requestFullscreen()`**, because the browser renders only that subtree — a grid-row bar is simply not on screen; (2) it owns an idle auto-hide (3s timer, cursor hiding, drag/EQ pinning, the `active` window-vs-DOM-fullscreen flag) that would be dead weight docked; (3) its colours target arbitrary video frames (`--overlay-base` + text-shadow on a scrim) where the docked bar uses skin tokens on a solid surface — same rule as `VideoSubtitles`. On top of that the docked bar carries the entire mini player, the source tooltip, tags, download, ICY title, rank badge and error states. Keep converging the *contents*; don't try to merge the shells.
- Track info: album art, like/dislike buttons, title + a **static Artist · Album** line (clickable artist/album links) preceded by the **`SourceIndicator`** (source icon + hover panel with decode facts and Open folder / Open on *X*). The fullscreen bar mounts the same component in the same slot — see `frontend.md`. The full bar does **not** show the cycling Now Playing info section — that lives only in the mini player (see below).
- Controls: previous, play/pause, next, stop
- Right: queue mode (normal/repeat-all/repeat-one), randomize, auto-continue, equalizer, volume, **fullscreen**
- **Fullscreen button** (`.now-group--view`, last on the right): enters fullscreen for whatever is playing, via App's single `toggleFullscreenForTrack` — the *same* callback Cmd/Ctrl+F uses, which dispatches by track kind (video → its own container/mpv path, audio → the `AudioFullscreen` overlay). The bar must not re-derive that rule. It sits in the far corner so it lands where `FullscreenControls`' Exit button is, giving one place to look in either bar. **Enter-only**, and deliberately: while fullscreen is up this bar is covered (both the overlay and the video container pin themselves over the grid), so the restore half of the toggle is the fullscreen bar's Exit button. Disabled, not hidden, when nothing is playing — hiding it would reflow the right end of the bar as the queue drains.

**Mini mode:** Compact bar with art, title + the dynamic **Now Playing info** line (see below), play controls, close/expand. Draggable window, scroll-to-volume.

**Filmstrip seek bar** (`FilmstripSeekBar.tsx` / `.css`) — the seek surface for a video with a storyboard, on both the now-playing bar (34px) and `FullscreenControls` (28px), **expanding to 75px on hover** (see below). The frames *are* the content, so four rules hold and each one replaced a bug:

- **Progress is not drawn by dimming the frames.** The played run fills the **bottom perforation rail** with the accent (`.filmstrip-rail-lit`, width from the clamped progress). Frames ahead take only a token `grayscale(0.12) brightness(0.92)`. The previous `brightness(0.5)` multiplied already-dim footage into mud — on a dark music video the whole unplayed run bottomed out at black and read as broken rather than as unplayed. Don't reintroduce a heavier ahead filter to make progress more visible; that is what the rail is for.
- **Unbuffered is a texture, not more darkness.** Frames past the buffered edge get a diagonal hatch (`.filmstrip-cell--unbuffered::after`) plus a mild `brightness(0.78)`, replacing a second multiply down to `0.25`. Stacking darkening steps made a stalled stream indistinguishable from a broken one. The `--unbuffered` rule must stay **after** `--ahead` in source order (equal specificity, and `filter` does not compose across rules).
- **Separation is a real gap.** Frames are laid out with a `GUTTER_PX` (3px) flex gap of `--video-bg` plus a 1px hairline, and `MIN_SLOT_PX` is **60** — the floor, not the 16:9 aspect, is what sizes a frame at both real bar heights. `planCells()` budgets the gutters out of the track width before distributing integer cell widths.
- **Chrome is drawn in `--overlay-base`, never `--overlay-inverse`.** That token is `0, 0, 0` on dark skins (`base.css`), so the old seam was a black hairline between dark frames and the rails were black-on-black — the strip only ever looked like film on a light skin. Rails now use **opposite** tokens: dark band (`--overlay-inverse`) with **bright** holes (`--overlay-base`), which is also how physical film reads. The lit rail's holes are `--accent-text`, because the band under them is the accent on every skin.

Two alternatives were mocked up and rejected: dimming the frames less but keeping dimming as the progress cue (still degrades the picture to signal position), and a scrim toward `--overlay-inverse` instead of a brightness multiply (fixes the murk but keeps progress fighting the content for the same pixels). If the accent rail ever proves too subtle at 34px, that scrim at a low alpha (~0.2) over the ahead run is the correction to reach for — not a heavier filter.

**Hover expansion (`--seek-h`).** At 34px a frame gets a 24px picture area and a 60px slot (`MIN_SLOT_PX`, which always binds at that height) — a face is about ten pixels tall. So the bar **expands to 75px while the pointer is over it**, where the aspect calculation asks for a 116px slot and `MIN_SLOT_PX` stops binding: roughly **four times the picture area**, exactly when you're scrubbing. Three rules:
- **It grows upward, out of flow.** `.now-seek-wrap` / `.fs-seek-wrap` keep the layout height and the bar inside is `position: absolute; bottom: 0` with `height: var(--seek-h)`. Growing it for real would mean changing `--now-playing-h`, a global the app grid, the queue drawer, the video dock and `useVideoLayout` all read — so the footer would reflow every time the queue crossed from an audio track to a video one, and reserving the height always would cost every audio track ~40px of chrome for a video-only feature.
- **Only for a filmstrip.** Gated on `has-filmstrip` (from the shared `hasFilmstrip()`, which `SeekLadder` branches on too, so a host can't expand a bar with no frames in it). A waveform or segmented bar gains nothing from height it doesn't use.
- **The scrub bubble anchors to `--seek-h`, not to `100%`.** The wrapper stays at its slot height while the bar grows past it, so a `100%`-anchored bubble would end up *inside* the expanded strip — precisely when it is being read.

The bubble is the other half of this: it renders a **240px** storyboard tile (`SEEK_THUMB_WIDTH`). Division of labour — the strip answers "where are the cuts", the bubble answers "what is at 2:41". At 176px the two were competing at the same job and neither won.

**Both surfaces degrade to the plain ladder when a video has no storyboard**, which now includes "the user switched generation off" — Settings → Playback → **"Video seek previews"** (`videoStoryboards`, default on) gates the local ffmpeg pass, so such a video gets the segmented bar and a text-only bubble. Cached and source-published sheets keep rendering, because neither costs anything to produce; a pass in flight is killed as soon as nobody is on that video. Do **not** gate the renderers on the setting — that would discard free previews. See `docs/seek-preview-spec.md` → "Switching it off, and stopping a pass".

**Now Playing info line** (the line under the title, **mini player only** — the full bar shows a static Artist · Album line instead): a dynamic, auto-cycling section. Modules and plugins register items (`api.nowPlayingInfo` — see `plugins.md`); built-ins are **Artist · Album**, **Artist**, **Album**, **Plays · Rank** (one item), **Source**, **Quality**, **Duration**, **Tags** (`#`-prefixed track tags), **Synced Lyrics** (the line currently being sung in quotes, tracks playback position; drops out of the cycle during intros/instrumental gaps when no line is actively sung), **Plain Lyrics** (one unsynced line in quotes, stable per track), plus the Last.fm plugin's **Scrobbles**. The lyrics items reuse the cached lyrics info-type and each shows only when that kind of lyrics exists for the track. Each item carries a per-type **style** (lyrics italic, play-stats accent, secondary metadata muted — all via skin tokens, never hardcoded colors), a **time-of-persistence** (ToP) multiplier, and a **priority** (its position in the cycle). ToP + priority + on/off are configured in **Settings → Playback tab → "Now playing info"** (`NowPlayingInfoSettings.tsx`): one row per registered item with a drag handle + rank and a **single** `<select>` that is both the on/off and the dwell control — `Off` / `Preview only` / `On request` / `1×` / `2×` / `5×` / `10×` (picking a dwell enables the item; there is no separate switch) — plus "Reset to defaults". It reuses the `.provider-v*` row markup/CSS and the shared `startRowDrag` from `utils/rowDrag.ts` — the same list pattern as Settings → Providers. The mini player's native context menu carries a single **"Now playing info…"** item that leaves mini mode, opens Settings and scrolls to that section (via SettingsPanel's one-shot `scrollToId`/`onScrolledToId` props); it no longer configures items inline. The cycle runs two phases per track: a **preview pass** (every enabled item shown once at the base ~5s interval, with a slide animation) then **steady rotation** of the `top > 0` items, each dwelling `5s × top`; `0×` items appear only in the preview. **Both phases follow the user's priority order** — ToP is dwell time only, never rank. **"On request"** items (`top === NOW_PLAYING_TOP_REQUEST`, −1) sit outside both phases: whenever their resolved content changes or (re)appears they **preempt** whatever is on the line for up to one base interval — less when a newer request arrives or the content vanishes — and the rotation keeps ticking underneath and shows through again when the request ends (pure `trackOnRequestItems` in `NowPlayingInfoCycler`, unit-tested). Built for time-critical content: on-request Synced Lyrics shows each line exactly as it's sung and the rotation plays through instrumental gaps. Deliberately not stretched by a marquee glide — a newer request may cut a scroll mid-glide. Rendered by `NowPlayingInfoCycler`; resolution/selection/ordering/styling live in `useNowPlayingInfo`; selection persists as `nowPlayingInfoSelection`, the ToP map as `nowPlayingInfoPersistence`, and the ordered item ids as `nowPlayingInfoOrder` (items missing from it — a newly installed plugin's, or a built-in added by an app update — keep their registration order at the end). Each item declares its own default-enabled state (`defaultEnabled`); **Artist · Album** (1×), **Synced Lyrics** (On request, italic), and **Scrobbles** (0×) are on by default — the rest (including **Tags** and **Plain Lyrics**) are opt-in.

## Now Playing View

**Component:** `NowPlayingView.tsx` (the `nowplaying` main-content view, reached via the sidebar or Cmd+3). A lean-back, full-column presentation of the current track. Distinct from the always-present Now Playing **Bar** in row 3.

**One surface, two chromes.** The same component renders the in-grid view *and* the audio fullscreen overlay (`variant="fullscreen"`, see "Fullscreen" below). Everything described in this section — backdrop, art regime, lyrics, the action row — is therefore true of both; only the sizing and the identity block differ. New behaviour added here lands in both places, which is the point.

**Audio tracks:** blurred album-art backdrop + foreground album art + centered lyrics. Image resolution uses the album→artist `useImageCache` chain (same as queue/bar), through the pure `resolveNowPlayingArt`. Art presence switches the whole surface regime — backdrop + always-light text, or the `--noart` skin gradient + skin text — so that switch waits for a **settled** lookup (`useImageCache.isResolved`); an unsettled one holds the art regime over `--np-backdrop-base` instead of flipping the regime twice per new album.

**View actions (top-right):** an **auto-hiding** row (`.np-actions`), in the same corner the video theater puts its own controls so the set doesn't jump when the queue turns up a video. It fades in on pointer movement over the surface and out after the shared idle wait (`useIdleVisibility`, 3s — the same beat as the fullscreen bar and the theater overlay), and hides at once when the pointer leaves the surface. At rest a lean-back view should be the artwork and the words, not three icons in a corner.
- Visibility lives on the **container** (`is-visible`), not per-button. `:hover` and `:focus-within` on the row are plain state rules that beat the hidden base, and they are what stop the timer fading a 30px button out from under the pointer reaching for it, or hiding one the keyboard just focused — no JS guard needed for either.
- This replaced a two-mechanism arrangement (buttons at 0.4, lifted to 0.85 by a `:where(.now-playing-view:hover)` *floor*) plus a **fullscreen override that dimmed them back down** — needed because fullscreen is the whole screen, so `:hover` on the view was permanently true and the row sat lit forever. One timer answers both surfaces; there is no longer a second tier to keep in step. Don't reintroduce a hover-floor here. The hover chip is `--np-btn-hover-bg`, which follows the regime (a fixed dark chip over scrimmed art, the skin's `--bg-hover` over the skin gradient) — the skin colour alone put a white glyph on a pale block in light skins. **Every action is a visible button — there is no ⋯ and no right-click menu.** Left to right:
- **Visualizer** (disc icon) — opens the picker, still a **native** menu (a list of choices is a menu, and JS dropdowns are banned app-wide) anchored under the button via `getBoundingClientRect()`. The button replaces a ⋯ that gave no hint what was behind it. Deliberately not an equalizer glyph — the now-playing bar already uses those for the actual EQ.
- **Lyrics** (subtitle icon, same glyph as the video theater's subtitle toggle) — shows/hides the lyrics column. Carries `aria-pressed`; `.is-off` when hidden. **Disabled, not hidden**, on a track with no lyrics, so the row doesn't reshuffle as the queue advances.
- **Fullscreen** — same icon as `VideoAmbientOverlay`'s, and last so it lands in the extreme corner like the theater's. Shown whenever something non-video is playing. A **toggle**: one `onToggleFullscreen` callback for both directions, so in fullscreen it stays in place and only the glyph turns around (arrows in, matching the control bar's own exit button).

The whole menu was collapsed into these buttons: **"Fullscreen visualizer" is gone from any menu** (the button is the only route), and with the picker and lyrics also promoted, `contextMenu/buildNowPlayingMenuSpecs.ts` had nothing left and was deleted along with its test. Do not reintroduce a ⋯ here — three visible buttons are the discoverable surface the menu was trying to be, so a second hidden route to the same three would be duplication.

In **fullscreen** the row is the same three buttons in the same order — the set doesn't change with the chrome, so nothing appears or vanishes as you enter. The pointer-in-view *floor* is overridden back to the resting dim, though: that floor assumes the pointer is often somewhere else in the app (sidebar, queue, now-playing bar), and when the view is the whole screen it is always inside, so the row would sit pinned at 0.85 — three lit buttons in the corner of a lean-back surface. Each button's own `:hover` still lights it, the floor being `:where()`-neutralised. Nothing was moved into `FullscreenControls` for any of this; the bar's idle timer already listens on the whole fullscreen container, so activity over the row keeps the bar alive and the two fades don't fight. This row owns a fullscreen toggle, but it is **not** the only one: the control bar keeps its own Exit button on the audio path too (see "Fullscreen" below for why — one corner to look in either bar). So there are **three** ways out: this button, the bar's Exit, and Escape.

**Type scales with the stage.** Lyrics (`--np-lyric-size`) and the identity block (`--np-title-size`, with `.np-subtitle` / `.np-tags` `calc()`-derived from it at 0.53 / 0.44) are `clamp()`ed against `vh + vw` instead of being fixed at a `--fs-*` token, so a 4K display gets lyrics you can read from a sofa rather than the same 19px it showed on a laptop. Three rules, all load-bearing:
- **The floor is the old fixed value.** `clamp(var(--fs-lg), …, var(--fs-2xl))` for lyrics, `clamp(var(--fs-2xl), …, 52px)` for the title. No window ever gets *smaller* type than before the feature; the clamp only buys growth. Growth starts around 1080p (lyrics 19→21, title 30→34) and tops out by 1440p–4K (30 / 52).
- **Both axes are in the preferred term.** Height decides how many lines are on screen, width how many characters fit before wrapping — a `vh`-only formula grows the type on a short wide window where there is no room for it.
- **The lyrics column grows with `max()`, not a bigger fixed cap.** `max-width: max(560px, 30vw)` (in-grid) / `max(720px, 34vw)` (fullscreen). A larger font in a hard-capped column is not "bigger lyrics", it is more wrapping; `max()` guarantees the column is never narrower than it is today, and the stage's own cap still bounds it. Line padding is `em` for the same reason — `7px` between 40px lines reads as cramped.

Fullscreen gets its own tier (`clamp(var(--fs-xl), 1.5vh + 0.7vw, 40px)`): a higher floor, because entering fullscreen is a deliberate act and should look different immediately, and a higher ceiling because none of the app furniture is on screen. The **title** has no fullscreen tier — this surface doesn't draw one there (`showIdentity`); the control bar's `.fs-title` carries it and scales itself via `--fsbar-title-size` on the same floor-at-the-old-value principle.

**Lyrics collapse:** hiding lyrics — because the track has none, or because the user turned the Lyrics button off (persisted as `nowPlayingLyricsHidden`) — drops the lyrics column and hands the whole stage to the art column, so a **visualizer grows to fill the view** instead of staying square in half of it. The static artwork grows too, but modestly (it's a fixed-resolution image). The column is unmounted rather than hidden so its position-driven auto-scroll stops. The flag is **shared with fullscreen**: one preference, so the two surfaces can never disagree about whether lyrics are on.

**Fullscreen:** `AudioFullscreen.tsx`, an opaque full-window overlay at the app root. Its surface is **this same view** at `variant="fullscreen"` — so fullscreen carries the blurred backdrop, the art regime, the corner buttons and, notably, the **lyrics**, which the old art-only fullscreen dropped (the more lean-back of the two surfaces was the one without karaoke). The stage is the `fullscreen` visualizer slot, which inherits the Now Playing pick (see `plugins.md` "Visualizers"), falling back to album art and then the initials placeholder — the view's own ladder, which is why fullscreen works for anything playing rather than only for users who installed a visualizer. Only sizing and the identity block differ from the in-grid view: with the app chrome and the title block gone, the `.now-playing-view--fs` tier gives the stage the height and width budget the in-grid tier reserves for furniture that isn't there, and the title comes from the control bar instead of being drawn twice. Window fullscreen, not DOM element fullscreen. Controls are the shared `FullscreenControls` on the usual idle fade; **Escape** or **Cmd/Ctrl+F** exits. Audio only — video has its own fullscreen path (it owns the shared `<video>` element and can't be re-parented).

**The bar drops one button here.** `onToggleFullscreen` and `onToggleQueue` are both **optional** on `FullscreenControls`; audio fullscreen passes the first and omits the second. **Exit stays** — the restore control belongs at the right end of the control bar in *every* fullscreen, so it is where the windowed bar's fullscreen button just was. It does duplicate the surface's corner row, and that is accepted: the corner row fades with the artwork and reads as part of the presentation, while the bar is the transport. **Playlist is still dropped** — the queue reveals itself at the right edge here, so the button would be a second route to a gesture that already exists. Video fullscreen passes both (no corner row, no edge gesture).

**Queue drawer (edge-revealed).** The root `.app` gains `audio-fs-open`, and `QueuePanel.css` turns the panel from a grid column into a fixed drawer: parked at `translateX(100%)`, `z-index: 1000` (above the overlay's 999, below the auto-continue popover at 1100 and modals at 2000), spanning `top: 52px` to `bottom: var(--now-playing-h)`. `App.tsx` reveals it — `fsQueueRevealed` + a `mousemove` listener live only while fullscreen is up — and the root gains `fs-queue-revealed`, which slides it in.
- **Fixed, not a z-index bump on the grid item:** it must be full width even when the user has the queue *collapsed* (`--queue-width` keeps the resizable width regardless of the collapsed 40px column), and out-of-flow means entering fullscreen doesn't reflow the grid underneath.
- **Hysteresis, not one threshold:** reveal within 24px of the right edge, hide only once the pointer is clear of the whole drawer. A single boundary flickers the panel every time the pointer crosses it — and the drawer is exactly the region you must be inside to click a track.
- **`top: 52px`** clears `.np-actions`. Full-height slid the drawer over the visualizer / lyrics / exit buttons, so opening the queue appeared to delete them, and the only way back was to move away — which closes the drawer you just opened.
- **No width is reserved on the surface.** The drawer is transient, so it overlays; reserving space would slide the artwork sideways every time the pointer brushed the right edge. Persistent panels reserve, transient ones cover.
- Audio only. In browser-engine video fullscreen the panel isn't inside the `:fullscreen` element at all and cannot be shown; native-mpv video fullscreen has the same `z-index: 999` problem and still has the dead Playlist button.

**Video tracks:** the shared `<video>` element is repositioned to fill the column (theater mode via `.video-container--theater` — no remount, mirrors fullscreen). The surround is the skin's `--video-bg` letterbox fill (black by default); nothing tints the picture — there is deliberately **no** ambient glow/vignette layer (it was removed: an `inset: 0` overlay lands on the video's own edges, not just the letterbox, and its color came from static artwork rather than live frames). A `VideoAmbientOverlay` paints auto-hiding layers over the full-bleed video without adding transport controls:
- An "up next" chip (bottom-right, click to jump)
- A title/artist intro (bottom-left, re-triggers on track change)
- A subtitle toggle (top-right, only when synced lyrics matched the video) + a fullscreen button (top-right)

Overlay visibility uses a self-contained idle timer mirroring `FullscreenControls` — every layer shares the same fade. Pure helper `nextQueueTrack` lives in `src/utils/videoOverlay.ts` (unit-tested).

**Subtitles over video** (`VideoSubtitles.tsx` / `.css`) — the current synced line plus the upcoming one, one instance mounted in `.video-container` so the docked preview, theater and fullscreen all share it. Two rules, both of which were bugs first:

- **Colour follows the video, not the skin.** Text uses `--hero-text-primary` / `--hero-text-secondary` and the outline uses `--video-subtitle-stroke` / `--video-subtitle-shadow` (`base.css`, always dark). Never `--text-primary` / `--text-secondary`, and never `rgba(var(--overlay-inverse), …)` — that token flips to `255,255,255` on light skins (`base.css` `[data-skin-type="light"]`), so the previous styling rendered dark text under a *white* halo over video, and the upcoming line — at muted `--text-secondary` — was illegible on every skin. What backs these glyphs is an arbitrary video frame; the skin has no say in it.
- **The outline is a stroke, not a glow.** `paint-order: stroke fill` paints the stroke first so the fill covers its inner half and letterforms keep their weight. A blurred `text-shadow` washes out over bright or busy footage — exactly when it is needed. An `@supports not (paint-order: stroke)` block falls back to hard offset shadows, because a *centered* stroke (what you get when `paint-order` is ignored) thins the glyphs and is worse than none.

**Lyrics timing offset (`LyricsOffsetControl`).** Fetched LRC is timed against the *audio release*; a music video routinely opens with 10–30s of intro the release doesn't have, and live/remastered cuts drift by a second or two. Without an offset the lyrics are simply wrong on those tracks. The control is `[«] +2.5s [»]` — 0.5s steps, **Shift for 5s** (an intro is 30 clicks otherwise), and clicking the readout resets to zero.
- **Positive delays.** `lyricPosition(position, offset) = position − offset`, which owns the sign for all four call sites. Getting it backwards is silent — the lyrics just drift further as you "fix" them — so it is a named helper with its own test rather than an inline subtraction.
- **Per-track and persisted** (`lyricsOffsets` in the app store, keyed by `lyricOffsetKey` → `track:{artist}:{title}`, lowercased). A video is out by its intro on *every* play, so session-scoped would mean re-dialling it each time. Metadata-keyed for the same reason likes are: a `QueueTrack` has no DB id, and the same recording should keep its offset whichever source served it. **Zero is pruned, not stored**, or the record accumulates a no-op entry for every track anyone ever nudged and undid.
- **Applied at four places, all through `lyricPosition`:** the Now Playing karaoke column, `VideoSubtitles`, the mini player's synced-lyrics info item (`useNowPlayingInfo`), and — inverted — **tap-to-seek**, which seeks to `line.time + offset` so a click lands on the words the user actually clicked rather than `offset` seconds away.
- **Mounted on the two surfaces that show lyrics:** the Now Playing lyrics column (synced only — plain text has no timeline to shift) and `VideoAmbientOverlay` beside the subtitle toggle (only while subtitles are on). It is deliberately *not* in the corner action row: it belongs to what it adjusts.

**Lyrics/video duration gate:** `syncedLyricsFitMedia(lines, durationSecs)` (`src/utils/lyrics.ts`, unit-tested) decides whether subtitles appear at all, and is **two-sided**. It rejects lyrics that run past the media beyond a 10s tolerance (a short edit or a 30s preview) *and* lyrics whose last line lands below 60% of the media length (an 80-minute concert upload, a DJ set, an extended remix — the timings cannot be in sync with what is on screen). An ordinary music video with an intro and outro passes (4:30 video, last line at 3:20 → 0.74). The known cost is a false negative on a track with a very long instrumental outro; hiding lyrics there is the safer miss. Unknown duration allows. `App.tsx` feeds it `playback.durationSecs` before the queue entry's `duration_secs` — what is decoding can differ from what the entry claims. A rejected fit also removes the subtitle toggle from both the dock actions and `VideoAmbientOverlay`, since both are gated on the same value — there is no dead switch.

**Lyrics** run through the existing plugin info-type provider chain (LRCLIB → …) via the `useLyrics` hook (`useInformationTypes` gained an `include` filter to scope the fetch to lyrics only):
- **Synced (LRC):** centered karaoke highlighting — active line bright/bigger/bolder — with smooth auto-scroll, spring line animation, and tap-a-line-to-seek. Auto-scroll stops on unsynced lyrics.
- **Plain (unsynced):** same typography as synced but no spring/scale animation (no active line to drive it); scrolls proportionally to playback position when it overflows.

The audio view does not show an "up next" panel — the Queue Panel (column 3) is the surface for upcoming tracks and queue-jumps. (The video theater mode keeps its own auto-hiding "up next" chip via `VideoAmbientOverlay`, described above.)

## Detail Pages

All detail pages follow a consistent structure (see conventions.md for layout rules):

**Artist Detail** (`ArtistDetail.tsx`):
- Header: circular avatar + name + like/hate
- Albums grid
- Track list (artist's tracks)
- Information sections (tabs)

**Album Detail** (`AlbumDetail.tsx` + `TrackList`):
- Header: 240x240 cover + title + artist (clickable) + year + count + play all + like/hate
- Track list
- Information sections (tabs)

**Track Detail** (`TrackDetailView.tsx`):
- Header: album art + metadata
- Information sections (tabs: lyrics, similar tracks, artist info, etc.)

**Tag Detail:** Header + track list + information sections.

## Information Sections

**Component:** `InformationSections.tsx`

Tab-based interface rendered on detail pages. Each tab is a plugin-registered information type.

- Tabs are drag-and-drop reorderable
- Lazy-loaded (fetch on tab click) with caching
- Placement: `header` (above track list) or `below` (below track list)
- Display kinds: `rich_text`, `html`, `lyrics`, `stat_grid`, `entity_list`, `entity_cards`, `tag_list`, `ranked_list`, `annotated_text`, `key_value`, `image_gallery`, `title_line`

## Context Menus

**Component:** `ContextMenu.tsx`

See "Entity System > Context Menu Consistency" for how context menus work across all surfaces.

**Base actions per target:**

| Target | Base Actions |
|--------|-------------|
| **track** | Play, Enqueue, Play Next, Show in Folder, Delete, Bulk Edit, Export as Tape, search providers |
| **album** | Play All, Enqueue All, Refresh Image |
| **artist** | Play All, Enqueue All, Refresh Image |
| **multi-track** | Play, Enqueue, Delete, Bulk Edit |
| **playlist** | Play All, Enqueue All, Delete |
| **queue items** | Remove, Keep Only, Move to Top/Bottom; single item also: Details, Edit info…, Start radio |
| **video** | Dock position (top/bottom/left/right) |

Plugin-registered actions appear on all applicable targets automatically, minus any the user turned off per-item in Extensions → Contributions. Search providers are user-configurable (built-in and custom).

## Skin System

Skins control all colors via CSS custom properties on `:root`.

**19 color keys** (defined in `types/skin.ts` → `SkinColors`):
```
bg-primary, bg-secondary, bg-tertiary, bg-surface, bg-hover,
text-primary, text-secondary, text-tertiary,
accent, accent-dim, accent-text, border, now-playing-bg,
success, error, warning, like, dislike, video-bg
```

`accent-text`, `like`, `dislike`, and `video-bg` postdate the original 15-key schema and are **optional** (`OPTIONAL_SKIN_COLOR_KEYS` in `types/skin.ts`): `validateSkin()` tolerates their absence and rendering falls back to the default skin's values. New skins should still define all 19.

`video-bg` is the letterbox/pillarbox fill behind video — both the browser `<video>` container and the native mpv layer read it (`useSkins.ts` mirrors it to mpv's `background-color`), so both engines surround video identically. It is independent from `bg-primary` so a **light** skin can keep a cinema-black surround without darkening the whole app; the built-in skins all set it to black.

Plus derived RGB versions (`--bg-primary-rgb`, `--accent-rgb`, `--now-playing-bg-rgb`) for `rgba()` usage.

**Skin JSON format:**
```json
{ "name": "", "author": "", "version": "", "type": "dark|light",
  "colors": { /* 18 hex color values */ }, "customCSS": "/* max 10KB, sanitized */" }
```

**Utilities** (`skinUtils.ts`): `generateSkinCSS()`, `sanitizeCustomCSS()` (strips @import, javascript:, url()), `validateSkin()`.

**Guidelines:**
- Always use CSS custom properties (`var(--bg-primary)`, etc.) — never hardcode colors
- Test UI changes across multiple skins
- Use the 7-level type scale: `--fs-2xs` through `--fs-2xl`

## Design System

Standard `.ds-*` CSS classes are defined in `src/design-system.css`. When building new UI, use these classes instead of creating ad-hoc styles. Existing components will migrate incrementally.

**Available classes:**

| Category | Base Class | Variants |
|----------|-----------|----------|
| Buttons | `.ds-btn` | `--primary`, `--secondary`, `--danger`, `--ghost`, `--sm`, `--lg` |
| Tabs | `.ds-tabs` + `.ds-tab` | `--compact`, `--no-border`, `.ds-tab-badge` |
| Modals | `.ds-modal-overlay` + `.ds-modal` | `--sm`, `--lg`, `--xl`, `.ds-modal-title`, `.ds-modal-actions` |
| Cards | `.ds-card` | `.ds-card-art`, `--circular`, `.ds-card-play`, `--accent`, `.ds-card-like`, `.ds-card-more`, `.ds-card-body`, `.ds-card-title`, `.ds-card-subtitle` |
| Card grid | `.ds-card-grid` | `--wide` |
| Inputs | `.ds-input` | — |
| Selects | `.ds-select` | — |
| Toggles | `.ds-toggle` + `.ds-toggle-thumb` | `.on` state |
| Search | `.ds-search` | — |
| Tables | `.ds-table` | `.ds-table-header`, `.ds-table-row`, `.highlighted`, `.active` |
| Columns | `.ds-col--grow`, `--shrink`, `--right`, `--secondary` | — |
| Lists | `.ds-list` + `.ds-list-item` | `.ds-list-item-img`, `--circular`, `.ds-list-item-info`, `.ds-list-item-name`, `.ds-list-item-secondary` |
| Spinners | `.ds-spinner` | `--sm` (16px), `--lg` (32px) |

**Usage:** `className="ds-btn ds-btn--primary ds-btn--sm"`

**Rule:** New UI must use `.ds-*` classes. Do not create new ad-hoc button, tab, modal, card, input, table, or list styles.

**Design Tokens (skinnable):**

Structural properties exposed as CSS custom properties in `:root` (defined in `base.css`). Skins can override these via `customCSS` to change the app's shape/feel without touching component code.

| Token | Default | Controls |
|-------|---------|----------|
| `--ds-radius` | `6px` | Buttons, inputs, selects, table rows, list items |
| `--ds-radius-pill` | `20px` | Search boxes |
| `--ds-radius-card` | `8px` | Cards |
| `--ds-radius-modal` | `10px` | Modals |
| `--ds-card-gap` | `16px` | Card grid gap |
| `--ds-card-min` | `160px` | Card grid minimum column width |

Example skin override via `customCSS`:
```css
:root { --ds-radius: 0px; --ds-radius-pill: 4px; --ds-radius-card: 2px; }
```
