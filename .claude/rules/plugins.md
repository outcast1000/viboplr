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

### Externally-maintained plugins

These plugins are **not bundled** in `src-tauri/plugins/`. Their canonical source is a separate repo, and they are installed from the plugin gallery (`outcast1000/viboplr-plugins`, index-only) which resolves each entry's `updateUrl` to that repo's GitHub release zip. Once installed they live in the user plugin dir and auto-update via the same `updateUrl`. To change one, edit + release in its repo; there is no bundled copy here to sync.

| Plugin id | Canonical repo | Notes |
|---|---|---|
| `spotify-browse` | `outcast1000/viboplr-spotify` | Self-contained; release flow + `scripts/bump.sh` live in that repo. |
| `tidal-browse` | `outcast1000/viboplr-tidal` | Self-contained (HTTP via `api.network.fetch`); same release flow. |
| `p2p-sharing` | `outcast1000/viboplr-p2p` | **JS UI shell only.** The P2P engine lives in this host's Rust (`src-tauri/src/p2p/`, the `api.p2p.*` bridge) and is version-coupled to `outcast1000/viboplr-relay`. Releases in that repo change only the UI; protocol/networking changes are host+relay changes here. The plugin's `minAppVersion` gates its install/auto-update — bump it when you change `api.p2p.*` so older apps don't pull an incompatible shell. |
| `youtube` | `outcast1000/viboplr-youtube` | Self-contained; contributes the `youtube-fallback` stream resolver + `youtube-download` download provider. Shells out to `yt-dlp`/`ffmpeg` via `api.system.exec`. Same release flow (`scripts/bump.sh` + CI) as the others. **Not** in the gallery as a loose copy — un-bundling means fresh installs have no YouTube playback/download until it's installed from the gallery. |

### Registering a plugin in the gallery

The gallery (`outcast1000/viboplr-plugins`) is **index-only** — it hosts no plugin code, only an `index.json` that points at each plugin's own-repo release. "Registering" a plugin = adding an entry to that `index.json`. The chain is:

```
viboplr-plugins/index.json  →  entry.updateUrl  →  <repo>/releases/latest/download/update.json  →  the .zip
```

At install, `install_gallery_plugin_by_update_url` reads the entry's `updateUrl`, fetches that `update.json` (enforcing `minAppVersion`), downloads the `file` zip it names, and installs via `install_plugin_from_zip`. So the plugin's repo + a published release must exist **before** registering — the gallery entry is the last step, not the first.

**Steps:**

1. **Plugin repo with a release.** The repo has `manifest.json` + `index.js`; the release assets are `<name>.zip` (with `manifest.json` at the zip **root** — the installer does not strip a wrapper folder) and `update.json`. The `scripts/package.sh` + `.github/workflows/release.yml` pattern (see `viboplr-youtube`) produces both. The permanent endpoint is `https://github.com/<owner>/<repo>/releases/latest/download/update.json`.

2. **Add an entry to `index.json`** (`version: 2`, under `plugins[]`):
   ```json
   {
     "id": "youtube",
     "name": "YouTube",
     "author": "Viboplr",
     "description": "Play and download tracks from YouTube via yt-dlp",
     "minAppVersion": "0.9.4",
     "updateUrl": "https://github.com/outcast1000/viboplr-youtube/releases/latest/download/update.json"
   }
   ```
   - `id` **must** match the plugin's `manifest.json` `id` exactly (it's the override/storage key).
   - `updateUrl` is the only load-bearing field for install. `name`/`description` are display metadata you maintain by hand; **`version` and `minAppVersion` are auto-synced from your live `update.json` by the gallery's reconcile bot** (`scripts/reconcile-versions.mjs` — daily + on release), so you don't hand-maintain them (omit them and the bot backfills; the submission bot also seeds `version` on merge). The *real* version/min-app gate is always enforced from the live `update.json` at install regardless.
   - Optional behavior fields: `recommended` / `profiles` (onboarding pre-selection) and `stability` (`"experimental"` moves the entry into the gallery's collapsed Experimental section in-app and the Experimental group on the site, excludes it from onboarding, and badges already-installed copies until the plugin's own manifest carries the field — see "Manifest Format").

