# Plugins

Plugins extend Viboplr with information sections, image providers, stream resolvers, download providers, context menu actions, sidebar views, event hooks, and settings panels.

## Architecture

Two-layer system:
1. **Rust layer** — image download worker with Rust-JS bridge, embedded artwork extraction, SQLite-backed caching, plugin file I/O, info type / image provider / stream resolver / download provider storage, scheduler, system exec (allow-listed), env var access.
2. **TypeScript layer** — plugin discovery and loading (`usePlugins.ts`), info type orchestration (`useInformationTypes.ts`), image resolution bridge (`useImageResolver.ts`), stream resolver chain and download provider chain (`App.tsx`), rendering (`InformationSections.tsx`, `PluginViewRenderer.tsx`).

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
  "debugOnly": false,
  "icon": "M...",
  "homepage": "https://...",
  "updateUrl": "https://.../manifest.json",
  "apiUsage": [{ "api": "network.fetch", "reason": "Fetch metadata" }],
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
    "streamResolvers": [{
      "id": "resolver-id",
      "name": "Resolver Name",
      "priority": 300
    }],
    "downloadProviders": [{
      "id": "provider-id",
      "name": "Provider Name",
      "priority": 300
    }],
    "contextMenuItems": [{
      "id": "action-id",
      "label": "Menu Label",
      "targets": ["track", "album", "artist", "multi-track", "playlist"]
    }],
    "sidebarItems": [{
      "id": "view-id",
      "label": "Sidebar Label",
      "icon": "icon-name"
    }],
    "eventHooks": ["track:started", "track:scrobbled", "track:liked", "track:added", "track:removed", "scan:complete"],
    "settingsPanel": {
      "id": "settings-id",
      "label": "Settings Tab Label",
      "order": 40
    }
  }
}
```

`debugOnly: true` hides the plugin unless the app is running in debug mode. Plugins reload automatically when the debug mode setting flips.

## Plugin Lifecycle

1. **Discovery** — `invoke("plugin_list_installed")` scans user and built-in plugin dirs. User plugins override built-in by ID.
2. **Validation** — checks `minAppVersion` via semver comparison. Incompatible plugins get status `"incompatible"`. `debugOnly` plugins are filtered out when debug mode is off.
3. **Activation** — reads `index.js` via `plugin_read_file`, executes `new Function("api", code)(api)`, calls `activate(api)`.
4. **Running** — plugin handlers respond to events, fetch requests, UI actions, stream/download resolves.
5. **Deactivation** — calls `deactivate()`, clears all handlers and unsubscribers.

When a plugin's version changes, all its cached information values are deleted, forcing re-fetch.

## Plugin API

Plugins receive an `api` object. The plugin exports `activate(api)` and optionally `deactivate()`. The canonical TypeScript definitions live in `src/types/plugin.ts` (`ViboplrPluginAPI`).

### api.log(level, message, section?)

Top-level logger. Writes to the app's frontend log stream. Prefer this over `console.log` for persistent diagnostics.

### api.library
- `getTracks(opts?)` — `{ artistId?, albumId?, tagId?, limit?, offset? }`
- `ftsTracks(query, opts?)` / `ftsArtists(query, opts?)` / `ftsAlbums(query, opts?)` / `ftsTags(query, opts?)` — FTS5 search
- `getArtists(opts?)` / `getAlbums(opts?)` / `getTags(opts?)` — paginated listings (`getAlbums` accepts `artistId`)
- `getTrackById(id)` / `getArtistById(id)` / `getAlbumById(id)` / `getTagById(id)`
- `getHistory(opts?)` / `getMostPlayed(opts?)` — `opts.days` switches to the rolling-window variant
- `recordHistoryPlaysBatch(plays)` — batch import scrobbles, returns `{ imported, skipped }`
- `applyTags(trackId, tagNames)` — tag tracks
- `onTrackAdded(handler)` / `onTrackRemoved(handler)` / `onScanComplete(handler)` — library events

### api.playback
- `getCurrentTrack()` / `isPlaying()` / `getPosition()`
- `playTrack(track)` / `playTracks(tracks, startIndex?, context?)` — `track` is a `PluginTrack`; `context` is `{ name, coverUrl?, source?, metadata? }`
- `insertTrack(track, position)` / `insertTracks(tracks, position)` — insert into the current queue
- `onTrackStarted(handler)` / `onTrackScrobbled(handler)` / `onTrackLiked(handler)` — playback events
- `onStreamResolve(providerId, handler)` — handler gets `(title, artistName, albumName, durationSecs)`, returns `{ url, label } | null`
- `onResolveStreamByUri(scheme, handler)` — handler gets `(id, quality?)` and returns a URL; used for custom URL schemes (e.g., `tidal://`)

`PluginTrack`: `{ path?, title, artist_name?, album_title?, duration_secs?, track_number?, image_url? }`. `image_url` is shown in the now playing bar and queue when no library image exists.

### api.contextMenu
- `onAction(actionId, handler)` — handle clicks on registered context menu items. Handler receives a `PluginContextMenuTarget`.

