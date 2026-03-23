# Download Manager with Metadata & Cover Art

## Overview

Add a download manager that lets users download tracks from TIDAL and Subsonic sources to a local folder collection, with embedded metadata tags, cover art, and configurable audio format. Also auto-fetches and caches TIDAL cover art during downloads.

## Architecture

Backend-driven download queue running as a background Rust thread (similar to the existing image download worker and scanner). Uses `Mutex<VecDeque> + Condvar` for FIFO ordering (the existing image worker uses `Mutex<Vec>` with LIFO pop — FIFO is more appropriate for downloads where users expect first-queued to download first). The download worker thread receives `Arc<Database>` and `AppHandle` at spawn time for DB access and event emission. API clients (`TidalClient`, `SubsonicClient`) are constructed fresh per download on the worker thread. The pipeline: resolve stream URL -> download to temp file -> write metadata tags via lofty -> embed cover art -> move to organized path -> notify library.

```
Frontend (context menu / TIDAL view)
  |
  | invoke("download_track", { ... })
  | invoke("download_album", { ... })
  v
Tauri Commands (commands.rs)
  |
  | enqueue DownloadRequest
  v
DownloadManager (downloader.rs)
  |  Background thread with Mutex<VecDeque> + Condvar
  |  Processes one download at a time
  |
  |  1. Resolve stream URL (TidalClient / SubsonicClient)
  |  2. HTTP GET -> temp file
  |  3. Write tags (lofty)
  |  4. Embed cover art (lofty Picture API)
  |  5. Move to {dest}/{Artist}/{Album}/{TrackNum} - {Title}.{ext}
  |  6. Save cover.jpg alongside
  |  7. scanner::process_media_file() for immediate library pickup
  |  8. Emit download-progress / download-complete events
  v
Local folder collection (auto-detected by library)
```

## Data Structures

### DownloadFormat enum (Rust)

```rust
enum DownloadFormat {
    Flac,
    Aac,
    Mp3,
}
```

Maps to:
- TIDAL quality param: `Flac -> "LOSSLESS"`, `Aac -> "HIGH"`, `Mp3 -> "HIGH"`
- Subsonic stream URL param: `&format=raw` / `&format=aac` / `&format=mp3`
- File extension: `.flac` / `.m4a` / `.mp3`

### DownloadRequest struct (Rust)

```rust
struct DownloadRequest {
    id: u64,                        // unique request ID
    track_title: String,
    artist_name: String,
    album_title: String,
    track_number: Option<u32>,
    genre: Option<String>,
    year: Option<i32>,
    cover_url: Option<String>,      // TIDAL cover URL or Subsonic getCoverArt URL
    source_collection_id: i64,      // which TIDAL/Subsonic collection to stream from
    remote_track_id: String,        // subsonic_id field value
    dest_collection_id: i64,        // local folder collection to save into
    format: DownloadFormat,
}
```

### DownloadManager struct (Rust)

```rust
struct DownloadManager {
    queue: Mutex<VecDeque<DownloadRequest>>,
    condvar: Condvar,
    active: Mutex<Option<DownloadStatus>>,
    next_id: AtomicU64,
    completed: Mutex<VecDeque<DownloadStatus>>,  // last N completed
}
```

Stored in `AppState` alongside existing fields.

### DownloadStatus struct (Rust, serialized to frontend)

```rust
struct DownloadStatus {
    id: u64,
    track_title: String,
    artist_name: String,
    status: String,       // "queued" | "downloading" | "writing_tags" | "complete" | "error"
    progress_pct: u8,     // 0-100 for downloading phase
    error: Option<String>,
}
```

## Tauri Commands

### download_track

```rust
fn download_track(
    state: State<'_, AppState>,
    source_collection_id: i64,
    remote_track_id: String,
    dest_collection_id: i64,
    format: String,  // "flac" | "aac" | "mp3"
) -> Result<u64, String>  // returns download request ID
```

Looks up track metadata from the database (title, artist, album, track number, genre, year), resolves cover URL from TIDAL cover_id or Subsonic cover art, builds a `DownloadRequest`, and enqueues it. Returns the request ID.

### download_album

```rust
fn download_album(
    state: State<'_, AppState>,
    source_collection_id: i64,
    album_id: String,       // TIDAL album ID or Subsonic album ID
    dest_collection_id: i64,
    format: String,
) -> Result<Vec<u64>, String>  // returns download request IDs
```

Fetches all tracks in the album from the remote API, enqueues each as a `DownloadRequest`. Returns all request IDs.

### get_download_status

```rust
fn get_download_status(
    state: State<'_, AppState>,
) -> Result<DownloadQueueInfo, String>
```

Returns:
```rust
struct DownloadQueueInfo {
    active: Option<DownloadStatus>,
    queued: Vec<DownloadStatus>,
    completed: Vec<DownloadStatus>,  // last 10
}
```

### cancel_download

```rust
fn cancel_download(
    state: State<'_, AppState>,
    download_id: u64,
) -> Result<(), String>
```

Removes a pending item from the queue by ID. Cannot cancel an active download (it completes or errors).

## Events

| Event | Payload | When |
|-------|---------|------|
| `download-progress` | `DownloadStatus` | Status change or progress update during download |
| `download-complete` | `{ id, track_title, dest_path }` | Track fully downloaded, tagged, and moved |
| `download-error` | `{ id, track_title, error }` | Download failed |

## Download Pipeline Detail

### Step 1: Resolve stream URL

- **TIDAL**: `TidalClient::get_stream_url(remote_track_id, quality)` where quality is derived from `DownloadFormat`
- **Subsonic**: Requires modifying `SubsonicClient::stream_url()` (currently takes only `track_id`) to accept optional `format` and `max_bit_rate` parameters. The Subsonic `stream.view` endpoint supports `format=raw` (original file), `format=mp3`, etc. and `maxBitRate` for server-side transcoding. Note: transcoding support depends on the server's configuration and installed codecs.

