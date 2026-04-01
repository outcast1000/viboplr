# Viboplr — Specification

## 1. Overview

Viboplr is a lightweight, cross-platform **media player** for macOS and Windows. It plays audio and video files from local folders, Subsonic/Navidrome servers, and TIDAL. It scans local folders in the background, reads metadata tags, and builds a searchable library backed by SQLite. The player prioritizes fast startup, instant playback, and quick search.

**Non-goals (v1):** equalizer/DSP, lyrics, mobile.

## 2. Tech Stack

| Layer            | Technology                          | Purpose                                  |
| ---------------- | ----------------------------------- | ---------------------------------------- |
| App shell        | Tauri 2                             | Native window, small binary, no Chromium |
| Backend          | Rust                                | Scanning, DB, file watching, sync, downloads, API clients |
| Frontend         | TypeScript + React                  | UI + playback via HTML5 media elements   |
| Playback         | HTML5 `<audio>` / `<video>`         | OS-native codecs via webview             |
| File serving     | Tauri asset protocol                | `asset://` serves local files to webview |
| Server streaming | Subsonic REST API                   | HTTP streaming from Subsonic/Navidrome   |
| Tag reading      | `lofty`                             | ID3v1/v2, Vorbis, FLAC, MP4, Opus tags  |
| File watching    | `notify`                            | Cross-platform filesystem events         |
| Database         | SQLite via `rusqlite`               | Embedded media library                   |
| Search           | SQLite FTS5                         | Sub-millisecond full-text search         |
| Scrobbling       | Last.fm API (`ws.audioscrobbler.com`)| Now-playing, scrobble, history import    |
| TIDAL streaming  | Hi-Fi API (Monochrome)              | Search, browse, stream from TIDAL catalog|
| Downloads        | `reqwest` + `lofty`                 | Track downloads with tag writing         |
| State persistence| `tauri-plugin-store` v2              | Save/restore UI state across restarts    |

All Rust dependencies are MIT or Apache-2.0 licensed. No GPL/LGPL.

## 3. Supported Formats

### Audio

MP3, FLAC, AAC/M4A, WAV, ALAC, OPUS.

WMA: best-effort.

### Video

MP4/M4V/MOV (H.264) — supported on both macOS and Windows.

WebM (VP8/VP9) — Windows only (Chromium-based WebView2). Not supported on macOS (WebKit).

## 4. Core Features

### 4.1 Collections

All music sources are unified under a **Collections** abstraction. A collection has a `kind` discriminator:

- **`local`** — a local folder scanned for media files.
- **`subsonic`** — a Subsonic/Navidrome server synced via the Subsonic REST API.
- **`tidal`** — a TIDAL instance connected via the Hi-Fi API (see §4.18).
- **`seed`** — debug-only fake test data (gated behind `debug_assertions`).

Every track belongs to a collection via `collection_id`. The sidebar displays all collections with kind badges, resync buttons, and remove buttons.

**Collection settings:** Each collection can be edited via an Edit Collection modal (`EditCollectionModal` component) with:
- **Name** — editable display name.
- **Enabled/Disabled** — a boolean toggle. Disabled collections' tracks are filtered out of all library views and search results via a global `ENABLED_COLLECTION_FILTER`. Disabling is non-destructive; tracks remain in the database.
- **Auto-update** — a boolean toggle. When enabled, the collection is automatically resynced at a configurable interval.
- **Update frequency** — selectable interval (15m, 30m, 1h, 3h, 6h, 12h, 24h). Default: 60 minutes.
- **Last synced** — read-only display of last sync time and duration.

### 4.2 Local Folder Scanning

- User selects a folder via native directory picker → creates a `local` collection.
- A background Rust thread walks the folder tree recursively.
- Skips files with 0-byte size.
- For each audio file, reads tags via `lofty`. **Video files** (mp4, m4v, mov, webm) skip tag reading entirely — the filename is used as the title with no artist/album/genre metadata.
- For audio files, if tags are missing or empty, falls back to **regex-based filename parsing** (see §4.3).
- Genre metadata from file tags is stored as **tags** (many-to-many relationship with tracks).
- Inserts/updates rows in SQLite (`artists`, `albums`, `tags`, `track_tags`, `tracks`).
- Reports scan progress to the frontend via Tauri events.
- Each track's `collection_id` is set to the owning collection.
- **Soft delete:** When files are removed from disk, their tracks are marked as `deleted = 1` rather than being hard-deleted from the database. All track queries filter `WHERE t.deleted = 0`.
- **Logging:** The scanner logs at `info!` level throughout: scan start (folder path + file count), each file processed ("New file" or "Updated file"), file removals, and scan end (total count + elapsed time).

### 4.3 Tag Fallback — Filename Regex

When `lofty` returns no usable tags, the following regex patterns are tried in order against the filename (stem only, no extension):

1. `^(?P<track>\d+)[\s._-]+(?P<artist>.+?)\s*-\s*(?P<title>.+)$`
   → e.g. `03 - Pink Floyd - Comfortably Numb`
2. `^(?P<artist>.+?)\s*-\s*(?P<title>.+)$`
   → e.g. `Pink Floyd - Comfortably Numb`
3. `^(?P<track>\d+)[\s._-]+(?P<title>.+)$`
   → e.g. `03 - Comfortably Numb` (parent folder → album & artist)
4. **Fallback:** filename stem → title, parent folder → album, grandparent folder → artist.

### 4.4 File Monitoring

- `notify` crate watches all local collection folders for create/delete/rename/modify events.
- On change, the scanner re-processes only the affected file(s), with the correct `collection_id`.
- Runs on a dedicated background thread; does not block UI or playback.
- Logs file change and removal events at `info!` level.

### 4.5 Subsonic/Navidrome Server Integration

- User adds a server via a modal dialog (name, URL, username, password).
- On connect, the client pings the server to verify credentials.
- **Authentication:** tries token auth first (`md5(password+salt)`), falls back to plaintext if ping fails. Credentials are stored in the `collections` table (password token, salt, auth method).
- **Sync:** a background thread paginates `getAlbumList2` (500/page), then fetches each album's tracks via `getAlbum`. Artists, albums, and tracks are upserted into the local DB.
- **Track path:** subsonic tracks use a synthetic path `subsonic://{collection_id}/{subsonic_track_id}` to satisfy the UNIQUE constraint on `tracks.path`.
- **Resync:** deletes all tracks for the collection, then performs a full re-import.
- Genre metadata from Subsonic is stored as tags.
- Progress reported via `sync-progress` / `sync-complete` events.

### 4.6 Library Browsing

- Browse by **artist**, **album**, **tag**, **liked tracks**, **history**, **TIDAL** (when a tidal collection exists), or **all tracks** (flat list).
- List view (table) with columns: like (heart icon), track number, title, artist, album, year, quality (bitrate), duration, file size, collection, path. Columns are togglable via a column menu; default visible: like, number, title, artist, album, duration. In list/tiles view modes, tracks use a **two-line layout**: title on line 1 (15px), artist · album on line 2 (13px).
- **Multi-selection:** Click to select a single track. Cmd/Ctrl+Click to toggle individual tracks. Shift+Click to select a contiguous range. Cmd/Ctrl+Shift+Click to add a range to the existing selection. Selected rows are visually highlighted. Selection is cleared on view/track-list change and on double-click.
- Tracks from all enabled collections (local and server) are unified in a single library.
- **Breadcrumb actions:** Artist detail and tag detail views show "Play All" and "Queue All" buttons in the breadcrumb bar. The All Tracks view does not show these bulk-play buttons.

**View modes:** Artists, Albums, Tags, All Tracks, and Liked views each support three view modes, toggled via a `ViewModeToggle` component in the sort bar:
- **Basic** — compact table with sortable column headers.
- **List** — row-based list with images/art, like buttons, and metadata.
- **Tiles** — card grid with large artwork, like overlays, and metadata below.

View mode selections are persisted per entity (`artistViewMode`, `albumViewMode`, `tagViewMode`, `trackViewMode`, `likedViewMode`).

**Artist list sort controls:** A sort bar above the artist list offers Name, Tracks (track count), and Shuffle buttons, plus a heart toggle to float liked artists to the top. Name and Tracks cycle through ascending → descending → unsorted on repeated clicks. Shuffle re-randomizes each click (Fisher-Yates).

**Album grid sort controls:** A sort bar above the album grid offers Name, Artist, Year, Tracks, and Shuffle buttons, plus a heart toggle to float liked albums to the top. Name, Artist, Year, and Tracks cycle asc → desc → unsorted. Shuffle re-randomizes each click.

**Tag list sort controls:** A sort bar above the tag list offers Name, Tracks (track count), and Shuffle buttons, plus a heart toggle to float liked tags to the top. Name and Tracks cycle asc → desc → unsorted. Shuffle re-randomizes each click (Fisher-Yates).

**All Tracks sort controls:** The sort bar is split into two labeled rows: a **Sort** row (Title, Artist, Album, Year, Quality, Duration, Size, Collection, Shuffle, and a heart toggle to float liked tracks to the top) and a **Filter** row (YouTube filter `YT`, media type filter All/Audio/Video). Sort fields cycle asc → desc → unsorted. The view mode toggle and collapse button remain visible when the sort bar is collapsed.

**Independent scrolling:** Lists scroll within their own container instead of the whole main content area, so headers and breadcrumbs remain visible while scrolling long lists.

**Performance:** Track counts for artists, albums, and tags are precomputed and stored in `track_count` columns (see §5). Counts are recomputed after every scan, sync, collection toggle, and FTS rebuild. The `get_artists`, `get_albums`, and `get_tags` queries use simple `WHERE track_count > 0` filters instead of JOIN/GROUP BY/HAVING, making sidebar navigation instant. The frontend skips fetching tracks when only the album grid or tag list is displayed (no track table rendered), and does not re-fetch the full album list when navigating to the Albums view (already loaded by `loadLibrary`).

### 4.7 Tags

Tags replace the previous single-genre-per-track model. A track can have **multiple tags** via a many-to-many relationship (`track_tags` junction table). Genre metadata read from file tags or Subsonic metadata is stored as tags. The Tags view in the sidebar lists all tags with track counts; clicking one shows a tag detail header and the tag's tracks.

**Liked tags:** Each tag has a `liked` boolean attribute. Like buttons appear in all three tag view modes (heart icon). The tag detail header also shows a like button. The sort bar has a heart toggle to float liked tags to the top.

**Tag images:** Tags support manual image management (set from file, paste from clipboard, remove) via the generic entity image commands (`set_entity_image`, `paste_entity_image`, `remove_entity_image` with `kind: "tag"`). Images are stored as files in `{app_dir}/tag_images/{canonical_slug}.{ext}` (see §12.3 for canonical slug format). A `TagCardArt` component renders the tag image (or initial letter fallback) in list and tiles views, with lazy-loading via IntersectionObserver.

**Auto-generated composite tag images:** When a tag has no manually-set image, the backend auto-generates a composite PNG from the top 1–3 artists (by track count) within that tag. Artist photos are cropped to circles with anti-aliased edges and a dark border, overlapping horizontally on a transparent canvas (right-to-left draw order so the top artist is in front). The composite is generated via the `image` crate (`composite_image.rs`) and follows the same async pipeline as other images: frontend requests via `fetch_tag_image`, backend processes on the worker thread, emits `tag-image-ready` event when done. Failure tracking and deduplication are shared with artist/album image downloads.

### 4.8 Search

**Dual search architecture:** The app has two independent search mechanisms:

1. **Central search dropdown** (`CentralSearchDropdown` component, `useCentralSearch` hook): A pill-shaped input in the caption bar (`Cmd/Ctrl+K` to focus) that queries the FTS5 index with 400ms debounce. Displays up to 5 results in a dropdown with album art (fallback: artist image, then initial letter), two-line rows (title + artist · album subtitle), and keyboard navigation. Enter plays the selected track; `Cmd/Ctrl+Enter` enqueues it. Pressing Enter with no selection commits the query to the current view's search bar. Footer hints show available actions.

