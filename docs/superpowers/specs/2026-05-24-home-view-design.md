# Home View — Design

**Date:** 2026-05-24
**Status:** Spec, ready for implementation plan

## Goal

Add a new top-level "Home" view that gives the user a curated landing page on app launch — a featured-track hero carousel followed by a stack of horizontal shelves (recently played, most played, recently added, liked albums, liked artists, jump back in) plus shelves contributed by plugins (e.g., Spotify's downloaded playlists).

Home becomes the default initial view. The user's persisted last view still wins on subsequent launches.

## Sidebar placement

- New `home` value in the `View` union (`src/types.ts`).
- Sidebar gets a "Home" button at the very top of the nav, above Library, with a house icon. Cmd/Ctrl+0 hint.
- Default startup view is `home` for first launch (no persisted view yet). After that, the persisted view restoration takes precedence.

## Page layout

```
┌─────────────────────────────────────────────────────┐
│ HomeHero                                            │
│ ┌──────┐  FEATURED TRACK                            │
│ │      │  Track Title                               │
│ │ 320  │  Artist Name                               │
│ │ ×320 │  [Year] [Tag] [Duration] [Format]          │
│ │      │  [▶ Play]  [≡+ Enqueue]                    │
│ └──────┘  ● ● ● ◉ ● ● ●  (7 dots)                   │
│ Background: blurred art of current featured track   │
├─────────────────────────────────────────────────────┤
│ Page header actions: [⟳ Refresh] [⚙ Shelves…]       │
├─────────────────────────────────────────────────────┤
│ Recently played                                  →  │
│ [card][card][card][card][card][card]…               │
│                                                     │
│ Most played                                      →  │
│ [card][card]…                                       │
│                                                     │
│ … etc                                               │
└─────────────────────────────────────────────────────┘
```

Shelves render top-to-bottom in fixed order (built-ins first, plugin shelves appended in plugin priority order). Visibility is per-shelf user-toggleable.

## Components

All new files live under `src/components/` and `src/hooks/`. All styling uses CSS custom properties (skin-compatible) and the `.ds-*` design-system classes where they fit.

### `HomeView.tsx` + `HomeView.css`
- Top-level page rendered when `view === "home"`.
- Renders `<HomeHero>` then a `<HomeShelf>` per visible shelf.
- Reads data from `useHome()`.
- Header strip with `[⟳ Refresh]` and `[⚙ Shelves…]` ghost buttons (right-aligned).
- Empty state: if the entire library has zero tracks, renders a centered "Add a collection to get started" CTA that navigates to `collections`.

### `HomeHero.tsx`
- Auto-rotating carousel of 7 featured tracks.
- Left side: 320×320 album-art square (uses existing entity-image resolution chain — embedded → album → artist → placeholder).
- Right side: track metadata (title, artist, year, tag, duration, format), `[▶ Play]` (primary) and `[≡+ Enqueue]` (secondary) buttons.
- Background: full-bleed blurred copy of the current art at low opacity (~0.25), darkened gradient overlay so foreground text stays legible across skins.
- Carousel arrow buttons (left/right) and 7 pagination dots below the buttons.
- Auto-advances every 8s. Pauses on mouse hover, resumes on mouse-leave. Manual nav (arrows/dots) resets the timer.
- `[▶ Play]` plays only the featured track. `[≡+ Enqueue]` enqueues only the featured track (runs `findDuplicates` and shows the duplicate banner per the enqueue convention).
- Clicking the art also plays the featured track.
- Right-click on the art opens the standard `track` context menu (with all plugin actions).

### `HomeShelf.tsx`
- Header row: shelf title (left), chevron arrow buttons that scroll-by-page (right).
- Horizontal scroller using a single-row CSS grid (`grid-auto-flow: column` + `overflow-x: auto`), `scroll-snap-type: x mandatory` on cards.
- Renders one of four card kinds based on the shelf's `displayKind`:
  - `album-cards` → existing `AlbumCardArt` markup
  - `artist-cards` → existing `ArtistCardArt` markup (circular)
  - `playlist-cards` → square `.ds-card` with cover + name + track count
  - `track-rows` → compact track cards with art + title + artist
- Right-click on any card opens the standard plugin-aware context menu via `pluginMenuItems` + `onPluginAction` (per `ui.md` "Context Menu Consistency"). Targets:
  - album cards → `album` target
  - artist cards → `artist` target
  - playlist cards → `playlist` target
  - track cards → `track` target
- Click behavior:
  - Album/artist with `libraryId` set → navigate to detail view.
  - Album without `libraryId` → `playTracks(items.tracks, 0, { name, coverUrl, source: "album" })`.
  - Artist without `libraryId` → no-op (artists must have a library id to navigate).
  - Playlist → `playTracks(items.tracks, 0, { name, coverUrl, source: "playlist" })`.
  - Track → `playTracks([track], 0)` (no context).
- If the shelf has zero items in a fetch cycle, the shelf hides itself for that cycle. If it has fewer than the requested count, it just stops — no padding.

### `HomeShelvesPopover.tsx`
- Triggered from the `[⚙ Shelves…]` button in the page header.
- Lists every registered shelf (built-in and plugin) with a checkbox.
- Toggling persists to `homeShelfVisibility: Record<string, boolean>` in the app-state store.
- Shelf keys:
  - Built-in: `builtin:recently-played`, `builtin:most-played`, etc.
  - Plugin: `${pluginId}:${shelfId}`.

## Hook: `useHome.ts`

Owns all Home state. Returns `{ featured, shelves, refresh, isLoading, visibility, setVisibility }`.

State:
- `featured: Track[]` — up to 7 library tracks for the hero (full `Track` so play/enqueue/context-menu can flow through canonical actions without re-resolving via `find_track_by_metadata`).
- `shelves: HomeShelf[]` — ordered list of resolved shelves with their data.
- `isLoading: boolean`.

Lifecycle:
- Computes featured + shelves on view-mount (when Home becomes visible).
- Auto-refreshes on a **5-minute interval, only while Home is visible**. The interval starts on mount and is cleared on unmount or when the user navigates away.
- `refresh()` re-runs the full pipeline immediately and resets the timer.
- All async work runs in parallel via `Promise.allSettled`. Built-in failures are caught and logged with `console.error`; the shelf hides for the cycle.
- Plugin shelf handlers have a 5-second timeout; on timeout the shelf is treated as an error for the cycle.

Featured-7 source:
- Reuses the auto-continue weighted-strategy chain from `useAutoContinue.ts`. Pulls 7 picks (40% Random, 20% Same Artist, 20% Same Tag, 10% Most Played, 10% Liked).
- Anchor track:
  - If a track is currently playing, anchor on it.
  - Else if history exists, anchor on the most-recently-played track.
  - Else fall back to pure-random for all 7.
- Output is the full library `Track[]` (with DB IDs). Hero rendering pulls only metadata fields it needs — DB IDs are not surfaced to the UI surface but are retained so play/enqueue/like flows go through canonical actions without round-tripping through `find_track_by_metadata`.

## Built-in shelves

| Shelf id | Title | Item type | Source | Limit |
|---|---|---|---|---|
| `builtin:recently-played` | Recently played | track | `invoke("get_history", { limit: 30 })` → dedupe by track id, keep first-seen | 20 |
| `builtin:most-played` | Most played | track | `invoke("get_history_most_played", { limit: 20 })` (history rows expose `display_title` / `display_artist` — track-rows shelf, since history is track-level and doesn't carry album metadata) | 20 |
| `builtin:recently-added` | Recently added | album | `invoke("get_albums", { sort: "added_desc", limit: 20 })` | 20 |
| `builtin:liked-albums` | Liked albums | album | `invoke("get_albums", { liked: 1, limit: 20 })` | 20 |
| `builtin:liked-artists` | Liked artists | artist | `invoke("get_artists", { liked: 1, limit: 20 })` | 20 |
| `builtin:jump-back-in` | Jump back in | mixed (album/artist) | reads `recentlyVisitedEntities` from app-state store | 12 |

### Backend touch points

- **`get_albums` sort param:** the existing command and `db.rs` query are extended to accept `sort: "added_desc" | "title_asc" | …` (default unchanged). Implementation uses the existing `albums.created_at` column — no schema change. One added branch in `db.rs`'s albums query and pass-through in `commands.rs`.
- No other backend changes for built-in shelves.

### Recently visited tracking

- New app-state key `recentlyVisitedEntities: Array<{ kind: "album" | "artist", id: number, ts: number }>`.
- `useNavigationHistory` (or wherever entity detail views are mounted) records an entry when an album or artist detail view opens.
- Ring buffer: max 20 entries, deduped by `kind:id` (most recent wins, older copy removed).
- Persists through the existing debounced-write + `restoredRef`-guard pattern.

## Plugin shelves

### Manifest

`contributes.homeShelves` is a new array. Validation added in `plugins.rs`. No new database tables.

```json
{
  "contributes": {
    "homeShelves": [
      {
        "id": "downloaded-playlists",
        "title": "Spotify · Downloaded",
        "displayKind": "playlist-cards",
        "limit": 20,
        "icon": "music"
      }
    ]
  }
}
```

Fields:
- `id` — unique within the plugin. Global key is `${pluginId}:${id}`.
- `title` — shelf header text.
- `displayKind` — one of `"album-cards" | "artist-cards" | "playlist-cards" | "track-rows"`.
- `limit` — advisory; passed to the handler.
- `icon` — optional; for future use (e.g., shelf header decoration).

A plugin may declare any number of shelves. The user can hide any individual shelf via the visibility popover.

### Runtime API

Added to the plugin API surface (`src/types/plugin.ts` and the runtime in `usePlugins.ts`):

```ts
interface HomeAPI {
  onFetchShelf(
    shelfId: string,
    handler: (limit: number) => Promise<HomeShelfResult>
  ): () => void;
}

type HomeShelfResult =
  | { status: "ok"; items: HomeShelfItem[] }
  | { status: "empty" }
  | { status: "error"; message?: string };

type HomeShelfItem =
  // playlist-cards
  | {
      id: string;
      name: string;
      coverUrl?: string;
      trackCount?: number;
      tracks: PluginTrack[];
      sourcePluginId?: string;
    }
  // album-cards
  | {
      libraryId?: number;
      name: string;
      artistName?: string;
      coverUrl?: string;
      tracks?: PluginTrack[];
    }
  // artist-cards
  | {
      libraryId?: number;
      name: string;
      imageUrl?: string;
    }
  // track-rows
  | { track: PluginTrack };
```

`api.home` is the new namespace on `ViboplrPluginAPI`.

### Lifecycle

- Plugin shelves are resolved in parallel with built-in shelves on each refresh.
- Per-handler 5-second timeout; on timeout, treat as `error` for the cycle.
- When a plugin is deactivated/reloaded, its shelves disappear immediately. `useHome` subscribes to the same activate/deactivate signals `usePlugins` already exposes and re-derives the shelf list.
- Errors are caught and `console.error`'d per the error-logging convention. They do not break other shelves.

### Spotify plugin (concrete usage)

Manifest snippet shown above. In `index.js`:

```js
api.home.onFetchShelf("downloaded-playlists", async (limit) => {
  const playlists = (await api.storage.get("downloadedPlaylists")) || [];
  return {
    status: "ok",
    items: playlists.slice(0, limit).map((p) => ({
      id: p.id,
      name: p.name,
      coverUrl: p.coverUrl,
      trackCount: p.tracks.length,
      tracks: p.tracks,
    })),
  };
});
```

Click on a card → `playTracks(item.tracks, 0, { name: item.name, coverUrl: item.coverUrl, source: "playlist" })`.
Right-click → standard `playlist` context menu (Play All / Enqueue All / Delete + plugin actions).

## Persistence

Two new keys added to the existing `app-state.json` store. Both go through the existing 500ms debounce + `restoredRef` guard.

```ts
homeShelfVisibility: Record<string, boolean>;
recentlyVisitedEntities: Array<{ kind: "album" | "artist"; id: number; ts: number }>;
```

Default: all shelves visible until the user toggles otherwise.

## Image resolution

Card images use the existing async resolution chain (per `queue.md` "Image Resolution"):

1. Item's `image_url` / `coverUrl` if set (plugin-provided).
2. Album image by name (`get_entity_image("album", album_title, artist_name)`) for album cards.
3. Artist image by name for artist cards.
4. Embedded artwork for track cards (track items still flow through the same name-based chain after album/artist fall through).
5. Placeholder SVG.

No DB-id-keyed image lookups are introduced. Existing components (`AlbumCardArt`, `ArtistCardArt`) handle this already; track-row cards reuse the same chain.

## Conventions compliance

- All play / enqueue actions route through `useQueue.playTracks` / `enqueueTracks` (with `findDuplicates` for enqueue) — no reimplementation.
- Hero card → uses the canonical `playTracks([track], 0)` flow; enqueue runs `findDuplicates` and surfaces the duplicate banner.
- Like/unlike from context menu → existing `useLikeActions` flow (uses `find_track_by_metadata` for tracks not in the library).
- Every catch logs with `console.error` including context.
- Cards visually match existing entity tiles; new shelves do not introduce one-off card styles.
- `homeShelves` plugin contribution is the only new manifest field; existing manifest validation logic is extended, not replaced.

## Testing

- **TypeScript unit tests** (`src/__tests__/`):
  - `home-featured.test.ts` — given a mock library + history, the featured-7 picker returns 7 unique tracks following the strategy weights (probabilistic, snapshot-style — assert distribution roughly matches).
  - `home-shelves.test.ts` — shelf resolver pipeline under `Promise.allSettled`: errors in one don't break others; timeouts hide the shelf; empty results hide the shelf.
  - `recently-visited.test.ts` — ring buffer dedup + cap at 20.
- **Rust tests** (`db.rs`):
  - `test_get_albums_sort_added_desc` — albums sorted by `created_at DESC` when `sort: "added_desc"` is passed.
- **E2E** (`tests/e2e/specs/home.test.js`):
  - App launches into Home on first run (no persisted view).
  - Hero advances after 8s; clicking a dot pauses auto-advance and shows the corresponding track.
  - Clicking `[▶ Play]` starts playback of the featured track.
  - At least one shelf renders with library data when seeded.
  - Toggle shelf visibility persists across reload.

## Out of scope

- No drag-to-reorder shelves (visibility toggle only — Q2 from brainstorming).
- No new database tables.
- Plugin shelves do not get a custom `displayKind` escape hatch — they pick from the four built-in renderers. (Custom rendering would belong to plugin sidebar views, not Home shelves.)
- No "see all" deep-link page per shelf — the shelf scrolls horizontally; users dive into Library/History views for the full lists.
