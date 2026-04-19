# UI

## Entity System

The app has 5 core entity types that appear across many surfaces. Every entity type uses shared rendering, shared CSS classes, and shared context menus — regardless of where it appears.

### Entity Types

| Entity | Key Fields | Where it appears |
|--------|-----------|-----------------|
| **Track** | id, path, title, artist_name, album_title, duration_secs, liked (-1/0/1), format, collection_id | All Tracks, Album detail, Tag detail, Artist detail, Liked, Queue, TIDAL search, Spotify playlists, similar tracks, search results |
| **Artist** | id, name, track_count, liked | Artists view, search results, similar artists, TIDAL browse |
| **Album** | id, title, artist_name, year, track_count, liked | Albums view, artist detail, search results, TIDAL browse |
| **Playlist** | id, name, track_count | Playlists view, Spotify browse |
| **Tag** | id, name, track_count, liked | Tags view |

Track paths use URL schemes: `file://` (local), `subsonic://`, `tidal://`.

### Three Rendering Modes

Every entity list supports three view modes using shared CSS classes. The styling must be consistent across all surfaces — a track in "All Tracks" must look identical to a track in a playlist, TIDAL results, or a plugin view.

| Mode | CSS Class | Layout | Context Menu |
|------|-----------|--------|--------------|
| **Table** | `.entity-table` | Grid columns, sortable headers | Right-click on row |
| **List** | `.entity-list` | Rows with thumbnails, two-line layout (title + subtitle) | Right-click on row |
| **Tiles** | `.album-grid` | Card grid (`repeat(auto-fill, minmax(160px, 1fr))`) | Via `...` button overlay on card (see Tile Card Structure below) |

### Context Menu Consistency

The app must detect what kind of entity it is rendering and show the appropriate context menu with all applicable actions — including plugin-registered actions.

**Core principle:** An entity's context menu is the same regardless of where it appears. A track in the library, in a playlist, in TIDAL search results, or in a plugin view all get the same base actions plus all registered plugin actions.

**How it works:**
1. Each surface renders entities using the shared CSS classes and wires up `onContextMenu` handlers
2. The handler builds a `PluginContextMenuTarget` with available data (id, title, artist, etc.)
3. `ContextMenu.tsx` renders base actions for the entity kind plus all `pluginMenuItems` registered via `contributes.contextMenuItems` in plugin manifests
4. For entities without a library ID (e.g., external search results), the target still carries title/artist so plugins can act on metadata alone

**Registering new actions:** Both internal features and plugins register context menu items via `contributes.contextMenuItems` in their manifest with `targets: ["track", "album", "artist", "multi-track", "playlist"]`. New actions automatically appear in all context menus for that entity type across every surface.

**When adding a new surface that shows entities:** Use the shared CSS classes, wire up context menus with `pluginMenuItems` and `onPluginAction`, and ensure all three view modes work. Do not create one-off styling — reuse the existing `.entity-table`, `.entity-list`, and `.album-grid` patterns.

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
- Back/Forward navigation buttons
- `CentralSearchDropdown` (global search with results preview)
- Spacer (draggable)
- Help button (keyboard shortcuts)
- Mini player button
- Window controls (Windows/Linux right)

## Sidebar

**Component:** `Sidebar.tsx` (column 1, all rows)

Navigation items with keyboard shortcuts:
- Tracks (Cmd+1), Artists (Cmd+2), Albums (Cmd+3), Tags (Cmd+4), Liked (Cmd+5), History (Cmd+6), Playlists
- Plugin sidebar items (below separator)
- Bottom: Collections button, Settings button (with update badge)

Active state: animated `.sidebar-indicator` follows active nav button via JS-computed transform.

## Main Content

**Container:** `.main` (column 2, rows 2-3)

Views are toggled via `library.view` (`View` union type). When an entity is selected, its detail view replaces the list. Views:

| View | List Component | Detail Component |
|------|---------------|-----------------|
| Tracks | `TrackList` | `TrackDetailView` |
| Artists | `ArtistListView` | `ArtistDetailContent` |
| Albums | `AlbumListView` | `AlbumDetailHeader` + `TrackList` |
| Tags | `TagListView` | Tag header + `TrackList` |
| Liked | `LikedTracksView` | — |
| History | `HistoryView` | — |
| Playlists | `PlaylistsView` | Playlist detail |
| Collections | `CollectionsView` | — |
| Plugin views | `PluginViewRenderer` | — |

### View Modes

See "Entity System > Three Rendering Modes" above. Toggled via `ViewModeToggle` in `Breadcrumb`. View mode persisted per entity type (`artistViewMode`, `albumViewMode`, etc.).

## Queue Panel

**Component:** `QueuePanel.tsx` (column 3, all rows)

Two states:
- **Expanded:** Header (load/save/save-as/clear buttons) + scrollable queue list + info bar (count + duration)
- **Collapsed:** 40px strip showing count & duration, click to expand

Queue items show: thumbnail, title + duration, artist + album, "locate track" button.

Features: drag-and-drop reorder, multi-select (Shift/Cmd+Click), right-click context menu, duplicate detection on enqueue, resizable width via drag handle.

### Playlist Context

When tracks are played from a specific source (album, artist, tag, playlist, Spotify playlist, etc.), a `PlaylistContext` is attached to the queue. This gives the queue panel awareness of *what* the user is playing.

```typescript
interface PlaylistContext {
  name: string;              // e.g., album title, artist name, playlist name
  coverPath?: string | null; // local image path (for library entities)
  coverUrl?: string | null;  // remote image URL (for plugins like Spotify)
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

**Track image URLs:** Each track in the payload can carry an `image_url` field. When playing tracks from external sources (TIDAL, Spotify), include the image URL so the now playing bar and queue can display artwork without needing a library image lookup.

## Now Playing Bar

**Component:** `NowPlayingBar.tsx` (row 3, all columns)

**Full mode:**
- Seek bar (waveform visualization or segmented bar) with elapsed | total time
- Track info: album art, like/dislike buttons, title/artist/album (all clickable to navigate)
- Controls: previous, play/pause, next, stop
- Right: queue mode (normal/loop/shuffle), auto-continue, sync-with-playing toggle, volume

**Mini mode:** Compact bar with art, title/artist, play controls, close/expand. Draggable window, scroll-to-volume.

## Detail Pages

All detail pages follow a consistent structure (see conventions.md for layout rules):

**Artist Detail** (`ArtistDetailContent.tsx`):
- Header: circular avatar + name + like/hate
- Albums grid
- Track list (artist's tracks)
- Information sections (tabs)

**Album Detail** (`AlbumDetailHeader.tsx` + `TrackList`):
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
| **track** | Play, Enqueue, Play Next, Show in Folder, Find in YouTube, Delete, Bulk Edit, Export as Tape, Search providers |
| **album** | Play All, Enqueue All, Refresh Image |
| **artist** | Play All, Enqueue All, Refresh Image |
| **multi-track** | Play, Enqueue, Delete, Bulk Edit |
| **playlist** | Play All, Enqueue All, Delete |
| **queue items** | Remove, Keep Only, Move to Top/Bottom |
| **video** | Dock position (top/bottom/left/right) |

Plugin-registered actions appear on all applicable targets automatically. Search providers: Google, Last.fm, Genius, YouTube, X/Twitter (user-configurable).

## Skin System

Skins control all colors via CSS custom properties on `:root`.

**15 color keys** (defined in `types/skin.ts` → `SkinColors`):
```
bg-primary, bg-secondary, bg-tertiary, bg-surface, bg-hover,
text-primary, text-secondary, text-tertiary,
accent, accent-dim, border, now-playing-bg,
success, error, warning
```

Plus derived RGB versions (`--bg-primary-rgb`, `--accent-rgb`, `--now-playing-bg-rgb`) for `rgba()` usage.

**Skin JSON format:**
```json
{ "name": "", "author": "", "version": "", "type": "dark|light",
  "colors": { /* 15 hex color values */ }, "customCSS": "/* max 10KB, sanitized */" }
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