2. **Per-view search bars** (`ViewSearchBar` component, `useViewSearchState` hook): Each view (artists, albums, tags, tracks, liked, history, tidal) has its own independent search bar that filters content within that view. Search state is maintained per-view and persists across view switches. Navigation history stores per-view search queries (via `viewSearchQueries` map) instead of a single shared query. **Arrow key navigation:** Pressing Down/Up in a view search bar navigates the underlying list (highlight moves), Enter activates the highlighted item. **Artist view search** tokenizes the query on whitespace and punctuation (`/[\s.,;:_\-\/\\]+/`), requiring all tokens to match (AND logic) for flexible multi-word lookups.

**FTS5 index:**
- SQLite FTS5 virtual table indexes: track title, artist name, album title, tag names, filename.
- **Accent-insensitive:** all indexed text is stripped of diacritics before insertion via a custom `strip_diacritics()` SQL function (Rust, using `unicode-normalization` crate). Search queries are also normalized before matching. This works for all Unicode scripts (Latin, Greek, Cyrillic, etc.). Client-side list filtering (artists, albums, tags) uses JavaScript `String.normalize("NFD")` with combining-mark removal for the same effect.
- Search-as-you-type with <100 ms response time.
- Uses custom SQL functions `filename_from_path()` and `strip_diacritics()` (Rust-implemented) registered at database initialization.
- Index automatically rebuilt after folder scans and server syncs; can be manually triggered via `rebuild_search_index` command.

### 4.9 Playback

- Frontend-driven via HTML5 `<audio>` and `<video>` elements.
- **Local tracks:** served to the webview via Tauri's `asset://` protocol (`convertFileSrc()`).
- **Server tracks:** `get_track_path` constructs a streaming URL with auth params from stored credentials. The `<audio>` element plays the HTTP URL directly.
- **TIDAL tracks:** `get_track_path` fetches a fresh CDN URL from the Hi-Fi API at play time. The `<audio>` element plays the HTTPS URL directly.
- Media type (audio vs video) determined by file extension (video: mp4, m4v, mov, webm).
- Transport controls: play, pause, stop, seek, volume.
- Position and duration tracked via HTML5 media events (`timeupdate`, `loadedmetadata`, `play`, `pause`, `ended`) — no polling.
- Video displayed **below the content area** (between the track list and the now-playing bar) with a **resizable splitter**. The splitter is draggable (default height: 300px, persisted as `videoSplitHeight`), has a collapse/expand button to minimize the video, and enforces a 150px minimum track list height. A **fullscreen button overlay** appears on hover in the bottom-right corner of the video, with a tooltip showing the keyboard shortcut (`Cmd/Ctrl+F`) and how to exit (`Esc`). Double-click or `Cmd/Ctrl+F` on the video enters native fullscreen.
- **Double-click:** Double-clicking a track in any view (All Tracks, Artist, Album, Tag, Liked) plays only that single track — the queue is replaced with just that one track. No additional tracks are queued or auto-played after it finishes (unless Auto Continue is enabled).
- **Playback error handling:** Error event handlers on `<audio>` and `<video>` elements detect unsupported codecs, network errors, and decode errors. A red error banner appears above the now-playing bar with a descriptive message and dismiss button. The error clears automatically when a new track starts playing.
- **Waveform seek bar:** Audio tracks display a waveform visualization inside the seek bar (both the Now Playing bar and fullscreen controls). Audio files are analyzed using the Web Audio API with RMS-based amplitude calculation and 95th-percentile normalization (power curve) to prevent flat-wall waveforms. Bucket count is dynamic (1 per second, capped at 400). Waveform peak data is cached as versioned JSON files in `{app_dir}/waveforms/v2/{track_id}.json` for instant display on subsequent plays; old cache entries are cleaned up on first launch. Graceful degradation: a plain seek bar is shown for video tracks, remote/subsonic tracks, files over 10 MB, or when Web Audio decoding fails.
- Keyboard navigation: arrow keys to navigate tracks, Enter to play.
- **Minimized window:** Playback continues when the app window is minimized. A `visibilitychange` listener resumes playback if the browser auto-pauses media when the page becomes hidden. The crossfade loop uses `setInterval` instead of `requestAnimationFrame` so it runs while the page is hidden.

#### Gapless Playback & Crossfading

The player uses a **dual audio element (A/B)** architecture to achieve gapless transitions and crossfading between audio tracks. Video tracks do not participate in crossfading.

**Architecture:**
- Two `<audio>` elements (`audioRefA`, `audioRefB`) are always present in the DOM. One is the "active" slot (currently playing), the other is "inactive" (available for preloading).
- An `activeSlot` state (`"A"` | `"B"`) tracks which element is currently playing. On explicit `handlePlay`, the slot resets to `"A"`.

**Preloading:**
- When the active track's remaining time drops below a threshold (`max(5, crossfadeSecs + 2)` seconds), the player calls `peekNext()` from the queue to identify the next track.
- The next track's audio source is loaded into the inactive audio element with `preload="auto"`. A `canplay` event marks it as ready.
- If the queue changes or the user takes a manual action (play, stop), the preload is invalidated: the inactive element is paused, its `src` removed, and preload state cleared.

**Crossfade:**
- When crossfade is enabled (`crossfadeSecs > 0`) and the remaining time of the active track drops below `crossfadeSecs`, the player initiates a crossfade — provided the preload is ready.
- The incoming element starts playing at volume 0. A `requestAnimationFrame` loop ramps the incoming element's volume up from 0 to `volume` and the outgoing element's volume down from `volume` to 0 over the crossfade duration.
- At the end of the fade, the outgoing element is paused and its `src` removed. The active slot swaps to the incoming element.
- User actions during crossfade (pause, stop, manual play) cancel the crossfade immediately, snapping the incoming element to full volume and cleaning up the outgoing element.

**Gapless (crossfade = 0):**
- When crossfade is disabled, preloading still occurs. When the active track ends, `handleGaplessNext()` checks for a preloaded track and immediately starts the inactive element at full volume while stopping the active element, achieving a gapless transition.
- If no preload is ready, the normal `onEnded` path fires (auto-continue or stop).

**Settings:**
- `crossfadeSecs` is configurable via a slider in Settings (0–10 seconds, 0.5s steps). A value of 0 means "off" (gapless mode). Default: 3 seconds.
- Persisted to the app store under the `crossfadeSecs` key.

### 4.10 Liked Tracks, Artists, Albums & Tags

- **Tracks — tri-state liked:** Each track has a `liked` integer attribute with three states: **-1** (disliked), **0** (neutral), **1** (loved). In the track list, a heart icon column shows: filled heart (♥) when loved, outline heart (♡) when neutral or disliked. A separate **dislike button** (⊘ when neutral/loved, ✖ when disliked) appears alongside the heart in track lists, the Now Playing bar, and fullscreen controls. Clicking toggles between disliked (-1) and neutral (0). The `toggle_liked` command accepts an `i32` value. **Disliked tracks are excluded from Auto Continue** (all strategies add `AND t.liked != -1`) **and from Play All / Queue All operations**.
- The **Now Playing bar** shows both like and dislike buttons next to the current track info, allowing users to love/dislike the playing track without scrolling to it.
- The sidebar has a "Liked" view that shows all loved tracks (`liked = 1`) via `get_liked_tracks`. Search in this view is scoped to liked tracks only (`liked_only` flag in `TrackQuery`).
- **Artists:** Each artist has a `liked` integer (0 or 1). In the All Artists list, a heart icon per row toggles the like via `toggle_liked` (with `kind: "artist"`). The artist detail header also shows a heart icon next to the artist name. The sort bar's heart toggle floats liked artists to the top.
- **Albums:** Each album has a `liked` integer (0 or 1). In the All Albums grid, a heart overlay appears on hover (top-right corner of the album card) and toggles via `toggle_liked` (with `kind: "album"`). Liked albums show the heart permanently. The album detail header also shows a heart icon next to the album title. The sort bar's heart toggle floats liked albums to the top.
- **Tags:** Each tag has a `liked` integer (0 or 1). Like buttons appear in all three tag view modes (basic, list, tiles) and in the tag detail header, toggling via `toggle_liked` (with `kind: "tag"`). The sort bar's heart toggle floats liked tags to the top.
- **Scan-safe:** the `liked` column on tracks is excluded from the `upsert_track` ON CONFLICT clause, so re-scanning or re-syncing a collection preserves the user's likes. Artist, album, and tag likes are never touched by scanning.
- **Migration:** existing databases gain `liked` columns via `ALTER TABLE` for `tracks`, `artists`, `albums` (all `INTEGER NOT NULL DEFAULT 0`), and `tags` (migration version 5).

### 4.11 Auto Continue

When playback reaches the end of the queue in "normal" mode, the player normally stops. **Auto Continue** mode instead automatically selects and plays one more track, creating an endless listening experience.

**UI:** An infinity symbol (`∞`) button in the Now Playing bar (between the queue mode button and volume). When enabled, the button is accent-colored. Clicking opens a popover with:
- An ON/OFF toggle at the top.
- 5 weighted sliders (0–100%) controlling the probability of each selection strategy. Adjusting one slider proportionally redistributes the others to maintain a 100% total.

**Selection strategies:**

| Strategy | Default Weight | Behavior |
|----------|---------------|----------|
| Random | 40% | Any random track from the library (excluding the current track) |
| Same Artist | 20% | Random track by the same artist |
| Same Tag | 20% | Random track sharing any tag with the current track |
| Most Played | 10% | Random pick from the top 50 most-played tracks |
| Liked | 10% | Random liked track |

**Same Format filter:** A "Same format" toggle in the auto continue popover restricts all strategies to only pick tracks of the same media type (audio or video) as the currently playing track. This passes a `format_filter` parameter (`"audio"` or `"video"`) to the backend `get_auto_continue_track` command. Persisted as `autoContinueSameFormat` in the app store.

**Selection logic:**
1. A random number 0–99 is rolled and mapped to a strategy based on cumulative weights.
2. The backend `get_auto_continue_track` command executes the chosen strategy's SQL query (all exclude the current track via `t.id != ?`).
3. If the strategy returns no result (e.g., no liked tracks, no tags), the frontend retries with `"random"` as a fallback.
4. The selected track is appended to the queue and immediately played.

**Persistence:** `autoContinueEnabled` (boolean) and `autoContinueWeights` (object with 5 number fields) are persisted to the app store and restored on startup.

### 4.12 Context Menu

- Right-click on a track, album, or artist to open a context menu.
- **Multi-track context menu:** When multiple tracks are selected, right-clicking shows a context menu with "Play N tracks" and "Enqueue N tracks" actions. Search providers and Locate File are hidden for multi-track selections.
- **Play** / **Enqueue**: Play immediately or add to queue.
- **Locate File** (local tracks only): Opens the track's parent directory in the OS file explorer (macOS Finder, Windows Explorer via `raw_arg` for proper path quoting, or Linux xdg-open).
- **Delete** (local tracks only): Deletes the file from disk and soft-deletes the track from the database. Shows a confirmation dialog before proceeding. Supports single and multi-track deletion. If the currently playing track is deleted, playback stops. Only available for local (non-subsonic, non-tidal) tracks.
- **Upgrade via TIDAL** (local tracks only, when TIDAL is configured): Opens a modal to replace the local file with a higher-quality version from TIDAL (see §4.23).
- **Search providers**: Dynamic list of enabled search providers (see §4.14). Each provider appears with its icon and a "Search on {name}" label. Clicking opens the provider's URL with `{artist}` and `{title}` placeholders filled in. Only providers with a URL template for the current context (artist/album/track) are shown.

### 4.13 Play History

Play history is stored in a **decoupled 3-table system** (`history_artists`, `history_tracks`, `history_plays`) that is independent from the main library. This allows history to survive track deletions, library rebuilds, and imports from external sources like Last.fm. The history system powers the History view, the "Most Played" auto-continue strategy, and Last.fm scrobbling.

**Schema:**
- **`history_artists`** — canonical name (diacritics stripped + lowercase), display name, first/last played timestamps, play count, optional `library_artist_id` for reconnection.
- **`history_tracks`** — linked to `history_artists`, canonical title, display title, first/last played timestamps, play count, optional `library_track_id` for reconnection.
- **`history_plays`** — individual play entries with `history_track_id` and `played_at` timestamp.