3. **Commit & push `index.json`.** Live for everyone on their next Extensions open — no host app release required.

**After registration, updates are automatic** — the app re-checks each `updateUrl` ~every 24h and auto-updates installed copies, and the gallery's reconcile bot keeps each entry's displayed `version`/`minAppVersion` in step with its live `update.json`. Touch `index.json` by hand again only for material display changes (rename, description, `recommended`/`stability`).

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
      "ttl": 7776000
    }],
    "imageProviders": [{
      "entity": "artist|album|tag"
    }],
    "streamResolvers": [{
      "id": "resolver-id",
      "name": "Resolver Name"
    }],
    "downloadProviders": [{
      "id": "provider-id",
      "name": "Provider Name"
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
    },
    "homeShelves": [{
      "id": "shelf-id",
      "title": "Shelf Title",
      "displayKind": "album-cards|artist-cards|playlist-cards|track-rows",
      "limit": 20,
      "icon": "icon-name"
    }]
  }
}
```

`debugOnly: true` hides the plugin unless the app is running in debug mode. Plugins reload automatically when the debug mode setting flips.

`autoEnable` (optional, top-level) is an **opt-out** flag for the first-launch auto-enable of **built-in** plugins. On first launch only (no saved `enabledPlugins` list yet), every built-in plugin is enabled automatically — *except* those with `autoEnable: false`, which start disabled. Absent/`true` = enabled on first launch (the default). Once the user has a saved enable/disable list, their choices are always respected. Has no effect on user/gallery-installed plugins.

`stability` (optional, top-level) declares plugin maturity. Absent = stable; `"experimental"` gives the plugin an "Experimental" badge (with a disclaimer tooltip) in the Extensions view, quarantines its gallery entry into a collapsed "Experimental" section, and excludes it from the onboarding wizard's recommendations. **Unrecognized values are treated as experimental-tier (fail-safe)** — never as stable — and the UI always renders the tier label "Experimental" rather than echoing the raw value. The gallery `index.json` entry mirrors the field for pre-install presentation; installed copies fall back to the gallery entry's value when their manifest lacks the field (dev plugins exempt — their local manifest is authoritative). One shared classifier (`src/utils/pluginStability.ts`) implements the rule for the app; `docs/js/gallery.js` carries a synced copy for the site. A future built-in plugin marked experimental should also set `autoEnable: false` so first-launch auto-enable doesn't switch it on.

## Plugin Lifecycle

1. **Discovery** — `invoke("plugin_list_installed")` scans user and built-in plugin dirs. User plugins override built-in by ID.
2. **Validation** — checks `minAppVersion` via semver comparison. Incompatible plugins get status `"incompatible"`. `debugOnly` plugins are filtered out when debug mode is off.
3. **Activation** — reads `index.js` via `plugin_read_file`, executes `new Function("api", code)(api)`, calls `activate(api)`.
4. **Running** — plugin handlers respond to events, fetch requests, UI actions, stream/download resolves.
5. **Deactivation** — calls `deactivate()`, clears all handlers and unsubscribers.

When a plugin's version changes, all its cached information values are deleted, forcing re-fetch.

## Plugin API

Plugins receive an `api` object. The plugin exports `activate(api)` and optionally `deactivate()`. The canonical TypeScript definitions live in `src/types/plugin.ts` (`ViboplrPluginAPI`).

### api.appVersion

Top-level string — the running host app version (semver). Use it for in-plugin feature gating beyond the manifest's `minAppVersion` (e.g. opt into a newer API only when present).

### api.log(level, message, section?)

Top-level logger. Writes to the app's frontend log stream. Prefer this over `console.log` for persistent diagnostics.

### api.library
- `getTrackCount()` — total track count across enabled collections
- `getTracks(opts?)` — `{ artistId?, albumId?, tagId?, limit?, offset? }`
- `ftsTracks(query, opts?)` / `ftsArtists(query, opts?)` / `ftsAlbums(query, opts?)` / `ftsTags(query, opts?)` — FTS5 search
- `getArtists(opts?)` / `getAlbums(opts?)` / `getTags(opts?)` — paginated listings (`getAlbums` accepts `artistId`)
- `getTrackById(id)` / `getArtistById(id)` / `getAlbumById(id)` / `getTagById(id)`
- `getHistory(opts?)` / `getMostPlayed(opts?)` / `getMostPlayedArtists(opts?)` — `opts.days` switches each to the rolling-window variant. `getMostPlayedArtists` returns `{ history_artist_id, play_count, track_count, display_name, rank }[]`.
- `getHistoryPlayCount()` / `getHistoryPlaysPage(opts?)` — total play count + a cheap, **album-free**, keyset-paginated page of raw plays (`{ beforeTs?, beforeId?, limit? }`; pass the previous page's last row to advance). Use these to stream a large history in chunks instead of pulling it all via `getHistory` — the latter resolves an album per row (O(plays × tracks)) and can freeze the app on long histories.
- `recordHistoryPlaysBatch(plays)` — batch import scrobbles, returns `{ imported, skipped }`
- `applyTags(trackId, tagNames)` — tag a single track; returns `[{ id, name }]`
- `applyTagsBulk(assignments)` — apply tags to many tracks in one call. `assignments` is `Array<[trackId, tagNames]>`; returns the count of tracks updated. DB-only (does not write file metadata — that's `bulkUpdateTracks` / `bulk_update_tracks`).
- `bulkUpdateTracks(trackIds, fields)` — bulk-edit `{ artist_name?, album_title?, year?, tag_names? }`; writes through to audio-file metadata. Mirrors the `BulkEditModal` path.
- `findDuplicates(opts?)` — duplicate groups by diacritic-normalized title+artist, optionally also matching duration and/or file size within tolerance (`{ matchDuration?, durationToleranceSecs?, matchSize?, sizeTolerancePct?, localOnly? }`). Returns `Track[][]`, each group length ≥ 2 and **keeper-first** (`group[0]` is the highest-quality copy). Backs the `duplicate-finder` plugin.
- `onTrackAdded(handler)` / `onTrackRemoved(handler)` / `onScanComplete(handler)` — library events

### api.playback
- `getCurrentTrack()` / `isPlaying()` / `getPosition()`
- `playTrack(track)` / `playTracks(tracks, startIndex?, context?)` — `track` is a `PluginTrack`; `context` is `{ name, coverUrl?, source?, metadata? }`
- `insertTrack(track, position)` / `insertTracks(tracks, position)` — insert into the current queue
- `onTrackStarted(handler)` / `onTrackScrobbled(handler)` / `onTrackLiked(handler)` — playback events. Each handler receives the currently-playing track, which is a metadata-only **`QueueTrack`** (no DB ids — `id`/`album_id`/`artist_id` are absent), **not** a library `Track`. Act on metadata (`title` / `artist_name` / `album_title` / `duration_secs`) and resolve a library row on demand via `find_track_by_metadata` if you need an id. `onTrackLiked` also gets a second `liked: boolean` argument; only **like** dispatches it (dislike never does).
- `onStreamResolve(providerId, handler)` — handler gets `(title, artistName, albumName, durationSecs)`, returns `{ url, label } | null`
- `onResolveStreamByUri(scheme, handler)` — handler gets `(id, quality?)` and returns a URL; used for custom URL schemes (e.g., `custom://`)

