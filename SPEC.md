# FastPlayer — Specification

## 1. Overview

FastPlayer is a lightweight, cross-platform **media player** for macOS and Windows. It plays audio and video files, scans local folders in the background, reads metadata tags, and builds a searchable library backed by SQLite. The player prioritizes fast startup, instant playback, and quick search.

**Non-goals (v1):** streaming, playlists/queues, equalizer/DSP, lyrics, internet album art fetching, mobile.

## 2. Tech Stack

| Layer            | Technology                          | Purpose                                  |
| ---------------- | ----------------------------------- | ---------------------------------------- |
| App shell        | Tauri 2                             | Native window, small binary, no Chromium |
| Backend          | Rust                                | Scanning, DB, file watching              |
| Frontend         | TypeScript + React                  | UI + playback via HTML5 media elements   |
| Playback         | HTML5 `<audio>` / `<video>`         | OS-native codecs via webview             |
| File serving     | Tauri asset protocol                | `asset://` serves local files to webview |
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

MP4 (H.264) — supported on both macOS and Windows.

WebM (VP8/VP9) — Windows only (Chromium-based WebView2). Not supported on macOS (WebKit).

## 4. Core Features

### 4.1 Folder Scanning

- User selects one or more folders via native directory picker.
- A background Rust thread walks the folder tree recursively.
- For each audio or video file, reads tags via `lofty`.
- If tags are missing or empty, falls back to **regex-based filename parsing** (see §4.2).
- Inserts/updates rows in SQLite (`artists`, `albums`, `genres`, `tracks`).
- Reports scan progress to the frontend via Tauri events.

### 4.2 Tag Fallback — Filename Regex

When `lofty` returns no usable tags, the following regex patterns are tried in order against the filename (stem only, no extension):

1. `^(?P<track>\d+)[\s._-]+(?P<artist>.+?)\s*-\s*(?P<title>.+)$`
   → e.g. `03 - Pink Floyd - Comfortably Numb`
2. `^(?P<artist>.+?)\s*-\s*(?P<title>.+)$`
   → e.g. `Pink Floyd - Comfortably Numb`
3. `^(?P<track>\d+)[\s._-]+(?P<title>.+)$`
   → e.g. `03 - Comfortably Numb` (parent folder → album & artist)
4. **Fallback:** filename stem → title, parent folder → album, grandparent folder → artist.

### 4.3 File Monitoring

- `notify` crate watches all scanned folders for create/delete/rename/modify events.
- On change, the scanner re-processes only the affected file(s).
- Runs on a dedicated background thread; does not block UI or playback.

### 4.4 Library Browsing

- Browse by **artist**, **album**, **genre**, or **all tracks** (flat list).
- Grid view (album art) and list view (table).
- Sort by name, date added, year, duration.

### 4.5 Search

- SQLite FTS5 virtual table indexes: track title, artist name, album title, genre name, filename.
- Search-as-you-type with <100 ms response time.
- Uses custom SQLite function `filename_from_path()` (Rust-implemented) to correctly extract filenames from full paths for indexing.
- Index automatically rebuilt after folder scans; can be manually triggered via `rebuild_search_index` command.

### 4.6 Playback

- Frontend-driven via HTML5 `<audio>` and `<video>` elements.
- Local files served to the webview via Tauri's `asset://` protocol (`convertFileSrc()`).
- Media type (audio vs video) determined by file extension.
- Transport controls: play, pause, stop, seek, volume.
- Position and duration tracked via HTML5 media events (`timeupdate`, `loadedmetadata`, `play`, `pause`, `ended`) — no polling.
- Video displayed inline in the main content area; audio plays with no visual.
- Shuffle and repeat (repeat-one, repeat-all, no-repeat).
- Album art display from embedded tags when available.

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

CREATE TABLE genres (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE
);

CREATE TABLE tracks (
    id              INTEGER PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    artist_id       INTEGER REFERENCES artists(id),
    album_id        INTEGER REFERENCES albums(id),
    genre_id        INTEGER REFERENCES genres(id),
    track_number    INTEGER,
    duration_secs   REAL,
    format          TEXT,
    file_size       INTEGER,
    modified_at     INTEGER,
    added_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE folders (
    id              INTEGER PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    last_scanned_at INTEGER
);

-- Full-text search
CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title,
    artist_name,
    album_title,
    genre_name,
    filename,
    content='',
    tokenize='unicode61'
);
```

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
│  │  Playback via asset:// protocol     │   │
│  └──────────────────────────────────────┘   │
└──────────────────┬──────────────────────────┘
                   │ Tauri IPC (invoke / listen)
┌──────────────────▼──────────────────────────┐
│                Tauri Commands               │
│  add_folder, remove_folder, get_artists,    │
│  get_albums, get_tracks, get_track_path,    │
│  search                                     │
└──┬───────────┬──────────────────────────────┘
   │           │
   ▼           ▼
┌────────┐ ┌────────────┐
│Scanner │ │  Watcher   │
│Service │ │  Service   │
│lofty + │ │  notify    │
│regex   │ │            │
└───┬────┘ └─────┬──────┘
    │            │
    ▼            ▼
┌──────────────────┐
│   SQLite (DB)    │
│  rusqlite + FTS5 │
└──────────────────┘
```

## 7. Tauri Commands (API)

| Command                 | Args                        | Returns                  |
| ----------------------- | --------------------------- | ------------------------ |
| `add_folder`            | `path: String`              | `FolderInfo`             |
| `remove_folder`         | `folder_id: i64`            | `()`                     |
| `get_folders`           | —                           | `Vec<FolderInfo>`        |
| `get_artists`           | —                           | `Vec<Artist>`            |
| `get_albums`            | `artist_id: Option<i64>`    | `Vec<Album>`             |
| `get_tracks`            | `album_id: Option<i64>`     | `Vec<Track>`             |
| `get_tracks_by_artist`  | `artist_id: i64`            | `Vec<Track>`             |
| `search`                | `query: String`             | `Vec<Track>`             |
| `get_track_path`        | `track_id: i64`             | `String`                 |
| `rebuild_search_index`  | —                           | `()`                     |

### Tauri Events (backend → frontend)

| Event              | Payload             |
| ------------------ | ------------------- |
| `scan-progress`    | `{ scanned, total, folder }` |
| `scan-complete`    | `{ folder }`        |
| `library-updated`  | `{ changed_tracks }` |

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

- Streaming / network sources
- Playlists / queue management
- Equalizer / audio effects / DSP
- Lyrics display
- Album art fetching from the internet
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
INSERT INTO tracks_fts (rowid, title, artist_name, album_title, genre_name, filename)
SELECT t.id, t.title, COALESCE(ar.name, ''), COALESCE(al.title, ''),
       COALESCE(g.name, ''), filename_from_path(t.path)
FROM tracks t ...
```

**Dependencies:** Requires the `functions` feature in rusqlite (`Cargo.toml`):

```toml
rusqlite = { version = "0.32", features = ["bundled", "functions"] }
```