**Canonical matching:** Artist names and track titles are canonicalized by stripping diacritics and lowercasing before storage. This ensures that "Björk" and "bjork" merge into the same history entry.

**Scrobble threshold:** Play history is not recorded immediately on playback start. Instead, the frontend tracks elapsed time and calls `record_play` only after the **scrobble threshold** is met: the track must have played for at least **50% of its duration or 4 minutes**, whichever comes first. Tracks shorter than 30 seconds are never recorded. This follows the Last.fm scrobbling rules.

**Video tracks:** By default, video track plays are **not** recorded in history. A "Track video history" toggle in Settings > General allows users to opt in. When off (default), the frontend skips both `record_play` and Last.fm scrobbling for video tracks. Persisted as `trackVideoHistory` in the app store.

**Real-time recording (`record_play`):**
- Looks up track metadata from the library, canonicalizes artist/title.
- Upserts into `history_artists` and `history_tracks` (keeps `library_artist_id`/`library_track_id` current for reconnection).
- **30-second dedup window:** Skips the play record if the same track was recorded within the last 30 seconds.
- Inserts into `history_plays` and updates denormalized `play_count` on tracks and artists.

**Backend commands:**
- `record_play(track_id)` — records a play from the library (looks up metadata, 30-sec dedup).
- `get_history_recent(limit)` — most recent individual plays with display metadata.
- `get_history_most_played(limit)` — tracks ranked by total play count (all time) with rank.
- `get_history_most_played_since(since_ts, limit)` — tracks ranked by play count since a timestamp.
- `get_history_most_played_artists(limit)` — artists ranked by total play count with track count.
- `search_history_artists(query, limit)` — search history artists by name.
- `search_history_tracks(query, limit)` — search history tracks by title/artist.
- `reconnect_history_track(history_track_id)` — attempt to match a disconnected history track to a library track.
- `reconnect_history_artist(history_artist_id)` — attempt to match a disconnected history artist to a library artist.
- `get_track_rank(history_track_id)` — get the rank of a specific track by play count.
- `get_artist_rank(history_artist_id)` — get the rank of a specific artist by play count.

**Frontend (HistoryView component):**
The History view (`Ctrl/Cmd+6`) uses a **tabbed interface** with four tabs:
1. **All Time** — top 20 tracks by total play count, showing rank, title, artist, and play count.
2. **Last 30 Days** — top 20 tracks by play count in the last 30 days.
3. **Recent** — last 50 individual plays with relative timestamps (e.g., "5m ago", "2h ago", "3d ago").
4. **Artists** — top 20 artists by total play count, showing rank, artist image, name, play count, and track count.

Each tab shows its content independently; search filters across all sections. Arrow keys from the search bar navigate the active tab's list (Down/Up to highlight, Enter to activate). Double-clicking a row plays the track (or navigates to the artist view for artist rows).

**Ghost entry reconnection:** History entries for tracks or artists that no longer exist in the library ("ghost" entries) can be dynamically reconnected. Double-clicking a disconnected history track or artist attempts to match it to a current library entry by canonical title and artist name. If a match is found, the history entry is reconnected and the track plays (or the artist view opens). If no match is found, a status bar warning is displayed.

**Rank display in Now Playing bar:** When a track is playing and has history data, its rank and the artist's rank are displayed in the Now Playing bar (e.g., "#5" for the track, "#3" for the artist).

### 4.14 Configurable Search Providers

Search providers in the context menu are fully user-configurable: add, remove, edit, enable/disable. Configuration is persisted across sessions via `tauri-plugin-store`.

**Data model (`SearchProviderConfig`):**

```typescript
interface SearchProviderConfig {
  id: string;            // "builtin-google" for defaults, crypto.randomUUID() for custom
  name: string;          // Display name
  enabled: boolean;
  builtinIcon?: string;  // "google"|"lastfm"|"x"|"youtube"|"genius" for SVG icons
  artistUrl?: string;    // e.g., "https://www.last.fm/music/{artist}"
  albumUrl?: string;     // e.g., "https://www.last.fm/music/{artist}/{title}"
  trackUrl?: string;     // e.g., "https://genius.com/search?q={title}+{artist}"
}
```

- Placeholders `{artist}` and `{title}` are URL-encoded on substitution. Unfilled placeholders are removed.
- If a URL template is absent for a context (artist/album/track), the provider is hidden for that context.
- **5 built-in providers** ship by default: Google, Last.fm, X, YouTube, Genius.

**Built-in vs custom providers:**
- Built-in providers (`id.startsWith("builtin-")`) can be disabled and edited but not deleted.
- Custom providers can be deleted. Their icons are fetched via Google's favicon service (`https://www.google.com/s2/favicons?domain={domain}&sz=32`), with a first-letter circle fallback on error.

**Settings UI** (Settings > Providers tab):
- List view: each row shows icon, name, context chips (Artist/Album/Track), enable/disable toggle, edit button, and delete button (custom only).
- Inline edit/add form: name, artist/album/track URL template fields with placeholder hints.
- "Add Provider" and "Reset to Defaults" buttons.

**Persistence:**
- Stored under the `searchProviders` key in the app store. Default value is `null`, meaning "use built-in defaults". The key is only written when the user makes their first edit, avoiding unnecessary disk writes for default configurations.

### 4.15 State Persistence

UI state is saved to disk via `tauri-plugin-store` and restored on startup so the app resumes exactly where the user left off. The store is a JSON file (`app-state.json`) in the active profile directory (see section 4.19).

**Persisted state:**

| Key | Type | Default |
|-----|------|---------|
| `view` | `string` (`"all"`, `"artists"`, `"albums"`, `"tags"`, `"liked"`, `"history"`, `"tidal"`) | `"all"` |
| `selectedArtist` | `number \| null` | `null` |
| `selectedAlbum` | `number \| null` | `null` |
| `selectedTag` | `number \| null` | `null` |
| `currentTrackId` | `number \| null` | `null` |
| `positionSecs` | `number` | `0` |
| `volume` | `number` | `1.0` |
| `queueTrackIds` | `number[]` | `[]` |
| `queueIndex` | `number` | `-1` |
| `queueMode` | `string` (`"normal"`, `"loop"`, `"shuffle"`) | `"normal"` |
| `showQueue` | `boolean` | `false` |
| `playlistName` | `string \| null` | `null` |
| `windowWidth` | `number \| null` | `null` |
| `windowHeight` | `number \| null` | `null` |
| `windowX` | `number \| null` | `null` |
| `windowY` | `number \| null` | `null` |
| `searchProviders` | `SearchProviderConfig[] \| null` | `null` |
| `crossfadeSecs` | `number` | `3` |
| `autoContinueEnabled` | `boolean` | `false` |
| `autoContinueWeights` | `{ random, sameArtist, sameTag, mostPlayed, liked }` | `{ 40, 20, 20, 10, 10 }` |
| `autoContinueSameFormat` | `boolean` | `false` |
| `miniMode` | `boolean` | `false` |
| `artistViewMode` | `string` (`"basic"`, `"list"`, `"tiles"`) | `"tiles"` |
| `albumViewMode` | `string` (`"basic"`, `"list"`, `"tiles"`) | `"tiles"` |
| `tagViewMode` | `string` (`"basic"`, `"list"`, `"tiles"`) | `"tiles"` |
| `trackViewMode` | `string` (`"basic"`, `"list"`, `"tiles"`) | `"basic"` |
| `likedViewMode` | `string` (`"basic"`, `"list"`, `"tiles"`) | `"basic"` |
| `lastfmSessionKey` | `string \| null` | `null` |
| `lastfmUsername` | `string \| null` | `null` |
| `trackVideoHistory` | `boolean` | `false` |
| `videoSplitHeight` | `number` | `300` |
| `sidebarCollapsed` | `boolean` | `false` |
| `miniWindowX` | `number \| null` | `null` |
| `miniWindowY` | `number \| null` | `null` |
| `fullWindowWidth` | `number \| null` | `null` |
| `fullWindowHeight` | `number \| null` | `null` |
| `fullWindowX` | `number \| null` | `null` |
| `fullWindowY` | `number \| null` | `null` |
| `skin` | `string` | `"default"` |

**Behavior:**

- Only the track ID is persisted — the full `Track` object is re-fetched via `get_track_by_id` on restore. If the track was deleted, the app gracefully falls back to no current track.
- On restore, the last track is loaded at the saved position but playback does **not** auto-start — the user must press play. `positionSecs` updates ~4×/sec during playback; the `autoSave: 500` debounce coalesces disk writes.
- Queue is persisted as an array of track IDs. On restore, tracks are re-fetched via `get_tracks_by_ids`. Missing tracks are silently dropped.
- Window size and position are stored in logical (CSS) pixels. On restore, size is applied first, then position. On resize/move, saves are debounced at 500 ms. If no saved values exist, the app uses the default window size from `tauri.conf.json`.
- Mini mode state is persisted separately: full window geometry is saved when entering mini mode and restored when exiting. Mini window position is also saved independently.
- Saves are debounced at 500 ms (`autoSave: 500`).
- A `restoredRef` guard prevents save effects from firing before restore completes, avoiding overwriting persisted data with defaults.

### 4.16 Mini Player Mode

A compact, always-on-top floating player that replaces the full window with a minimal transport bar.

**Dimensions:** 40px height, 280–550px width (auto-sized based on track title/artist text width, initial: 500px). The window has no native decorations in mini mode and uses a transparent background for rounded corners on macOS.

**UI (NowPlayingBar mini mode):**
- Album art thumbnail (with initial-letter fallback if no image available).
- Two-line text: track title on line 1, artist · album on line 2.
- Previous, play/pause, and next buttons grouped on the right.
- Restore button (⧉) and close button (⏻) grouped after the playback controls.
- A thin progress bar at the bottom showing playback position.
- **Double-click** anywhere on the mini player restores the full window.
- Draggable: clicking and dragging anywhere on the bar (except buttons) moves the window via `getCurrentWindow().startDragging()`.

**Toggle:** A labeled "Mini Player" button in the **caption bar** (to the right of the search bar), or `Ctrl+Shift+M` (or `Cmd+Shift+M` on macOS). When entering mini mode:
1. Current full window geometry (size + position) is saved to the store.
2. Window resizes to mini dimensions.
3. Mini window position is restored from store (if previously saved), otherwise stays at current position.
4. Window becomes always-on-top with no decorations.

When exiting mini mode:
1. Mini window position is saved.
2. Full window geometry is restored.
3. Always-on-top and decorations are restored to normal.

**Auto-resize:** When the current track changes while in mini mode, the mini player recalculates its width based on the track title and artist text to avoid unnecessary truncation (clamped to `MINI_MIN_WIDTH`–`MINI_MAX_WIDTH`).

**macOS transparency:** On macOS, the native window background is set to transparent via Cocoa APIs (`NSWindow.setBackgroundColor_(NSColor::clearColor)`) to allow CSS rounded corners on the mini player.

### 4.17 Keyboard Shortcuts

Shortcuts use `Ctrl` on Windows/Linux and `Cmd` on macOS unless noted otherwise.

**No modifier (only when not focused on a text input):**

| Shortcut | Action |
|----------|--------|
| `Space` | Play / Pause |
| `←` | Seek backward 15 seconds |
| `→` | Seek forward 15 seconds |
| `↑` | Volume up (+10%) |
| `↓` | Volume down (-10%) |

**With Ctrl/Cmd modifier:**

| Shortcut | Action |
|----------|--------|
| `Ctrl+1` | Show All Tracks view |
| `Ctrl+2` | Show Artists view |
| `Ctrl+3` | Show Albums view |
| `Ctrl+4` | Show Tags view |
| `Ctrl+5` | Show Liked Tracks view |
| `Ctrl+6` | Show History view |
| `Ctrl+7` | Show TIDAL view (when tidal collection exists) |
| `Ctrl+K` | Focus central search dropdown |
| `Ctrl+F` | Toggle fullscreen (when playing video) |
| `Ctrl+L` | Like/unlike current track |
| `Ctrl+P` | Toggle playlist panel |
| `Ctrl+M` | Toggle mute (mute/unmute volume) |
| `Ctrl+Shift+M` | Toggle mini player mode |
| `Ctrl+B` | Toggle sidebar collapse/expand |
| `Ctrl+←` | Previous track |
| `Ctrl+→` | Next track |