`PluginTrack`: `{ path?, title, artist_name?, album_title?, duration_secs?, track_number?, image_url? }`. `image_url` is shown in the now playing bar and queue when no library image exists.

### api.contextMenu
- `onAction(actionId, handler)` — handle clicks on registered context menu items. Handler receives a `PluginContextMenuTarget`.
- `registerItem(item)` — register a context-menu item **at runtime** (the dynamic counterpart to static `contributes.contextMenuItems`; use when the item set depends on user state). `item` is `{ id, label, targets, submenuLabel?, order? }` (`PluginDynamicMenuItem`); `id` is the action id routed to `onAction`, `label` is text-only (native menus have no icons), and items sharing a `submenuLabel` (per target kind) are grouped into one native submenu. Returns an unsubscriber.
- `unregisterItem(itemId)` — drop a runtime-registered item by id.

### api.home
- `onFetchShelf(shelfId, handler)` — register a fetch handler for a shelf the plugin contributes (either via `contributes.homeShelves` in the manifest, or via `registerShelf` at runtime). Handler receives `(limit: number)` and returns `Promise<HomeShelfResult>`. Each handler call has a 5-second timeout — slow handlers are treated as `{ status: "error" }` for that cycle. Returns an unsubscriber.
- `registerShelf(descriptor)` — register a shelf at runtime. `descriptor` is `{ id, title, displayKind, limit?, icon? }`. Use this when the set of shelves depends on user-specific state (e.g., one shelf per Spotify section). Returns an unsubscriber. The static manifest path is for shelves whose set is known at build time; runtime registration is for everything else.
- `unregisterShelf(shelfId)` — drop a runtime-registered shelf.
- `onItemClick(shelfId, handler)` — take over body-clicks on this shelf's cards. Handler receives the clicked `HomeShelfItem`. When registered, the host calls it **instead of** the default click action (navigate-to-detail for `album-cards`/`artist-cards`, play for `playlist-cards`/`track-rows`) — use it to navigate into the plugin's own view (e.g. Spotify opens its playlist detail). Returns an unsubscriber. The play button on the card is unaffected; it always plays.
- `onResolvePlay(shelfId, handler)` — resolve play tracks lazily. For a `playlist-cards` item whose `tracks` you supplied empty, register a resolver; when the user presses the card's play button the host awaits `handler(item) => Promise<PluginTrack[]>` (behind a loading modal) and plays the returned tracks. Use for plugins that fetch tracks on demand. Returns an unsubscriber.

