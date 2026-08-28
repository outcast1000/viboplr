---
paths:
  - "src-tauri/plugins/**"
  - "src/types/plugin.ts"
  - "src/hooks/usePlugins.ts"
  - "src/hooks/useInformationTypes.ts"
  - "src/hooks/useImageResolver.ts"
  - "src/hooks/useExtensions.ts"
  - "src/components/PluginViewRenderer.tsx"
  - "src/components/InformationSections.tsx"
  - "src/components/ExtensionsView.tsx"
  - "src-tauri/src/plugins.rs"
---

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

`p2p-sharing` (`outcast1000/viboplr-p2p`) was **de-registered from the gallery** when the host's P2P engine was removed. The repo still exists but the plugin can't work — its `api.p2p` calls have no host bridge. Don't re-add it to `index.json`.

`youtube` (`outcast1000/viboplr-youtube`) was **de-registered from the gallery** on 2026-08-10, superseded by `ytdlp` — same yt-dlp backend, but it covers SoundCloud, Bandcamp and 1000+ other sites, and it's the `recommended` entry. Unlike `p2p-sharing` this plugin still *works*: the repo is untouched and installed copies keep running **and keep auto-updating**, because updates resolve from the `updateUrl` in each installed manifest, not from the index. Only discovery is gone. Don't re-add it to `index.json` — two entries for one job made the narrower one look like the YouTube-specific choice.

