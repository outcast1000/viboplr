# Plugins

Plugins extend Viboplr with information sections, image providers, context menu actions, sidebar views, event hooks, and settings panels.

## Architecture

Two-layer system:
1. **Rust layer** — image download worker with Rust-JS bridge, embedded artwork extraction, SQLite-backed caching, plugin file I/O, info type and image provider storage
2. **TypeScript layer** — plugin discovery (`usePlugins.ts`), info type orchestration (`useInformationTypes.ts`), image resolution bridge (`useImageResolver.ts`), rendering (`InformationSections.tsx`, `PluginViewRenderer.tsx`)

## Directory Structure

Plugins live in `src-tauri/plugins/`. Each plugin is a folder with:
```
plugin-name/
├── manifest.json    # Metadata and contributions
└── index.js         # Plugin code (ES5, executed via new Function("api", code))
```

User-installed plugins (in app data directory) override built-in plugins with the same ID.

## Manifest Format

```json
{
  "id": "plugin-id",
  "name": "Display Name",
  "version": "1.0.0",
  "author": "Author Name",
  "description": "What this plugin does",
  "minAppVersion": "0.9.4",
  "contributes": {
    "informationTypes": [{
      "id": "info_type_id",
      "name": "Tab Label",
      "entity": "artist|album|track|tag",
      "displayKind": "rich_text|lyrics|stat_grid|...",
      "ttl": 7776000,
      "order": 200,
      "priority": 300
    }],
    "imageProviders": [{
      "entity": "artist|album",
      "priority": 400
    }],
    "contextMenuItems": [{
      "id": "action-id",
      "label": "Menu Label",
      "targets": ["track", "album", "artist", "multi-track"]
    }],
    "sidebarItems": [{
      "id": "view-id",
      "label": "Sidebar Label",
      "icon": "icon-name"
    }],
    "eventHooks": ["track:started", "track:scrobbled", "track:liked", "track:played"],
    "settingsPanel": {
      "id": "settings-id",
      "label": "Settings Tab Label",
      "order": 40
    },
    "fallbackProviders": [{
      "id": "provider-id",
      "name": "Provider Name"
    }]
  }
}
```

## Plugin Lifecycle

1. **Discovery** — `invoke("plugin_list_installed")` scans user and built-in plugin dirs. User plugins override built-in by ID.
2. **Validation** — checks `minAppVersion` via semver comparison. Incompatible plugins get status `"incompatible"`.
3. **Activation** — reads `index.js` via `plugin_read_file`, executes `new Function("api", code)(api)`, calls `activate(api)`.
4. **Running** — plugin handlers respond to events, fetch requests, UI actions.
5. **Deactivation** — calls `deactivate()`, clears all handlers and unsubscribers.

When a plugin's version changes, all its cached values are deleted, forcing re-fetch.

## Plugin API

Plugins receive an `api` object. The plugin exports `activate(api)` and optionally `deactivate()`.

### api.library
- `getTracks(opts?)` / `getArtists()` / `getAlbums()` / `getTrackById(id)` — library queries
- `search(query)` — search library
- `getHistory(opts?)` / `getMostPlayed(opts?)` — play history
- `recordHistoryPlaysBatch(plays)` — batch import history
- `applyTags(trackId, tagNames)` — tag tracks

### api.playback
- `getCurrentTrack()` / `isPlaying()` / `getPosition()`
- `playTidalTrack(track)` / `enqueueTidalTrack(track)` / `playTidalTracks(tracks, startIndex)`
- `onTrackStarted(handler)` / `onTrackPlayed(handler)` / `onTrackScrobbled(handler)` / `onTrackLiked(handler)`
- `onFallbackResolve(providerId, handler)` — resolve tracks from external sources

### api.contextMenu
- `onAction(actionId, handler)` — handle context menu clicks, receives `PluginContextMenuTarget`

### api.ui
- `setViewData(viewId, data)` — render plugin views (PluginViewData types)
- `showNotification(message)` / `navigateToView(viewId)` / `requestAction(action, payload)`
- `onAction(actionId, handler)` — handle UI action events