`HomeShelfResult`: `{ status: "ok", items: HomeShelfItem[] } | { status: "empty" } | { status: "error", message? }`. Empty/error/timeout shelves are filtered out for that refresh cycle (so they're not visual errors — they just don't render).

`HomeShelfItem` is a discriminated union by the parent shelf's `displayKind`:

| displayKind | Item shape |
|---|---|
| `album-cards` | `{ libraryId?, name, artistName?, coverUrl?, tracks? }` — `libraryId` makes the card navigate to the album detail page; otherwise `tracks` (PluginTrack[]) plays on click |
| `artist-cards` | `{ libraryId?, name, imageUrl? }` — `libraryId` navigates to artist detail; without it the card is a no-op on click |
| `playlist-cards` | `{ id, name, coverUrl?, subtitle?, tracks: PluginTrack[] }` — `subtitle` shown under the title; clicking plays the tracks with `{ name, coverUrl, source: "playlist" }` context |
| `track-rows` | `{ track: PluginTrack }` — clicking plays just that track |

`coverUrl` / `imageUrl` may be either a remote URL (http/https/data) or a local filesystem path — the renderer detects the difference. Local paths can carry a `#v=N` cache-busting suffix that the renderer preserves.

When a plugin is deactivated or reloaded, `usePlugins` automatically drops all of its registered home-shelf handlers and runtime descriptors.

### api.nowPlayingInfo

Contributes items to the cycling **Now Playing info** section (the line that shows under the title in the **mini player** — the full now-playing bar shows a static Artist · Album line instead; see `ui.md` "Now Playing Bar"). The host cycles through the *enabled* items; the user picks which via the mini player's native context menu. Mirrors the `api.home` register/onFetch pattern.

