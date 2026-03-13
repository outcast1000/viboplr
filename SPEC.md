# FastPlayer — Specification

## 1. Overview

FastPlayer is a lightweight, cross-platform **media player** for macOS and Windows. It plays audio and video files from local folders and Subsonic/Navidrome servers, scans local folders in the background, reads metadata tags, and builds a searchable library backed by SQLite. The player prioritizes fast startup, instant playback, and quick search.

**Non-goals (v1):** playlists/queues, equalizer/DSP, lyrics, mobile.

## 2. Tech Stack

| Layer            | Technology                          | Purpose                                  |
| ---------------- | ----------------------------------- | ---------------------------------------- |
| App shell        | Tauri 2                             | Native window, small binary, no Chromium |
| Backend          | Rust                                | Scanning, DB, file watching, sync        |
| Frontend         | TypeScript + React                  | UI + playback via HTML5 media elements   |
| Playback         | HTML5 `<audio>` / `<video>`         | OS-native codecs via webview             |
| File serving     | Tauri asset protocol                | `asset://` serves local files to webview |
| Server streaming | Subsonic REST API                   | HTTP streaming from Subsonic/Navidrome   |
| Tag reading      | `lofty`                             | ID3v1/v2, Vorbis, FLAC, MP4, Opus tags  |
| File watching    | `notify`                            | Cross-platform filesystem events         |
| Database         | SQLite via `rusqlite`               | Embedded media library                   |
| Search           | SQLite FTS5                         | Sub-millisecond full-text search         |
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
- **`seed`** — debug-only fake test data (gated behind `debug_assertions`).

Every track belongs to a collection via `collection_id`. The sidebar displays all collections with kind badges, resync buttons, and remove buttons.

### 4.2 Local Folder Scanning

- User selects a folder via native directory picker → creates a `local` collection.
- A background Rust thread walks the folder tree recursively.
- For each audio or video file, reads tags via `lofty`.
- If tags are missing or empty, falls back to **regex-based filename parsing** (see §4.3).
- Genre metadata from file tags is stored as **tags** (many-to-many relationship with tracks).
- Inserts/updates rows in SQLite (`artists`, `albums`, `tags`, `track_tags`, `tracks`).
- Reports scan progress to the frontend via Tauri events.
- Each track's `collection_id` is set to the owning collection.

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

- Browse by **artist**, **album**, **tag**, **liked tracks**, or **all tracks** (flat list).
- List view (table) with columns: like (heart icon), track number, title, artist, album, duration.
- Tracks from all collections (local and server) are unified in a single library.

### 4.7 Tags

Tags replace the previous single-genre-per-track model. A track can have **multiple tags** via a many-to-many relationship (`track_tags` junction table). Genre metadata read from file tags or Subsonic metadata is stored as tags. The Tags view in the sidebar lists all tags; clicking one filters the track list.

### 4.8 Search

- SQLite FTS5 virtual table indexes: track title, artist name, album title, tag names, filename.
- **Accent-insensitive:** all indexed text is stripped of diacritics before insertion via a custom `strip_diacritics()` SQL function (Rust, using `unicode-normalization` crate). Search queries are also normalized before matching. This works for all Unicode scripts (Latin, Greek, Cyrillic, etc.). Client-side list filtering (artists, albums, tags) uses JavaScript `String.normalize("NFD")` with combining-mark removal for the same effect.
- Search-as-you-type with <100 ms response time.
- Uses custom SQL functions `filename_from_path()` and `strip_diacritics()` (Rust-implemented) registered at database initialization.
- Index automatically rebuilt after folder scans and server syncs; can be manually triggered via `rebuild_search_index` command.

### 4.9 Playback

- Frontend-driven via HTML5 `<audio>` and `<video>` elements.
- **Local tracks:** served to the webview via Tauri's `asset://` protocol (`convertFileSrc()`).
- **Server tracks:** `get_track_path` constructs a streaming URL with auth params from stored credentials. The `<audio>` element plays the HTTP URL directly.
- Media type (audio vs video) determined by file extension (video: mp4, m4v, mov, webm).
- Transport controls: play, pause, stop, seek, volume.
- Position and duration tracked via HTML5 media events (`timeupdate`, `loadedmetadata`, `play`, `pause`, `ended`) — no polling.
- Video displayed inline in the main content area; audio plays with no visual.
- Keyboard navigation: arrow keys to navigate tracks, Enter to play.

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

### 4.10 Liked Tracks

