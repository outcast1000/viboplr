---
name: plugin-system
description: "Use when modifying the Viboplr plugin system: information sections, information retrieval, renderers, lyrics, TIDAL, Spotify, image providers, or creating/editing plugins"
trigger: "When the user is working on plugin-related code, information type sections, renderers, lyrics, TIDAL integration, Spotify integration, image providers, or plugin manifest/API changes"
---

# Viboplr Plugin System Guide

This skill provides comprehensive context for working on the Viboplr plugin system. Use it whenever modifying plugins, information types, renderers, the provider chain, lyrics, TIDAL, Spotify, or image providers.

## Quick Reference — Where Things Live

### Core Plugin Infrastructure

| What | File | Key Lines |
|---|---|---|
| Plugin discovery, loading, API construction | `src/hooks/usePlugins.ts` | `loadPlugins()`, `activatePlugin()`, `buildAPI()` |
| Info type cache + provider chain orchestration | `src/hooks/useInformationTypes.ts` | `loadSections()`, `decideCacheAction()` |
| Image resolve Rust-JS bridge | `src/hooks/useImageResolver.ts` | Listens for `image-resolve-request`, runs plugin fallback chain |
| Tab UI, renderer dispatch, action handling | `src/components/InformationSections.tsx` | `handleAction()` |
| Provider Priority settings UI | `src/components/SettingsPanel.tsx` | Drag-and-drop reorder, toggle on/off, reset defaults |
| Renderer registry (displayKind → component) | `src/components/renderers/index.ts` | `renderers` map |
| All TS types: manifest, API, view data | `src/types/plugin.ts` | `ViboplrPluginAPI`, `ImageFetchResult`, `PluginImageProvidersAPI` |
| Display kind types, entity keys, cache types | `src/types/informationTypes.ts` | `DisplayKind`, `buildEntityKey()` |
| Tauri commands for plugin/info/provider CRUD | `src-tauri/src/commands.rs` | `info_sync_types`, `sync_image_providers`, provider management |
| SQLite schema + queries | `src-tauri/src/db.rs` | `info_sync_types()`, `sync_image_providers()`, `get_all_provider_config()` |
| Embedded album artwork provider + utilities | `src-tauri/src/image_provider/mod.rs` | `AlbumImageProvider` trait, `embedded.rs` |

### Built-in Plugins (all under `src-tauri/plugins/`)

| Plugin | Dir | Contributes |
|---|---|---|
| Last.fm | `lastfm/` | 9 info types (artist/album/track), events, settings panel |
| Genius | `genius/` | 3 info types (shares `artist_bio`/`album_wiki` IDs with Last.fm as priority-200 fallback) |
| LRCLIB | `lrclib/` | 1 info type (lyrics) |
| TIDAL Browse | `tidal-browse/` | Sidebar + 3 context menu items + image providers (artist+album, priority 100) |
| Spotify Browse | `spotify-browse/` | Sidebar only (OAuth PKCE) |
| Deezer | `deezer/` | Image providers: artist (priority 200), album (priority 300) |
| iTunes | `itunes/` | Image providers: artist (priority 300), album (priority 200) |
| TheAudioDB | `audiodb/` | Image providers: artist (priority 400) |
| MusicBrainz | `musicbrainz/` | Image providers: artist (priority 500), album (priority 500) |
### Individual Renderers (all under `src/components/renderers/`)

`RichTextRenderer`, `HtmlRenderer`, `EntityListRenderer`, `EntityCardsRenderer`, `StatGridRenderer`, `LyricsRenderer`, `TagListRenderer`, `RankedListRenderer`, `AnnotatedTextRenderer`, `AnnotationsRenderer`, `KeyValueRenderer`, `ImageGalleryRenderer`, `TitleLineRenderer`

---

## Architecture at a Glance

The plugin system has two layers:

1. **Rust backend** — Image download worker with Rust-JS bridge, embedded artwork extraction, SQLite-backed information type/value/image provider storage, TIDAL client, plugin file I/O
2. **TypeScript frontend** — Plugin discovery/activation, API construction, info type fetch orchestration with provider fallback, image resolve bridging, provider priority settings UI, rendering

Plugins are JS files (`index.js` + `manifest.json`) loaded via `new Function()` in the renderer process. They receive a `ViboplrPluginAPI` object with namespaces: `library`, `playback`, `contextMenu`, `ui`, `storage`, `network`, `tidal`, `collections`, `informationTypes`, `imageProviders`.

Built-in plugins that contribute `imageProviders` or `informationTypes` are automatically enabled on first load.

---