### api.ui
- `setViewData(viewId, data)` — render plugin views (see `PluginViewData` types)
- `showNotification(message)` / `navigateToView(viewId)` / `requestAction(action, payload)`
- `onAction(actionId, handler)` — handle UI action events emitted from plugin views
- `setBadge(viewId, badge)` — set a sidebar badge: `null | { type: "dot", variant } | { type: "count", value, variant }`

### api.storage
- `get<T>(key)` / `set(key, value)` / `delete(key)` — SQLite-backed key-value storage per plugin
- `cacheFile(subdir, filename, url)` / `getCachePath(subdir, filename)` / `listCacheDirs()` / `deleteCacheDir(subdir)` — flat file cache (legacy)
- `files` — nested plugin file storage (see below)

### api.storage.files

Nested file I/O rooted inside the plugin's data directory. `path` is a string array (path segments joined safely by the backend).
- `writeJson(path, data)` / `readJson<T>(path)`
- `writeText(path, content)` / `readText(path)`
- `download(path, url)` — fetch URL through Rust and write to disk
- `getPath(path)` / `exists(path)`
- `list(path)` — returns `[{ name, isDir }]`
- `remove(path)` / `copy(src, dst)` / `move(src, dst)`

### api.network
- `fetch(url, init?)` — HTTP requests proxied through Rust (bypasses CORS). Returns `{ status, text(), json() }`.
- `openUrl(url)` — open in system browser
- `onDeepLink(handler)` — subscribe to deep links delivered to the app
- `openBrowseWindow(url, opts?)` — opens an embedded browse window. Returns `BrowseWindowHandle` with `eval`, `close`, `show`, `hide`, `onMessage`, `onNavigation`.

### api.collections
- `getLocalCollections()` — returns local-kind collections as `[{ id, name, path }]`

### api.playlists
- `save(data)` / `list()` / `delete(id)` / `getTracks(id)` — saved playlists (source-aware, image-aware)

### api.informationTypes
- `onFetch(infoTypeId, handler)` — handler receives an `InfoEntity`, returns `{ status: "ok", value } | { status: "not_found" } | { status: "error", message? }`.

There is **no** `api.informationTypes.invoke` escape hatch — plugins cannot call arbitrary Tauri commands.

### api.imageProviders
- `onFetch(entity, handler)` — entity is `"artist"` or `"album"`. Handler receives `(name, artistName?)` and returns `{ status: "ok", url, headers? } | { status: "ok", data } | { status: "not_found" } | { status: "error", message? }`.

### api.downloads
- `getDownloadFormat()` — returns the user's configured download format (`"flac" | "m4a" | "mp3" | "aac"`)
- `enqueue(request)` — queue a download through the unified downloader. `request: { title, artistName?, albumTitle?, uri?, durationSecs?, destCollectionId?, destCollectionPath?, format?, provider? }`. Returns the download ID.
- `onResolveByUri(providerId, handler)` — handler receives `(uri, format)` and returns a `DownloadResolveResult | null`
- `onResolveByMetadata(providerId, handler)` — handler receives `(title, artistName, albumName, durationSecs, format)`
- `onInteractiveSearch(providerId, handler)` — handler receives `(query, limit)` and returns `InteractiveSearchResult[]` for the `DownloadModal` manual-search flow
- `onInteractiveResolve(providerId, handler)` — handler receives `(matchId, format)` and returns a `DownloadResolveResult`

`DownloadResolveResult`: `{ url, headers?, metadata?: { title, artist, album, trackNumber, year, genre, coverUrl } }`.

### api.scheduler
- `register(taskId, intervalMs)` / `unregister(taskId)` / `complete(taskId)` — periodic task registration. Backend emits `plugin-scheduler-due` events at the configured interval.
- `onDue(taskId, handler)` — invoked when the task is due

### api.system
- `exec(program, args?, opts?)` — run a subprocess, returns `{ exitCode, stdout, stderr }`. **Allow-list only:** currently `yt-dlp` and `ffmpeg`. `opts.cwd` defaults to the app data directory.

### api.env
- `get(key)` — read an environment variable

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

## Stream Resolver Chain

Stream resolvers provide playback URLs when a track's native source isn't available (e.g., library track missing on disk, no local file for a TIDAL track).

### Flow (`App.tsx` `streamResolversRef`)

For each track to play:
1. If a local copy exists for the track's metadata, use it.
2. If the track has a native URL (`file://`, `subsonic://`, `tidal://`, or `http(s)://`), try the native resolver.
3. Walk the user-ordered list of plugin stream resolvers. Each is called with `(title, artistName, albumName, durationSecs)` and has 15 seconds to return `{ url, label } | null`.
4. First success wins. Failures fall through to the next resolver. `addLog` surfaces fallback info to the user.

### Custom URL Schemes

`api.playback.onResolveStreamByUri(scheme, handler)` registers a resolver for a URL scheme (e.g., `tidal://`). The handler returns a playable URL for a given `(id, quality?)`. This replaced the old built-in TIDAL integration.