**Alt modifier:**

| Shortcut | Action |
|----------|--------|
| `Alt+←` | Navigation history: go back |
| `Alt+→` | Navigation history: go forward |

Track list keyboard navigation (without modifier): arrow keys to navigate tracks, Enter to play, Shift+Enter to enqueue.

### 4.18 TIDAL Integration (Hi-Fi API)

Viboplr can search and stream from TIDAL's catalog via the **Hi-Fi API** (the backend behind [Monochrome](https://github.com/monochrome-music/monochrome)). The API instance URL is user-configurable — public instances exist (e.g., `monochrome-api.samidy.com`, `api.monochrome.tf`) and users can self-host. No client-side authentication is needed; all TIDAL auth is handled server-side.

**Setup:**

- TIDAL instances are discovered automatically via uptime worker URLs and cached for 24 hours. An optional user-configurable override URL is tried first before falling back to discovered instances.
- If all instances fail, the cache is invalidated so the next request re-fetches automatically.

**Search & Browsing (`tidal-browse` plugin):**

- TIDAL browsing is provided by the built-in `tidal-browse` JavaScript plugin (see §4.28).
- The plugin adds a sidebar entry and provides search, album detail, and artist detail views using the plugin view system.
- Search queries tracks, artists, and albums in parallel via the `api.tidal` plugin namespace.
- Album cards are clickable → loads album detail with full track listing. Each track can be played, queued, or downloaded.
- Artist cards are clickable → loads artist detail with discography (album grid).
- **Context menu integration:** The plugin contributes context menu items: "Search on TIDAL", "Upgrade Quality via TIDAL", and "Play from TIDAL". These replace the previously hardcoded TIDAL context menu entries.
- **Per-track download:** Each track in search results and album detail views can be downloaded. The download uses `tidal_save_track` to persist metadata, then streams the audio file to the local collection's folder.
- Cover art loaded directly from TIDAL's CDN: `https://resources.tidal.com/images/{uuid_with_slashes}/{size}x{size}.jpg`.

**Playback (on-demand save):**

- TIDAL search results are **ephemeral** (not in the DB). When the user plays a track, `tidal_save_track` is called first:
  1. Fetches full track metadata via `GET /info/?id={tidal_id}`.
  2. Creates/finds the artist and album in the local DB via `get_or_create_artist()` / `get_or_create_album()`.
  3. Upserts the track with `path = "tidal://{collection_id}/{tidal_id}"` and `subsonic_id = tidal_id`.
  4. Returns the persisted `Track` object, which is then played via the normal playback path.
- Stream URLs are fetched at play time (not enqueue time) to avoid CDN token expiration. `get_track_path` detects the `tidal` collection kind and calls the Hi-Fi API's `/track/?id={id}&quality=LOSSLESS` endpoint.
- **BTS manifest decoding:** The stream endpoint returns `{ manifest: "<base64>", manifestMimeType: "application/vnd.tidal.bts" }`. The manifest is base64-decoded to JSON `{ urls: ["https://cdn..."], mimeType: "audio/flac" }` and the first URL is returned. The `mimeType` field is extracted to determine the actual audio format (FLAC, AAC/M4A, MP3) — this is used to set the correct file extension when downloading. DASH manifests (`application/dash+xml`) are not supported; quality is capped at `LOSSLESS`.

**Reusing `subsonic_id` column:**

- TIDAL track IDs are stored in the existing `subsonic_id` column to avoid schema migration. `get_track_path` disambiguates by checking the collection's `kind` field (see §11.4).

**Backend API client (`src-tauri/src/tidal.rs`):**

- `TidalClient` struct with instance failover and `reqwest::blocking::Client` (15s timeout).
- Methods: `search()` (tracks/artists/albums), `get_track_info()`, `get_stream_url()`, `get_album()`, `get_artist()`, `get_artist_albums()`.
- Static helpers: `cover_url()`, `artist_picture_url()` for constructing TIDAL CDN image URLs.

### 4.19 Profiles

Viboplr supports Chrome-like profiles for isolating data (database, images, settings) between different use cases. Each profile is stored in `{app_data_dir}/profiles/{name}/`.

**Default behavior (no arguments):** Uses the `default` profile. On first run, existing legacy data from the root app data directory is automatically migrated to `profiles/default/`.

**Environment variable:**
```bash
VIBOPLR_PROFILE=work npm run tauri dev
```

**CLI argument:**
```bash
./Viboplr --profile work
./Viboplr --profile=work
```

The environment variable takes precedence if both are set. Profile directories are created automatically. Profile names must start with an alphanumeric character and contain only alphanumeric characters, hyphens, or underscores (1-64 characters). Non-default profiles display the profile name in the window title (e.g., "Viboplr [work]").

### 4.20 Playlist Panel

A collapsible side panel for managing the current play queue as a playlist. Toggled via a playlist button in the Now Playing bar.

**Panel UI (`QueuePanel` component):**
- Header with title "Playlist" and action buttons: Load playlist (folder icon), Save playlist (floppy icon), Clear playlist (trash icon), Close (×).
- Track list showing title, artist, duration, and a locate (magnifying glass) button per track that navigates to the track in the library. The currently playing track is highlighted. Track removal is available via the right-click context menu.
- Footer info bar showing playlist name (if loaded/saved), track count, and total duration.