## How To: Common Plugin Changes

### Adding a New Information Type to an Existing Plugin

1. Add entry to `manifest.json` → `contributes.informationTypes[]`:
   ```json
   { "id": "my_type", "name": "Display Name", "entity": "track", "displayKind": "rich_text", "ttl": 604800, "order": 300, "priority": 100 }
   ```
2. In `index.js`, register fetch handler:
   ```js
   api.informationTypes.onFetch("my_type", async (entity) => {
     // entity: { kind, name, id, artistName?, albumTitle? }
     const data = await api.network.fetch(url).then(r => r.json());
     return { status: "ok", value: { summary: data.text } };
     // or: { status: "not_found" } / { status: "error" }
   });
   ```
3. Ensure the `displayKind` has a matching renderer in `src/components/renderers/index.ts`
4. Bump plugin version to invalidate cache

### Adding a New Display Kind (Renderer)

1. Add to `DisplayKind` union in `src/types/informationTypes.ts`
2. Define data interface in same file
3. Create `MyRenderer.tsx` in `src/components/renderers/`
4. Implement `RendererProps` interface: `{ data, onEntityClick?, onAction?, resolveEntity?, context? }`
5. Register in `src/components/renderers/index.ts` → `renderers` map
6. Decide placement in `getInfoPlacement()` — add to `RIGHT_DISPLAY_KINDS` if it should show in sidebar

### Creating a New Plugin

1. Create directory: `src-tauri/plugins/my-plugin/` (built-in) or `{app_dir}/plugins/my-plugin/` (user)
2. Create `manifest.json` with required fields: `id`, `name`, `version`
3. Add optional `contributes` (sidebar, context menu, events, info types, settings)
4. Create `index.js` exporting `activate(api)` function
5. Optional: return `deactivate` function from `activate()` for cleanup

### Adding an Image Provider Plugin

1. Create plugin directory: `src-tauri/plugins/my-provider/`
2. Create `manifest.json` with `imageProviders` contribution:
   ```json
   {
     "id": "my-provider", "name": "My Provider", "version": "1.0.0",
     "contributes": {
       "imageProviders": [
         { "entity": "artist", "priority": 350 },
         { "entity": "album", "priority": 350 }
       ]
     }
   }
   ```
3. Create `index.js` and register image fetch handlers:
   ```js
   function activate(api) {
     api.imageProviders.onFetch("artist", async (name) => {
       const resp = await api.network.fetch(`https://api.example.com/artist?q=${encodeURIComponent(name)}`);
       if (!resp.ok) return { status: "not_found" };
       const data = await resp.json();
       return { status: "ok", url: data.imageUrl };
       // or: { status: "ok", data: "<base64 string>" }
     });
   }
   module.exports = { activate };
   ```
4. Priority determines fallback order (lower = tried first). Check existing providers to pick an appropriate value.

### Adding a Context Menu Action

1. Declare in `manifest.json` → `contributes.contextMenuItems[]`:
   ```json
   { "id": "my-action", "label": "Do Thing", "targets": ["track"] }
   ```
2. Register handler in `index.js`:
   ```js
   api.contextMenu.onAction("my-action", (target) => {
     // target: { kind, trackId?, title?, artistName?, albumId?, ... }
   });
   ```

### Adding a Sidebar View

1. Declare in `manifest.json` → `contributes.sidebarItems[]`:
   ```json
   { "id": "my-view", "label": "My View", "icon": "star" }
   ```
2. Render view in `index.js`:
   ```js
   api.ui.setViewData("my-view", {
     type: "layout", direction: "vertical",
     children: [
       { type: "text", content: "<h2>Hello</h2>" },
       { type: "button", label: "Click", action: "do-thing" }
     ]
   });
   api.ui.onAction("do-thing", () => { /* ... */ });
   ```

---

## Key Patterns to Follow

### Entity Keys Are Name-Based

Cached metadata uses name-based keys, NOT library IDs:
```
artist:Radiohead
album:Radiohead:OK Computer  
track:Radiohead:Paranoid Android
tag:electronic
```
This decouples cached data from any specific library collection.

### Provider Chain Fallback

Multiple plugins can provide the same `typeId`. They're tried in `priority` order (lower = first). First `status: "ok"` wins. This allows plugins to compete/override.

### Cache TTL Rules

- Success values: use per-type TTL (typically 7-90 days)
- Error/not_found values: fixed 1-hour TTL, then retry
- Stale "ok" values: display immediately while refetching in background
- Plugin version bump: invalidates all cached values for that plugin

### Information Type & Image Provider Sync

On plugin load, ALL active information types and image providers are synced to SQLite via `info_sync_types` and `sync_image_providers`. Types/providers from disabled/missing plugins become `active = 0` but their cached data is preserved. User-customized priorities are preserved across syncs.

### Plugin API Is Scoped Per-Plugin

Each plugin gets its own `api` object built by `buildAPI()`. Handler registrations are tracked per-plugin for proper cleanup on deactivation.

### Renderer Actions Flow Up

Renderers emit `onAction(actionId, payload)` → `InformationSections.handleAction()` handles built-in actions (`save-lyrics`, `play-track`, `play-or-youtube`, `youtube-search`), delegates others to parent.

### Plugin View Data vs Information Renderers

Two separate rendering systems:
1. **Information type renderers** — `displayKind` → `renderers[kind]` component. For metadata sections.
2. **Plugin view data** — `PluginViewData` tree rendered by `PluginViewRenderer`. For sidebar plugin views.

---

## Database Schema

```sql
-- Type registry (synced from manifests)
information_types (id, type_id, name, entity, display_kind, plugin_id, ttl, sort_order, priority, active)
  UNIQUE (type_id, plugin_id)

