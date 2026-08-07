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
- Play button: absolute positioned over image, `rgba(0, 0, 0, 0.4)` backdrop, 40px play icon with drop shadow
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
- Bottom: Collections, Extensions (with update count badge), Settings (with update badge)

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

**Visibility popover:** `[⚙ Shelves]` opens a checklist of every registered shelf (built-in + plugin). Toggling persists to `homeShelfVisibility: Record<string, boolean>` in the app store. Default is "all visible" (missing keys count as visible).

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
- Seek bar (waveform visualization or segmented bar) with elapsed | total time
- Track info: album art, like/dislike buttons, title + a **static Artist · Album** line (clickable artist/album links). The full bar does **not** show the cycling Now Playing info section — that lives only in the mini player (see below).
- Controls: previous, play/pause, next, stop
- Right: queue mode (normal/repeat-all/repeat-one), randomize, auto-continue, equalizer, volume

**Mini mode:** Compact bar with art, title + the dynamic **Now Playing info** line (see below), play controls, close/expand. Draggable window, scroll-to-volume.

**Now Playing info line** (the line under the title, **mini player only** — the full bar shows a static Artist · Album line instead): a dynamic, auto-cycling section. Modules and plugins register items (`api.nowPlayingInfo` — see `plugins.md`); built-ins are **Artist · Album**, **Artist**, **Album**, **Plays · Rank** (one item), **Source**, **Quality**, **Duration**, **Tags** (`#`-prefixed track tags), **Synced Lyrics** (the line currently being sung in quotes, tracks playback position; drops out of the cycle during intros/instrumental gaps when no line is actively sung), **Plain Lyrics** (one unsynced line in quotes, stable per track), plus the Last.fm plugin's **Scrobbles**. The lyrics items reuse the cached lyrics info-type and each shows only when that kind of lyrics exists for the track. Each item carries a per-type **style** (lyrics italic, play-stats accent, secondary metadata muted — all via skin tokens, never hardcoded colors), a **time-of-persistence** (ToP) multiplier, and a **priority** (its position in the cycle). ToP + priority + on/off are configured in **Settings → Playback tab → "Now playing info"** (`NowPlayingInfoSettings.tsx`): one row per registered item with a drag handle + rank and a **single** `<select>` that is both the on/off and the dwell control — `Off` / `Preview only` / `1×` / `2×` / `5×` / `10×` (picking a dwell enables the item; there is no separate switch) — plus "Reset to defaults". It reuses the `.provider-v*` row markup/CSS and the shared `startRowDrag` from `utils/rowDrag.ts` — the same list pattern as Settings → Providers. The mini player's native context menu carries a single **"Now playing info…"** item that leaves mini mode, opens Settings and scrolls to that section (via SettingsPanel's one-shot `scrollToId`/`onScrolledToId` props); it no longer configures items inline. The cycle runs two phases per track: a **preview pass** (every enabled item shown once at the base ~5s interval, with a slide animation) then **steady rotation** of the `top > 0` items, each dwelling `5s × top`; `0×` items appear only in the preview. **Both phases follow the user's priority order** — ToP is dwell time only, never rank. Rendered by `NowPlayingInfoCycler`; resolution/selection/ordering/styling live in `useNowPlayingInfo`; selection persists as `nowPlayingInfoSelection`, the ToP map as `nowPlayingInfoPersistence`, and the ordered item ids as `nowPlayingInfoOrder` (items missing from it — a newly installed plugin's, or a built-in added by an app update — keep their registration order at the end). Each item declares its own default-enabled state (`defaultEnabled`); **Artist · Album** (1×), **Synced Lyrics** (5×, italic), and **Scrobbles** (0×) are on by default — the rest (including **Tags** and **Plain Lyrics**) are opt-in.

## Now Playing View

**Component:** `NowPlayingView.tsx` (the `nowplaying` main-content view, reached via the sidebar or Cmd+3). A lean-back, full-column presentation of the current track. Distinct from the always-present Now Playing **Bar** in row 3.

**Audio tracks:** blurred album-art backdrop + foreground album art + centered lyrics. Image resolution uses the album→artist `useImageCache` chain (same as queue/bar).

**View actions (top-right):** a dim row (`.np-actions`) that brightens on hover of the view, in the same corner the video theater puts its own controls so the set doesn't jump when the queue turns up a video. **Every action is a visible button — there is no ⋯ and no right-click menu.** Left to right:
- **Visualizer** (disc icon) — opens the picker, still a **native** menu (a list of choices is a menu, and JS dropdowns are banned app-wide) anchored under the button via `getBoundingClientRect()`. The button replaces a ⋯ that gave no hint what was behind it. Deliberately not an equalizer glyph — the now-playing bar already uses those for the actual EQ.
- **Lyrics** (subtitle icon, same glyph as the video theater's subtitle toggle) — shows/hides the lyrics column. Carries `aria-pressed`; `.is-off` when hidden. **Disabled, not hidden**, on a track with no lyrics, so the row doesn't reshuffle as the queue advances.
- **Fullscreen** — same icon as `VideoAmbientOverlay`'s, and last so it lands in the extreme corner like the theater's. Shown whenever something non-video is playing.

The whole menu was collapsed into these buttons: **"Fullscreen visualizer" is gone from any menu** (the button is the only route), and with the picker and lyrics also promoted, `contextMenu/buildNowPlayingMenuSpecs.ts` had nothing left and was deleted along with its test. Do not reintroduce a ⋯ here — three visible buttons are the discoverable surface the menu was trying to be, so a second hidden route to the same three would be duplication.

**Lyrics collapse:** hiding lyrics — because the track has none, or because the user turned the Lyrics button off (persisted as `nowPlayingLyricsHidden`) — drops the lyrics column and hands the whole stage to the art column, so a **visualizer grows to fill the view** instead of staying square in half of it. The static artwork grows too, but modestly (it's a fixed-resolution image). The column is unmounted rather than hidden so its position-driven auto-scroll stops.

**Fullscreen visualizer:** `AudioFullscreen.tsx`, an opaque full-window overlay at the app root whose stage is the `fullscreen` slot — which inherits the Now Playing pick (see `plugins.md` "Visualizers") — and falls back to the album art, so fullscreen works for anything playing rather than only for users who installed a visualizer. Window fullscreen, not DOM element fullscreen. Controls are the shared `FullscreenControls` on the usual idle fade; **Escape** or **Cmd/Ctrl+F** exits. Audio only — video has its own fullscreen path.

**Video tracks:** the shared `<video>` element is repositioned to fill the column (theater mode via `.video-container--theater` — no remount, mirrors fullscreen). The surround is the skin's `--video-bg` letterbox fill (black by default); nothing tints the picture — there is deliberately **no** ambient glow/vignette layer (it was removed: an `inset: 0` overlay lands on the video's own edges, not just the letterbox, and its color came from static artwork rather than live frames). A `VideoAmbientOverlay` paints auto-hiding layers over the full-bleed video without adding transport controls:
- An "up next" chip (bottom-right, click to jump)
- A title/artist intro (bottom-left, re-triggers on track change)
- A subtitle toggle (top-right, only when synced lyrics matched the video) + a fullscreen button (top-right)

Overlay visibility uses a self-contained idle timer mirroring `FullscreenControls` — every layer shares the same fade. Pure helper `nextQueueTrack` lives in `src/utils/videoOverlay.ts` (unit-tested).

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
