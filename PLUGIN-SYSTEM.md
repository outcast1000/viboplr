# Viboplr Plugin System — Design Document

> Comprehensive reference for the plugin architecture covering Information Sections, Information Retrieval, Renderers, Lyrics, TIDAL, and Spotify subsystems.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Plugin Manifest & Lifecycle](#plugin-manifest--lifecycle)
3. [Plugin API Surface](#plugin-api-surface)
4. [Information Sections](#information-sections)
5. [Information Retrieval & Provider Chain](#information-retrieval--provider-chain)
6. [Renderers](#renderers)
7. [Lyrics Subsystem](#lyrics-subsystem)
8. [TIDAL Integration](#tidal-integration)
9. [Spotify Integration](#spotify-integration)
10. [Image Provider Chain (Rust-JS Bridge)](#image-provider-chain-rust-js-bridge)
11. [Database Schema](#database-schema)
12. [Built-in Plugins Reference](#built-in-plugins-reference)
13. [Data Flow Diagrams](#data-flow-diagrams)

---

## Architecture Overview

The plugin system is a **two-layer** architecture:

1. **Rust layer** — Image download worker with Rust-JS bridge, embedded artwork extraction, SQLite-backed caching, plugin file I/O, information type and image provider storage. Lives in `src-tauri/src/`.
2. **TypeScript/React layer** — Plugin discovery, activation, API construction, information type fetch orchestration, image resolve bridging, and rendering. Lives in `src/hooks/usePlugins.ts`, `src/hooks/useInformationTypes.ts`, `src/hooks/useImageResolver.ts`, and `src/components/`.

Plugins are **JavaScript files** (`index.js`) with a `manifest.json`, loaded at runtime via `new Function()`. They run in the renderer process and communicate with the Rust backend through the host-provided `ViboplrPluginAPI` object.

```
┌──────────────────────────────────────────────────────────┐
│                    React Frontend                         │
│  ┌──────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │usePlugins│  │useInformation  │  │useImageResolver  │  │
│  │  .ts     │──│  Types.ts      │  │  .ts             │  │
│  └────┬─────┘  └───────┬────────┘  └──────┬───────────┘  │
│       │                │                   │              │
│  ┌────▼────────────────▼───────────────────▼───────────┐  │
│  │              Plugin Runtime (JS)                     │  │
│  │  lastfm · genius · lrclib · tidal · spotify         │  │
│  │  deezer · itunes · audiodb · musicbrainz            │  │
│  └──────────────────┬──────────────────────────────────┘  │
├─────────────────────┼────────────────────────────────────┤
│  Tauri IPC          │  invoke() / emit()                 │
├─────────────────────┼────────────────────────────────────┤
│  ┌──────────────────▼──────────────────────────────────┐  │
│  │              Rust Backend                            │  │
│  │  commands.rs · db.rs · image_provider/               │  │
│  │  tidal.rs · lastfm.rs · downloader.rs · lib.rs      │  │
│  └─────────────────────────────────────────────────────┘  │
│                   SQLite (db.rs)                           │
└──────────────────────────────────────────────────────────┘
```

### Key Files

| Layer | File | Purpose |
|-------|------|---------|
| Frontend | `src/hooks/usePlugins.ts` | Plugin discovery, loading, API construction, event dispatch |
| Frontend | `src/hooks/useInformationTypes.ts` | Cache logic, TTL, provider fallback chain orchestration |
| Frontend | `src/hooks/useImageResolver.ts` | Rust-JS bridge: resolves image requests by running the plugin fallback chain |
| Frontend | `src/components/InformationSections.tsx` | Tab UI, renderer selection, action handling |
| Frontend | `src/components/TitleLineInfo.tsx` | Title-line placement: filters and renders `title_line` sections in entity headers |
| Frontend | `src/components/SettingsPanel.tsx` | Provider Priority section: drag-and-drop reorder, toggle on/off, reset defaults |
| Frontend | `src/components/renderers/index.ts` | Renderer registry (displayKind → React component) |
| Frontend | `src/types/plugin.ts` | All TypeScript types for manifests, APIs, view data |
| Frontend | `src/types/informationTypes.ts` | Display kinds, entity keys, cache types, section state |
| Backend | `src-tauri/src/commands.rs` | Tauri commands for plugin I/O, info type CRUD, image/info provider management |
| Backend | `src-tauri/src/db.rs` | SQLite schema + queries for information_types/values/image_providers |
| Backend | `src-tauri/src/image_provider/mod.rs` | Embedded album artwork provider (trait + helper utilities) |
| Backend | `src-tauri/src/tidal.rs` | TIDAL API client with instance failover |
| Plugins | `src-tauri/plugins/*/` | Built-in plugin manifests and implementations |

---

## Plugin Manifest & Lifecycle

### Manifest Structure

Every plugin has a `manifest.json`:

```jsonc
{
  "id": "my-plugin",           // Unique identifier
  "name": "My Plugin",         // Display name
  "version": "1.0.0",          // Semver
  "author": "Author",
  "description": "What it does",
  "minAppVersion": "0.9.4",    // Minimum compatible app version
  "contributes": {
    "sidebarItems":      [],   // Navigation sidebar entries
    "contextMenuItems":  [],   // Right-click menu actions
    "eventHooks":        [],   // Playback events to subscribe to
    "informationTypes":  [],   // Metadata sections to provide
    "imageProviders":    [],   // Image fetch handlers for artist/album artwork
    "settingsPanel":     {}    // Settings tab contribution
  }
}
```

### Contribution Points

| Contribution | Type | Description |
|---|---|---|
| `sidebarItems` | `{id, label, icon}` | Adds a navigation item to the sidebar |
| `contextMenuItems` | `{id, label, targets[]}` | Adds right-click actions. Targets: `track`, `album`, `artist`, `multi-track` |
| `eventHooks` | `string[]` | Events: `track:started`, `track:played`, `track:scrobbled`, `track:liked` |
| `informationTypes` | `{id, name, entity, displayKind, ttl, order, priority}` | Metadata sections (see [Information Sections](#information-sections)) |
| `imageProviders` | `{entity, priority}` | Registers image fetch handlers for `artist` or `album` artwork (see [Image Provider Chain](#image-provider-chain-rust-js-bridge)) |
| `settingsPanel` | `{id, label, icon?, order?}` | Adds a tab in Settings |

### Lifecycle

```
Discovery → Validation → Activation → Running → Deactivation
```

1. **Discovery** (`usePlugins.ts`): `invoke("plugin_list_installed")` scans both user plugins (`{app_dir}/plugins/`) and built-in plugins (`src-tauri/plugins/`). User plugins override built-in by ID. Built-in plugins that contribute `imageProviders` or `informationTypes` are automatically enabled on first load.

2. **Validation** (`usePlugins.ts:522`): Checks `minAppVersion` via semver comparison. Incompatible plugins get status `"incompatible"`.

3. **Activation** (`usePlugins.ts:459`):
   - Reads `index.js` via `invoke("plugin_read_file", {pluginId, path: "index.js"})`
   - Creates module: `new Function("api", code)(api)`
   - Calls `activate(api)` — plugin registers handlers
   - Stores optional `deactivate` function for cleanup

4. **Running**: Plugin handlers respond to events, fetch requests, UI actions.

5. **Deactivation** (`usePlugins.ts:425`):
   - Calls plugin's `deactivate()` if defined
   - Runs all registered unsubscribers
   - Clears handler maps and view data

### Plugin State

```typescript
type PluginStatus = "active" | "error" | "incompatible" | "disabled";

interface PluginState {
  id: string;
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  enabled: boolean;
  builtin?: boolean;
}
```

---

## Plugin API Surface

Plugins receive a `ViboplrPluginAPI` object in their `activate(api)` call. Defined in `src/types/plugin.ts:287`.

### API Namespaces

| Namespace | Key Methods | Purpose |
|---|---|---|
| `api.library` | `getTracks()`, `getArtists()`, `getAlbums()`, `getTrackById()`, `search()`, `getHistory()`, `getMostPlayed()`, `recordHistoryPlaysBatch()`, `applyTags()` | Read/write library data |
| `api.playback` | `getCurrentTrack()`, `isPlaying()`, `getPosition()`, `playTidalTrack()`, `enqueueTidalTrack()`, `onTrackStarted()`, `onTrackPlayed()`, `onTrackScrobbled()`, `onTrackLiked()` | Playback state & events |
| `api.contextMenu` | `onAction(actionId, handler)` | Handle right-click actions |
| `api.ui` | `setViewData(viewId, data)`, `showNotification()`, `navigateToView()`, `requestAction()`, `onAction()` | Render plugin views, handle UI actions |
| `api.storage` | `get(key)`, `set(key, value)`, `delete(key)` | Per-plugin persistent key-value store (SQLite-backed) |
| `api.network` | `fetch(url, init)`, `openUrl()`, `onDeepLink()`, `onOAuthCallback()`, `startOAuthListener()` | HTTP requests, OAuth flows |
| `api.tidal` | `search()`, `getAlbum()`, `getArtist()`, `getStreamUrl()`, `downloadTrack()`, `downloadAlbum()`, `checkStatus()` | TIDAL API access |
| `api.collections` | `getLocalCollections()`, `getDownloadFormat()` | Collection queries |
| `api.informationTypes` | `onFetch(typeId, handler)`, `invoke(command, args)` | Register metadata fetch handlers |
| `api.imageProviders` | `onFetch(entity, handler)` | Register image fetch handlers for artist/album artwork |

### Handler Storage (Internal)

Each loaded plugin maintains handler maps in `usePlugins.ts`:

```typescript
interface LoadedPlugin {
  contextMenuHandlers:   Map<string, handler>;
  uiActionHandlers:      Map<string, handler>;
  infoFetchHandlers:     Map<string, handler>;
  imageFetchHandlers:    Map<string, handler>;  // keyed by entity ("artist"|"album")
  deepLinkHandlers:      Array<handler>;
  oauthCallbackHandlers: Array<handler>;
  unsubscribers:         Array<() => void>;  // cleanup
}
```

---

## Information Sections

Information Sections are the tabbed metadata panels shown for entities (artists, albums, tracks, tags). Each section is backed by an **information type** declared in a plugin manifest.

### Information Type Declaration

```jsonc
{
  "id": "artist_bio",           // Unique within plugin
  "name": "About",              // Tab label
  "entity": "artist",           // artist | album | track | tag
  "displayKind": "rich_text",   // Renderer to use
  "ttl": 7776000,               // Cache TTL in seconds (90 days)
  "order": 200,                 // Sort order (lower = first)
  "priority": 100               // Provider chain priority (lower = tried first)
}
```

### Entity Key System

Cached values use **name-based keys**, not library IDs, enabling cross-library metadata sharing:

```typescript
// src/types/informationTypes.ts:191
function buildEntityKey(entity: InfoEntity): string {
  switch (entity.kind) {
    case "artist": return `artist:${entity.name}`;
    case "album":  return `album:${entity.artistName}:${entity.name}`;
    case "track":  return `track:${entity.artistName}:${entity.name}`;
    case "tag":    return `tag:${entity.name}`;
  }
}
```

### Section State Machine

Each section resolves to one of three states:

```typescript
type InfoSectionState =
  | { kind: "loaded"; data: unknown; stale: boolean }
  | { kind: "loading" }
  | { kind: "hidden" };  // not_found or fresh error
```

### Placement Logic

Sections render in three positions based on `displayKind`:

| Placement | Display Kinds |
|---|---|
| **Title (header area)** | `title_line` |
| **Right sidebar** | `ranked_list`, `tag_list`, `image_gallery` |
| **Below (main area)** | All others: `rich_text`, `html`, `entity_list`, `entity_cards`, `stat_grid`, `lyrics`, `annotated_text`, `annotations`, `key_value` |

**Title placement** works differently from the other two. `title_line` sections are filtered out of `InformationSections.tsx` and never appear as tabs. Instead, a dedicated `TitleLineInfo` component (`src/components/TitleLineInfo.tsx`) uses the same `useInformationTypes` hook but filters FOR `title_line` only. It renders inline in the entity header — for example, in `ArtistDetailContent.tsx` inside `<span className="artist-bio-stats">`, showing stats like "1,234 listeners · 5,678 plays". The `TitleLineRenderer` displays items as `<value> <label>` separated by middle dots (`·`).

### Tab Rendering

`InformationSections.tsx` groups non-title-line sections by placement and displays tabs for each group. Custom (non-plugin) tabs can be injected via `customTabs` prop.

### Action Handling

Renderers emit actions via `onAction(actionId, payload)`. Built-in actions handled by `InformationSections.tsx:53`:

| Action | Payload | Behavior |
|---|---|---|
| `save-lyrics` | `{text, kind}` | Upserts lyrics to cache |
| `play-track` | `{id}` | Plays library track by ID |
| `play-or-youtube` | `{name, artist?}` | Tries library, falls back to YouTube |
| `youtube-search` | `{name, artist?}` | Opens YouTube search |
| *(other)* | *(any)* | Delegated to parent `onAction` |

---

## Information Retrieval & Provider Chain

The fetch system uses a **provider fallback chain** with TTL-based caching.

### Cache Decision Logic

`useInformationTypes.ts:14` — `decideCacheAction()`:

```
┌─────────────────────┬──────────────────────┬─────────────┐
│ Cached Status       │ TTL State            │ Action       │
├─────────────────────┼──────────────────────┼─────────────┤
│ null (no cache)     │ —                    │ loading      │
│ "ok"                │ fresh                │ render       │
│ "ok"                │ stale                │ render +     │
│                     │                      │ refetch      │
│ "not_found"/"error" │ fresh (< 1 hour)     │ hidden       │
│ "not_found"/"error" │ stale (>= 1 hour)    │ loading      │
│                     │                      │ (retry)      │
└─────────────────────┴──────────────────────┴─────────────┘
```

- **Success TTL**: Per-type (e.g., 90 days for bios, 7 days for popularity)
- **Error TTL**: Fixed 1 hour — errors retry after 1 hour

### Fetch Flow

```
1. User views entity (track/artist/album/tag)
   ↓
2. InformationSections receives entity prop
   ↓
3. useInformationTypes.loadSections()
   ↓
4. Backend query: info_get_types_for_entity(entity_kind)
   → Returns registered types with provider chains
   ↓
5. Backend query: info_get_values_for_entity(entity_key)
   → Returns all cached values for this entity
   ↓
6. For each type, decideCacheAction():
   - "render" → show cached data
   - "render_and_refetch" → show cached + schedule fetch
   - "loading" → show skeleton + schedule fetch
   - "hidden" → skip (not_found/error, still fresh)
   ↓
7. For types needing fetch, iterate provider chain:
   for (const [pluginId, integerId] of providers) {
     result = await invokeInfoFetch(pluginId, typeId, entity)
     if (result.status === "ok") break  // first success wins
   }
   ↓
8. Cache result: invoke("info_upsert_value", ...)
   ↓
9. Clean up stale values from lower-priority providers
   ↓
10. Update UI section state
```

### Deduplication

Concurrent fetches for the same `typeId:entityKey` are deduplicated via `inFlightRef` Set.

### Type Sync

When plugins load, all declared information types and image providers are synced to the SQLite backend:

```typescript
// usePlugins.ts
invoke("info_sync_types", { types: allTypes })
invoke("sync_image_providers", { providers: allImageProviders })
```

Both sync operations deactivate all rows, upsert the incoming set as active, and preserve user-customized priorities. This preserves cached data for temporarily missing plugins.

### Cache Invalidation

When a plugin's version changes, all its cached values are deleted (`usePlugins.ts:629-647`), forcing re-fetch with potentially updated logic.

---

## Renderers

Renderers are React components that visualize information type data. Registered in `src/components/renderers/index.ts`.

### Renderer Registry

```typescript
const renderers: Record<string, ComponentType<RendererProps>> = {
  rich_text:      RichTextRenderer,
  html:           HtmlRenderer,
  entity_list:    EntityListRenderer,
  entity_cards:   EntityCardsRenderer,
  stat_grid:      StatGridRenderer,
  lyrics:         LyricsRenderer,
  tag_list:       TagListRenderer,
  ranked_list:    RankedListRenderer,
  annotated_text: AnnotatedTextRenderer,
  annotations:    AnnotationsRenderer,
  key_value:      KeyValueRenderer,
  image_gallery:  ImageGalleryRenderer,
  title_line:     TitleLineRenderer,
};
```

### Renderer Props Interface

```typescript
interface RendererProps {
  data: unknown;
  onEntityClick?: (kind: string, id?: number, name?: string) => void;
  onAction?: (actionId: string, payload?: unknown) => void;
  resolveEntity?: (kind: string, name: string) => { id?: number; imageSrc?: string } | undefined;
  context?: { positionSecs?: number };
}
```

### Display Kinds & Data Schemas

| displayKind | Data Type | Description |
|---|---|---|
| `rich_text` | `{summary, full?}` | Collapsible summary/full text |
| `html` | `{content}` | Sanitized HTML |
| `entity_list` | `{items: [{name, subtitle?, match?, image?, url?, libraryId?, libraryKind?}]}` | Clickable entity list with images |
| `entity_cards` | `{items: [{name, subtitle?, match?, image?, url?, libraryId?, libraryKind?}]}` | Grid of entity cards with match % |
| `stat_grid` | `{items: [{label, value, unit?}]}` | Statistics in a grid |
| `lyrics` | `{text, kind: "plain"|"synced", lines?: [{time, text}]}` | Lyrics with optional sync |
| `tag_list` | `{tags: [{name, url?}], suggestable?}` | Tag chips with optional suggest action |
| `ranked_list` | `{items: [{name, subtitle?, value, maxValue?, libraryId?, libraryKind?}]}` | Ranked items with bar visualization |
| `annotated_text` | `{overview?, sections: [{heading?, text}]}` | Sectioned text with headings |
| `annotations` | `{overview?, annotations: [{fragment, explanation}]}` | Fragment-based annotations |
| `key_value` | `{items: [{key, value}]}` | Simple key-value pairs |
| `image_gallery` | `{images: [{url, caption?, source?}]}` | Image carousel |
| `title_line` | `{items: [{label, value}]}` | Single-line inline stats |

### Plugin View Renderer

Plugins that contribute sidebar items render their UI via `PluginViewData` — a separate system from information type renderers:

```typescript
type PluginViewData =
  | { type: "track-list"; tracks: Track[]; title?: string }
  | { type: "card-grid"; items: CardGridItem[]; columns?: number }
  | { type: "track-row-list"; items: TrackRowItem[]; ... }
  | { type: "text"; content: string }
  | { type: "stats-grid"; items: StatItem[] }
  | { type: "button"; label: string; action: string; ... }
  | { type: "layout"; direction: "vertical"|"horizontal"; children: PluginViewData[] }
  | { type: "spacer" }
  | { type: "search-input"; placeholder?; action; value? }
  | { type: "tabs"; tabs: [{id, label, count?}]; activeTab; action }
  | { type: "loading"; message? }
  | { type: "toggle"; label; description?; action; checked; disabled? }
  | { type: "select"; label; description?; action; value; options: [{value, label}] }
  | { type: "progress-bar"; value; max; label? }
  | { type: "settings-row"; label; description?; control: PluginViewData }
  | { type: "section"; title; children: PluginViewData[] }
```

---

## Lyrics Subsystem

Lyrics are provided by the **LRCLIB plugin** and rendered by `LyricsRenderer.tsx`.

### Data Flow

```
LRCLIB API (lrclib.net) → Plugin onFetch handler → Cache → LyricsRenderer
```

### LRCLIB Plugin (`src-tauri/plugins/lrclib/`)

- Queries `https://lrclib.net/api/get?artist_name=...&track_name=...&album_name=...&duration=...`
- Returns synced lyrics (LRC format) if available, otherwise plain text
- TTL: 90 days
- HTTP 404 → `{status: "not_found"}`

### Lyrics Data Shape

```typescript
interface LyricsData {
  text: string;                           // Raw text
  kind: "plain" | "synced";              // Type
  lines?: Array<{ time: number; text: string }>;  // Parsed LRC lines
}
```

### LRC Parsing

Synced lyrics use LRC format: `[MM:SS.ms]text`. Parsed via regex:

```
/^\[(\d{2}):(\d{2})[.:]\d{2,3}\](.*)$/
```

### LyricsRenderer Features

1. **Plain lyrics**: Simple text display
2. **Synced lyrics**: Highlights current line based on `context.positionSecs`, auto-scrolls
3. **User override**: After manual scroll, auto-scroll pauses for 5 seconds
4. **Edit mode**: Toggle between plain/synced, edit text, save via `save-lyrics` action
5. **Save persistence**: `save-lyrics` action upserts to `information_values` table

---

## TIDAL Integration

TIDAL integration spans both Rust backend (API client) and a JS plugin (sidebar UI).

### Rust Client (`src-tauri/src/tidal.rs`)

- **Global singleton**: `static GLOBAL_TIDAL: Mutex<Option<Arc<TidalClient>>>`
- **Instance failover**: Tries multiple TIDAL proxy URLs, caches working instances for 24 hours
- **Methods**: `search()`, `get_album()`, `get_artist()`, `get_artist_albums()`, `get_stream_url()`

### Tauri Commands (`src-tauri/src/commands.rs`)

| Command | Parameters | Returns |
|---|---|---|
| `tidal_search` | `collectionId, query, limit, offset` | `TidalSearchResult` |
| `tidal_get_album` | `albumId` | `TidalAlbumDetail` |
| `tidal_get_artist` | `artistId` | `TidalArtistDetail` |
| `tidal_get_artist_albums` | `artistId` | `Vec<TidalSearchAlbum>` |
| `tidal_get_stream_url` | `trackId, quality?` | `String` (URL) |
| `tidal_check_status` | — | `{available, instance_count}` |
| `tidal_save_track` | `trackId, collectionId?, format?` | — |
| `download_album` | `albumId, collectionId?, format?` | — |

### TIDAL Browse Plugin (`src-tauri/plugins/tidal-browse/`)

**Contributions**: Sidebar item ("TIDAL") + context menu items (search, upgrade quality, play from TIDAL) + image providers (artist priority 100, album priority 100)

**Views**: Search → Album detail → Artist detail, with tab navigation (Tracks, Albums, Artists)

**Plugin API access**: Uses `api.tidal.*` for search/fetch, `api.ui.setViewData()` for rendering, `api.contextMenu.onAction()` for right-click actions, `api.imageProviders.onFetch()` for artist/album image resolution.

**Image resolution**: Searches TIDAL for artist/album, extracts `picture_id`/`cover_id`, returns URL in format `https://resources.tidal.com/images/{id}/{size}x{size}.jpg`.

### Download Integration

TIDAL tracks can be downloaded via `downloader.rs`:
- Formats: FLAC (lossless), AAC, MP3
- Writes ID3/Vorbis tags + embedded cover art
- Progress reported via `download-progress` / `download-complete` / `download-error` events

---

## Spotify Integration

Spotify is a **browse-only** plugin — no metadata provider contributions, no information types.

### Spotify Browse Plugin (`src-tauri/plugins/spotify-browse/`)

**Contributions**: Sidebar item ("Spotify") only.

### Authentication

- **OAuth PKCE** (Authorization Code with Proof Key)
- Client ID: `44d2ad940a874b629112797a45b36a13`
- Redirect URI: `viboplr://spotify/callback`
- Scopes: `user-library-read`, `playlist-read-private`
- PKCE: SHA-256 code challenge via `crypto.subtle.digest()`
- Token refresh on 401 with automatic retry

### Features

| Feature | API Endpoint | Description |
|---|---|---|
| Liked Songs | `/v1/me/tracks` | Paginated list of user's liked songs |
| Playlists | `/v1/me/playlists` | User's private playlists |
| Playlist Tracks | `/v1/playlists/{id}/tracks` | Tracks within a playlist |
| Search | `/v1/search` | Search tracks, artists, albums |

### State Management

```javascript
state = {
  accessToken, refreshToken, tokenExpiry, codeVerifier,
  currentView, likedTracks, likedOffset, likedTotal,
  playlists, playlistTracks, playlistTracksOffset,
  playlistTracksTotal, currentPlaylist, userName,
  searchQuery, searchResults: { tracks, artists, albums },
  searchTab, detailTrack
}
```

### Plugin APIs Used

- `api.network.fetch()` — Spotify API calls
- `api.network.openUrl()` — Browser redirect for OAuth
- `api.network.onOAuthCallback()` — Callback URL handling
- `api.storage` — Token persistence across sessions
- `api.ui.setViewData()` — Sidebar view rendering
- `api.ui.onAction()` — UI interaction handling

---

## Image Provider Chain (Rust-JS Bridge)

Image fetching uses a **Rust-JS bridge** architecture. The Rust image download worker emits requests to the frontend, where JS plugins run the fallback chain. This replaces the previous hardcoded Rust provider chain and allows user-configurable provider priority via the Settings UI.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Rust Backend                           │
│  ┌──────────────┐   emit("image-resolve-request")       │
│  │ Image Worker  │──────────────────────────┐            │
│  │ (lib.rs)      │◄─────────────────────────┼──────┐     │
│  └──────┬────────┘  invoke("image_resolve   │      │     │
│         │            _response")             │      │     │
│  ┌──────▼────────┐                          │      │     │
│  │ Embedded      │  (album only, tried      │      │     │
│  │ Provider      │   first before bridge)   │      │     │
│  └───────────────┘                          │      │     │
├─────────────────────────────────────────────┼──────┼─────┤
│  Tauri IPC / Events                         │      │     │
├─────────────────────────────────────────────┼──────┼─────┤
│                   React Frontend             │      │     │
│  ┌──────────────────────────────────────────▼──────┤     │
│  │ useImageResolver.ts                             │     │
│  │  1. Listens for image-resolve-request           │     │
│  │  2. Calls get_image_providers (priority order)  │     │
│  │  3. Tries each plugin's image handler           │     │
│  │  4. Returns first success via image_resolve     │     │
│  │     _response command                           ┼─────┘
│  └──────────────────┬──────────────────────────────┘     │
│                     │                                     │
│  ┌──────────────────▼──────────────────────────────┐     │
│  │  Plugin Image Handlers (JS)                      │     │
│  │  tidal · deezer · itunes · audiodb · musicbrainz │     │
│  └──────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

### Rust-JS Bridge (`src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`)

The image download worker runs in a background thread. When it needs an image:

1. **Album**: Tries `EmbeddedArtworkProvider` first (Rust-native, extracts artwork from audio file metadata via the `lofty` crate). If embedded artwork is found, the bridge is skipped entirely.
2. **Artist or Album fallthrough**: Creates a one-shot `mpsc` channel, registers it in `ImageResolveRegistry`, and emits an `image-resolve-request` event to the frontend.
3. **Waits** up to 30 seconds for a response via the channel.
4. **On response**: Downloads the image from the returned URL (with optional custom headers) or decodes base64 data, then saves to disk and emits `artist-image-ready` / `album-image-ready`.
5. **On failure**: Records the failure in `image_fetch_failures` table and emits an error event.

```rust
// commands.rs
pub struct ImageResolveResult {
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub data: Option<String>,    // base64 encoded image bytes
    pub error: Option<String>,
}

pub struct ImageResolveRegistry {
    pub pending: Mutex<HashMap<String, mpsc::Sender<ImageResolveResult>>>,
}
```

### Frontend Image Resolver (`src/hooks/useImageResolver.ts`)

The `useImageResolver` hook bridges the Rust worker to the plugin image handlers:

1. Listens for `image-resolve-request` events containing `{request_id, entity, id, name/title, artist_name}`.
2. Queries active providers in priority order via `get_image_providers` command.
3. Calls `invokeImageFetch(pluginId, entity, name, artistName?)` for each provider sequentially.
4. On first `{status: "ok"}` result: sends the URL/headers/data back via `image_resolve_response` command.
5. If all providers fail: sends an error response.

### Image Provider API

Plugins register image handlers via `api.imageProviders.onFetch()`:

```typescript
type ImageFetchResult =
  | { status: "ok"; url: string; headers?: Record<string, string> }
  | { status: "ok"; data: string }    // base64 encoded
  | { status: "not_found" }
  | { status: "error"; message?: string };

interface PluginImageProvidersAPI {
  onFetch(
    entity: "artist" | "album",
    handler: (name: string, artistName?: string) => Promise<ImageFetchResult>,
  ): () => void;
}
```

### Default Fallback Chain Order

Priority is user-configurable via Settings > Providers. Default order (lower = tried first):

**Artist chain**: TIDAL (100) → Deezer (200) → iTunes (300) → AudioDB (400) → MusicBrainz (500)

**Album chain**: Embedded (Rust-native, always first) → TIDAL (100) → iTunes (200) → Deezer (300) → MusicBrainz (500)

### Plugin Implementations

| Plugin | Artist Source | Album Source |
|---|---|---|
| tidal-browse | TIDAL API search → `picture_id` → cover URL | TIDAL API search → `cover_id` → cover URL |
| deezer | `/search/artist` → `picture_xl` | `/search/album` → `cover_xl` |
| itunes | Search → `artworkUrl100` upscaled to 600px | Search → artwork upscaled to 600px |
| audiodb | `/search.php` → `strArtistThumb` | *(not applicable)* |
| musicbrainz | MBID → Wikimedia Commons thumbnail | Release-group MBID → Cover Art Archive |
| Embedded | *(not applicable — Rust-native)* | `lofty` crate → embedded artwork from audio files |

### Provider Management Commands (`src-tauri/src/commands.rs`)

| Command | Parameters | Description |
|---|---|---|
| `sync_image_providers` | `providers: [(plugin_id, entity, priority)]` | Sync image provider table from plugin manifests |
| `get_image_providers` | `entity` | Get active providers for entity in priority order |
| `get_all_provider_config` | — | Get full config for Settings UI (info types + image providers) |
| `update_image_provider_priority` | `plugin_id, entity, priority` | Update provider priority |
| `update_image_provider_active` | `plugin_id, entity, active` | Toggle provider on/off |
| `update_info_type_priority` | `type_id, plugin_id, priority` | Update info type provider priority |
| `update_info_type_active` | `type_id, plugin_id, active` | Toggle info type provider on/off |
| `reset_provider_priorities` | `image_defaults, info_defaults` | Reset all priorities to manifest defaults |
| `image_resolve_response` | `request_id, result` | Return image result from frontend to Rust worker |

### Settings Provider Priority UI (`src/components/SettingsPanel.tsx`)

The Settings > Providers tab includes a **Provider Priority** section that shows all image providers and information type provider chains, grouped by entity (Artist, Album, Track). Users can:

- **Drag-and-drop** to reorder providers within a multi-provider row
- **Toggle** individual providers on/off
- **Reset** all priorities to manifest defaults
- Album images always show "Embedded" locked at the first position (it runs in Rust before the bridge)

### Failure Caching

Failed image fetches are recorded in `image_fetch_failures` table to avoid retrying known failures.

### Shared Utilities (`image_provider/mod.rs`)

- `http_client()` — Creates `reqwest::blocking::Client` with Viboplr user agent
- `write_image()` — Writes bytes to disk with parent directory creation

---

## Database Schema

### information_types

```sql
CREATE TABLE information_types (
    id           INTEGER PRIMARY KEY,
    type_id      TEXT NOT NULL,          -- e.g. "artist_bio"
    name         TEXT NOT NULL,          -- e.g. "About"
    entity       TEXT NOT NULL,          -- artist | album | track | tag
    display_kind TEXT NOT NULL,          -- rich_text | lyrics | etc.
    plugin_id    TEXT NOT NULL,          -- e.g. "lastfm"
    ttl          INTEGER NOT NULL,       -- seconds
    sort_order   INTEGER NOT NULL DEFAULT 500,
    priority     INTEGER NOT NULL DEFAULT 500,
    active       INTEGER NOT NULL DEFAULT 1,
    UNIQUE (type_id, plugin_id)
);
```

### information_values

```sql
CREATE TABLE information_values (
    information_type_id INTEGER NOT NULL REFERENCES information_types(id),
    entity_key          TEXT NOT NULL,   -- e.g. "artist:Radiohead"
    value               TEXT NOT NULL,   -- JSON string
    status              TEXT NOT NULL DEFAULT 'ok',  -- ok | not_found | error
    fetched_at          INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (information_type_id, entity_key)
);
CREATE INDEX idx_info_values_entity ON information_values(entity_key);
```

### image_providers

```sql
CREATE TABLE image_providers (
    id          INTEGER PRIMARY KEY,
    plugin_id   TEXT NOT NULL,
    entity      TEXT NOT NULL CHECK(entity IN ('artist', 'album')),
    priority    INTEGER NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1
);
```

### plugin_storage

```sql
CREATE TABLE plugin_storage (
    plugin_id TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    PRIMARY KEY (plugin_id, key)
);
```

### Key DB Methods (`src-tauri/src/db.rs`)

**Information Types:**

| Method | Description |
|---|---|
| `info_sync_types()` | Deactivate all → upsert active types, preserving user-customized priorities (transaction) |
| `info_get_types_for_entity()` | Get active types for entity kind with provider chains |
| `info_get_value()` | Get single cached value |
| `info_get_values_for_entity()` | Get all cached values for an entity key |
| `info_upsert_value()` | Insert or update cached value |
| `info_delete_value()` | Delete single cached value |
| `info_delete_values_for_type()` | Delete all values for a type_id |
| `info_delete_all_for_entity()` | Purge all values for an entity |

**Image Providers:**

| Method | Description |
|---|---|
| `sync_image_providers()` | Deactivate all → upsert providers, preserving user-customized priorities → delete orphans (transaction) |
| `get_image_providers()` | Get active providers for entity ordered by priority ASC |
| `get_all_provider_config()` | Returns (info_types, image_providers) for Settings UI |
| `update_image_provider_priority()` | Update provider priority for a plugin+entity |
| `update_image_provider_active()` | Toggle provider active state |
| `update_info_type_priority()` | Update information type provider priority |
| `update_info_type_active()` | Toggle information type active state |
| `reset_provider_priorities()` | Reset both image and info type priorities to manifest defaults |

---

## Built-in Plugins Reference

### lastfm (v1.1.0)

**Purpose**: Scrobbling, now playing, history import, and metadata from Last.fm

**Information Types**:
| ID | Entity | displayKind | TTL |
|---|---|---|---|
| `artist_stats` | artist | `title_line` | 90d |
| `artist_bio` | artist | `rich_text` | 90d |
| `artist_top_tracks` | artist | `ranked_list` | 7d |
| `similar_artists` | artist | `entity_cards` | 90d |
| `album_wiki` | album | `rich_text` | 90d |
| `album_track_popularity` | album | `ranked_list` | 7d |
| `track_info` | track | `title_line` | 7d |
| `track_tags` | track | `tag_list` | 7d |
| `similar_tracks` | track | `ranked_list` | 90d |

**Event Hooks**: `track:started`, `track:scrobbled`, `track:liked`
**Settings Panel**: Yes (Last.fm auth, import)

### genius (v1.0.0)

**Purpose**: Song explanations, artist/album descriptions from Genius

**Information Types**:
| ID | Entity | displayKind | TTL | Priority |
|---|---|---|---|---|
| `genius_song_explanation` | track | `annotations` | 90d | 100 |
| `artist_bio` | artist | `rich_text` | 90d | 200 |
| `album_wiki` | album | `rich_text` | 90d | 200 |

**Provider Chain**: Genius shares `artist_bio` and `album_wiki` type IDs with Last.fm. Last.fm has priority 100, Genius has priority 200 — making Genius a fallback provider when Last.fm has no data.

### lrclib (v1.0.0)

**Purpose**: Synced and plain lyrics from LRCLIB

**Information Types**:
| ID | Entity | displayKind | TTL |
|---|---|---|---|
| `lyrics` | track | `lyrics` | 90d |

### tidal-browse (v1.0.0)

**Purpose**: Search, stream, and download from TIDAL

**Sidebar**: "TIDAL" with icon
**Context Menu**: search-tidal (track/album/artist), upgrade-quality (track), play-from-tidal (track)
**Image Providers**: artist (priority 100), album (priority 100)

### spotify-browse (v1.0.0)

**Purpose**: Browse Spotify library — liked songs and playlists

**Sidebar**: "Spotify" with icon
**Auth**: OAuth PKCE flow

### example-stats (v1.0.0)

**Purpose**: Example plugin showing playback statistics and plugin API usage

**Sidebar**: "Stats" with chart-bar icon
**Context Menu**: show-artist-stats (track, artist)
**Event Hooks**: all four events

### deezer (v1.0.0)

**Purpose**: Artist and album images from Deezer

**Image Providers**: artist (priority 200), album (priority 300)

### itunes (v1.0.0)

**Purpose**: Artist and album images from iTunes

**Image Providers**: artist (priority 300), album (priority 200)

### audiodb (v1.0.0)

**Purpose**: Artist images from TheAudioDB

**Image Providers**: artist (priority 400)

### musicbrainz (v1.0.0)

**Purpose**: Artist and album images from MusicBrainz and Cover Art Archive

**Image Providers**: artist (priority 500), album (priority 500)

### randomizer (v1.0.0)

**Purpose**: Shows 10 random tracks from library

**Sidebar**: "Randomizer" with star icon

---

## Data Flow Diagrams

### Entity View → Metadata Display

```
User clicks artist/album/track
  │
  ▼
Entity detail view mounts
  │
  ▼
<InformationSections entity={...} placement="below|right" />
  │
  ▼
useInformationTypes(entity, invokeInfoFetch)
  │
  ├──▶ invoke("info_get_types_for_entity", {entity: kind})
  │     → registered types + provider chains
  │
  ├──▶ invoke("info_get_values_for_entity", {entityKey})
  │     → cached values map
  │
  ▼
For each type: decideCacheAction(status, fetchedAt, ttl)
  │
  ├── "render"           → show cached data immediately
  ├── "render_and_refetch" → show cached + fetch in background
  ├── "loading"          → show skeleton + fetch
  └── "hidden"           → skip (not_found/error, still fresh)
      │
      ▼ (if fetch needed)
  Provider fallback chain:
    Provider 1 (pluginId, integerId)
      → invokeInfoFetch(pluginId, typeId, entity)
        → plugin.infoFetchHandlers.get(typeId)(entity)
          → HTTP request to external API
      → if status === "ok": stop, cache, render
      → if not: try next provider
    Provider 2 ...
    Provider N ...
```

### Plugin Sidebar View

```
User clicks plugin sidebar item
  │
  ▼
App sets currentView = "plugin:{pluginId}:{viewId}"
  │
  ▼
PluginViewRenderer reads viewData from registry
  │
  ▼
Renders PluginViewData tree (layout, cards, buttons, etc.)
  │
  ▼
User action → dispatchUIAction(pluginId, actionId, data)
  │
  ▼
Plugin handler processes action
  │
  ▼
Plugin calls api.ui.setViewData() with updated view
```

### Image Resolution (Rust-JS Bridge)

```
Image download worker needs artist/album image
  │
  ├── (Album only) Try EmbeddedArtworkProvider (Rust-native)
  │     → If found: save to disk, emit album-image-ready, done
  │
  ▼
Create one-shot mpsc channel
Register sender in ImageResolveRegistry
  │
  ▼
emit("image-resolve-request", {request_id, entity, id, name/title, artist_name})
  │
  ▼  (Tauri event system)
  │
useImageResolver hook receives event
  │
  ├──▶ invoke("get_image_providers", {entity})
  │     → active providers in priority order
  │
  ▼
For each provider (plugin):
  invokeImageFetch(pluginId, entity, name, artistName?)
    → plugin.imageFetchHandlers.get(entity)(name, artistName?)
      → HTTP request to external API (TIDAL, Deezer, etc.)
    → if status === "ok": send result back, stop
    → if not: try next provider
  │
  ▼
invoke("image_resolve_response", {requestId, result})
  │
  ▼  (Back in Rust worker thread)
  │
Receive via mpsc channel (30s timeout)
  │
  ├── URL result: download via reqwest, save to disk
  ├── base64 data: decode and save to disk
  └── Error/timeout: record in image_fetch_failures
  │
  ▼
emit("artist-image-ready" / "album-image-ready")
```