-- Cached values
information_values (information_type_id → information_types.id, entity_key, value JSON, status, fetched_at)
  PRIMARY KEY (information_type_id, entity_key)
  INDEX ON (entity_key)

-- Image provider registry (synced from manifests)
image_providers (id, plugin_id, entity CHECK('artist','album'), priority, active)

-- Per-plugin key-value storage
plugin_storage (plugin_id, key, value)
  PRIMARY KEY (plugin_id, key)
```

---

## TIDAL Specifics

- Rust client: `src-tauri/src/tidal.rs` — global singleton with instance failover + 24h cache
- Plugin API: `api.tidal.*` gives plugins access to search, albums, artists, streaming, downloads
- Image providers: `tidal-browse` plugin registers via `api.imageProviders.onFetch()` (priority 100 for both artist+album)
- Download: `downloader.rs` — FLAC/AAC/MP3, ID3/Vorbis tags, embedded covers
- Context menu: `tidal-browse` plugin adds search/upgrade/play actions
- Commands: `tidal_search`, `tidal_get_album`, `tidal_get_artist`, `tidal_get_stream_url`, etc.

## Spotify Specifics

- Browse-only plugin (no metadata/info types)
- OAuth PKCE flow with `crypto.subtle` for SHA-256
- Token persistence via `api.storage`
- Deep link callback via `api.network.onOAuthCallback()`
- Views: liked songs, playlists, search (tabs: tracks/artists/albums)

## Lyrics Specifics

- Provided by LRCLIB plugin (`src-tauri/plugins/lrclib/`)
- Synced lyrics: LRC format `[MM:SS.ms]text` parsed by `LyricsRenderer`
- Auto-scroll to current line based on `context.positionSecs`
- User editable: edit mode toggles between plain/synced, saves via `save-lyrics` action
- Lyrics data: `{ text, kind: "plain"|"synced", lines?: [{time, text}] }`

## Image Provider Chain (Rust-JS Bridge)

Image fetching uses a **Rust-JS bridge**. The Rust image worker emits `image-resolve-request` events to the frontend, where `useImageResolver.ts` runs the plugin fallback chain and sends results back via `image_resolve_response`.

- **Album images**: Embedded artwork (Rust-native via `lofty` crate) is always tried first. If not found, falls through to the bridge.
- **Artist images**: Always use the bridge directly.
- **Bridge mechanism**: `ImageResolveRegistry` in `commands.rs` uses one-shot `mpsc` channels. 30s timeout per request.
- **Plugin API**: `api.imageProviders.onFetch(entity, handler)` — handler returns `{status: "ok", url}`, `{status: "ok", data: "<base64>"}`, `{status: "not_found"}`, or `{status: "error", message}`.
- **Default artist order**: TIDAL (100) → Deezer (200) → iTunes (300) → AudioDB (400) → MusicBrainz (500)
- **Default album order**: Embedded (Rust) → TIDAL (100) → iTunes (200) → Deezer (300) → MusicBrainz (500)
- **User-configurable**: Priority and on/off state editable via Settings > Providers. Persisted in `image_providers` table.
- **Provider management commands**: `get_image_providers`, `get_all_provider_config`, `update_image_provider_priority`, `update_image_provider_active`, `reset_provider_priorities`
- Failed fetches cached in `image_fetch_failures` table

---

## Design Document

Full design document with data flow diagrams: `PLUGIN-SYSTEM.md`