| Plugin id | Canonical repo | Notes |
|---|---|---|
| `spotify-browse` | `outcast1000/viboplr-spotify` | Self-contained; release flow + `scripts/bump.sh` live in that repo. |
| `tidal-browse` | `outcast1000/viboplr-tidal` | Self-contained (HTTP via `api.network.fetch`); same release flow. |
| `youtube` | `outcast1000/viboplr-youtube` | **De-registered from the gallery** (see above) — superseded by `ytdlp`, so a fresh install can't reach it and `ytdlp` is what supplies YouTube playback/download now. Self-contained; contributes the `youtube-fallback` stream resolver + `youtube-download` download provider. Shells out to `yt-dlp`/`ffmpeg` via `api.system.exec`. Same release flow (`scripts/bump.sh` + CI) as the others, and still worth releasing — existing installs auto-update from its own `updateUrl`. |
| `ytdlp` | `outcast1000/viboplr-ytdlp` | The **replacement for `youtube`** and the `recommended` gallery entry: yt-dlp for YouTube, SoundCloud, Bandcamp and 1000+ sites. Owns YouTube search/playback outright (there is no core `search_youtube` — see CLAUDE.md "Do Not Reintroduce") and contributes the "Watch YouTube video" track action. Shells out to `yt-dlp`/`ffmpeg` via `api.system.exec`; the host owns the binary's version/release checking (`dependencies.rs`), so the plugin must not hit GitHub itself. |
| `ffmpeg-tools` | `outcast1000/viboplr-ffmpeg-tools` | Self-contained; bulk-convert (`api.contextMenu.registerItem` "Convert to…" submenu) + a Media Info tab (`ffmpeg-probe` information type: container/stream/tag probe + loudness). Shells out to `ffmpeg` only — there's no `ffprobe` in the allow-list, so probe/loudness data is parsed from plain ffmpeg's stderr banner. Same release flow (`scripts/bump.sh` + CI) as the others. |
| `vinyl-deck` | `outcast1000/viboplr-vinyl-deck` | The reference **visualizer** — the play queue pressed onto a record, filling the `nowplaying` slot. **The only external plugin with a real toolchain**: TypeScript across six modules with 51 tests, bundled by vite to the single IIFE the loader wants, so `index.js` is a committed build artifact and its CI fails if it drifts from a fresh build. Vendors the host's visualizer contract (it can't import `src/`) and re-syncs it with `npm run sync-types`. Same release flow (`scripts/package.sh` + CI) as the others. |

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
   - `updateUrl` is the only load-bearing field for install. **It is not the only copy of that URL that matters:** the update checker reads `updateUrl` from the *installed manifest*, so a plugin whose own `manifest.json` omits it installs perfectly and is then never checked again. Put it in the plugin's manifest too. (The host now stamps a missing one in at install time, which retro-fixes a copy on its next reinstall — but a plugin should still declare it, since that's what makes a side-loaded or already-installed copy checkable.) `vinyl-deck`, `genius` and `auto-tagger` all shipped without it and went releases-deep unnoticed. `name`/`description` are display metadata you maintain by hand; **`version` and `minAppVersion` are auto-synced from your live `update.json` by the gallery's reconcile bot** (`scripts/reconcile-versions.mjs` — daily + on release), so you don't hand-maintain them (omit them and the bot backfills; the submission bot also seeds `version` on merge). The *real* version/min-app gate is always enforced from the live `update.json` at install regardless.
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
  "updateUrl": "https://.../releases/latest/download/update.json",
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
    "eventHooks": ["track:started", "track:scrobbled", "track:liked", "track:added", "track:removed", "queue:changed", "scan:complete"],
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
    }],
    "searchProviders": [{
      "id": "provider-id",
      "name": "Provider Name",
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

## Per-Contribution Visibility

A user can turn off **individual** contributions without disabling the whole plugin:

| Contribution | Surface | Persisted as |
|---|---|---|
| Information types / image providers / stream resolvers | Settings → Providers (on/off + priority) | `*.active` / `*.priority` DB columns, plus `streamResolverOrder` (download providers have **no** priority/enable — the downloader follows the track's source) |
| Home shelves | Home → ⚙ Shelves (on/off + order) | `homeShelfVisibility` / `homeShelfOrder` |
| Now Playing info items | Settings → Playback (on/off + dwell + order) | `nowPlayingInfoSelection` / `…Persistence` / `…Order` |
| **Context menu items, sidebar views, search providers** | **Extensions → plugin detail → Contributions** | **`pluginContributionVisibility`** |

The last row is `src/utils/pluginContributions.ts` (pure, unit-tested): one flat `Record<key, boolean>` keyed `` `${pluginId}:${kind}:${itemId}` `` where `kind` is `"menu"`, `"sidebar"`, or `"search"`. **A missing key means visible** — same default-on rule as `homeShelfVisibility`, so a plugin update that adds a menu item shows it instead of silently hiding it. The kind is in the key because ids collide across kinds (yt-dlp's search provider and its menu action can share a trailing id without one toggle hiding both).

**The filter is applied once, in `usePlugins`** — `plugins.menuItems`, `plugins.sidebarItems` and `plugins.searchProviders` are already filtered when a consumer receives them, so every surface (library, queue, playlists, plugin views, Home, `buildContextMenuSpecs`, the Cmd+K dropdown) inherits it for free. Do not re-filter at a call site, and do not read the raw lists to build a menu: a native menu has no DOM, so a hidden item that leaked into a spec list could not be filtered out later. It covers static manifest contributions and their runtime counterparts (`api.contextMenu.registerItem`, `api.search.registerProvider`) uniformly, because the merge happens before the filter.

`filterContributions` takes an optional id accessor for this reason: `PluginSearchProvider` names its id `providerId`, not `id`.

**Hiding a search provider is enough to stop it running.** The host only queries a provider when the user activates its offer row (see "Global Search"), so removing the row removes the only trigger — there is no second path to gate.

`usePlugins` also returns `contributions` (the **unfiltered** flat list, so a turned-off item still has a row to turn back on), `contributionVisibility`, and `setContributionEnabled(key, enabled)` — the last writes state and the store directly rather than via an effect, so there is no restore-guard to get wrong.

**For plugin authors:** hiding a sidebar item does *not* disable the view — `api.ui.navigateToView` still reaches it. If your item set depends on the user's own preferences, prefer gating `api.contextMenu.registerItem` / `unregisterItem` from your own `settingsPanel`; the host toggle is the generic fallback that works without plugin cooperation.

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
- `getTrackLikeStates(tracks)` — read persisted like states from the durable, ID-less `entity_likes` store (works for non-library tracks too). `tracks` is `{ title, artistName? }[]`; returns a parallel `number[]` where `1` = liked, `-1` = disliked, `0` = neither.
- `setTrackLikesBatch(tracks)` — persist a batch of track likes/dislikes (e.g. importing an external service's loved tracks). `tracks` is `{ title, artistName?, liked?, updatedAt? }[]` (`liked` defaults to `1`; `updatedAt` = unix seconds). Funnelled through the host's **newer-wins** merge with existing state, so re-running is idempotent. Returns the count of rows applied. Emits `entity-likes-changed { kind: "bulk" }`, so the app refreshes queue + library lists. Backs the Last.fm loved-tracks import.
- `onTrackAdded(handler)` / `onTrackRemoved(handler)` / `onScanComplete(handler)` — library events

### api.playback
- `getCurrentTrack()` / `isPlaying()` / `getPosition()`
- `visualizers` — see "Visualizers" below.
- `getQueue()` — the whole play queue in order plus the playing index: `{ tracks: QueueTrack[], index }`. Metadata-only `QueueTrack`s, same as `getCurrentTrack`. Guard with a `typeof` check for older hosts.
- `onQueueChanged(handler)` — fires when the queue's contents *or* current index change (enqueue, reorder, remove, clear, track advance). **Coalesced and payload-free** — read the new state back with `getQueue()` when it fires. Dispatched from App.tsx off the live queue, so it's one signal per committed change rather than a diff stream.
- `playTrack(track)` / `playTracks(tracks, startIndex?, context?)` — `track` is a `PluginTrack`; `context` is `{ name, coverUrl?, source?, metadata? }`
- `insertTrack(track, position)` / `insertTracks(tracks, position)` — insert into the current queue
- `playWithBackfill({ head, context?, resolveTail, tailErrorMessage? })` — **play the known opening track(s) now, hand the rest over when the slow work finishes.** For any play whose first track is known up front but whose remainder costs seconds (a scrape, a paged catalog) — e.g. a "song radio" that always opens with the seed the user picked. `head` plays immediately (metadata-only is fine — the stream-resolver chain resolves it on play); `resolveTail()` returns the full list (head included or not — the host strips a leading run it already started, per `dropPlayedHead`). On failure/empty the head keeps playing and `tailErrorMessage` shows as a toast. **Prefer this over `playTracks` + `insertTracks`:** the host discards the tail if the user replaced or cleared the queue mid-resolve (generation-guarded — see conventions.md "Play With Backfill"), which a hand-rolled insert can't detect, and it needs no loading modal — the queue panel shows its own "Filling in the rest…" row for the whole wait. **Resolves with the number of tracks actually appended** (0 = the tail failed, was empty, was entirely the head, or was discarded because the user moved on), so announce success from that number rather than from your own resolved list. Guard with `typeof api.playback.playWithBackfill === "function"` for older hosts.
- `onTrackStarted(handler)` / `onTrackScrobbled(handler)` / `onTrackLiked(handler)` — playback events. Each handler receives the currently-playing track, which is a metadata-only **`QueueTrack`** (no DB ids — `id`/`album_id`/`artist_id` are absent), **not** a library `Track`. Act on metadata (`title` / `artist_name` / `album_title` / `duration_secs`) and resolve a library row on demand via `find_track_by_metadata` if you need an id. `onTrackLiked` also gets a second `liked: boolean` argument; only **like** dispatches it (dislike never does).
- `onStreamResolve(providerId, handler)` — handler gets `(title, artistName, albumName, durationSecs, opts?)` and returns `{ url, label, video? } | null`. `opts.preferVideo` is an advisory hint (the user turned on Settings → Playback → "Prefer video"): a resolver that can should return a video stream and set `video: true`, and the host reclassifies the track to video and plays it in the theater; ignore the hint to keep returning audio. The hint never reorders the chain or overrides source priority — first non-null result still wins.
- `onResolveStreamByUri(scheme, handler)` — handler gets `(id, quality?, opts?)` and returns **either** a bare URL string (one self-contained stream) **or** a candidate list `{ candidates: StreamCandidate[] }`; used for custom URL schemes (e.g., `custom://`). `opts.externalAudio` (advisory) tells the resolver the host can attach a separate audio stream — true only when the **native mpv engine** will render this as **video**. A source whose hi-res streams are split (video-only + audio-only, e.g. YouTube ≥720p) should return the candidate list when the hint is set, and a self-contained (muxed) URL otherwise. The host's selector (`selectStream`) picks per its active engine: the native engine pairs a hi-res video-only stream with a separate audio-only stream (mpv merges them via `audio-file`); the browser engine takes a muxed stream (it can't merge), which is also the instant fallback if a native play errors. Older hosts don't send `externalAudio` and treat a candidate list's best muxed stream as the URL, so returning a bare muxed URL stays fully back-compatible.

  Alongside `candidates` you may report **`sourceUrl`** — the page the stream came from, the same attribution field `onStreamResolve` returns. **Do.** A track played from its own plugin scheme is otherwise attributed by its *URI*, and the host's source panel then shows an opaque or encoded id (`ytdlp://https%3A%2F%2Fwww%2Eyoutube%2Ecom%2F…`) with no way out to the original page — while the *same* track resolved by metadata shows a clean URL and an "Open on …" button, because that path has always carried the field. Two consequences for a plugin: it needs the object form (a bare URL string has nowhere to put it), and the host treats a **one-candidate list exactly like a bare URL** (`selectStream`), so switching to `{ candidates: [one], sourceUrl }` costs nothing and older hosts simply ignore the extra field.
- `onResolveStoryboard(scheme, handler)` — supply **seek-preview thumbnails** for a custom URL scheme. Handler gets `(id)` and returns a `Storyboard | null`; the host shows one tile in the seek bar's hover bubble. **Return the source's own published storyboard** where one exists rather than extracting frames — YouTube serves `sb0`–`sb3` sprite sheets (~58 KB for 200 thumbnails at `sb2`), so nothing is decoded and the video is never re-streamed. Cache the **sheet bytes** (e.g. `api.storage.files.download`), not the URLs: signed media URLs typically expire within hours while the images are permanent. Called once per track with a **10 s** host-side timeout — discovery that needs a subprocess should ride whatever call already resolves the stream instead of spawning again. `null` (no storyboard — short clips often have none), a timeout, or a throw all mean "no preview" and leave the bubble as plain text.

`Storyboard`: `{ sheets: string[], cols, rows, count, tileW, tileH, startSecs, intervalSecs }`. Tiles are row-major within a sheet, sheets consecutive in time; `count` is how many tiles actually carry a frame (grids may be padded) and the host never addresses past it. `sheets` entries may be remote URLs or local paths under the plugin's storage — the host runs local paths through `convertFileSrc`. The same shape describes host-generated storyboards for local files, so there is one renderer and one cache entry type.

`StreamCandidate`: `{ url, kind: "muxed" | "video" | "audio", height?, container?, vcodec?, acodec?, tbr? }`. `kind` is `muxed` (video+audio in one stream, browser-safe), `video` (video-only), or `audio` (audio-only). `height` (px), `container` (`"mp4"`/`"webm"`/`"m4a"`…), `vcodec`/`acodec`, and `tbr` (kbps) refine the host's pick — it prefers browser-safe mp4/avc + m4a/aac for the muxed/fallback stream and highest resolution for the native video stream.

`PluginTrack`: `{ path?, title, artist_name?, album_title?, duration_secs?, track_number?, image_url?, kind? }`. `image_url` is shown in the now playing bar and queue when no library image exists. `kind` (`"audio" | "video"`) is an advisory claim about what the track *is*, for pre-play presentation and routing; there is deliberately **no** `format` (container) field — see "Video-vs-audio" below.

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
  - **Skip the wait with `partial`:** if you know the track the list *starts* with (a radio station's seed, or the one entry still cached from a previous fetch), ship it in `tracks` and set `partial: true` on the item. The host then plays that head **immediately** and appends your resolved remainder behind the music — no loading modal, no dead air. Return the full list from the resolver either way; the host de-dupes a leading run it has already started (`dropPlayedHead`), and a resolve that fails or returns `[]` leaves the head playing plus a toast. Only set `partial` when the shipped tracks genuinely open the list — the host trusts that order and appends after them. Older hosts ignore the field and play just the head, so pair it with a resolver, not instead of one.

`HomeShelfResult`: `{ status: "ok", items: HomeShelfItem[] } | { status: "empty" } | { status: "error", message? }`. Empty/error/timeout shelves are filtered out for that refresh cycle (so they're not visual errors — they just don't render).

`HomeShelfItem` is a discriminated union by the parent shelf's `displayKind`:

| displayKind | Item shape |
|---|---|
| `album-cards` | `{ libraryId?, name, artistName?, coverUrl?, tracks?, partial? }` — `libraryId` makes the card navigate to the album detail page; otherwise `tracks` (PluginTrack[]) plays on click. `partial` behaves as on `playlist-cards`; it's ignored when `libraryId` is set |
| `artist-cards` | `{ libraryId?, name, imageUrl? }` — `libraryId` navigates to artist detail; without it the card is a no-op on click |
| `playlist-cards` | `{ id, name, coverUrl?, subtitle?, tracks: PluginTrack[], partial? }` — `subtitle` shown under the title; clicking plays the tracks with `{ name, coverUrl, source: "playlist" }` context. `partial: true` means `tracks` is only the known start of the list and the rest comes from `onResolvePlay` (see above) |
| `track-rows` | `{ track: PluginTrack }` — clicking plays just that track |

`coverUrl` / `imageUrl` may be either a remote URL (http/https/data) or a local filesystem path — the renderer detects the difference. Local paths can carry a `#v=N` cache-busting suffix that the renderer preserves.

When a plugin is deactivated or reloaded, `usePlugins` automatically drops all of its registered home-shelf handlers and runtime descriptors.

### api.nowPlayingInfo

Contributes items to the cycling **Now Playing info** section (the line that shows under the title in the **mini player** — the full now-playing bar shows a static Artist · Album line instead; see `ui.md` "Now Playing Bar"). The host cycles through the *enabled* items; the user picks which via the mini player's native context menu. Mirrors the `api.home` register/onFetch pattern.

- `registerItem({ id, label, priority? })` — add an item at runtime. `label` is the checkbox text in the context menu; `priority` orders it among plugin items (lower first; built-ins always precede plugin items). Returns an unsubscriber.
- `unregisterItem(id)` — drop a registered item.
- `onFetch(id, handler)` — `handler(track: PluginTrack) => Promise<NowPlayingInfoResult>` resolves the item's text for the current track. Has a 5-second host-side timeout; slow handlers count as `error` for that track. Returns an unsubscriber.

`NowPlayingInfoResult`: `{ status: "ok", text } | { status: "empty" } | { status: "error", message? }`. `empty`/`error`/timeout simply hide the item for that track (no error indicator). Built-in items contributed by the core app are **Artist · Album**, **Artist**, **Album**, **Plays · Rank** (play count + chart rank from history, in one item), **Source** (Local / Subsonic / Web / scheme), **Quality** (for video: codec · resolution · fps via the mpv engine's live facts; for audio: format · sample rate · bit depth, or bitrate — from `get_audio_properties_by_path` for a file on disk, since only the file states its real bit depth, falling back to the engine's live facts for anything streamed), **Duration**, **Tags** (`#`-prefixed track tags, resolved via `find_track_by_metadata` → `get_tags_for_track`), **Synced Lyrics** (the line *currently being sung* in quotes, tracking playback position), and **Plain Lyrics** (one line of unsynced lyrics in quotes, stable per track); the Last.fm plugin contributes **Scrobbles**. The two lyrics items reuse the cached lyrics info-type (via `useLyrics`) and only fetch when enabled; each appears only when that kind of lyrics exists for the track (synced vs. plain), otherwise it's hidden for that track. The Synced Lyrics item additionally drops out of the cycle during intros and instrumental gaps — when no line is actively being sung (before the first timestamp, or on a blank LRC gap line) it resolves to nothing rather than lingering on the last sung line (`activeSyncedLine` in `utils/lyrics.ts`). Each item declares its own `defaultEnabled`; **Artist · Album**, **Synced Lyrics**, and **Scrobbles** are on by default — everything else (including **Tags** and **Plain Lyrics**) is opt-in. Each item also has a built-in per-type style (skin-token-backed), a time-of-persistence multiplier, and a user-set priority (its position in the cycle) — the latter two set in Settings → Playback → "Now playing info" (persisted as `nowPlayingInfoPersistence` / `nowPlayingInfoOrder`); see `ui.md` "Now Playing Bar". A plugin item's `priority` therefore only decides where it *first* appears (after the built-ins, ordered among plugin items); the user can move it anywhere afterwards. When a plugin is deactivated/reloaded, `usePlugins` drops its items + handlers automatically. One dwell option is **"On request"**: the item never sits in the steady rotation and instead preempts the line for up to ~10s whenever its resolved content *changes or (re)appears* (see `ui.md` "Now Playing Bar"). Since a plugin item resolves once per track, an on-request plugin item flashes once when its text lands at track start; the built-in Synced Lyrics item — which re-resolves per sung line — uses it as its default for karaoke-style behavior. There is no push API (`requestShow`-style) yet; if a plugin needs mid-track requests, that's the extension point to add.

### api.search

Contributes a searchable catalog to the global search (Cmd+K). Mirrors the `api.home` register/onQuery pattern. Full contract in "Global Search (Cmd+K)" below — read it before implementing, because the timing rule is unusual.

- `registerProvider({ id, name, icon? })` — add a provider at runtime. Returns an unsubscriber. Prefer this over the manifest when the capability is conditional (a missing binary means the provider can't answer and must not be offered).
- `unregisterProvider(providerId)` — drop it.
- `onQuery(providerId, handler)` — `handler(query: string, limit: number) => Promise<PluginSearchResult>`. Returns an unsubscriber.

`PluginSearchResult`: `{ status: "ok", tracks } | { status: "empty" } | { status: "error", message? }`. **The host never calls this while the user types** — it renders an offer row and queries only on activation — so a handler is allowed to take seconds (60s backstop). Return `PluginTrack`s carrying a resolvable `path`. Handlers and runtime providers are dropped automatically on deactivate/reload, so a plugin must re-register on activate (guard the whole namespace: `api.search` is absent on older hosts).

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
- `fetch(url, init?)` — HTTP requests proxied through Rust (bypasses CORS). `init` is `{ method?, headers?, body?, insecure?, timeoutMs? }`. Returns `{ status, headers, getSetCookie(), text(), json() }`.
  - **`headers`** is the response's headers, names lowercased, repeats joined with `", "` exactly as `Headers.get()` does. **`getSetCookie()`** returns every `Set-Cookie` value separately, in send order — needed because that join is not reversible (a cookie's `Expires` attribute contains a comma of its own), and because a session API may set several cookies at once. This is what makes cookie-authenticated APIs reachable at all: the backend sends ordered `[name, value]` pairs rather than a map precisely so a repeated `Set-Cookie` can't be collapsed to the last one. A header whose value isn't valid UTF-8 is **dropped**, not emitted as `""` — an unreadable header is one a plugin can't use, and an empty string reads like a real value.
  - **`url`** (on the response) is the final URL after reqwest followed any redirects — absent on older backends, so feature-detect. It exists because an ISP block page is invisible without it: national blocking (e.g. Greece's edppi.gr) 302s a request to a notice page that answers HTTP 200 from a *different host*, which otherwise reads exactly like the target site answering with no content. The qBittorrent plugin's web-indexer sweep uses it to report "redirected to <host> — the site looks blocked on your network" instead of "no results".
  - **`timeoutMs`** aborts the request after N ms. There is **no default**, deliberately: reqwest imposes none, so an unreachable host hangs the promise until the OS gives up — set one on anything that polls, and leave it off for a call that may legitimately run for minutes. A plugin can't cancel an in-flight fetch, so racing a `setTimeout` is not a substitute: the abandoned request keeps running and a poll loop leaks them.
- `openUrl(url)` — open in system browser
- `onDeepLink(handler)` — subscribe to deep links delivered to the app
- `openBrowseWindow(url, opts?)` — opens an embedded browse window. Returns `BrowseWindowHandle` with `eval`, `close`, `show`, `hide`, `onMessage`, `onNavigation`.

### api.collections
- `getLocalCollections()` — returns local-kind collections as `[{ id, name, path }]`
- `resync(collectionId)` — rescan a collection; the plugin-side equivalent of the Resync button in Collections. For a plugin that lands new files **inside** a local collection (a completed download, an import), this is what makes them reach the library without waiting for the daily auto-update. Resolves as soon as the scan is *spawned*, not when it finishes — the backend ignores a second call for a collection already scanning (`resyncing_collections`), so calling it after each batch is safe. Listen on `api.library.onScanComplete` for the finish. Guard with a `typeof` check for older hosts.

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
- There is **no `enqueue`** — the background download queue (`enqueue_download` + its worker) was removed along with the host's batch menu items. A plugin that wants a download UI opens the host modal via `api.ui.requestAction("download-tracks", { providerId, providerName, tracks })` (single track → `SingleTrackDownload`, several → `MultiTrackDownload`), or downloads itself and lands the files in a local collection (`api.collections.resync`).
- `reportProgress(progress)` — report progress for the resolve the host is **currently awaiting**. `progress` is `{ percent?, label?, detail?, etaSecs? }`, all optional: omit `percent` when the work is indeterminate (a merge) and the host keeps its spinner instead of parking a bar on an invented number. Outside a resolve it is a deliberate no-op, so it is always safe to call. **A provider that downloads the file itself rather than returning a URL must call this** — that resolve is not a lookup, it is the whole download (yt-dlp fetching a video and merging it through ffmpeg runs for minutes), and without it the host has nothing to show but a spinner. Pair it with `opts.onOutput` on `api.system.exec` to turn the tool's own progress lines into reports, and guard with `typeof api.downloads.reportProgress === "function"` for older hosts.
- `onResolveByUri(providerId, handler)` — handler receives `(uri, format)` and returns a `DownloadResolveResult | null`
- `onResolveByMetadata(providerId, handler)` — handler receives `(title, artistName, albumName, durationSecs, format)`
- `onInteractiveSearch(providerId, handler)` — handler receives `(query, limit)` and returns `InteractiveSearchResult[]` for the `DownloadModal` manual-search flow
- `onInteractiveResolve(providerId, handler)` — handler receives `(matchId, format)` and returns a `DownloadResolveResult`
- `onGetQualities(providerId, handler)` — synchronous `() => DownloadQualityOption[]` (`{ value, label, video?, description? }[]`); supplies the quality/format choices the `DownloadModal` offers for this provider. Mark a video-producing option with `video: true` — the modal defaults to the first such option when the track being downloaded is itself a video (e.g. downloading the video you're watching), instead of the first option; the user can still pick any other. `description` renders as muted helper text under the picker for the SELECTED option — keep `label` short ("Type · Format — note") and put re-encode caveats/format explanations there; older hosts ignore it.

`DownloadResolveResult`: `{ url, headers?, metadata?: { title, artist, album, trackNumber, year, genre, coverUrl }, ext? }`. `ext` overrides the saved file extension for the requested format. **A download provider should return a concrete `ext` whenever it knows the container** — it's the provider's job to name the file, and it's the only fully reliable signal. There is **no byte-sniffing any more**: `"auto"` sniffing rode the removed background queue, and the `DownloadModal` resolves the extension *before* the bytes arrive, so `"auto"` falls back to the format's default extension (or `.bin` when the provider also declared no `onGetQualities`). Return the real `ext`.

### api.scheduler
- `register(taskId, intervalMs)` / `unregister(taskId)` / `complete(taskId)` — periodic task registration. Backend emits `plugin-scheduler-due` events at the configured interval.
- `onDue(taskId, handler)` — invoked when the task is due

### api.system
- `exec(program, args?, opts?)` — run a subprocess, returns `{ exitCode, stdout, stderr }`. **Allow-list only:** currently `yt-dlp` and `ffmpeg`. `opts.cwd` defaults to the app data directory. `opts.onOutput(line, stream)` streams the child's output live, split on `\n` **and** `\r` so a CLI that redraws one progress line still reports (yt-dlp needs `--newline` + `--progress` anyway, since a redraw never completes a line); the resolved `stdout`/`stderr` are still the complete, **verbatim** text, so an existing parse is unaffected. An exec started **inside a download resolve** is killed when the user cancels that download and the promise then rejects with **`"Cancelled"`** — rethrow that verbatim rather than mapping it to a failure message, because the host recognises its own cancellation and stays silent (see `api.downloads.reportProgress`). Execs outside a resolve (a version probe) take the original unpiped path and are not cancellable.
- `getDependency(name)` — read the host's **cached** status for a registered external binary: `{ name, installed, version, origin: "managed" | "system" | null, latest } | null`. **Cache-only — never hits the network.** On a cold cache the host may run a one-shot local `--version` probe (single-flight and timeout-bounded, with the result persisted across sessions keyed by the binary file's identity), so the first call of a session can take seconds — but concurrent calls never spawn extra processes. `latest` stays `null` until the host's own background check populates it (~30s after startup, then daily, or via Settings). Plugins must use this rather than checking GitHub themselves — the host owns release/version checking (see `backend.md` "External Binary Dependencies").

- `openPath(path)` — open a local file (or folder) with the application the OS associates with it, for something the app itself can't render: a `.nfo`, a PDF booklet, a folder of scans. **Use this, not `api.network.openUrl("file://…")`** — `openUrl` is the opener plugin's *JS* entry point, whose scope (`opener:default`) allows only `http`/`https`/`mailto`/`tel`, so a `file://` URL there is **refused** and the button silently does nothing. This one goes through a Rust command with no such scope. Path may be bare or `file://`-prefixed; a missing path rejects rather than failing quietly.
- `revealPath(path)` — reveal a local file in the OS file manager, **selecting** it in its folder (falling back to opening the containing folder on network shares, where the shell's select APIs reject UNC paths). The same host command the app's own "Show in folder" uses, so a plugin gets the UNC handling for free instead of re-deriving a parent directory.
- `readAudioTags(paths)` — read embedded tags for local files: one `{ title, artist, album_artist, album, track_number, disc_number, year, genre, duration_secs } | null` per input path, in order, `null` for anything unreadable. **Batch the whole set in one call** — the host probes on a worker thread (so a slow mount can't freeze the webview) and a per-file call is a per-file IPC round trip; a plugin queueing a finished release calls this once per user action. **There is no filename fallback** (unlike the library scanner, which falls through to its own regexes): a missing tag comes back `null` so the caller's own parse — which knows the folder, torrent or release the file came from — stands. Merge **per field**, tags winning, your parse filling the gaps; a release tagged with an artist but no track number should still take the number off `03 - `. Feature-detect (`typeof api.system.readAudioTags === "function"`) rather than raising `minAppVersion`, so older hosts keep the parsed values. The canonical consumer is the qBittorrent plugin, whose queue entries were otherwise pure filename guesswork.

### api.env
- `get(key)` — read an environment variable

### api.p2p — removed

There is **no** `api.p2p` namespace. The host's libp2p engine and its plugin bridge were removed along with the `p2p-sharing` gallery entry; see backend.md "Removed: P2P engine". Peer-transfer functionality would have to ship as a plugin using the generic surfaces (`api.network`, `api.downloads`, a stream resolver) — do not reintroduce a core P2P bridge.

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
| `play-or-youtube` | `{name, artist?}` | Plays a metadata-only external track — resolved on play through the stream-resolver chain (e.g. the yt-dlp plugin), so a library copy or any resolver can satisfy it |

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

For each track to play — **the exact thing that was asked for, then your own copy of it, then go and find one**:
1. If the track has a native URL (`file://`, `subsonic://`, or `http(s)://`), try the native resolver. Plugin-registered schemes are resolved via `onResolveStreamByUri`.
2. If a local copy exists for the track's metadata, use it. (For a **path-less** track — a Home track-row carrying only title + artist — there is no step 1, so this is the first entry; its `patch` is also what lets the play path classify such a track from the file that was matched.)
3. Walk the user-ordered list of plugin stream resolvers. Each is called with `(title, artistName, albumName, durationSecs)` and has 60 seconds to return `{ url, label } | null` (resolvers like YouTube shell out to `yt-dlp`, which can be slow).
4. First success wins. Failures fall through to the next resolver. `notify()` surfaces fallback info to the user.

**Steps 1 and 2 used to be the other way round, and the swap is load-bearing.** The local-copy shortcut was written when every non-`file://` scheme was a genuine network stream (`subsonic://`, `tidal://`), where substituting a local file is a plain win. But `isRemoteScheme` is only "not `file://`", so a plugin scheme that resolves to a file *on the same disk* — `qbt://` — was caught by the same rule, and there the shortcut wins nothing: it outranked the exact file the user clicked with a `find_track_by_metadata` result, which is fuzzy about **which** copy. Clicking `05. Nothingman.mp3` inside a Vitalogy torrent played `Pearl Jam - Nothingman.mp3` out of an unrelated compilation folder — a different recording, silently. Known cost of the new order: a track whose own source is dead or slow (a taken-down video, an unreachable server) now waits for that to fail before the local copy plays.

**A chain entry must fail during *resolve*, not during playback.** The chain only advances when `resolve()` throws; a source that resolves "successfully" and then won't load is a dead end — the retry re-resolves the same entry and gives up. That is why the local-copy entry verifies the file with `file_exists` before handing back a path: a library row outlives its file, and without the check a stale row killed playback for a track whose real copy was sitting right there. Any new entry that can go stale needs the same treatment.

### Custom URL Schemes

`api.playback.onResolveStreamByUri(scheme, handler)` registers a resolver for a custom URL scheme (e.g., `custom://`). The handler returns a playable URL — or a `{ candidates: StreamCandidate[], sourceUrl? }` menu for split-stream sources — for a given `(id, quality?, opts?)`. See the `api.playback` reference above for the candidate contract, the `opts.externalAudio` hint (hi-res video: the native mpv engine merges a video-only + audio-only pair), and `sourceUrl` (attribution — report it, or the source panel shows your raw URI).

**How the source panel names a plugin scheme.** `nativeResolverName` (`queueEntry.ts`, pure + unit-tested) resolves the scheme to its owning plugin's **manifest name** — `ytdlp://` reads "yt-dlp", not the capitalized protocol "Ytdlp". Capitalizing the scheme is only the fallback for a scheme nothing owns (an uninstalled plugin whose tracks are still in the queue). That string is user-facing twice: it titles the panel and fills in "Open on ___", so a plugin gets the naming right for free by having a sensible `name` in its manifest.

### Video-vs-audio: the host decides, from what the resolve found

`isVideoTrack` (`src/utils.ts`) reads a track's `format` first and falls back to its **path extension**. A plugin URI has neither — `qbt://<hash>/3` has no extension — so a plugin track would always classify as **audio**, and a video file plays through the `<audio>` element: sound, no picture, no theater.

**The host handles this itself at play time, and a plugin whose scheme resolves to a local file needs to do nothing to be *played* right.** The by-URI chain entry already knows the real path (`attributedSourceUrl`, which derives `file://<engineSource.path>` even when the resolver reported no `sourceUrl`); it runs that through `videoContainerFromPath` and patches `format` onto the track — and onto the queue entry (`onTrackFormatResolved`). Resolution completes *before* any element or engine is chosen, so the patched classification is what routes playback — the same `patch: { format }` channel the prefer-video pass uses.

**To classify *before* anything plays** — the queue row's icon, frame-thumb candidacy, initial routing — declare **`PluginTrack.kind: "audio" | "video"`** when the plugin knows it (a filename it read, a source that only serves video). The host stamps the same provisional `format: "mp4"` the prefer-video pass uses; whatever a resolve later reads off the real file overwrites it. This is deliberately a *kind*, not a container: a `format` claim ("mkv") is something a plugin usually can't know, and it has teeth the claimant shouldn't pull (`needsTranscode` routes mkv/avi/wmv through the transcode server). There is still **no `PluginTrack.format` field**. `kind` is optional and advisory, so already-released plugins are unaffected. `TrackRowItem.kind` carries the same claim for rows dragged into the queue.

The other channels, older or narrower:

- **`onStreamResolve` (metadata):** return `video: true` in answer to `opts.preferVideo`. The host stamps `format: "mp4"` and plays it in the theater; `video: false` on an already-video track downgrades it to audio and notifies. This is the only channel that participates in the prefer-video pass.
- **An extension on your own URI** (legacy, retired). `isVideoTrack`'s path fallback sees it, which is what `ytdlp://` historically did: `encodeRef` percent-escaped every dot in the encoded page URL (`%2E`) and appended a literal `.mp4` for video refs. ytdlp ≥1.23.0 no longer mints suffixed refs — it declares `kind` and reads the resolve intent from `opts.video` — but its `decodeRef` parses suffixed refs forever (they live in persisted queues), and the `%2E` escaping stays so a page URL that itself ends in a video extension can't false-trip the detector on an audio ref.

`onResolveStreamByUri` never gets `opts.preferVideo`, but it now gets **`opts.video`** — the track's classification (from `PluginTrack.kind` or its persisted format) — so a resolver whose ids no longer encode the intent (ytdlp without its legacy suffix) knows to serve video, muxed when `opts.externalAudio` is not also set. A resolver that still reads intent off its own id may ignore it.

### Configuration

Users can drag-and-drop reorder and toggle stream resolvers on/off in Settings > Providers. Order and enabled state are stored under `streamResolverOrder` in the app store.

## Download Provider Chain

Download providers implement URL resolution for the unified `DownloadModal`.

- **By URI:** a plugin handles a specific scheme (e.g., `custom://`, `external://`) via `onResolveByUri`. Used when the app already has a canonical URI.
- **By metadata:** a plugin accepts arbitrary `(title, artistName, albumName, durationSecs, format)` via `onResolveByMetadata`. Sole consumer: `decideDownload`'s metadata closure (a stream-resolver win with no native URI — the now-playing button / "Download…" on that track). Nothing walks providers as a chain any more — the background queue and mixtape export's resolve round-trip are both gone (export is source-faithful; see conventions.md).
- **Interactive:** a plugin contributes `onInteractiveSearch` + `onInteractiveResolve`, surfaced as the manual-search step inside `DownloadModal`. **Narrow reach:** the host generates no per-provider menu entries (no "Download from {X}…" / "Upgrade from {X}…" — a provider that wants a menu presence contributes its own context-menu item), so the search step only runs when the modal opens with no resolvable URI (a metadata-only track via the now-playing button). A provider whose download flow doesn't fit a one-string search (qBittorrent) should skip these handlers entirely and own the flow in its view.

**Resolve scopes (progress + cancellation).** Each resolve the host awaits runs inside a *scope* (`withResolveScope` in `usePlugins.ts`), which exists because a provider that downloads the file itself is otherwise a black box for minutes: nothing to show and nothing to stop. The scope routes that provider's `api.downloads.reportProgress` calls to whoever is waiting (the `DownloadModal`, via the `onProgress` argument threaded through `DownloadProvider.resolveByUri` / `resolveByMetadata` / `decideDownload`'s metadata closure), and records every `api.system.exec` started inside it so `plugins.cancelDownloadResolve(pluginId)` can kill the running subprocess — `plugin_exec_cancel` SIGKILLs the child's whole **process group**, since yt-dlp spawns ffmpeg. A killed exec rejects with `"Cancelled"`; the modal's generation guard drops that (and any late success), so cancelling never surfaces as a download error. Scopes stack per plugin, so a resolve that nests a retry still reports to the same place.

There is **no user priority/enable for download providers** (the Settings → Providers download group, its DB table and CRUD commands were removed), and **no chain**: the downloader follows the track's *source* (`decideDownload`) — one provider per resolve, never a walk. A modal-driven resolve has **no timeout**, deliberately: a provider that downloads the file itself (yt-dlp) legitimately runs for minutes, and the modal's live Cancel button (→ `cancelDownloadResolve`, which kills the provider's subprocess) is the user's way out — a fixed deadline just reported real downloads as failures. The built-in Subsonic provider handles `subsonic://` URIs natively.

## Home Shelves

Plugins contribute horizontal shelves to the Home page via `api.home`. Two paths:

- **Static (manifest):** `contributes.homeShelves[]` declares a fixed set known at build time. Each entry must still register a fetch handler via `api.home.onFetchShelf(shelfId, handler)`.
- **Runtime:** `api.home.registerShelf(descriptor)` adds a shelf programmatically. Use this when the set depends on user-specific state — e.g., the Spotify plugin contributes one shelf per active section, and re-syncs them whenever the user adds or removes a section.

The merged manifest + runtime list is exposed by `usePlugins` as `homeShelves` and consumed by `useHome` (see `ui.md` "Home View"). Built-in shelves are listed first; plugin shelves follow.

**Refresh contract:** Home calls every shelf's handler on view-mount only when the persisted snapshot is older than 24 hours (or absent). The user can also trigger a refresh manually via the toolbar button at any time. Each handler has a 5-second timeout — keep them fast or kick off background work elsewhere and serve from cached state. Returning `{ status: "empty" }` hides the shelf for that cycle (no error indicator). Returning `{ status: "error", message }` logs to `console.error` and hides the shelf.

**Image rules:** local paths (e.g. plugin-cached covers under `api.storage.files`) are run through `convertFileSrc` automatically. Append `#v=<timestamp>` to bust the WebView cache when content changes. Remote URLs (http/https/data) are passed through unchanged.

**Click semantics:** by default, for `playlist-cards`, `playTracks` is invoked with `{ name, coverUrl, source: "playlist" }` context, which gives the queue panel a banner — don't replicate that wiring inside the plugin, Home does it for you. To override the default (e.g. navigate into the plugin's own view instead of playing), register `api.home.onItemClick(shelfId, handler)`; when present it wins over the default body-click action. The play button on the card still plays regardless. Body-click and the play button run the **same** host path, so a lazy resolve / `partial` backfill behaves identically either way.

**Live example:** `src-tauri/plugins/spotify-browse/index.js` — the `syncHomeShelves` function diffs desired vs. registered shelves on every `render()`, registering one playlist-card shelf per Spotify section and serving items from in-memory `state.playlists` / `state.playlistTracks`. It also registers `onItemClick` per shelf so clicking a card navigates into the Spotify view and opens that playlist's detail page.

## Global Search (Cmd+K)

Plugins contribute searchable catalogs to the caption-bar search via `api.search`. Same two paths as Home Shelves:

- **Static (manifest):** `contributes.searchProviders[]` — `{ id, name, icon? }`. Each entry must still register a handler via `api.search.onQuery(providerId, handler)`.
- **Runtime:** `api.search.registerProvider(descriptor)`. Use this when the capability is **conditional** — e.g. gate registration on the host reporting a required binary installed, because a provider that can't answer must not be offered.

The merged list is exposed by `usePlugins` as `searchProviders`; `useCentralSearch` consumes it. That list is already filtered by the user's per-contribution toggles (see "Per-Contribution Visibility") — a provider the user hid never gets an offer row, and so is never queried.

**The host never queries a provider while the user types.** This is the load-bearing rule of the whole surface, not a tuning choice: every real provider costs seconds (yt-dlp shells out to a binary; a scraper drives a hidden browser window), so a debounce would spawn a process or a window per keystroke. Instead the dropdown renders one offer row per provider ("Search “x” on yt-dlp") and calls the handler only when the user activates it. Handlers may therefore be slow — the backstop is `PLUGIN_SEARCH_TIMEOUT_MS` (60s), not the 5s home-shelf budget. **Do not add speculative prefetching on either side.**

**Contract:** the handler returns `{ status: "ok", tracks }` / `{ status: "empty" }` / `{ status: "error", message? }`. `tracks` are `PluginTrack`s and should carry a resolvable `path` (e.g. `ytdlp://…`) — a metadata-only row forces the stream-resolver chain to search all over again at play time. `limit` is a hint; the host trims to `PLUGIN_RESULT_LIMIT`. A throw is caught and reported as `error`, so one broken provider can never break the search.

**Results are tracks only.** Albums and artists are deliberately out of scope: the dropdown's album/artist rows navigate to a detail page by library id, which a plugin result has no way to supply.

**Host-side layout:** `buildPluginSearchSections` (in `utils/centralSearchPlugins.ts`) produces the rendered rows *and* the keyboard-selectable item list in one walk, so the two can never disagree about an index. Every row carries its own `itemIndex` (null for display-only rows — spinner / no-results / error — which the arrow keys skip). Plugin sections always render after the library results. New row kinds go through that builder; do not compute indices in the component.

**Interaction:** activating an offer row runs the provider and keeps the dropdown open (its results replace the row in place). Activating a result plays it — `Cmd/Ctrl+Enter` enqueues — through `pluginTrackToQueueTrack` + the canonical queue actions, then reconciles like state against the durable store, exactly like every other plugin-track entry point.

**Not wired to the mini player.** `useMiniSearch` stays library-only: multi-second catalog searches with status rows don't fit a 40px bar.

**No plugin currently ships a provider.** yt-dlp was the only one (v1.15.0–v1.20.0) and **removed** its provider deliberately — its sidebar view searches better, and a second entry point only spent more yt-dlp searches against YouTube's bot gate. Do not cite it as the example, and do not re-add it. The host side of this API stays; it is still the right surface for a catalog whose search is cheap.

**If you build one:** register at runtime (not in the manifest) whenever the capability is conditional, and reset the "already registered" flag in `deactivate` — the host drops the provider on unload, so a disable/enable cycle must register again.

## Plugin View Rendering

Plugins with sidebar items render UI via `PluginViewData` (separate from info type renderers). Set data via `api.ui.setViewData(viewId, data)`.

| Type | Purpose |
|---|---|
| `track-list` | Full track list with library-style rendering |
| `card-grid` | Grid of image cards (playlists, albums, artists). Items can carry `contextMenuActions` + `tracks` for pass-through context menus. |
| `track-row-list` | Compact row list (selectable, per-row actions). Items: `{ id, title, subtitle?, album?, imageUrl?, duration?, action?, actions?, path?, artistName?, albumTitle?, durationSecs? }` (`actions` names which of the list's declared actions *that* row shows). Node flags: `numbered?` (leading `#` index), `showHeader?` (column-header row + Album column), `openOnClick?` (a plain click opens the row instead of selecting it — for lists of containers. `"title"` narrows the hotspot to the row's title: the name opens, the rest of the row selects, with no modifier needed for either — qBittorrent's torrent list. Older hosts treat the string as truthy and open on any click, so it degrades to `true`), `selectionPresets?` (`{ id, label, ids }[]`: extra buttons in the toolbar's **All / None** group that select a named subset — e.g. qBittorrent's Audio / Video over a torrent's files. A preset *selects*; `actions` are what act on a selection. Ids are intersected with the rows on screen, and a preset matching none is rendered disabled. Requires `selectable`), `selectionMode?: "single" \| "multi"` (default `"multi"`. `"single"` keeps one row current and **removes the All / None / actions toolbar entirely** — for a list whose actions are per-row, where a bulk toolbar restates the row's own hover buttons and is fed by a selection that exists only to feed it. `selectionPresets` are ignored, modifier-clicks stop diverting to selection (so with `openOnClick` every click opens), and Cmd+A / Shift+arrow no longer extend. Older hosts ignore the field and render the multi list, so it needs no `minAppVersion` bump. qBittorrent's torrent list is single; the files inside a torrent stay multi), `contextMenu?: boolean` (default `true`. `false` removes the host's **universal track right-click menu** from every row — for a list whose rows are not tracks. qBittorrent's file lists set it: a torrent's contents are mostly cover art, `.nfo` files and things that haven't downloaded, so the menu offered Play / Enqueue / Play Next on rows where none of them can happen, while every action a file row really has is already a button on the row. **Drag-to-queue is unaffected** — that is gated on the row's own `path`, so a finished media file can still be dragged. Older hosts ignore the field and keep showing the menu), `columns?` + `sortBy?` / `sortDir?` / `sortAction?` (**table mode** — see below). |
| `text` | Plain / class-styled text |
| `stats-grid` | Label/value stat tiles |
| `button` | Action button (`accent` / `secondary`, disabled, custom data payload) |
| `toggle` | Boolean toggle with `checked` state (**not** `value` — that was a historical bug) |
| `select` | Dropdown with options |
| `layout` | Vertical / horizontal container with children |
| `spacer` | Layout spacer |
| `search-input` / `text-input` | Text entry that fires an action on change. `search-input` extras: `buttonLabel` (submit-only + labeled button), `pasteButton` (a "Paste" button that fills the input from the clipboard and submits — backed by the host `read_clipboard_text` command), `stateKey` (per-key text memory, so one node multiplexed across tabs keeps each tab's typed text). `text-input` extras: `multiline`/`rows`, and `password` (masks the field for a service password or API secret; **wins over `multiline`**, since a textarea has no masked mode and silently falling back to a visible one would defeat the point) |
| `tabs` | Tab bar with `activeTab` |
| `loading` | Loading spinner with optional message |
| `progress-bar` | `{value, max, label?}` |
| `bar-chart` | Proportional bars for distributions / ranked counts. `{bars: [{label, value, sublabel?, color?, id?, action?}], max?, orientation?: "horizontal"\|"vertical", valueFormat?: "number"\|"percent"\|"duration"}`. Horizontal by default (label · fill · value); `color` should be a skin var. A bar with `action` is clickable (hover/focus affordance) and fires `onAction(action, { id, label })` — used e.g. by Library Statistics to drill from a top artist into its plays-over-time. Skin-safe. |
| `heatmap` | Grid of intensity cells (e.g. an hour-of-day × weekday "listening clock"). `{rows: string[], cols: string[], cells: number[][], max?, colLabelEvery?, valueSuffix?}`. Cell fill = `value / max`. Skin-safe. |
| `line-chart` | Trend line(s) over an ordered x-axis (e.g. plays per month). `{series: [{points: number[], label?, color?}], labels?: string[], max?, area?, valueFormat?}`. SVG polyline (+ optional area fill); `labels` are the x-ticks. Skin-safe. |
| `toolbar` | Titled button bar with optional status text |
| `settings-row` | Label + description + right-side control or child view |
| `section` | Titled grouping wrapper |
| `confirm` | Modal-style confirm with `confirmAction` / `cancelAction` and optional `data` payload. `checkboxLabel` (+ `checkboxDefault`) adds one opt-in tick **inside** the dialog for a second, more destructive reading of the same action — qBittorrent's "Also delete the downloaded files from disk" on Remove. Its state rides back merged into the action payload as **`checkboxChecked`**, on *both* actions (read it off cancel to remember the tick). Only an object payload can carry it: `undefined`/`null` becomes `{ checkboxChecked }`, an object gains the key, anything else (a bare id) passes through untouched. Prefer this over a second menu entry, which puts the dangerous variant one mis-click from the ordinary one. Older hosts render no checkbox and send nothing, which reads as `false` — so declare the *safe* behaviour as the unticked one |
| `detail-header` | Renders the **native** detail hero (`DetailHero`): multi-image crossfade background (`bgImages[]`, 0-4), effect looks + FX selector (inherits the global hero effect preference), square/`circle` art (`artShape`), `title`, `subtitle`+`meta` as chips, foreground art from `imageUrl`, Play (`playAction`) / Enqueue (`enqueueAction`) buttons, and an overflow (⋯) menu built from `actions[]` then `contextMenuActions[]`. Like/dislike, eyebrow, and titleLine are not exposed to plugins. |

### Table mode (`track-row-list` + `columns`)

For a list whose rows are compared on several numbers at once — a torrent search
weighing size against seeders against file count. Declare
`columns: { id, label, width?, align?, sortable? }[]` alongside `showHeader: true`,
and give each item a `cells: Record<columnId, string>`. The columns replace the
fixed Album / Duration pair; the row's `title` keeps the one flexing column and
its header reads **Name**. Requires `selectable` (the library-style list), like
`selectionPresets` and `openOnClick`.

Three rules, each of which was a decision rather than an accident:

- **The plugin sorts, the host doesn't.** `sortAction` fires with
  `{ column, direction }` on a header click and the plugin re-renders `items` in
  the new order; `sortBy` / `sortDir` are only what draws the ▲/▼. The host sees
  `"400 MB"` and `"1.2 GB"`, which sort backwards as strings — the plugin holds
  the raw numbers. `direction` is the flip of the current one for the sorted
  column and `"desc"` otherwise; treat it as a suggestion (a fresh *text* column
  wants `"asc"`).
- **An empty cell renders as an em dash.** A column the source never reported
  must not read as zero, so pass `""` for unknown and let the host draw the dash
  once, rather than inventing a placeholder per field.
- **Don't also set `duration`.** In table mode the trailing meta slot is
  dropped, because the figure that used to live there now has a column.

Older hosts ignore `columns` entirely and render the ordinary Album / Duration
list, so no `minAppVersion` bump is needed — but they will show the *old* fields,
so keep whatever `subtitle` still makes sense on its own.

## Visualizers

Rich visuals that fill **host-owned slots**. Contract: `src/types/pluginVisualizer.ts`. Host: `components/VisualizerSlot.tsx`, slot resolution in `utils/visualizerSlots.ts`, registry in `usePlugins` (`plugins.visualizers` / `plugins.createVisualizer`).

**The governing rule: plugins render, the host acts.** A visualizer is a pure function of (host state, user gesture). It holds no state anyone else depends on, and its only writes are `actions.seek(secs)`, `actions.playQueueIndex(n)` and `actions.setPlaying(bool)` — the gestures a playback visual naturally has. There is still deliberately **no** volume, next/previous or queue mutation: that stays with the host, so a misbehaving visualizer can cost you a view but never your music. (`seek` is in on the principle that the host's own seek bar is a visual that writes position.)

**`setRate(rate)` + `state.rate` — playback speed.** Added for the deck's other physical control, the 33/45 selector. **Pitch rides along with tempo** on both engines (the browser element's `preservesPitch` and mpv's `audio-pitch-correction` are both turned *off*, against their defaults) — a turntable resamples, so 45 on a 33 pressing is faster *and* higher. That's the feature; a pitch-corrected version would be a tempo tool, not a deck.

The two ship together on purpose: a speed control that can't show which speed is selected is a control that lies, so `state.rate` is as load-bearing as the write. It's also the honest input for anything animating at the music's pace — a platter drawn at a fixed 33 while the audio runs at 45 is a picture of the wrong deck.

**The host clamps it** (`clampRate` in `VisualizerSlot`, 0.25–4; zero, negative and non-finite all become 1), and the host keeps a route back to 1× that doesn't depend on the plugin — Settings → Playback, plus a reset on every launch, since rate is deliberately **not persisted**. That matters more here than for any other action: everything else a visualizer can write is instantly visible and trivially undone, but a rate is audible, subtle and sticky, and is the first write in this contract that could genuinely cost someone their music. A visualizer must never be the only way out of a state it put you in.

**`setPlaying` is a state, not a toggle.** Pass the state you want. A visualizer renders from a snapshot that may be a frame stale, and a toggle read against a stale snapshot inverts; the host compares against live state and no-ops when they already agree. It was added for the control a deck already draws — a cue lever whose raised position *is* the paused state, which could otherwise only animate a lie. Guard it (`typeof host.actions.setPlaying === "function"`) if you support hosts older than it.

**`mount` is the escape hatch, not the default.** Anything that is a list, a form or a header belongs in the declarative `PluginViewData` node union — that's what makes plugin content look native. Reach for a visualizer only for genuine visuals.

**Declaring one** — `contributes.visualizers: [{ id, name, placements, icon? }]` (static) or `api.visualizers.register(descriptor)` (runtime), then `api.visualizers.onMount(id, factory)`. The factory must return a **fresh** object per call: one instance per occupied slot. Placements: `nowplaying`, `sidebar`, `queue-header`, `fullscreen`, `miniplayer` — **`nowplaying`** (replaces the art column) and **`fullscreen`** are wired; `sidebar` / `queue-header` / `miniplayer` are declared in the contract but have no host slot yet. Selection persists as `visualizerSlots` in the app store.

**Picking one:** the Now Playing view's **visualizer button** (top-right, disc icon) opens the native picker; Settings → Playback has the same list as a select. Declaring a visualizer is enough to appear in both — no extra registration. There is no ⋯ menu and no right-click menu on that view any more; fullscreen and the lyrics toggle are their own buttons beside it.

**The picker's first entry is "Artwork", not "None".** Not selecting a plugin visualizer has always meant "render the track's album/artist image", so the slot is never empty and the old label described the absence of a plugin rather than what the user sees. It is still stored as `null`, so a plugin author sees no difference — but don't write UI or docs that call the unselected state "None".

**The `fullscreen` slot inherits the `nowplaying` pick** when the user hasn't chosen one explicitly *and* that visualizer also declares `fullscreen` (`resolveFullscreenSlot`). Going fullscreen means "show me this, bigger", so a plugin that wants F to work only has to add `"fullscreen"` to its `placements` — there is no second thing for the user to configure, and nothing offers the explicit `fullscreen` key today (it is honoured if set, for a future visualizer only worth showing at full size). Entered with **F** (audio only — video keeps its own fullscreen path) or from the ⋯ menu; **Escape** exits.

**Growing into the view:** with lyrics absent or collapsed, the `nowplaying` slot takes the whole stage rather than staying square in half of it. A visualizer should therefore expect its box to change aspect and size at runtime and handle `onResize` properly — this is not a one-time measurement.

**The host owns the frame loop**, not the plugin. It calls `frame(state)` and therefore can stop calling an off-screen or backgrounded visualizer, and gives up on one that throws 10 frames in a row. Never run your own `requestAnimationFrame`.

**It is capped at `VISUALIZER_TARGET_FPS` (60), which on macOS changes nothing.** Measured, so don't repeat the folklore: WKWebView drives `requestAnimationFrame` at **60Hz even on a 120Hz ProMotion display** — instrumented in the running app, raw rAF was 60.0Hz and the gate passed 60.0 of them per second. The cap is a portability ceiling for webviews that *do* follow a high-refresh display (WebView2 on a 120/144Hz monitor), not a saving on a Mac; alternating A/B runs there landed within the ~0.7 CPU-s/min noise floor. The gate is the pure `shouldRenderFrame`, deliberately lenient (it draws once 75% of the budget has elapsed): a strict deadline halves the rate on any display whose interval doesn't divide the budget — 144Hz would have run at 48fps, *below* an uncapped 60Hz panel. **Never derive elapsed time from a frame count** — integrate `state.timeMs` deltas, which is what the vinyl deck's platter does, so a capped host and an old uncapped one spin at the same speed.

**For scale, before optimising a visualizer:** on that same rig the vinyl deck's entire animation measured ~**1 CPU-s/min (~1.7% of one core)** at 60fps — the difference between drawing it and freezing it with the rest of the Now Playing view untouched — against ~7.8 CPU-s/min for that screen with the deck frozen. A visualizer's frame loop is not where the Now Playing view's cost lives, and a change that "should obviously be faster" there is below the noise floor of a 60-second CPU sample. Measure with a same-screen control (freeze the loop), not against a different view: the Home view costs *more* than Now Playing with the deck running, so it is not a floor.

**The shared audio bus is suspended while no slot is mounted.** A running `AudioContext` is a render thread waking every ~2.7ms whether or not anything is connected, and the bus is module-level so it outlives every slot — one visit to Now Playing used to leave it awake for the session. Slots ref-count it (`acquireAudioBus` / `releaseAudioBus`, suspended after a 2s grace so a parting one-shot finishes and a fullscreen handover doesn't seam). Suspended, never closed: a closed context can't be reused and browsers cap how many may exist. **The device is still only *built* on the first `host.audio` read**, so a visualizer that only draws opens none — don't read `host.audio` at mount "to have it ready", read it when you first make a noise. (The vinyl deck did exactly that and opened a device for users who had its sounds switched off.)

`PluginVisualizerState` arrives as one consistent snapshot — `currentIndex` always indexes the `queue` it came with, which removes the staleness bug a plugin assembling this from separate reads would have. **`queueRevision`** is the cheap signal for "redo per-queue work": it only changes when the queue does, so expensive layout/repaint happens once per change rather than once per frame.

**Render target is a shadow root.** CSS custom properties inherit through shadow boundaries, so skin tokens arrive for free while the plugin's CSS can't leak out; `host.useDesignSystem()` adopts the `.ds-*` sheet into it. Two consequences to know:
- The app's global `prefers-reduced-motion` guard **does not cross a shadow boundary**, and could never reach a canvas animation anyway. The host adopts a base sheet carrying that guard, and `host.reducedMotion` covers everything animated in JS. Honour it.
- Skin-safety is no longer structural — a plugin's canvas *can* hardcode a colour where a host renderer's provably can't. Use `host.token()` + `host.onSkinChange()`, and prefer the **alpha-only** painting trick (paint black/white alpha, let CSS underneath supply the colour): the vinyl deck reads no token at all, so it cannot break a skin.

Gestures: attach your own listeners to the shadow root — the contract has no pointer hook on purpose, since owning real DOM is strictly more capable. Follow the repo drag rule inside it (manual mouse events, never HTML5 DnD).

**Known limitation:** cue hit-testing derived from the on-screen projection is exact only at zero platter tilt; a tilted exact test needs the inverse rotateX projection.

**Conformance check:** `src/__tests__/pluginVisualizerContract.test.ts` rebuilds the deck against the contract alone (no React, no host node) and drives it with synthetic frames. Change the contract, run that.

### Vinyl Deck (reference visualizer)

`outcast1000/viboplr-vinyl-deck` — the worked example of a rich visual living
entirely outside the app. **The host holds none of it**: no view kind, no
component, no geometry in `src/`. Read that repo's README before writing a
visualizer; it carries the geometry rationale and a list of the non-obvious
constraints (sandbox has no ambient DOM, measure the platter not the canvas, the
stylus must be drawn at the arm's far end, rotating a concentric canvas is
invisible).

What it exercises, and therefore what a new visualizer can rely on: the shadow
root and skin-token inheritance, `useDesignSystem`, `onResize`, `onSkinChange`,
`reducedMotion`, `queueRevision`, both `actions`, and settings reaching a running
instance by shared mutable reference (the host re-mounts only when a slot's
*selection* changes, so a settings change can never arrive as a new mount).

## Plugin build step

A plugin is still **one file the host evaluates as a function body, using whatever
it returns** — that contract is unchanged, and the hand-written ES5 plugins keep
working untouched. What's new is that a plugin may *generate* that file.

The pattern, in `viboplr-vinyl-deck`: vite lib mode, `formats: ["iife"]`, plus
`output.footer: "return __viboplrPlugin;"`. The result is
`var X = (function(exports){…})({}); return X;` — exactly what the loader wants. So
a toolchain is **purely author-side**: no CSP work, no module resolution inside the
webview, and nothing in the host to change.

Two things that repo does which any bundled-to-source plugin should copy:

- **Assert the bundle's shape after building.** A footer that silently stops being
  emitted produces a plugin that loads and exports nothing — it doesn't error, it
  just does nothing. `scripts/finish-build.mjs` checks for the trailing `return`
  and for `exports.activate` before moving the artifact into place.
- **Fail CI when the committed `index.js` doesn't match a fresh build.** The
  gallery installs from a release zip, so a stale committed bundle means users run
  code that doesn't correspond to the source.

**What the sandbox does and doesn't give you.** The loader passes a frozen stand-in
for `window`/`globalThis`/`self` and **`document: undefined`**. So a visualizer
cannot use ambient DOM, and this is not incidental:

- Get the document from the contract — `host.root.ownerDocument`.
- There is no ambient `window`, so **window-level drag listeners are impossible**.
  Use `setPointerCapture` on your own element with `pointermove`/`pointerup`; it's
  the better primitive anyway (the drag survives leaving the element and can't be
  stolen). Pointer events, not HTML5 DnD, which is banned in this webview.
- `setTimeout`/`setInterval`, `console`, `Math`, `JSON`, `Date`, `Promise` and the
  core constructors are available; almost nothing else is.

**Host types.** There is no published types package. An external plugin vendors
what it needs: copy the visualizer contract verbatim and re-sync it with a script
(never hand-patch a vendored copy — it drifts silently and nothing fails until a
user sees it misbehave), and hand-write a *subset* of the API surface for the calls
you actually make. Typing the view nodes you emit is worth it: it caught three
malformed ones the deck had shipped as hand-written JS.

### Toggle Control Note

Toggle controls use `checked: boolean`, not `value`. `{ type: "toggle", label, action, checked }`.

## Database Tables

- **`information_types`** — registered info types with `type_id`, `entity`, `display_kind`, `plugin_id`, `ttl`, `sort_order`, `priority`, `active`. Unique on `(type_id, plugin_id)`.
- **`information_values`** — cached values with `information_type_id`, `entity_key` (name-based), `value` (JSON), `status`, `fetched_at`. Primary key on `(information_type_id, entity_key)`.
- **`image_providers`** — registered image providers with `plugin_id`, `entity`, `priority`, `active`.
- **`stream_resolvers`** — registered stream resolvers with `plugin_id`, `resolver_id`, `priority`, `active`.
- **`plugin_storage`** — per-plugin key-value store. Primary key on `(plugin_id, key)`.
- **`plugin_schedules`** — periodic task state.