- Each track has a `liked` boolean attribute (stored as `INTEGER DEFAULT 0` in SQLite).
- A heart icon column appears in the track list: filled heart (♥) when liked, outline heart (♡) when not.
- Clicking the heart toggles the liked state via `toggle_track_liked` and updates local state immediately (tracks list, current track, and queue).
- The sidebar has a "Liked" view that shows all liked tracks via `get_liked_tracks`. Search in this view is scoped to liked tracks only (`liked_only` flag passed to `search`).
- **Scan-safe:** the `liked` column is excluded from the `upsert_track` ON CONFLICT clause, so re-scanning or re-syncing a collection preserves the user's likes.
- **Migration:** existing databases gain the `liked` column via `ALTER TABLE tracks ADD COLUMN liked INTEGER NOT NULL DEFAULT 0`.

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

**Selection logic:**
1. A random number 0–99 is rolled and mapped to a strategy based on cumulative weights.
2. The backend `get_auto_continue_track` command executes the chosen strategy's SQL query (all exclude the current track via `t.id != ?`).
3. If the strategy returns no result (e.g., no liked tracks, no tags), the frontend retries with `"random"` as a fallback.
4. The selected track is appended to the queue and immediately played.

**Persistence:** `autoContinueEnabled` (boolean) and `autoContinueWeights` (object with 5 number fields) are persisted to the app store and restored on startup.

### 4.12 Context Menu

- Right-click on a track, album, or artist to open a context menu.
- **Play** / **Enqueue**: Play immediately or add to queue.
- **Locate File** (local tracks only): Opens the track's parent directory in the OS file explorer (macOS Finder, Windows Explorer via `raw_arg` for proper path quoting, or Linux xdg-open).
- **Search providers**: Dynamic list of enabled search providers (see §4.14). Each provider appears with its icon and a "Search on {name}" label. Clicking opens the provider's URL with `{artist}` and `{title}` placeholders filled in. Only providers with a URL template for the current context (artist/album/track) are shown.

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

UI state is saved to disk via `tauri-plugin-store` and restored on startup so the app resumes exactly where the user left off. The store is a JSON file (`app-state.json`) in the app data directory.

**Persisted state:**

| Key | Type | Default |
|-----|------|---------|
| `view` | `string` (`"all"`, `"artists"`, `"albums"`, `"tags"`, `"liked"`, `"history"`) | `"all"` |
| `searchQuery` | `string` | `""` |
| `selectedArtist` | `number \| null` | `null` |
| `selectedAlbum` | `number \| null` | `null` |
| `selectedTag` | `number \| null` | `null` |
| `currentTrackId` | `number \| null` | `null` |
| `positionSecs` | `number` | `0` |
| `volume` | `number` | `1.0` |
| `queueTrackIds` | `number[]` | `[]` |
| `queueIndex` | `number` | `-1` |
| `queueMode` | `string` (`"normal"`, `"loop"`, `"shuffle"`) | `"normal"` |
| `windowWidth` | `number \| null` | `null` |
| `windowHeight` | `number \| null` | `null` |
| `windowX` | `number \| null` | `null` |
| `windowY` | `number \| null` | `null` |
| `searchProviders` | `SearchProviderConfig[] \| null` | `null` |
| `crossfadeSecs` | `number` | `3` |
| `autoContinueEnabled` | `boolean` | `false` |
| `autoContinueWeights` | `{ random, sameArtist, sameTag, mostPlayed, liked }` | `{ 40, 20, 20, 10, 10 }` |

**Behavior:**

- Only the track ID is persisted — the full `Track` object is re-fetched via `get_track_by_id` on restore. If the track was deleted, the app gracefully falls back to no current track.
- On restore, the last track is loaded at the saved position but playback does **not** auto-start — the user must press play. `positionSecs` updates ~4×/sec during playback; the `autoSave: 500` debounce coalesces disk writes.
- Queue is persisted as an array of track IDs. On restore, tracks are re-fetched via `get_tracks_by_ids`. Missing tracks are silently dropped.
- Window size and position are stored in logical (CSS) pixels. On restore, size is applied first, then position. On resize/move, saves are debounced at 500 ms. If no saved values exist, the app uses the default window size from `tauri.conf.json`.
- Saves are debounced at 500 ms (`autoSave: 500`).
- A `restoredRef` guard prevents save effects from firing before restore completes, avoiding overwriting persisted data with defaults.

## 5. Database Schema

