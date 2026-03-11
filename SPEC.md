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

- Browse by **artist**, **album**, **tag**, or **all tracks** (flat list).
- List view (table) with columns: track number, title, artist, album, duration.
- Tracks from all collections (local and server) are unified in a single library.

### 4.7 Tags

Tags replace the previous single-genre-per-track model. A track can have **multiple tags** via a many-to-many relationship (`track_tags` junction table). Genre metadata read from file tags or Subsonic metadata is stored as tags. The Tags view in the sidebar lists all tags; clicking one filters the track list.

### 4.8 Search

- SQLite FTS5 virtual table indexes: track title, artist name, album title, tag names, filename.
- Search-as-you-type with <100 ms response time.
- Uses custom SQLite function `filename_from_path()` (Rust-implemented) to correctly extract filenames from full paths for indexing.
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

### 4.10 Context Menu

- Right-click on a track to open a context menu.
- **Open Containing Folder** (local tracks only): Opens the track's parent directory in the OS file explorer (macOS Finder, Windows Explorer, or Linux xdg-open).
- For server tracks, the context menu indicates it is a server track (no folder to open).

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
    subsonic_id     TEXT
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
    tokenize='unicode61'
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
│  get_tags, search, show_in_folder,          │
│  get_track_path                             │
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
| `get_tracks_by_artist`  | `artist_id: i64`            | `Vec<Track>`             |
| `get_tags`              | —                           | `Vec<Tag>`               |
| `get_tags_for_track`    | `track_id: i64`             | `Vec<Tag>`               |
| `get_tracks_by_tag`     | `tag_id: i64`               | `Vec<Track>`             |
| `search`                | `query: String`             | `Vec<Track>`             |
| `get_track_path`        | `track_id: i64`             | `String` (path or URL)   |
| `show_in_folder`        | `track_id: i64`             | `()`                     |
| `rebuild_search_index`  | —                           | `()`                     |

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
SELECT t.id, t.title, COALESCE(ar.name, ''), COALESCE(al.title, ''),
       COALESCE(GROUP_CONCAT(tg.name, ', '), ''), filename_from_path(t.path)
FROM tracks t
LEFT JOIN artists ar ON t.artist_id = ar.id
LEFT JOIN albums al ON t.album_id = al.id
LEFT JOIN track_tags tt ON t.id = tt.track_id
LEFT JOIN tags tg ON tt.tag_id = tg.id
GROUP BY t.id
```

**Dependencies:** Requires the `functions` feature in rusqlite (`Cargo.toml`):

```toml
rusqlite = { version = "0.32", features = ["bundled", "functions"] }
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

### 11.4 Playback Resolution

`get_track_path` returns different values based on track type:

- **Local track** (`subsonic_id` is NULL): returns the filesystem path. Frontend wraps it with `convertFileSrc()` for `asset://` protocol.
- **Server track** (`subsonic_id` is set): constructs a full streaming URL `{server}/rest/stream.view?id={subsonic_id}&{auth_params}`. Frontend uses the URL directly as the `<audio>` src.