**Multi-selection:** Cmd/Ctrl+Click to toggle individual tracks. Shift+Click to select a contiguous range. Cmd/Ctrl+Shift+Click to add a range. Right-click context menu offers Play, Remove, Locate Track (navigates to the track's album view if available, otherwise the artist view), Move to top, and Move to bottom for selected tracks.

**Drag and drop reorder:** Mouse-event-based drag (not HTML5 DnD, for Tauri compatibility). Dragging single or multiple selected tracks shows a ghost element with track count and a drop position indicator line. Tracks are reordered on drop via `moveMultiple`.

**Drag from track list to playlist:** One or multiple selected tracks can be dragged from the main track list and dropped at a specific position in the playlist panel. Shows ghost element and drop indicators during drag.

**Duplicate detection:** When enqueueing tracks that already exist in the playlist, an inline banner appears in the playlist panel (not a modal) showing the duplicate count with three options: "Add all" (with auto-approve countdown, defaults to 10 seconds), "Add N new" (skip duplicates), or "Cancel". Only triggers on user-initiated enqueue actions, not on load playlist or auto continue.

**M3U playlist persistence:**
- **Save:** `save_playlist` command writes an M3U file with `#EXTINF` metadata (duration, artist, title) and absolute file paths. The playlist name is derived from the filename.
- **Load:** `load_playlist` command parses M3U/M3U8 files, resolves tracks by matching file paths against the database, and returns matched tracks. The playlist name is extracted from the filename.

**State persistence:** `showQueue` (panel visibility) and `playlistName` are persisted to the app store and restored on startup.

### 4.21 Last.fm Scrobbling

Viboplr integrates with Last.fm to report "now playing" status and scrobble completed plays.

**Authentication:**
- Uses Last.fm's web authentication flow. The user clicks "Connect" in Settings, which opens the Last.fm authorization page in the browser with a callback URL (`viboplr://lastfm-callback`).
- After the user authorizes, the app exchanges the auth token for a **session key** and **username** via `auth.getSession`.
- Session key and username are persisted in the app store (`lastfmSessionKey`, `lastfmUsername`) and restored on startup via `lastfm_set_session`.
- API key and secret are compiled into the binary via environment variables.

**API client (`src-tauri/src/lastfm.rs`):**
- `LastfmClient` struct with `api_key`, `api_secret`, and `reqwest::blocking::Client` (15s timeout).
- Methods: `get_auth_url()`, `get_session()`, `update_now_playing()`, `scrobble()`, `get_recent_tracks()`.
- All signed API calls use Last.fm's parameter protocol: params sorted alphabetically, concatenated as key-value pairs, appended with secret, then MD5 hashed.
- `get_recent_tracks(username, page, limit)` is a public (unsigned) GET request to `user.getRecentTracks`. Returns paginated scrobble history.
- Auth errors (codes 9, 14) are detected and emitted as `lastfm-auth-error` events so the frontend can disconnect the stale session.

**Scrobbling behavior:**
- When a new track starts playing, the frontend calls `lastfm_now_playing` to update the "now playing" status.
- When the scrobble threshold is met (same as play history — 50% or 4 min), the frontend calls `lastfm_scrobble` with the track ID and the timestamp when playback started.
- Both calls run on background threads (fire-and-forget) so they don't block playback.
- Video tracks are excluded from scrobbling unless "Track video history" is enabled.

**Scrobble confirmation:** When a track's play has been logged (history recorded), a checkmark indicator appears next to the time display in the Now Playing bar.

**History import:**

Users can import their complete Last.fm scrobble history into the local history system. The import is performed as a background task with progress reporting and cancellation support.

- The `lastfm_import_history` command extracts the username from the active session, spawns a background thread, and loops through all pages (200 tracks/page) of `user.getRecentTracks`.
- An `Arc<AtomicBool>` (`lastfm_importing`) on `AppState` serves as both a concurrency guard (prevents duplicate imports) and a cancellation flag.
- Each page is processed via `record_history_plays_batch()` — a single-transaction batch insert into the decoupled history tables. Uses **exact-timestamp dedup** (not the 30-sec window used for real-time plays) so legitimate repeated plays are preserved while re-imports skip already-imported entries.
- "Now playing" entries (no `date` field) are filtered out.
- Progress events (`lastfm-import-progress`) are emitted after each page with page number, total pages, imported count, and skipped count.
- 200ms sleep between API calls to respect Last.fm's rate limit (5 req/sec).
- On completion, emits `lastfm-import-complete` with final counts. On error or cancellation, emits `lastfm-import-error`.
- The `lastfm_cancel_import` command sets the `AtomicBool` to false; the import loop checks this flag each iteration and stops early.
- The `HistoryView` component exposes a `reload()` method via its imperative handle, called automatically on import completion to refresh the display.

**Settings UI (Settings > Last.fm tab):**

The Last.fm tab has two sections:

- **Account** — Shows connection status (connected username or disconnected), with a link to the user's Last.fm profile. "Connect" / "Disconnect" button.
- **History** — "Import scrobble history" button (disabled when not connected or import already running). Clicking opens a **modal overlay** showing:
  - A progress bar (page-based percentage) during import.
  - Stats: "Page X of Y" and "N imported, N skipped".
  - "Connecting to Last.fm..." state before the first progress event.
  - Completion summary or "Import cancelled" message when done.
  - **Cancel** button during import, **Close** button when finished.

**Metadata & Discovery API (read-only):**

The Last.fm client exposes several read-only API methods for fetching metadata. All are called via non-blocking commands that check a SQLite cache first (`lastfm_cache` table, 90-day TTL), then fetch in a background thread and emit a Tauri event with the result.

| Method | Last.fm API | Returns |
|--------|-------------|---------|
| `get_similar_artists(artist, limit)` | `artist.getSimilar` | Similar artists with match scores |
| `get_similar_tracks(artist, track, limit)` | `track.getSimilar` | Similar tracks with match percentages |
| `get_artist_info(artist)` | `artist.getInfo` | Artist bio, stats, tags, similar |
| `get_album_info(artist, album)` | `album.getInfo` | Album wiki, tags, tracklist |
| `get_track_top_tags(artist, track)` | `track.getTopTags` | Community tag suggestions |
| `get_artist_top_tags(artist)` | `artist.getTopTags` | Artist top tags |
| `love_track(session_key, artist, track)` | `track.love` | Loves a track (signed POST) |
| `unlove_track(session_key, artist, track)` | `track.unlove` | Unloves a track (signed POST) |

**Cache (`lastfm_cache` table):** Key-value store with `cache_key` (TEXT PRIMARY KEY), `value` (JSON TEXT), and `cached_at` (INTEGER timestamp). TTL is 90 days (~3 months). Cache keys are namespaced by method and entity (e.g., `similar_tracks:artist:title`). Added in DB migration version 10.

**Tauri commands:**

| Command | Args | Returns |
|---------|------|---------|
| `lastfm_get_auth_url` | — | `String` (auth URL) |
| `lastfm_authenticate` | `token: String` | `(LastfmStatus, String)` (status + session key) |
| `lastfm_set_session` | `session_key: String, username: String` | `()` |
| `lastfm_disconnect` | — | `()` |
| `lastfm_get_status` | — | `LastfmStatus` |
| `lastfm_now_playing` | `track_id: i64` | `()` (fire-and-forget) |
| `lastfm_scrobble` | `track_id: i64, started_at: i64` | `()` (fire-and-forget) |
| `lastfm_import_history` | — | `Result<(), String>` (spawns background thread) |
| `lastfm_cancel_import` | — | `()` |
| `lastfm_love_track` | `track_id: i64` | `()` (fire-and-forget) |
| `lastfm_unlove_track` | `track_id: i64` | `()` (fire-and-forget) |
| `lastfm_get_similar_artists` | `artist_name: String, limit: Option<u32>` | `Option<Value>` (cached or async) |
| `lastfm_get_similar_tracks` | `artist_name: String, track_title: String, limit: Option<u32>` | `Option<Value>` (cached or async) |
| `lastfm_get_artist_info` | `artist_name: String` | `Option<Value>` (cached or async) |
| `lastfm_get_album_info` | `artist_name: String, album_title: String` | `Option<Value>` (cached or async) |
| `lastfm_get_track_tags` | `artist_name: String, track_title: String` | `Option<Value>` (cached or async) |
| `lastfm_get_artist_tags` | `artist_name: String` | `Option<Value>` (cached or async) |
| `lastfm_apply_community_tags` | `track_id: i64, tag_names: Vec<String>` | `Vec<(i64, String)>` |
| `replace_track_tags` | `track_id: i64, tag_names: Vec<String>` | `Vec<(i64, String)>` |

**Events:**

| Event | Payload |
|-------|---------|
| `lastfm-auth-error` | `()` |
| `lastfm-import-progress` | `{ page, total_pages, imported, skipped }` |
| `lastfm-import-complete` | `{ imported, skipped }` |
| `lastfm-import-error` | `String` (error message, or `"cancelled"`) |
| `lastfm-similar-artists` | `Value` (JSON) |
| `lastfm-similar-tracks` | `Value` (JSON) |
| `lastfm-artist-info` | `Value` (JSON) |
| `lastfm-album-info` | `Value` (JSON) |
| `lastfm-track-tags` | `Value` (JSON) |
| `lastfm-artist-tags` | `Value` (JSON) |

### 4.22 Collapsible Sidebar

The left sidebar panel can be collapsed to save screen space.

- A toggle button at the bottom of the sidebar collapses/expands the panel.
- When collapsed, the sidebar shows icon-only navigation buttons with tooltips.
- **Keyboard shortcut:** `Cmd/Ctrl+B` toggles the sidebar.
- Collapsed state is persisted as `sidebarCollapsed` in the app store.

### 4.23 Upgrade Track via TIDAL

Local tracks can be replaced with higher-quality versions from TIDAL. Available via the context menu "Upgrade via TIDAL" option (only for local, non-subsonic tracks when a TIDAL collection is configured).

**Flow (`UpgradeTrackModal` component):**

1. **Search** — On open, auto-searches TIDAL using the track's title + artist name. Displays clickable results with cover art, title, artist, album, and duration.
2. **Download preview** — When the user selects a match, `tidal_download_preview` downloads the TIDAL version to a temporary file (`{stem}.upgrade.{ext}`) next to the original, writes tags via `lofty`, and returns comparison info.
3. **Compare** — Shows old vs new file side-by-side: format and file size. The user can confirm (replace) or cancel.
4. **Confirm** — `confirm_track_upgrade` deletes the old file, renames the `.upgrade.` file to the final name, removes the old DB entry, re-scans the new file, and rebuilds FTS.
5. **Cancel** — `cancel_track_upgrade` deletes the temporary preview file. Also called if the user navigates back to search from the compare step.

### 4.24 Custom Caption Bar & Window Controls

Viboplr uses a custom caption bar across all platforms (native window decorations are disabled). The caption bar is a full-width row at the top of the window grid, spanning above both the sidebar and content area.

**Layout (left to right):**
- **Window controls (left):** macOS traffic-light–style buttons (close, minimize, maximize) on the left. On Windows/Linux, a `WindowControls` component renders minimize, maximize, and close buttons instead.
- **Navigation history buttons:** Back and forward arrows for view navigation history.
- **Draggable spacer:** Flexible empty space that acts as a window drag region (double-click to maximize/restore).
- **Central search dropdown:** A pill-shaped input with a magnifying glass icon (left) and a clear button (right, shown when query is non-empty). Focused via `Cmd/Ctrl+K`. Queries the FTS5 index and displays a dropdown of up to 5 results with album art, two-line rows, and keyboard navigation (see §4.8 for details). Placeholder: "What do you want to play?".
- **Draggable spacer:** Another flexible drag region.
- **Mini player button:** Labeled "Mini Player" with an icon, positioned to the right of the search bar.
- **Window controls (right):** On Windows/Linux, a second `WindowControls` instance on the right side. Not rendered on macOS.

**Drag region:** The caption bar itself is a Tauri drag region (`data-tauri-drag-region`). All interactive children opt out of drag via `-webkit-app-region: no-drag`. The spacers between elements are also drag regions.

**Rounded corners:** The app container has `border-radius: 10px` for rounded window corners on all platforms.

## 5. Database Schema

```sql
CREATE TABLE artists (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    liked       INTEGER NOT NULL DEFAULT 0,
    track_count INTEGER NOT NULL DEFAULT 0   -- precomputed, updated by recompute_counts()
);

CREATE TABLE albums (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    artist_id   INTEGER REFERENCES artists(id),
    year        INTEGER,
    liked       INTEGER NOT NULL DEFAULT 0,
    track_count INTEGER NOT NULL DEFAULT 0,  -- precomputed, updated by recompute_counts()
    UNIQUE(title, artist_id)
);

CREATE TABLE tags (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    track_count INTEGER NOT NULL DEFAULT 0,  -- precomputed, updated by recompute_counts()
    liked       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE collections (
    id                          INTEGER PRIMARY KEY,
    kind                        TEXT NOT NULL,           -- 'local', 'subsonic', 'tidal', 'seed'
    name                        TEXT NOT NULL,           -- display name
    path                        TEXT,                    -- local folder path (local only)
    url                         TEXT,                    -- server base URL (subsonic/tidal)
    username                    TEXT,                    -- (subsonic only)
    password_token              TEXT,                    -- md5 token or plaintext (subsonic only)
    salt                        TEXT,                    -- (subsonic only, NULL for plaintext auth)
    auth_method                 TEXT DEFAULT 'token',    -- 'token' or 'plaintext' (subsonic only)
    last_synced_at              INTEGER,
    auto_update                 INTEGER NOT NULL DEFAULT 0,
    auto_update_interval_mins   INTEGER NOT NULL DEFAULT 60,
    enabled                     INTEGER NOT NULL DEFAULT 1,
    last_sync_duration_secs     REAL,
    last_sync_error             TEXT
);

CREATE TABLE tracks (
    id              INTEGER PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    artist_id       INTEGER REFERENCES artists(id),
    album_id        INTEGER REFERENCES albums(id),
    track_number    INTEGER,
    duration_secs   REAL,
    format          TEXT,
    file_size       INTEGER,
    modified_at     INTEGER,
    added_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    collection_id   INTEGER REFERENCES collections(id),
    subsonic_id     TEXT,                           -- remote ID (subsonic track ID or tidal track ID)
    liked           INTEGER NOT NULL DEFAULT 0,
    youtube_url     TEXT,                           -- associated YouTube URL
    deleted         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE track_tags (
    track_id    INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
    tag_id      INTEGER REFERENCES tags(id) ON DELETE CASCADE,
    UNIQUE(track_id, tag_id)
);

-- Decoupled history (independent from library)
CREATE TABLE history_artists (
    id              INTEGER PRIMARY KEY,
    canonical_name  TEXT NOT NULL UNIQUE,             -- strip_diacritics(lowercase(name))
    display_name    TEXT NOT NULL,
    first_played_at INTEGER NOT NULL,
    last_played_at  INTEGER NOT NULL,
    play_count      INTEGER NOT NULL DEFAULT 0,       -- denormalized
    library_artist_id INTEGER                         -- optional reconnection to library
);

CREATE TABLE history_tracks (
    id                INTEGER PRIMARY KEY,
    history_artist_id INTEGER NOT NULL REFERENCES history_artists(id),
    canonical_title   TEXT NOT NULL,                   -- strip_diacritics(lowercase(title))
    display_title     TEXT NOT NULL,
    first_played_at   INTEGER NOT NULL,
    last_played_at    INTEGER NOT NULL,
    play_count        INTEGER NOT NULL DEFAULT 0,      -- denormalized
    library_track_id  INTEGER,                         -- optional reconnection to library
    UNIQUE(history_artist_id, canonical_title)
);

CREATE TABLE history_plays (
    id                INTEGER PRIMARY KEY,
    history_track_id  INTEGER NOT NULL REFERENCES history_tracks(id),
    played_at         INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX idx_history_plays_track ON history_plays(history_track_id);
CREATE INDEX idx_history_plays_time  ON history_plays(played_at);

CREATE TABLE image_fetch_failures (
    kind       TEXT NOT NULL,        -- 'artist' or 'album'
    item_id    INTEGER NOT NULL,
    failed_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE(kind, item_id)
);

CREATE TABLE plugin_storage (
    plugin_id  TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    PRIMARY KEY (plugin_id, key)
);

CREATE TABLE lastfm_cache (
    cache_key  TEXT PRIMARY KEY,
    value      TEXT NOT NULL,         -- JSON response from Last.fm API
    cached_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Full-text search
CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title,
    artist_name,
    album_title,
    tag_names,
    filename,
    content='',
    tokenize='unicode61 remove_diacritics 2'
);
```

**Migration:** A `db_version` table tracks the schema version (starting at 1). On startup, `run_migrations()` checks the version and applies any needed ALTER TABLE statements. Migrations include: `folders` → `collections` with `kind='local'` (path prefix matching); `deleted` on tracks; `liked` on artists/albums/tracks; `auto_update`/`auto_update_interval_mins`/`enabled`/`last_sync_duration_secs` on collections; `track_count` on artists/albums/tags (version 2); `youtube_url` on tracks (version 3); `last_sync_error` on collections (version 4); `liked` on tags (version 5); migrate `play_history` data into decoupled `history_artists`/`history_tracks`/`history_plays` tables (version 6); drop `deleted` column from tracks after hard-deleting soft-deleted rows (version 7); drop legacy `play_history` table (version 8); add `library_artist_id`/`library_track_id` cache columns to history tables with backfill (version 9); add `lastfm_cache` table for Last.fm API response caching (version 10). After migrations, `recompute_counts()` runs on every startup to ensure counts are correct even after a crash or interrupted scan.

## 6. Architecture

```
┌─────────────────────────────────────────────┐
│                  Frontend                   │
│           React + TypeScript                │
│  ┌──────────┬───────────┬────────────────┐  │
│  │ Search   │ Library   │ Now Playing    │  │
│  │ Bar      │ View      │ Bar            │  │
│  └──────────┴───────────┴────────────────┘  │
│  ┌──────────────────────────────────────┐   │
│  │  HTML5 <audio> / <video> elements   │   │
│  │  Local: asset:// protocol           │   │
│  │  Server: HTTP streaming URL         │   │
│  │  TIDAL: CDN streaming URL           │   │
│  └──────────────────────────────────────┘   │
└──────────────────┬──────────────────────────┘
                   │ Tauri IPC (invoke / listen)
┌──────────────────▼──────────────────────────┐
│                Tauri Commands               │
│  add_collection, remove_collection,         │
│  update_collection, get_collections,        │
│  resync_collection,                         │
│  get_artists, get_albums, get_tracks,       │
│  get_tags, toggle_liked,                    │
│  show_in_folder, get_track_path,            │
│  tidal_search, tidal_save_track,            │
│  record_play, get_history_recent,            │
│  get_most_played, get_most_played_since     │
└──┬───────────┬───────────┬─────────┬────────┘
   │           │           │         │
   ▼           ▼           ▼         ▼
┌────────┐ ┌────────────┐ ┌──────┐ ┌──────┐
│Scanner │ │  Watcher   │ │Subso-│ │TIDAL │
│Service │ │  Service   │ │nic   │ │Client│
│lofty + │ │  notify    │ │Client│ │Hi-Fi │
│regex   │ │            │ │      │ │API   │
└───┬────┘ └─────┬──────┘ └──┬───┘ └──┬───┘
    │            │            │        │
    ▼            ▼            ▼        ▼
┌──────────────────────────────────────────┐
│             SQLite (DB)                  │
│           rusqlite + FTS5                │
└──────────────────────────────────────────┘
```

## 7. Tauri Commands (API)

### Collection Commands

| Command                 | Args                                                    | Returns            |
| ----------------------- | ------------------------------------------------------- | ------------------ |
| `add_collection`        | `kind, name, path?, url?, username?, password?`         | `Collection`       |
| `remove_collection`     | `collection_id: i64`                                    | `()`               |
| `update_collection`     | `collection_id: i64, name: String, auto_update: bool, auto_update_interval_mins: i64, enabled: bool` | `()` |
| `get_collections`       | —                                                       | `Vec<Collection>`  |
| `resync_collection`     | `collection_id: i64`                                    | `()`               |

### Library Commands

| Command                 | Args                        | Returns                  |
| ----------------------- | --------------------------- | ------------------------ |
| `get_artists`           | —                           | `Vec<Artist>`            |
| `get_albums`            | `artist_id: Option<i64>`    | `Vec<Album>`             |
| `get_tracks`            | `opts: TrackQuery`          | `Vec<Track>`             |
| `get_track_count`       | —                           | `i64`                    |
| `get_track_by_id`       | `track_id: i64`             | `Track`                  |
| `get_tracks_by_ids`     | `ids: Vec<i64>`             | `Vec<Track>`             |
| `get_tracks_by_artist`  | `artist_id: i64`            | `Vec<Track>`             |
| `get_tags`              | —                           | `Vec<Tag>`               |
| `get_tags_for_track`    | `track_id: i64`             | `Vec<Tag>`               |
| `get_tracks_by_tag`     | `tag_id: i64`               | `Vec<Track>`             |
| `toggle_liked`          | `kind: String, id: i64, liked: i32` | `()`              |
| `get_liked_tracks`      | —                           | `Vec<Track>`             |
| `get_track_path`        | `track_id: i64`             | `String` (path or URL)   |
| `show_in_folder`        | `track_id: i64`             | `()`                     |
| `rebuild_search_index`  | —                           | `()`                     |
| `get_auto_continue_track` | `strategy: String, current_track_id: i64, format_filter: Option<String>` | `Option<Track>` |
| `delete_tracks`           | `track_ids: Vec<i64>`                     | `Vec<i64>` (deleted IDs) |
| `get_cached_waveform`     | `track_id: i64`                           | `Option<Vec<f32>>`       |
| `cache_waveform`          | `track_id: i64, peaks: Vec<f32>`          | `()`                     |
| `reconnect_history_track` | `history_track_id: i64`                   | `Option<Track>`          |
| `reconnect_history_artist`| `history_artist_id: i64`                  | `Option<i64>`            |

**`TrackQuery` struct:** Unified query parameters for `get_tracks`. When `query` is present and non-empty, FTS search is used. When `album_id` is set without a query, returns album tracks ordered by track number (no pagination). Otherwise, returns paginated tracks with optional sort/filter.

| Field            | Type            | Default |
|------------------|-----------------|---------|
| `album_id`       | `Option<i64>`   | `null`  |
| `artist_id`      | `Option<i64>`   | `null`  |
| `tag_id`         | `Option<i64>`   | `null`  |
| `query`          | `Option<String>`| `null`  |
| `liked_only`     | `bool`          | `false` |
| `has_youtube_url` | `bool`         | `false` |
| `media_type`     | `Option<String>`| `null`  |
| `sort_field`     | `Option<String>`| `null`  |
| `sort_dir`       | `Option<String>`| `null`  |
| `limit`          | `Option<i64>`   | `100`   |
| `offset`         | `Option<i64>`   | `0`     |

**`toggle_liked` kind values:** `"track"`, `"artist"`, `"album"`, `"tag"`. Table name is validated via match arm at the command layer (no SQL injection risk). The `liked` parameter is an `i32`: -1 (dislike), 0 (neutral), 1 (loved). Artists, albums, and tags only use 0/1.

**`get_entity_image` / `set_entity_image` / `paste_entity_image` / `remove_entity_image` kind values:** `"artist"`, `"album"`, `"tag"`.

### Playlist Commands

| Command                 | Args                        | Returns                  |
| ----------------------- | --------------------------- | ------------------------ |
| `save_playlist`         | `path: String, track_ids: Vec<i64>` | `()`             |
| `load_playlist`         | `path: String`              | `PlaylistLoadResult`     |

### Play History Commands

| Command                          | Args                                   | Returns                      |
| -------------------------------- | -------------------------------------- | ---------------------------- |
| `record_play`                    | `track_id: i64`                        | `()`                         |
| `get_history_recent`             | `limit: i64`                           | `Vec<HistoryEntry>`          |
| `get_history_most_played`        | `limit: i64`                           | `Vec<HistoryMostPlayed>`     |
| `get_history_most_played_since`  | `since_ts: i64, limit: i64`            | `Vec<HistoryMostPlayed>`     |
| `get_history_most_played_artists`| `limit: i64`                           | `Vec<HistoryArtistStats>`    |
| `search_history_artists`         | `query: String, limit: i64`            | `Vec<HistoryArtistStats>`    |
| `search_history_tracks`          | `query: String, limit: i64`            | `Vec<HistoryMostPlayed>`     |
| `reconnect_history_track`        | `history_track_id: i64`                | `Option<Track>`              |
| `reconnect_history_artist`       | `history_artist_id: i64`               | `Option<i64>`                |
| `get_track_rank`                 | `track_id: i64`                        | `Option<i64>`                |
| `get_artist_rank`                | `artist_id: i64`                       | `Option<i64>`                |

### Image Commands

| Command                 | Args                        | Returns                  |
| ----------------------- | --------------------------- | ------------------------ |
| `get_entity_image`      | `kind: String, id: i64`     | `Option<String>` (path)  |
| `set_entity_image`      | `kind: String, id: i64, source_path: String` | `String` (dest path)  |
| `paste_entity_image`    | `kind: String, id: i64, image_data: Vec<u8>` | `String` (dest path)  |
| `remove_entity_image`   | `kind: String, id: i64`     | `()`                     |
| `fetch_artist_image`    | `artist_id: i64, artist_name: String` | `()` (fire-and-forget) |
| `fetch_album_image`     | `album_id: i64, album_title: String, artist_name?: String` | `()` (fire-and-forget) |
| `fetch_tag_image`       | `tag_id: i64, tag_name: String` | `()` (fire-and-forget) |
| `clear_image_failures`  | —                           | `()`                     |

### TIDAL Commands

| Command                   | Args                                                     | Returns              |
| ------------------------- | -------------------------------------------------------- | -------------------- |
| `tidal_test_connection`   | `url: String`                                            | `String` (version)   |
| `tidal_search`            | `collection_id: i64, query: String, limit: u32, offset: u32` | `TidalSearchResult`  |
| `tidal_save_track`        | `collection_id: i64, tidal_track_id: String`             | `Track`              |
| `tidal_get_album`         | `collection_id: i64, album_id: String`                   | `TidalAlbumDetail`   |
| `tidal_get_artist`        | `collection_id: i64, artist_id: String`                  | `TidalArtistDetail`  |
| `tidal_download_preview`  | `override_url: Option<String>, track_id: i64, tidal_track_id: String, format: String` | `UpgradePreviewInfo` |
| `confirm_track_upgrade`   | `track_id: i64, new_path: String`                        | `()`                 |
| `cancel_track_upgrade`    | `new_path: String`                                       | `()`                 |

### Last.fm Commands

| Command                   | Args                                        | Returns                        |
| ------------------------- | ------------------------------------------- | ------------------------------ |
| `lastfm_get_auth_url`     | —                                           | `String` (auth URL)            |
| `lastfm_authenticate`     | `token: String`                             | `(LastfmStatus, String)`       |
| `lastfm_set_session`      | `session_key: String, username: String`      | `()`                           |
| `lastfm_disconnect`       | —                                           | `()`                           |
| `lastfm_get_status`       | —                                           | `LastfmStatus`                 |
| `lastfm_now_playing`      | `track_id: i64`                             | `()` (fire-and-forget)         |
| `lastfm_scrobble`         | `track_id: i64, started_at: i64`            | `()` (fire-and-forget)         |
| `lastfm_import_history`   | —                                           | `()` (background thread)       |
| `lastfm_cancel_import`    | —                                           | `()`                           |

### Download Commands

| Command                 | Args                                                                     | Returns              |
| ----------------------- | ------------------------------------------------------------------------ | -------------------- |
| `download_track`        | `source_collection_id: i64, remote_track_id: String, dest_collection_id: i64, format: String` | `u64` (download ID)  |
| `download_album`        | `override_url: Option<String>, album_id: String, dest_collection_id: i64, format: String` | `Vec<u64>` (download IDs) |
| `get_download_status`   | —                                                                        | `DownloadQueueInfo`  |
| `cancel_download`       | `download_id: u64`                                                       | `bool`               |

### YouTube Commands

| Command                   | Args                                     | Returns              |
| ------------------------- | ---------------------------------------- | -------------------- |
| `search_youtube`          | `title: String, artist_name: Option<String>` | `YouTubeResult`      |
| `set_track_youtube_url`   | `track_id: i64, url: String`             | `()`                 |
| `clear_track_youtube_url` | `track_id: i64`                          | `()`                 |

### Skin Commands

| Command                   | Args                                     | Returns              |
| ------------------------- | ---------------------------------------- | -------------------- |
| `list_user_skins`         | —                                        | `Vec<Value>`         |
| `read_user_skin`          | `id: String`                             | `String` (JSON)      |
| `delete_user_skin`        | `id: String`                             | `()`                 |
| `import_skin_file`        | `path: String`                           | `String` (slug ID)   |
| `fetch_skin_gallery`      | —                                        | `String` (JSON index)|
| `install_gallery_skin`    | `url: String`                            | `String` (slug ID)   |

### Plugin Commands

| Command                   | Args                                                     | Returns              |
| ------------------------- | -------------------------------------------------------- | -------------------- |
| `plugin_get_dir`          | —                                                        | `String` (path)      |
| `plugin_list_installed`   | —                                                        | `Vec<Value>` (manifests) |
| `plugin_read_file`        | `plugin_id: String, path: String`                        | `String` (contents)  |
| `plugin_storage_get`      | `plugin_id: String, key: String`                         | `Option<String>`     |
| `plugin_storage_set`      | `plugin_id: String, key: String, value: String`          | `()`                 |
| `plugin_storage_delete`   | `plugin_id: String, key: String`                         | `()`                 |
| `plugin_fetch`            | `url: String, method?: String, headers?: Map, body?: String` | `Value` (JSON response) |
| `fetch_plugin_gallery`    | —                                                        | `Value` (gallery index) |
| `install_gallery_plugin`  | `plugin_id: String, base_url: String, files: Vec<String>`| `String` (path)      |
| `delete_user_plugin`      | `plugin_id: String`                                      | `()`                 |
| `oauth_listen`            | —                                                        | `u16` (port)         |

### Debug-Only Commands

| Command                 | Args                        | Returns                  |
| ----------------------- | --------------------------- | ------------------------ |
| `clear_database`        | —                           | `String`                 |

### Tauri Events (backend → frontend)

| Event              | Payload                             |
| ------------------ | ----------------------------------- |
| `scan-progress`    | `{ scanned, total, folder }`        |
| `scan-complete`    | `{ folder }`                        |
| `sync-progress`    | `{ synced, total, collection }`     |
| `sync-complete`    | `{ collectionId }`                  |
| `sync-error`       | `{ collectionId, error }`           |
| `artist-image-ready` | `{ artistId, path }`              |
| `artist-image-error` | `{ artistId, name, error }`       |
| `album-image-ready`  | `{ albumId, path }`               |
| `album-image-error`  | `{ albumId, title, error }`       |
| `tag-image-ready`    | `{ tagId, path }`                   |
| `lastfm-auth-error`  | `()`                                |
| `lastfm-import-progress` | `{ page, total_pages, imported, skipped }` |
| `lastfm-import-complete` | `{ imported, skipped }`           |
| `lastfm-import-error`    | `{ error }`                       |
| `download-progress`  | `{ id, filename, status, progress_pct }` |
| `download-complete`  | `{ id, filename, track_id }`        |
| `download-error`     | `{ id, filename, error }`           |
| `upgrade-download-progress` | `f64` (percentage)             |
| `lastfm-similar-artists`    | `Value` (JSON)                 |
| `lastfm-similar-tracks`     | `Value` (JSON)                 |
| `lastfm-artist-info`        | `Value` (JSON)                 |
| `lastfm-album-info`         | `Value` (JSON)                 |
| `lastfm-track-tags`         | `Value` (JSON)                 |
| `lastfm-artist-tags`        | `Value` (JSON)                 |

## 8. Performance Targets

| Metric                   | Target   |
| ------------------------ | -------- |
| Cold startup to usable UI | < 1 s   |
| Play after click         | < 200 ms |
| Search results           | < 100 ms |
| Binary size              | < 15 MB  |
| Idle RAM                 | < 50 MB  |

## 9. Platform Notes

- **macOS:** `.dmg` distribution, custom caption bar with traffic-light window controls, media key support via `souvlaki` crate. Transparent window background for mini player rounded corners.
- **Windows:** `.msi` / `.exe` installer, taskbar controls, media key support via `souvlaki` crate.

## 10. Showcase Website

A static showcase website lives in `docs/` and is hosted via **GitHub Pages** at `viboplr.com`.

**Pages:**
- `index.html` — Landing page with hero, feature cards, and download CTAs.
- `features.html` — Detailed feature breakdowns (playback, library, search, servers, mini player, keyboard shortcuts, discovery).
- `download.html` — Platform download cards (macOS/Windows), system requirements, changelog, auto-update note.

**Dynamic version badge:** The website fetches the latest release tag from the GitHub Releases API (`api.github.com/repos/outcast1000/viboplr/releases/latest`) and displays it on the homepage hero badge and the download page subtitle. Falls back to no version display if the API is unavailable.

**Stack:** Plain HTML/CSS/JS (no framework). Outfit font via Google Fonts. Shared `css/style.css` and `js/main.js` (scroll animations, mobile nav hamburger, version fetch).

**Hosting:** GitHub Pages from `/docs` on `main` branch. Custom domain configured via `docs/CNAME`.

**Analytics:** Cloudflare Web Analytics beacon on all pages — free, cookie-free, no consent banner required. Aligns with Viboplr's privacy-first branding.

### 4.25 Skins

Viboplr supports a fully customizable skin system that allows users to change the app's visual appearance by swapping CSS color tokens.

**Skin format (`SkinJson`):**
A skin is a JSON file with the following structure:

```json
{
  "name": "My Skin",
  "author": "Author Name",
  "version": "1.0.0",
  "type": "dark",
  "colors": {
    "bg-primary": "#111111",
    "bg-secondary": "#1a1a1a",
    "bg-surface": "#222222",
    "bg-hover": "#2a2a2a",
    "text-primary": "#ffffff",
    "text-secondary": "#aaaaaa",
    "accent": "#ff5500",
    "accent-dim": "#cc4400",
    "border": "#333333",
    "now-playing-bg": "#1a1a1a",
    "success": "#22cc66",
    "error": "#ff4444",
    "warning": "#ffaa00"
  },
  "customCSS": "/* optional extra CSS */"
}
```

- **13 color keys** are required, each a 3- or 6-digit hex value.
- **`type`** must be `"dark"` or `"light"` — controls `data-skin-type` on the root element for conditional styling.
- **`customCSS`** is optional (max 10 KB). Sanitized on load: `@import`, `expression()`, `javascript:`, and `url()` are stripped.

**Built-in skins (8):** Default, OLED Black, Arctic Light, Forest, Silver, Ocean Blue, Viboplr, Sunset. Bundled as JSON files in `src/skins/` and registered in `src/skins/index.ts`.

**User skins:** Stored as JSON files in `{app_dir}/skins/{slug}.json`. Slugs are auto-generated from the skin name (lowercase, non-alphanumeric replaced with hyphens, deduped with numeric suffix on collision).

**Gallery:** Community skins are hosted in a GitHub repository (`outcast1000/viboplr-skins`). The gallery index (`index.json`) lists available skins with preview color swatches. Users can browse and install skins directly from the gallery in Settings.

**CSS injection (`useSkins` hook):**
- On mount, loads the saved skin ID from the store and the list of user skins from disk.
- Generates CSS variable declarations from the skin's color map via `generateSkinCSS()` and injects them into a `<style>` element (`#viboplr-skin`).
- For `accent` and `now-playing-bg` keys, RGB component variables are also generated (e.g., `--accent-rgb: 255, 85, 0`) for use with `rgba()`.
- Re-injects whenever the active skin changes.

**Validation (`skinUtils.ts`):**
- `validateSkin()` checks all required fields, color format, type enum, and customCSS size limit.
- `sanitizeCustomCSS()` strips dangerous CSS patterns before injection.
- `generateSkinCSS()` produces the `:root` CSS variable block with optional sanitized custom CSS appended.

**CSS tokenization:** All semantic colors in `App.css` use CSS custom properties (e.g., `var(--bg-primary)`, `var(--accent)`) instead of hardcoded hex values, making the entire UI skinnable. An `--overlay-base` variable is provided for modal/overlay backgrounds.

**Settings UI (Settings > Skins tab):**
- **Installed skins:** Grid of skin cards showing name, author, type badge, and 4-color preview swatch. Active skin is highlighted. Click to apply.
- **Import:** File picker to import a `.json` skin file from disk.
- **Gallery:** "Browse Gallery" loads the community skin index. Each gallery entry shows name, author, type, and color preview. Click to install.
- **Delete:** User skins can be deleted (built-in skins cannot).

**State persistence:** The active skin ID is stored as `skin` in the app store.

### 4.26 Track Properties Modal

A tabbed modal for viewing and editing track metadata, accessible via right-click context menu on any track.

**Modal layout:** Fixed-size window with a caption bar (track title + close button) and a vertical sidebar with tab icons. Tabs:

1. **Info** — Track metadata: title, artist, album, duration, format, file size, path.
2. **Tags** — Current tags with remove buttons. Community tag suggestions from Last.fm (`track.getTopTags` / `artist.getTopTags`) with "Apply" buttons. "Replace all tags" option.
3. **Similar** — Similar tracks from Last.fm (`track.getSimilar`). Each result shows title, artist, and match percentage, with action buttons:
   - **Play** — plays the track if found in the local library.
   - **TIDAL search** — opens the TIDAL view with a search for the track (when a TIDAL collection exists).
   - **YouTube search** — searches YouTube for the track via the `search_youtube` backend command.
4. **Artist** — Artist bio from Last.fm (`artist.getInfo`), similar artists, and top tags.
5. **Album** — Album wiki/description from Last.fm (`album.getInfo`).

**Last.fm data fetching:** All Last.fm metadata calls are non-blocking. The command checks a SQLite cache first (`lastfm_cache` table, 90-day TTL). On cache miss, a background thread fetches from the API and emits the result via a Tauri event. The frontend listens for the event and updates the UI.

### 4.27 Last.fm Love/Unlove Sync

When a user likes (loved) or unlikes a track in Viboplr, the like state is synced to Last.fm via `track.love` / `track.unlove` API calls. These are fire-and-forget background operations that require an active Last.fm session.

### 4.28 Plugin System

Viboplr supports a plugin system that allows JavaScript plugins to extend the app with custom sidebar views, context menu items, event hooks, persistent storage, and network access. Plugins are loaded from two directories: **native (built-in)** plugins bundled with the app and **user** plugins in the user's profile directory, with user plugins taking precedence when IDs collide.

**Plugin structure:**
Each plugin is a directory containing a `manifest.json` and an `index.js` entry point:

```
my-plugin/
├── manifest.json
└── index.js
```

**Manifest (`manifest.json`):**

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "Author",
  "description": "What it does",
  "minAppVersion": "0.6.0",
  "contributes": {
    "sidebarItems": [{ "id": "main", "label": "My View", "icon": "📊" }],
    "contextMenuItems": [{ "id": "action", "label": "Do Thing", "targets": ["track"] }],
    "eventHooks": ["track:started", "track:played", "track:scrobbled", "track:liked"]
  }
}
```

- **`id`** — unique identifier.
- **`minAppVersion`** — semver minimum; plugins with a higher requirement are marked `incompatible`.
- **`contributes.sidebarItems`** — registers sidebar navigation entries that open plugin-rendered views.
- **`contributes.contextMenuItems`** — registers entries in the track/album/artist context menu. `targets` is an array of `"track" | "album" | "artist" | "multi-track"`.
- **`contributes.eventHooks`** — subscribes to playback lifecycle events: `track:started`, `track:played`, `track:scrobbled`, `track:liked`.

**Plugin API (`ViboplrPluginAPI`):**
Each plugin's `activate(api)` function receives an API object with these namespaces:

| Namespace | Methods |
|-----------|---------|
| `library` | `getTracks(opts?)`, `getArtists()`, `getAlbums()`, `getTrackById(id)`, `search(query)`, `getHistory(opts?)`, `getMostPlayed(opts?)` |
| `playback` | `getCurrentTrack()`, `isPlaying()`, `getPosition()`, `playTidalTrack(track)`, `enqueueTidalTrack(track)`, `playTidalTracks(tracks, startIndex?)`, `onTrackStarted(handler)`, `onTrackPlayed(handler)`, `onTrackScrobbled(handler)`, `onTrackLiked(handler)` |
| `contextMenu` | `onAction(actionId, handler)` — receives `PluginContextMenuTarget` with entity metadata (includes `subsonic` flag) |
| `ui` | `setViewData(viewId, data)`, `showNotification(message)`, `onAction(actionId, handler)`, `navigateToView(viewId)`, `requestAction(action, payload)` |
| `storage` | `get(key)`, `set(key, value)`, `delete(key)` — per-plugin key-value storage backed by SQLite |
| `network` | `fetch(url, init?)` — proxied HTTP requests via the Rust backend; `openUrl(url)` — open URL in default browser; `onDeepLink(handler)` — receive deep link callbacks (e.g. OAuth); `onOAuthCallback(handler)` — OAuth callback handler; `startOAuthListener()` — start local OAuth HTTP listener (returns port) |
| `tidal` | `search(query, limit?, offset?)`, `getAlbum(albumId)`, `getArtist(artistId)`, `getArtistAlbums(artistId)`, `getStreamUrl(trackId, quality?)`, `downloadTrack(trackId, opts?)`, `downloadAlbum(albumId, opts?)`, `checkStatus()` |
| `collections` | `getLocalCollections()`, `getDownloadFormat()` |

**View rendering (`PluginViewRenderer`):**
Plugin views use a structured data model (`PluginViewData`) rather than raw HTML. Supported view types: `track-list`, `card-grid`, `track-row-list` (with optional selection and toolbar actions), `text`, `stats-grid`, `button`, `layout` (vertical/horizontal container), `spacer`, `search-input` (text input that dispatches on Enter), `tabs` (switchable tab bar with optional counts), `loading`.

**Plugin lifecycle:**
1. On app startup, `usePlugins` hook discovers plugins via `plugin_list_installed`.
2. Each enabled plugin's `index.js` is read via `plugin_read_file` and executed in an isolated `Function` scope with the plugin API injected.
3. The plugin calls `activate(api)` and may return a `deactivate()` cleanup function.
4. Plugins can be enabled/disabled via Settings > Plugins tab.

**Plugin directories:**
- **Native plugins:** `{app_resources}/plugins/` (bundled with the app binary).
- **User plugins:** `{app_dir}/plugins/` (user profile directory, created on demand).

**Security:**
- `plugin_read_file` validates plugin IDs against path traversal (`..`, `/`, `\`) and canonicalizes paths to ensure reads stay within the plugin directory.
- Network requests are proxied through the Rust backend (`plugin_fetch` command) rather than allowing direct browser fetch.

**Plugin gallery:**
- A curated gallery of plugins is hosted at the `outcast1000/viboplr-plugins` GitHub repository.
- The gallery index is fetched via `fetch_plugin_gallery` and displayed in Settings > Plugins tab.
- Users can install gallery plugins with one click (`install_gallery_plugin`). Installation downloads the plugin files to a temp directory and atomically moves them into place.
- User-installed plugins can be deleted via `delete_user_plugin`. Built-in plugins are protected from deletion.

**Built-in plugins:**

- **`tidal-browse`** — TIDAL search, album/artist browsing, playback, downloads, and context menu integration (Search on TIDAL, Upgrade Quality, Play from TIDAL). See §4.18.
- **`spotify-browse`** — Spotify library browsing via OAuth PKCE authentication. Provides liked songs and playlists browsing with pagination, Spotify search with tabbed results (tracks, artists, albums), and a track detail view showing album art, metadata (popularity, release date, track number, explicit flag), with "Open in Spotify" and "Play Preview" actions. Uses deep links (`viboplr://spotify/callback`) for OAuth callback.