### api.storage
- `get<T>(key)` / `set(key, value)` / `delete(key)` — persistent key-value storage (SQLite-backed)

### api.network
- `fetch(url, init?)` — HTTP requests (proxied through Rust backend)
- `openUrl(url)` / `openBrowseWindow(url, opts)` — open URLs/browser windows
- `onDeepLink(handler)` / `onOAuthCallback(handler)` / `startOAuthListener()` — OAuth/deep link support

### api.tidal
- `search(query, limit, offset)` / `getAlbum(id)` / `getArtist(id)` / `getArtistAlbums(id)`
- `getStreamUrl(trackId, quality)` / `downloadTrack(trackId, opts)` / `downloadAlbum(albumId, opts)`
- `checkStatus()` — check TIDAL availability

### api.collections
- `getLocalCollections()` / `getDownloadFormat()`

### api.playlists
- `save(data)` / `list()` / `delete(id)` / `getTracks(id)`

### api.informationTypes
- `onFetch(infoTypeId, handler)` — register fetch handler, returns `{ status: "ok", value }` or `{ status: "not_found" }` or `{ status: "error" }`
- `invoke<T>(command, args)` — call any Tauri backend command

### api.imageProviders
- `onFetch(entity, handler)` — register image fetch handler for `"artist"` or `"album"`. Returns `{ status: "ok", url, headers? }` or `{ status: "ok", data }` (base64) or `{ status: "not_found" }` or `{ status: "error" }`

## Information Sections

Tabbed metadata panels shown on entity detail pages (artists, albums, tracks, tags).

### Provider Chain

Multiple plugins can provide the same information type ID (e.g., both `lastfm` and `genius` provide `artist_bio`). Lower `priority` number = tried first. First success wins.

### Entity Keys

Cached values use **name-based keys** (not DB IDs), enabling cross-library metadata sharing:
- Artist: `artist:{name}`
- Album: `album:{artistName}:{name}`
- Track: `track:{artistName}:{name}`
- Tag: `tag:{name}`

### Cache Decision Logic (`useInformationTypes.ts`)

| Cached Status | TTL State | Action |
|---|---|---|
| No cache | — | fetch (show loading) |
| `"ok"` | fresh | render cached |
| `"ok"` | stale | render cached + refetch in background |
| `"not_found"` / `"error"` | fresh (< 1 hour) | hidden |
| `"not_found"` / `"error"` | stale (>= 1 hour) | retry fetch |

Success TTL is per-type (e.g., 90 days for bios, 7 days for popularity). Error TTL is fixed 1 hour. Concurrent fetches for the same `typeId:entityKey` are deduplicated via `inFlightRef` Set.

### Placement

| Placement | Display Kinds |
|---|---|
| **Title (inline in header)** | `title_line` — rendered by `TitleLineInfo.tsx`, never appears as a tab |
| **Right sidebar** | `ranked_list`, `tag_list`, `image_gallery` |
| **Below (main tabs)** | All others: `rich_text`, `html`, `entity_list`, `entity_cards`, `stat_grid`, `lyrics`, `annotated_text`, `annotations`, `key_value` |

### Display Kind Data Schemas

| displayKind | Data Shape |
|---|---|
| `rich_text` | `{summary, full?}` |
| `html` | `{content}` |
| `entity_list` | `{items: [{name, subtitle?, match?, image?, libraryId?, libraryKind?}]}` |
| `entity_cards` | `{items: [{name, subtitle?, match?, image?, libraryId?, libraryKind?}]}` |
| `stat_grid` | `{items: [{label, value, unit?}]}` |
| `lyrics` | `{text, kind: "plain"|"synced", lines?: [{time, text}]}` |
| `tag_list` | `{tags: [{name, url?}], suggestable?}` |
| `ranked_list` | `{items: [{name, subtitle?, value, maxValue?, libraryId?, libraryKind?}]}` |
| `annotated_text` | `{overview?, sections: [{heading?, text}]}` |
| `annotations` | `{overview?, annotations: [{fragment, explanation}]}` |
| `key_value` | `{items: [{key, value}]}` |
| `image_gallery` | `{images: [{url, caption?, source?}]}` |
| `title_line` | `{items: [{label, value}]}` |