```sql
CREATE TABLE artists (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE
);

CREATE TABLE albums (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    artist_id   INTEGER REFERENCES artists(id),
    year        INTEGER,
    UNIQUE(title, artist_id)
);

CREATE TABLE tags (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE
);

CREATE TABLE collections (
    id              INTEGER PRIMARY KEY,
    kind            TEXT NOT NULL,           -- 'local', 'subsonic', 'seed'
    name            TEXT NOT NULL,           -- display name
    path            TEXT,                    -- local folder path (local only)
    url             TEXT,                    -- server base URL (subsonic only)
    username        TEXT,                    -- (subsonic only)
    password_token  TEXT,                    -- md5 token or plaintext (subsonic only)
    salt            TEXT,                    -- (subsonic only, NULL for plaintext auth)
    auth_method     TEXT DEFAULT 'token',    -- 'token' or 'plaintext' (subsonic only)
    last_synced_at  INTEGER
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
    subsonic_id     TEXT,
    liked           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE track_tags (
    track_id    INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
    tag_id      INTEGER REFERENCES tags(id) ON DELETE CASCADE,
    UNIQUE(track_id, tag_id)
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

**Migration:** On upgrade from the old schema, the `folders` table is automatically migrated to `collections` with `kind='local'`. Existing tracks are linked to their collection by path prefix matching. The `folders` table is dropped after migration.

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
│  └──────────────────────────────────────┘   │
└──────────────────┬──────────────────────────┘
                   │ Tauri IPC (invoke / listen)
┌──────────────────▼──────────────────────────┐
│                Tauri Commands               │
│  add_collection, remove_collection,         │
│  get_collections, resync_collection,        │
│  get_artists, get_albums, get_tracks,       │
│  get_tags, search, toggle_track_liked,      │
│  show_in_folder, get_track_path             │
└──┬───────────┬───────────┬──────────────────┘
   │           │           │
   ▼           ▼           ▼
┌────────┐ ┌────────────┐ ┌──────────────┐
│Scanner │ │  Watcher   │ │  Subsonic    │
│Service │ │  Service   │ │  Sync        │
│lofty + │ │  notify    │ │  Client      │
│regex   │ │            │ │              │
└───┬────┘ └─────┬──────┘ └──────┬───────┘
    │            │               │
    ▼            ▼               ▼
┌──────────────────────────────────┐
│          SQLite (DB)             │
│        rusqlite + FTS5           │
└──────────────────────────────────┘
```

## 7. Tauri Commands (API)

### Collection Commands

| Command                 | Args                                                    | Returns            |
| ----------------------- | ------------------------------------------------------- | ------------------ |
| `add_collection`        | `kind, name, path?, url?, username?, password?`         | `Collection`       |
| `remove_collection`     | `collection_id: i64`                                    | `()`               |
| `get_collections`       | —                                                       | `Vec<Collection>`  |
| `resync_collection`     | `collection_id: i64`                                    | `()`               |

### Library Commands

| Command                 | Args                        | Returns                  |
| ----------------------- | --------------------------- | ------------------------ |
| `get_artists`           | —                           | `Vec<Artist>`            |
| `get_albums`            | `artist_id: Option<i64>`    | `Vec<Album>`             |
| `get_tracks`            | `album_id: Option<i64>`     | `Vec<Track>`             |
| `get_track_count`       | —                           | `i64`                    |
| `get_track_by_id`       | `track_id: i64`             | `Track`                  |
| `get_tracks_by_artist`  | `artist_id: i64`            | `Vec<Track>`             |
| `get_tags`              | —                           | `Vec<Tag>`               |
| `get_tags_for_track`    | `track_id: i64`             | `Vec<Tag>`               |
| `get_tracks_by_tag`     | `tag_id: i64`               | `Vec<Track>`             |
| `toggle_track_liked`    | `track_id: i64, liked: bool`| `()`                     |
| `get_liked_tracks`      | —                           | `Vec<Track>`             |
| `search`                | `query, artist_id?, album_id?, tag_id?, liked_only?` | `Vec<Track>`   |
| `get_track_path`        | `track_id: i64`             | `String` (path or URL)   |
| `show_in_folder`        | `track_id: i64`             | `()`                     |
| `rebuild_search_index`  | —                           | `()`                     |
| `get_auto_continue_track` | `strategy: String, current_track_id: i64` | `Option<Track>` |

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
| `artist-image-error` | `{ artistId, error }`             |
| `album-image-ready`  | `{ albumId, path }`               |
| `album-image-error`  | `{ albumId, error }`              |

## 8. Performance Targets

| Metric                   | Target   |
| ------------------------ | -------- |
| Cold startup to usable UI | < 1 s   |
| Play after click         | < 200 ms |
| Search results           | < 100 ms |
| Binary size              | < 15 MB  |
| Idle RAM                 | < 50 MB  |

## 9. Platform Notes

- **macOS:** `.dmg` distribution, native title bar, media key support via `souvlaki` crate.
- **Windows:** `.msi` / `.exe` installer, taskbar controls, media key support via `souvlaki` crate.