**Settings UI (Settings > Plugins tab):**
Lists all discovered plugins with name, version, author, status badge (active/error/incompatible/disabled), and an enable/disable toggle. Error details are shown inline. A gallery section shows available plugins with install/installed status. User-installed plugins have a delete button.

## 11. Out of Scope (v1)

- Equalizer / audio effects / DSP
- Lyrics display
- Mobile platforms (iOS, Android)

## 12. Implementation Notes

### 12.1 FTS5 Filename Extraction

The FTS5 search index requires proper extraction of filenames from full file paths. SQLite's built-in string functions cannot reliably extract filenames because `RTRIM(path, chars)` treats the second argument as a **set of characters** rather than a substring, leading to incorrect truncation.

**Solution:** A custom SQLite function `filename_from_path()` is registered at database initialization. This function is implemented in Rust and uses `std::path::Path::file_name()` to correctly extract the filename component.

```rust
// Registered in db.rs
conn.create_scalar_function(
    "filename_from_path",
    1,
    FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
    |ctx| {
        let path_str: String = ctx.get(0)?;
        let path = std::path::Path::new(&path_str);
        let filename = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        Ok(filename)
    },
)?;
```

**Usage in FTS rebuild:**

```sql
INSERT INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, filename)
SELECT t.id, strip_diacritics(t.title), strip_diacritics(COALESCE(ar.name, '')),
       strip_diacritics(COALESCE(al.title, '')),
       strip_diacritics(COALESCE(GROUP_CONCAT(tg.name, ', '), '')),
       strip_diacritics(filename_from_path(t.path))
FROM tracks t
LEFT JOIN artists ar ON t.artist_id = ar.id
LEFT JOIN albums al ON t.album_id = al.id
LEFT JOIN track_tags tt ON t.id = tt.track_id
LEFT JOIN tags tg ON tt.tag_id = tg.id
GROUP BY t.id
```