### Configuration

Users can drag-and-drop reorder and toggle stream resolvers on/off in Settings > Providers. Order and enabled state are stored under `streamResolverOrder` in the app store. Per-resolver auto-save (caching resolved URLs back to the track) is stored under `autoSaveStreams`.

## Download Provider Chain

Download providers implement URL resolution for the unified `DownloadModal`.

- **By URI:** a plugin handles a specific scheme (e.g., `tidal://`, `external://`) via `onResolveByUri`. Used when the app already has a canonical URI.
- **By metadata:** a plugin accepts arbitrary `(title, artistName, albumName, durationSecs, format)` via `onResolveByMetadata`. Used for automatic fallbacks (e.g., YouTube search-and-download).
- **Interactive:** a plugin contributes `onInteractiveSearch` + `onInteractiveResolve`, surfaced as manual search inside `DownloadModal` with per-track picking.

Providers are prioritized by manifest `priority`. The built-in Subsonic provider handles `subsonic://` URIs natively.

## Plugin View Rendering

Plugins with sidebar items render UI via `PluginViewData` (separate from info type renderers). Set data via `api.ui.setViewData(viewId, data)`.

| Type | Purpose |
|---|---|
| `track-list` | Full track list with library-style rendering |
| `card-grid` | Grid of image cards (playlists, albums, artists). Items can carry `contextMenuActions` + `tracks` for pass-through context menus. |
| `track-row-list` | Compact row list (selectable, per-row actions) |
| `text` | Plain / class-styled text |
| `stats-grid` | Label/value stat tiles |
| `button` | Action button (`accent` / `secondary`, disabled, custom data payload) |
| `toggle` | Boolean toggle with `checked` state (**not** `value` — that was a historical bug) |
| `select` | Dropdown with options |
| `layout` | Vertical / horizontal container with children |
| `spacer` | Layout spacer |
| `search-input` / `text-input` | Text entry that fires an action on change |
| `tabs` | Tab bar with `activeTab` |
| `loading` | Loading spinner with optional message |
| `progress-bar` | `{value, max, label?}` |
| `toolbar` | Titled button bar with optional status text |
| `settings-row` | Label + description + right-side control or child view |
| `section` | Titled grouping wrapper |
| `confirm` | Modal-style confirm with `confirmAction` / `cancelAction` and optional `data` payload |
| `detail-header` | Detail-page header (title, subtitle, meta, image, actions, back/play/context-menu actions) |

### Toggle Control Note

Toggle controls use `checked: boolean`, not `value`. `{ type: "toggle", label, action, checked }`.

## Database Tables

- **`information_types`** — registered info types with `type_id`, `entity`, `display_kind`, `plugin_id`, `ttl`, `sort_order`, `priority`, `active`. Unique on `(type_id, plugin_id)`.
- **`information_values`** — cached values with `information_type_id`, `entity_key` (name-based), `value` (JSON), `status`, `fetched_at`. Primary key on `(information_type_id, entity_key)`.
- **`image_providers`** — registered image providers with `plugin_id`, `entity`, `priority`, `active`.
- **`stream_resolvers`** — registered stream resolvers with `plugin_id`, `resolver_id`, `priority`, `active`.
- **`download_providers`** — registered download providers with `plugin_id`, `provider_id`, `priority`, `active`.
- **`plugin_storage`** — per-plugin key-value store. Primary key on `(plugin_id, key)`.
- **`plugin_schedules`** — periodic task state.

## Existing Plugins

| Plugin | Contributions |
|--------|-------------|
| **audiodb** | Artist images (priority 400) |
| **auto-tagger** | Sidebar view; reacts to `track:added` and `scan:complete` to suggest/auto-assign tags |
| **deezer** | Artist images (200), album images (300) |
| **genius** | Song bio + song meaning (annotations), artist + album bios (rich_text, priority 200) |
| **itunes** | Artist images (300), album images (200) |
| **lastfm** | Multiple info types (stats, bios, similar, popularity, tags), scrobbling, event hooks, settings panel |
| **lrclib** | Synced/plain lyrics (priority 100) |
| **lyrics-ovh** | Plain lyrics (priority 300) |
| **lyrics-search** | Meta-search lyrics via Google + whitelisted scrapers (priority 400, settings panel) |
| **mock-download** | `debugOnly` download provider (priority 900) with settings panel — testing harness for the unified download flow |
| **musicbrainz** | Artist images (500), album images (500) |
| **spotify-browse** | Sidebar (Spotify), scrape-based browse (playlists/liked), settings panel with scrape diagnostics |
| **tidal-browse** | Sidebar (TIDAL), artist+album images (100), context menus (search/play/download-playlist), download provider (priority 100), stream resolver (priority 200), custom `tidal://` URI stream resolver |
| **youtube** | Stream resolver (priority 300) + download provider (priority 300) via `yt-dlp` + `ffmpeg`, settings panel with dependency checks |