- `registerItem({ id, label, priority? })` — add an item at runtime. `label` is the checkbox text in the context menu; `priority` orders it among plugin items (lower first; built-ins always precede plugin items). Returns an unsubscriber.
- `unregisterItem(id)` — drop a registered item.
- `onFetch(id, handler)` — `handler(track: PluginTrack) => Promise<NowPlayingInfoResult>` resolves the item's text for the current track. Has a 5-second host-side timeout; slow handlers count as `error` for that track. Returns an unsubscriber.

`NowPlayingInfoResult`: `{ status: "ok", text } | { status: "empty" } | { status: "error", message? }`. `empty`/`error`/timeout simply hide the item for that track (no error indicator). Built-in items contributed by the core app are **Artist · Album**, **Artist**, **Album**, **Plays · Rank** (play count + chart rank from history, in one item), **Source** (Local / Subsonic / Web / scheme), **Quality** (format · sample rate · bit depth, or bitrate — via `get_audio_properties_by_path` for local files), **Duration**, **Tags** (`#`-prefixed track tags, resolved via `find_track_by_metadata` → `get_tags_for_track`), **Synced Lyrics** (the line *currently being sung* in quotes, tracking playback position), and **Plain Lyrics** (one line of unsynced lyrics in quotes, stable per track); the Last.fm plugin contributes **Scrobbles**. The two lyrics items reuse the cached lyrics info-type (via `useLyrics`) and only fetch when enabled; each appears only when that kind of lyrics exists for the track (synced vs. plain), otherwise it's hidden for that track. The Synced Lyrics item additionally drops out of the cycle during intros and instrumental gaps — when no line is actively being sung (before the first timestamp, or on a blank LRC gap line) it resolves to nothing rather than lingering on the last sung line (`activeSyncedLine` in `utils/lyrics.ts`). Each item declares its own `defaultEnabled`; **Artist · Album**, **Synced Lyrics**, and **Scrobbles** are on by default — everything else (including **Tags** and **Plain Lyrics**) is opt-in. Each item also has a built-in per-type style (skin-token-backed) and a time-of-persistence multiplier set in the mini player's native menu (persisted as `nowPlayingInfoPersistence`); see `ui.md` "Now Playing Bar". When a plugin is deactivated/reloaded, `usePlugins` drops its items + handlers automatically.

### api.ui
- `setViewData(viewId, data, opts?)` — render plugin views (see `PluginViewData` types). `opts.scrollKey?: string` enables per-view scroll memory: the host saves/restores the view's scroll position keyed by `scrollKey`. Change it on navigation (new sub-view → opens at top; returning to a prior key → scroll restored); keep it stable across in-place updates so the view doesn't jump.
- `showNotification(message)` / `navigateToView(viewId)` / `requestAction(action, payload)`
- `onAction(actionId, handler)` — handle UI action events emitted from plugin views
- `setBadge(viewId, badge)` — set a sidebar badge: `null | { type: "dot", variant, tooltip? } | { type: "count", value, variant }`. `variant` is one of `accent | error | success | warning | muted`.

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
- `onFetch(infoTypeId, handler)` — *provide* a value: handler receives an `InfoEntity`, returns `{ status: "ok", value } | { status: "not_found" } | { status: "error", message? }`.
- `searchValues(query, opts?)` — *read* across the cached `information_values` store (any info type — lyrics, bios, reviews, similar lists, …). Case/diacritic-insensitive substring search. `opts` (all optional, AND-combined): `typeId` / `displayKind` / `entity` narrow by info type; `jsonPath` scopes matching **and** the returned `snippet` to one JSON field of the stored value (e.g. `"$.text"` for lyrics, `"$.summary"` for bios) — omit to search the whole value; `resolveTracks` populates `match.track` for `entity: "track"` matches; `limit`. Returns `InfoValueMatch[]`: `{ typeId, pluginId, entity, displayKind, entityKey, value (parsed JSON), status, fetchedAt, snippet, track }` where `track` is the resolved library `Track | null` (only for track entities when `resolveTracks` is set). This runs the scan in the host — the value store is keyed by metadata (`buildEntityKey`), not exposed as a queryable table to JS.
- `getValuesForEntity(entity)` — read every cached value for an `InfoEntity`: `Array<{ typeId, value (parsed JSON), status, fetchedAt }>`.
- `getValue(typeId, entity)` — read one cached value by info type for an `InfoEntity`, or `null`.