### Step 2: Download to temp file

- HTTP GET the stream URL using `reqwest::blocking::Client`
- Write to a temp file in the destination folder (e.g., `.viboplr-download-{id}.tmp`)
- Track bytes received for progress percentage (use Content-Length header if available)
- Emit `download-progress` events every ~100KB or 500ms

### Step 3: Write metadata tags

This introduces tag **writing** with lofty — the codebase currently only reads tags. The lofty 0.22 API supports writing:

- Open the temp file with `lofty::Probe::open().read()` to get a `TaggedFile`
- Get or create the primary tag via `tagged_file.tag_mut(TagType::VorbisComments)` (FLAC), `TagType::Id3v2` (MP3), or `TagType::Mp4Ilst` (M4A). If the downloaded file has no existing tags (common for TIDAL streams), use `tagged_file.insert_tag(Tag::new(tag_type))` first.
- Set fields: `tag.set_title()`, `tag.set_artist()`, `tag.set_album()`, `tag.set_track()`, `tag.set_genre()`, `tag.set_year()`
- Save via `tagged_file.save()`

### Step 4: Embed cover art

- If `cover_url` is set, HTTP GET the image
- For TIDAL: use existing `TidalClient::cover_url(cover_id, 1280)` helper (handles dash-to-slash conversion in cover ID)
- For Subsonic: fetch `{base_url}/rest/getCoverArt.view?id={album_id}&{auth_params}`
- Create a `lofty::Picture` via `Picture::new(PictureType::CoverFront, MimeType::Jpeg, image_bytes)`
- Add to the tag via `tag.push_picture(picture)` and save
- Also save as `cover.jpg` in the album directory for the existing image provider

### Step 5: Move to final path

- Sanitize artist/album/title for filesystem (replace `/`, `\`, `:`, etc.)
- Create directory structure: `{dest_collection_path}/{Artist}/{Album}/`
- Rename temp file to: `{TrackNum} - {Title}.{ext}` (e.g., `01 - Song Name.flac`)
- If track number is missing, use just `{Title}.{ext}`

### Step 6: Register in library

- Call `scanner::process_media_file(db, &final_path, Some(dest_collection_id))` directly (signature: `&Arc<Database>, &Path, Option<i64>`). Note: this function checks `modified_at` timestamps and skips unchanged files — newly created files will always be imported.
- This reads the tags we just wrote and creates the track in the database
- No full rescan needed
- For single-track downloads: rebuild FTS (`db.rebuild_fts()`) and recompute counts (`db.recompute_counts()`) immediately
- For album downloads: batch FTS rebuild and recompute counts once after all tracks complete

## Frontend Changes

### Context Menu (ContextMenu.tsx)

Add "Download to Library" option for tracks with `subsonic_id` (remote tracks):
- If one local collection: single menu item "Download to {collection_name}"
- If multiple local collections: submenu with each local collection as an option
- Each option includes a format picker (FLAC / AAC / MP3) or uses the default from settings

### TIDAL View (TidalView.tsx)

Add "Download Album" button on album detail pages:
- Same destination picker logic as context menu
- Enqueues all album tracks at once

### Download Status Indicator (StatusBar.tsx)

When downloads are active:
- Show a download icon with badge count in the status bar
- Click to expand a popover showing:
  - Active download with progress bar
  - Queued items with cancel buttons
  - Last 5 completed downloads
- Listen to `download-progress`, `download-complete`, `download-error` events

### Settings (SettingsPanel.tsx)

Add a "Downloads" section:
- Default format: FLAC / AAC / MP3 (dropdown, persisted to store)

## File Organization

New files:
- `src-tauri/src/downloader.rs` — DownloadManager, DownloadRequest, download pipeline logic

Modified files:
- `src-tauri/src/lib.rs` — register new commands, spawn download worker thread, add DownloadManager to AppState
- `src-tauri/src/commands.rs` — new download_track, download_album, get_download_status, cancel_download commands
- `src-tauri/src/models.rs` — DownloadFormat, DownloadRequest, DownloadStatus, DownloadQueueInfo structs
- `src-tauri/src/subsonic.rs` — add format/bitrate params to stream_url()
- `src/components/ContextMenu.tsx` — add "Download to Library" option
- `src/components/TidalView.tsx` — add "Download Album" button
- `src/components/StatusBar.tsx` — add download status indicator + popover
- `src/components/SettingsPanel.tsx` — add default download format setting
- `src/store.ts` — add `downloadFormat: "flac"` default
- `src/App.tsx` — wire up download event listeners, pass download state to components

## Edge Cases

- **Duplicate downloads**: Check if a file already exists at the target path before downloading. Skip with a log message.
- **Incomplete downloads**: Temp files (.viboplr-download-*.tmp) are cleaned up on error. On app startup, clean any stale temp files.
- **Disabled source collection**: If the source TIDAL/Subsonic collection is disabled, still allow downloads (credentials are still stored).
- **Missing metadata**: If artist/album is unknown, use "Unknown Artist" / "Unknown Album" for folder names.
- **Network errors**: Log the error, emit download-error event, clean up temp file, move to next item in queue. No automatic retry.
- **Disk space**: If a write fails mid-download (e.g., disk full), clean up the temp file and emit download-error. No pre-flight disk space check (handle write errors gracefully instead).
- **Subsonic transcoding**: Server-side format transcoding depends on server configuration. If the server doesn't support the requested format, it may return the original format — detect via Content-Type header and adjust file extension accordingly.