## 10. Out of Scope (v1)

- Playlists / queue management
- Equalizer / audio effects / DSP
- Lyrics display
- Mobile platforms (iOS, Android)

## 11. Implementation Notes

### 11.1 FTS5 Filename Extraction

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

### 11.6 Accent-Insensitive Search

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

### 11.2 Subsonic Authentication

The Subsonic API supports two auth modes:

1. **Token auth** (preferred): `u={user}&t={md5(password+salt)}&s={salt}` — password never sent over the wire.
2. **Plaintext auth** (fallback): `u={user}&p={password}` — used when the server does not support token auth.

On initial connection, `SubsonicClient::new()` tries token auth first and falls back to plaintext if the ping fails. The chosen method, token, and salt are persisted in the `collections` table so subsequent syncs reconstruct the client via `SubsonicClient::from_stored()` without needing the original password.

### 11.3 LIFO Image Download Queue

Artist and album image fetching is handled by a single background worker thread with a LIFO (last-in, first-out) queue. This ensures that the most recently requested images (i.e., whatever the user is currently looking at) are downloaded first.

**Architecture:**
- `AppState` holds a shared `DownloadQueue` containing a `Mutex<Vec<ImageDownloadRequest>>` and a `Condvar`.
- `fetch_artist_image` and `fetch_album_image` commands are fire-and-forget: they push a request onto the queue and return immediately.
- A single worker thread (spawned at app startup) waits on the condvar, pops the **last** item from the vec (LIFO), and processes it.
- Before downloading, the worker checks if the image file already exists on disk and skips if so (deduplication).
- After each download, the worker sleeps 1100ms to respect MusicBrainz rate limits (1 request/second with margin).
- On success, the worker emits `artist-image-ready` / `album-image-ready` events. On failure, it emits `artist-image-error` / `album-image-error` events.
- All logging is done via `log::info!` / `log::warn!` in Rust — no JS console logging for image downloads.

### 11.5 Extensible Image Provider System

Image fetching uses a trait-based provider system (`src-tauri/src/image_provider/`) so new sources (Discogs, Last.fm, Spotify, etc.) can be added without touching the download queue, commands, or frontend.

**Two separate traits:**
- `ArtistImageProvider` — `name() -> &str`, `fetch_artist_image(artist_name, dest_path) -> Result<(), String>`
- `AlbumImageProvider` — `name() -> &str`, `fetch_album_image(title, artist_name?, dest_path) -> Result<(), String>`

Two traits rather than one combined trait because providers may only support one entity type (e.g., Cover Art Archive only does albums). Both traits require `Send + Sync` since the worker thread holds them via `Arc<dyn Trait>`.

**Fallback chains:**
- `ArtistImageFallbackChain` and `AlbumImageFallbackChain` each hold a `Vec<Box<dyn Provider>>`, implement the corresponding trait, and try each provider in order. Failures are logged; the last error is returned if all providers fail.

**Built-in providers (`image_provider/musicbrainz.rs`):**
- `MusicBrainzArtistProvider` — searches MusicBrainz for the artist, follows image relations (resolving Wikimedia Commons thumbnails), and downloads the image.
- `MusicBrainzAlbumProvider` — searches MusicBrainz for a release-group, then fetches cover art from the Cover Art Archive.

**Shared utilities (`image_provider/mod.rs`):**
- `urlencoded()` — percent-encodes strings for MusicBrainz queries.
- `http_client()` — builds a `reqwest::blocking::Client` with the FastPlayer user-agent.
- `write_image()` — creates parent directories and writes bytes to disk.

**Wiring (`lib.rs`):**
- At app startup, fallback chains are constructed with MusicBrainz as the sole provider.
- The chains are passed as `Arc<dyn ArtistImageProvider>` / `Arc<dyn AlbumImageProvider>` into the worker thread.
- `artist_image.rs` and `album_image.rs` only retain `get_image_path()` and `remove_image()` (used by commands).

**Adding a new provider:**
1. Create `src-tauri/src/image_provider/newprovider.rs`.
2. Implement `ArtistImageProvider` and/or `AlbumImageProvider`.
3. Add to the fallback chain in `lib.rs` setup.
4. No changes to commands, events, or frontend.

### 11.4 Playback Resolution

`get_track_path` returns different values based on track type:

- **Local track** (`subsonic_id` is NULL): returns the filesystem path. Frontend wraps it with `convertFileSrc()` for `asset://` protocol.
- **Server track** (`subsonic_id` is set): constructs a full streaming URL `{server}/rest/stream.view?id={subsonic_id}&{auth_params}`. Frontend uses the URL directly as the `<audio>` src.