There is still **no** `api.informationTypes.invoke` escape hatch — plugins read/provide info values through the typed methods above, not arbitrary Tauri commands. The **Lyrics Search** plugin (`src-tauri/plugins/lyrics-search/`) is the canonical `searchValues` consumer (`{ typeId: "lyrics", jsonPath: "$.text", resolveTracks: true }`).

### api.imageProviders
- `onFetch(entity, handler)` — entity is `"artist"` or `"album"`. Handler receives `(name, artistName?)` and returns `{ status: "ok", url, headers? } | { status: "ok", data } | { status: "not_found" } | { status: "error", message? }`.

### api.downloads
- `enqueue(request)` — queue a download through the unified downloader. `request: { title, artistName?, albumTitle?, uri?, durationSecs?, destCollectionId?, destCollectionPath?, format?, provider? }`. Returns the download ID.
- `onResolveByUri(providerId, handler)` — handler receives `(uri, format)` and returns a `DownloadResolveResult | null`
- `onResolveByMetadata(providerId, handler)` — handler receives `(title, artistName, albumName, durationSecs, format)`
- `onInteractiveSearch(providerId, handler)` — handler receives `(query, limit)` and returns `InteractiveSearchResult[]` for the `DownloadModal` manual-search flow
- `onInteractiveResolve(providerId, handler)` — handler receives `(matchId, format)` and returns a `DownloadResolveResult`
- `onGetQualities(providerId, handler)` — synchronous `() => DownloadQualityOption[]` (`{ value, label }[]`); supplies the quality/format choices the `DownloadModal` offers for this provider.

`DownloadResolveResult`: `{ url, headers?, metadata?: { title, artist, album, trackNumber, year, genre, coverUrl }, ext? }`. `ext` overrides the saved file extension for the requested format; `ext: "auto"` tells the backend to sniff the container from the downloaded bytes (for originals of unknown format).

### api.scheduler
- `register(taskId, intervalMs)` / `unregister(taskId)` / `complete(taskId)` — periodic task registration. Backend emits `plugin-scheduler-due` events at the configured interval.
- `onDue(taskId, handler)` — invoked when the task is due

### api.system
- `exec(program, args?, opts?)` — run a subprocess, returns `{ exitCode, stdout, stderr }`. **Allow-list only:** currently `yt-dlp` and `ffmpeg`. `opts.cwd` defaults to the app data directory.
- `getDependency(name)` — read the host's **cached** status for a registered external binary: `{ name, installed, version, origin: "managed" | "system" | null, latest } | null`. **Cache-only — never hits the network.** On a cold cache the host may run a one-shot local `--version` probe (single-flight and timeout-bounded, with the result persisted across sessions keyed by the binary file's identity), so the first call of a session can take seconds — but concurrent calls never spawn extra processes. `latest` stays `null` until the host's own background check populates it (~30s after startup, then daily, or via Settings). Plugins must use this rather than checking GitHub themselves — the host owns release/version checking (see `backend.md` "External Binary Dependencies").

### api.env
- `get(key)` — read an environment variable

### api.p2p

Bridge to the host's Rust libp2p engine (`src-tauri/src/p2p/`) — the host side of the `p2p-sharing` plugin. Version-coupled to `outcast1000/viboplr-relay`; bump the plugin's `minAppVersion` when this surface changes so older apps don't pull an incompatible UI shell.