### Built-in Actions

Renderers emit actions via `onAction(actionId, payload)`. Built-in actions handled by `InformationSections.tsx`:

| Action | Payload | Behavior |
|---|---|---|
| `save-lyrics` | `{text, kind}` | Upserts lyrics to cache |
| `play-track` | `{id}` | Plays library track by ID |
| `play-or-youtube` | `{name, artist?}` | Tries library, falls back to YouTube |
| `youtube-search` | `{name, artist?}` | Opens YouTube search |

## Image Provider Chain (Rust-JS Bridge)

Image fetching uses a bridge between the Rust download worker and JS plugin handlers.

### Flow

1. **Album only:** Rust tries `EmbeddedArtworkProvider` first (extracts from audio file via `lofty`). If found, bridge is skipped.
2. Rust worker creates a one-shot `mpsc` channel, registers it in `ImageResolveRegistry`, emits `image-resolve-request` event to frontend.
3. `useImageResolver.ts` receives event, queries `get_image_providers` for active providers in priority order.
4. Calls each plugin's `imageFetchHandlers` sequentially. First `{status: "ok"}` wins.
5. Sends result back via `image_resolve_response` command (URL with optional headers, or base64 data).
6. Rust worker downloads from URL (or decodes base64), saves to disk, emits `artist-image-ready` / `album-image-ready`.
7. On failure or 30s timeout: records in `image_fetch_failures` table.

### Default Priority Order (user-configurable via Settings > Providers)

**Artist:** TIDAL (100) -> Deezer (200) -> iTunes (300) -> AudioDB (400) -> MusicBrainz (500)
**Album:** Embedded (Rust-native, always first) -> TIDAL (100) -> iTunes (200) -> Deezer (300) -> MusicBrainz (500)

### Provider Management

Users can drag-and-drop reorder and toggle providers on/off in Settings > Providers. `sync_image_providers()` and `info_sync_types()` preserve user-customized priorities when plugins reload. `reset_provider_priorities` restores manifest defaults.

## Plugin View Rendering

Plugins with sidebar items render UI via `PluginViewData` (separate from info type renderers):

Types: `track-list`, `card-grid`, `track-row-list`, `text`, `stats-grid`, `button`, `toggle`, `select`, `layout` (vertical/horizontal container), `spacer`, `search-input`, `tabs`, `loading`, `progress-bar`, `settings-row`, `section`.

## Database Tables

- **`information_types`** — registered info types with `type_id`, `entity`, `display_kind`, `plugin_id`, `ttl`, `sort_order`, `priority`, `active`. Unique on `(type_id, plugin_id)`.
- **`information_values`** — cached values with `information_type_id`, `entity_key` (name-based), `value` (JSON), `status`, `fetched_at`. Primary key on `(information_type_id, entity_key)`.
- **`image_providers`** — registered image providers with `plugin_id`, `entity`, `priority`, `active`.
- **`plugin_storage`** — per-plugin key-value store. Primary key on `(plugin_id, key)`.

## Existing Plugins

| Plugin | Contributions |
|--------|-------------|
| **allmusic** | Artist biographies (info type: `artist_bio`, `rich_text`) |
| **audiodb** | Artist images (priority 400) |
| **deezer** | Artist images (200), album images (300) |
| **genius** | Song explanations (`annotations`), artist/album bios (`rich_text`, priority 200 — fallback after Last.fm) |
| **itunes** | Artist images (300), album images (200) |
| **lastfm** | 9 info types (stats, bios, similar, popularity, tags), scrobbling, event hooks, settings panel |
| **lrclib** | Synced/plain lyrics (`lyrics`) |
| **lyrics-ovh** | Plain lyrics (priority 300) |
| **lyrics-search** | Meta-search lyrics via DuckDuckGo (priority 400, settings) |
| **musicbrainz** | Artist images (500), album images (500) |
| **spotify-browse** | Sidebar (Spotify), OAuth PKCE auth, liked songs, playlists, search |
| **tidal-browse** | Sidebar (TIDAL), context menus (search/upgrade/play), artist+album images (100), fallback provider |
