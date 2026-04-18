# Plugins

Plugins extend Viboplr with information sections, image providers, context menu actions, sidebar views, event hooks, and settings panels.

## Directory Structure

Plugins live in `src-tauri/plugins/`. Each plugin is a folder with:
```
plugin-name/
├── manifest.json    # Metadata and contributions
└── index.js         # Plugin code (ES5, executed via new Function("api", code))
```

User-installed plugins (in the app data directory) override built-in plugins with the same ID.

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
      "description": "What it shows",
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

## Plugin API

Plugins receive a `api` object in their `new Function("api", code)` execution context. The plugin exports `activate(api)` and optionally `deactivate()`.

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
- `fetch(url, init?)` — HTTP requests
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
- `onFetch(entity, handler)` — register image fetch handler, returns `{ status: "ok", url }` or `{ status: "not_found" }`

## Display Kinds

For `informationTypes[].displayKind`: `rich_text`, `html`, `entity_list`, `entity_cards`, `stat_grid`, `lyrics`, `tag_list`, `ranked_list`, `annotated_text`, `annotations`, `key_value`, `image_gallery`, `title_line`.

## Existing Plugins

| Plugin | What it does |
|--------|-------------|
| **allmusic** | Artist biographies from AllMusic |
| **audiodb** | Artist images from TheAudioDB |
| **deezer** | Artist and album images from Deezer |
| **genius** | Song explanations, artist/album descriptions, annotated lyrics |
| **itunes** | Artist and album images from iTunes |
| **lastfm** | Scrobbling, now playing, history import, metadata (9 info types + settings + event hooks) |
| **lrclib** | Synced and plain lyrics from LRCLIB |
| **lyrics-ovh** | Plain lyrics from Lyrics.ovh |
| **lyrics-search** | Meta-search lyrics via DuckDuckGo with site scrapers |
| **musicbrainz** | Artist and album images from MusicBrainz / Cover Art Archive |
| **spotify-browse** | Browse Spotify liked songs and playlists (DOM scraping) |
| **tidal-browse** | Search, stream, download from TIDAL (images + sidebar + context menus + fallback) |

## Key Implementation Details

- Plugins execute in a sandboxed `new Function()` context — no global scope access
- Multiple plugins can provide the same information type; lower priority number = checked first
- Plugin state persists in the backend SQLite database per plugin ID
- Information types and image providers are synced to the DB via `info_sync_types()` / `sync_image_providers()`
- Frontend loading: `usePlugins.ts` → `plugin_list_installed` command → read `index.js` → execute → call `activate(api)`
- Gallery plugins can be installed from remote (GitHub-hosted) via `install_gallery_plugin`