- `start(relayMultiaddr?)` / `stop()` — bring the node up/down.
- `getStatus()` / `getDiagnostics()` — node state; `getDiagnostics()` returns `P2pDiagnostics` (peer id, listen addrs, NAT status, protocol versions, connected peers, transfer/byte counters, pending dial/search/transfer counts, shared collections, uptime).
- `getMultiaddrs()` — this node's dialable addresses. `reserveRelay(multiaddr)` — reserve a relay slot for hole-punching.
- `searchPeer(peerId, multiaddr, query, limit?)` — query a peer's shared library.
- `streamFromPeer(peerId, multiaddr, trackId)` — resolve a playable URL for a peer's track. `downloadFromPeer(peerId, multiaddr, trackId, destCollectionId)` — pull a copy into a local collection.
- `getSharedCollections()` / `setSharedCollections(ids)` — which local collections this node shares.

## Information Sections

Tabbed metadata panels shown on entity detail pages (artists, albums, tracks, tags).

### Provider Chain

Multiple plugins can provide the same information type ID (e.g., both `lastfm` and `genius` provide `artist_bio`). The app hardcodes default priority ordering (in `usePlugins.ts`). Users can reorder providers in Settings > Providers. Lower `priority` number = tried first. First success wins.

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

Priority order is user-configurable via Settings > Providers. Default priority is hardcoded internally in `usePlugins.ts` (lower number = higher priority). Unknown plugins are added last (priority 999). For albums, the Rust-native `EmbeddedArtworkProvider` always runs first before any plugin providers.

## Stream Resolver Chain

Stream resolvers provide playback URLs when a track's native source isn't available (e.g., library track missing on disk, external track without a direct URL).

### Flow (`App.tsx` `streamResolversRef`)

For each track to play:
1. If a local copy exists for the track's metadata, use it.
2. If the track has a native URL (`file://`, `subsonic://`, or `http(s)://`), try the native resolver. Plugin-registered schemes are resolved via `onResolveStreamByUri`.
3. Walk the user-ordered list of plugin stream resolvers. Each is called with `(title, artistName, albumName, durationSecs)` and has 60 seconds to return `{ url, label } | null` (resolvers like YouTube shell out to `yt-dlp`, which can be slow).
4. First success wins. Failures fall through to the next resolver. `addLog` surfaces fallback info to the user.

### Custom URL Schemes

`api.playback.onResolveStreamByUri(scheme, handler)` registers a resolver for a custom URL scheme (e.g., `custom://`). The handler returns a playable URL for a given `(id, quality?)`.

### Configuration

Users can drag-and-drop reorder and toggle stream resolvers on/off in Settings > Providers. Order and enabled state are stored under `streamResolverOrder` in the app store.

## Download Provider Chain

Download providers implement URL resolution for the unified `DownloadModal`.

- **By URI:** a plugin handles a specific scheme (e.g., `custom://`, `external://`) via `onResolveByUri`. Used when the app already has a canonical URI.
- **By metadata:** a plugin accepts arbitrary `(title, artistName, albumName, durationSecs, format)` via `onResolveByMetadata`. Used for automatic fallbacks (e.g., YouTube search-and-download).
- **Interactive:** a plugin contributes `onInteractiveSearch` + `onInteractiveResolve`, surfaced as manual search inside `DownloadModal` with per-track picking.

Providers are prioritized by internal hardcoded defaults (in `usePlugins.ts`); unknown plugins are added last. The built-in Subsonic provider handles `subsonic://` URIs natively.

## Home Shelves

Plugins contribute horizontal shelves to the Home page via `api.home`. Two paths:

- **Static (manifest):** `contributes.homeShelves[]` declares a fixed set known at build time. Each entry must still register a fetch handler via `api.home.onFetchShelf(shelfId, handler)`.
- **Runtime:** `api.home.registerShelf(descriptor)` adds a shelf programmatically. Use this when the set depends on user-specific state — e.g., the Spotify plugin contributes one shelf per active section, and re-syncs them whenever the user adds or removes a section.

The merged manifest + runtime list is exposed by `usePlugins` as `homeShelves` and consumed by `useHome` (see `ui.md` "Home View"). Built-in shelves are listed first; plugin shelves follow.