### 12.2 Subsonic Authentication

The Subsonic API supports two auth modes:

1. **Token auth** (preferred): `u={user}&t={md5(password+salt)}&s={salt}` — password never sent over the wire.
2. **Plaintext auth** (fallback): `u={user}&p={password}` — used when the server does not support token auth.

On initial connection, `SubsonicClient::new()` tries token auth first and falls back to plaintext if the ping fails. The chosen method, token, and salt are persisted in the `collections` table so subsequent syncs reconstruct the client via `SubsonicClient::from_stored()` without needing the original password.

### 12.3 LIFO Image Download Queue

Artist and album image fetching is handled by a single background worker thread with a LIFO (last-in, first-out) queue. This ensures that the most recently requested images (i.e., whatever the user is currently looking at) are downloaded first.

**Architecture:**
- `AppState` holds a shared `DownloadQueue` containing a `Mutex<Vec<ImageDownloadRequest>>` and a `Condvar`.
- `fetch_artist_image` and `fetch_album_image` commands are fire-and-forget: they push a request onto the queue and return immediately.
- A single worker thread (spawned at app startup) waits on the condvar, pops the **last** item from the vec (LIFO), and processes it.
- Before downloading, the worker checks if the image file already exists on disk and skips if so (deduplication).
- **Failure tracking:** Before attempting a download, the worker also checks the `image_fetch_failures` table. If the item has a recorded failure, the download is skipped. On failure, the worker records the failure via `record_image_failure()`. The `clear_image_failures` command allows retrying all previously failed downloads.
- After each download, the worker sleeps 1100ms to respect rate limits (1 request/second with margin).
- On success, the worker emits `artist-image-ready` / `album-image-ready` events. On failure, it emits `artist-image-error` / `album-image-error` events.
- All logging is done via `log::info!` / `log::warn!` in Rust — no JS console logging for image downloads.