**Refresh contract:** Home calls every shelf's handler on view-mount only when the persisted snapshot is older than 24 hours (or absent). The user can also trigger a refresh manually via the toolbar button at any time. Each handler has a 5-second timeout — keep them fast or kick off background work elsewhere and serve from cached state. Returning `{ status: "empty" }` hides the shelf for that cycle (no error indicator). Returning `{ status: "error", message }` logs to `console.error` and hides the shelf.

**Image rules:** local paths (e.g. plugin-cached covers under `api.storage.files`) are run through `convertFileSrc` automatically. Append `#v=<timestamp>` to bust the WebView cache when content changes. Remote URLs (http/https/data) are passed through unchanged.

**Click semantics:** by default, for `playlist-cards`, `playTracks` is invoked with `{ name, coverUrl, source: "playlist" }` context, which gives the queue panel a banner — don't replicate that wiring inside the plugin, Home does it for you. To override the default (e.g. navigate into the plugin's own view instead of playing), register `api.home.onItemClick(shelfId, handler)`; when present it wins over the default body-click action. The play button on the card still plays regardless.

**Live example:** `src-tauri/plugins/spotify-browse/index.js` — the `syncHomeShelves` function diffs desired vs. registered shelves on every `render()`, registering one playlist-card shelf per Spotify section and serving items from in-memory `state.playlists` / `state.playlistTracks`. It also registers `onItemClick` per shelf so clicking a card navigates into the Spotify view and opens that playlist's detail page.

## Plugin View Rendering

Plugins with sidebar items render UI via `PluginViewData` (separate from info type renderers). Set data via `api.ui.setViewData(viewId, data)`.

| Type | Purpose |
|---|---|
| `track-list` | Full track list with library-style rendering |
| `card-grid` | Grid of image cards (playlists, albums, artists). Items can carry `contextMenuActions` + `tracks` for pass-through context menus. |
| `track-row-list` | Compact row list (selectable, per-row actions). Items: `{ id, title, subtitle?, album?, imageUrl?, duration?, action? }`. Node flags: `numbered?` (leading `#` index), `showHeader?` (column-header row + Album column). |
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
| `bar-chart` | Proportional bars for distributions / ranked counts. `{bars: [{label, value, sublabel?, color?, id?, action?}], max?, orientation?: "horizontal"\|"vertical", valueFormat?: "number"\|"percent"\|"duration"}`. Horizontal by default (label · fill · value); `color` should be a skin var. A bar with `action` is clickable (hover/focus affordance) and fires `onAction(action, { id, label })` — used e.g. by Library Statistics to drill from a top artist into its plays-over-time. Skin-safe. |
| `heatmap` | Grid of intensity cells (e.g. an hour-of-day × weekday "listening clock"). `{rows: string[], cols: string[], cells: number[][], max?, colLabelEvery?, valueSuffix?}`. Cell fill = `value / max`. Skin-safe. |
| `line-chart` | Trend line(s) over an ordered x-axis (e.g. plays per month). `{series: [{points: number[], label?, color?}], labels?: string[], max?, area?, valueFormat?}`. SVG polyline (+ optional area fill); `labels` are the x-ticks. Skin-safe. |
| `toolbar` | Titled button bar with optional status text |
| `settings-row` | Label + description + right-side control or child view |
| `section` | Titled grouping wrapper |
| `confirm` | Modal-style confirm with `confirmAction` / `cancelAction` and optional `data` payload |
| `detail-header` | Renders the **native** detail hero (`DetailHero`): multi-image crossfade background (`bgImages[]`, 0-4), effect looks + FX selector (inherits the global hero effect preference), square/`circle` art (`artShape`), `title`, `subtitle`+`meta` as chips, foreground art from `imageUrl`, Play (`playAction`) / Enqueue (`enqueueAction`) buttons, and an overflow (⋯) menu built from `actions[]` then `contextMenuActions[]`. Like/dislike, eyebrow, and titleLine are not exposed to plugins. |

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