**Now Playing bar image fetching:**
- When the current track changes, the frontend proactively requests the album image (and artist image as fallback) for the playing track.
- This ensures the Now Playing bar displays artwork even if the user has not browsed to the track's album or artist view.
- Uses the same on-demand fetch pattern: checks local cache first (`get_entity_image`), then fires off a background download (`fetch_album_image` / `fetch_artist_image`) if no local image exists.
- Respects the same deduplication guards (fetched/failed sets) so images are only requested once per session.

**Canonical name-based image storage:** Entity images are stored using filesystem-safe canonical slugs derived from entity names instead of numeric database IDs. This decouples images from the database so they persist across DB recreations. The `canonical_slug()` function strips diacritics, lowercases, removes unsafe filesystem characters, collapses whitespace, and truncates to 200 bytes. Image paths:
- Artist images: `{app_dir}/artist_images/{canonical_slug(name)}.{ext}`
- Album images: `{app_dir}/album_images/{canonical_slug(artist)} - {canonical_slug(title)}.{ext}`
- Tag images: `{app_dir}/tag_images/{canonical_slug(name)}.{ext}`

**Manual image management:**
- `set_entity_image(kind, id, source_path)` — copy an image from a local file path to the app's image directory.
- `paste_entity_image(kind, id, image_data)` — write raw image bytes (e.g., from clipboard paste) to the app's image directory. Image format (PNG/JPG) is auto-detected from magic bytes.
- `remove_entity_image(kind, id)` — delete an image from the app's image directory.

All three commands are generic, accepting `kind` = `"artist"`, `"album"`, or `"tag"`. A single `entity_image.rs` module provides `image_dir()`, `get_image_path()`, `remove_image()`, `canonical_slug()`, and `entity_image_slug()` helpers parameterized by kind.

Tags support auto-generated composite images via `fetch_tag_image` (see §4.7) in addition to manual management (set, paste, remove).

### 12.4 Playback Resolution

`get_track_path` returns different values based on track type. When `subsonic_id` is set, the collection's `kind` field is checked to determine the resolution strategy:

- **Local track** (`subsonic_id` is NULL): returns the filesystem path. Frontend wraps it with `convertFileSrc()` for `asset://` protocol.
- **Subsonic track** (`subsonic_id` is set, `kind = "subsonic"`): constructs a full streaming URL `{server}/rest/stream.view?id={subsonic_id}&{auth_params}`. Frontend uses the URL directly as the `<audio>` src.
- **TIDAL track** (`subsonic_id` is set, `kind = "tidal"`): makes a blocking HTTP call to the Hi-Fi API `/track/?id={tidal_id}&quality=LOSSLESS`, base64-decodes the BTS manifest, and returns the CDN URL. Fresh URL fetched at play time to avoid token expiration.

### 12.5 Extensible Image Provider System

Image fetching uses a trait-based provider system (`src-tauri/src/image_provider/`) so new sources can be added without touching the download queue, commands, or frontend.

**Two separate traits:**
- `ArtistImageProvider` — `name() -> &str`, `fetch_artist_image(artist_name, dest_path) -> Result<(), String>`
- `AlbumImageProvider` — `name() -> &str`, `fetch_album_image(title, artist_name?, dest_path) -> Result<(), String>`

Two traits rather than one combined trait because providers may only support one entity type (e.g., Cover Art Archive only does albums, embedded artwork only does albums). Both traits require `Send + Sync` since the worker thread holds them via `Arc<dyn Trait>`.

**Fallback chains:**
- `ArtistImageFallbackChain` and `AlbumImageFallbackChain` each hold a `Vec<Box<dyn Provider>>`, implement the corresponding trait, and try each provider in order. Failures are logged; the last error is returned if all providers fail.

**Built-in providers:**

| Provider | File | Artist | Album | Notes |
|----------|------|--------|-------|-------|
| TIDAL | `tidal.rs` | Yes | Yes | Searches TIDAL via Hi-Fi API; downloads artist pictures (750px) and album covers (1280px). Only active when a TIDAL collection is configured. |
| Deezer | `deezer.rs` | Yes | Yes | Searches Deezer API for artist photos and album covers |
| iTunes | `itunes.rs` | Yes | Yes | Searches iTunes Search API |
| AudioDB | `audiodb.rs` | Yes | No | Searches TheAudioDB for artist images |
| MusicBrainz | `musicbrainz.rs` | Yes | Yes | Searches MusicBrainz + Wikimedia Commons (artists) / Cover Art Archive (albums) |
| Embedded | `embedded.rs` | No | Yes | Extracts embedded artwork from the first local audio file of the album using `lofty` |

**Default fallback order:**
- Artists: TIDAL → Deezer → iTunes → AudioDB → MusicBrainz
- Albums: Embedded → TIDAL → iTunes → Deezer → MusicBrainz

**Shared utilities (`image_provider/mod.rs`):**
- `urlencoded()` — percent-encodes strings for API queries.
- `http_client()` — builds a `reqwest::blocking::Client` with the Viboplr user-agent.
- `write_image()` — creates parent directories and writes bytes to disk.

**Wiring (`lib.rs`):**
- At app startup, fallback chains are constructed with all providers in the specified order.
- The chains are passed as `Arc<dyn ArtistImageProvider>` / `Arc<dyn AlbumImageProvider>` into the worker thread.
- `entity_image.rs` provides generic `image_dir()`, `get_image_path()`, and `remove_image()` helpers parameterized by `kind` (used by commands).

**Adding a new provider:**
1. Create `src-tauri/src/image_provider/newprovider.rs`.
2. Implement `ArtistImageProvider` and/or `AlbumImageProvider`.
3. Add to the fallback chain in `lib.rs` setup.
4. No changes to commands, events, or frontend.

### 12.6 Accent-Insensitive Search

SQLite FTS5's built-in `remove_diacritics 2` only strips diacritics for Latin-based characters. It does **not** work for Greek, Cyrillic, or other non-Latin scripts (e.g., searching "μπαλαφας" would not match "Μπαλάφας").

**Solution:** A custom `strip_diacritics()` SQL function is registered at database initialization. It uses the `unicode-normalization` crate to NFD-decompose text and remove all combining marks, working correctly for any Unicode script.

```rust
// In db.rs
pub fn strip_diacritics(s: &str) -> String {
    s.nfd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect()
}
```

This function is applied in two places:
1. **FTS indexing:** all text is stripped before insertion into `tracks_fts` (via `strip_diacritics()` SQL function wrapping each column).
2. **Search queries:** the query string is stripped in Rust before building the FTS MATCH expression.

The frontend also applies equivalent normalization (`String.normalize("NFD")` + regex removal of combining marks) for client-side filtering of artist, album, and tag lists.

**Dependencies:** Requires `unicode-normalization` and the `functions` feature in rusqlite:

```toml
rusqlite = { version = "0.32", features = ["bundled", "functions"] }
unicode-normalization = "0.1"
```
