# Download Manager Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable downloading tracks from TIDAL and Subsonic sources to local folder collections with embedded metadata tags, cover art, and configurable audio format.

**Architecture:** A Rust-side `DownloadManager` running on a background thread processes a FIFO queue of download requests. Each download: resolves stream URL -> downloads to temp file -> writes metadata tags via lofty -> embeds cover art -> moves to `Artist/Album/` organized path -> registers in library via `scanner::process_media_file()`. Frontend adds context menu download options, a TIDAL album download button, a status bar download indicator, and a format setting.

**Tech Stack:** Rust (reqwest, lofty 0.22, serde), TypeScript/React, Tauri 2 IPC + events

**Spec:** `docs/superpowers/specs/2026-03-23-download-manager-design.md`

---

## File Structure

### New files
- `src-tauri/src/downloader.rs` — `DownloadManager` struct, `DownloadRequest`, `DownloadStatus`, `DownloadFormat`, the download pipeline (`process_download`), filesystem helpers (`sanitize_filename`, `build_dest_path`), tag writing, cover art embedding

### Modified files
- `src-tauri/src/lib.rs` — register new commands, spawn download worker thread, add `DownloadManager` to `AppState`
- `src-tauri/src/commands.rs` — add `download_track`, `download_album`, `get_download_status`, `cancel_download` commands; add `DownloadManager` to `AppState`
- `src-tauri/src/subsonic.rs` — extend `stream_url()` to accept optional format/bitrate params
- `src/components/ContextMenu.tsx` — add "Download to Library" menu item for remote tracks
- `src/components/TidalView.tsx` — add "Download Album" button on album detail view
- `src/components/StatusBar.tsx` — add download status indicator with progress popover
- `src/components/SettingsPanel.tsx` — add default download format dropdown
- `src/store.ts` — add `downloadFormat` default
- `src/App.tsx` — wire download event listeners, pass download state/handlers to components, add collections list for destination picker
- `src/App.css` — styles for download indicator, popover, context menu items

---

## Task 1: Data Structures & DownloadManager Core (Rust)

**Files:**
- Create: `src-tauri/src/downloader.rs`

- [ ] **Step 1: Create `downloader.rs` with types and `DownloadManager`**

```rust
// src-tauri/src/downloader.rs
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DownloadFormat {
    Flac,
    Aac,
    Mp3,
}

impl DownloadFormat {
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "flac" => Ok(Self::Flac),
            "aac" => Ok(Self::Aac),
            "mp3" => Ok(Self::Mp3),
            _ => Err(format!("Unknown format: {}", s)),
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            Self::Flac => "flac",
            Self::Aac => "m4a",
            Self::Mp3 => "mp3",
        }
    }

    pub fn tidal_quality(&self) -> &'static str {
        match self {
            Self::Flac => "LOSSLESS",
            Self::Aac | Self::Mp3 => "HIGH",
        }
    }

    pub fn subsonic_format_param(&self) -> Option<&'static str> {
        match self {
            Self::Flac => None, // raw/original
            Self::Aac => Some("aac"),
            Self::Mp3 => Some("mp3"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DownloadRequest {
    pub id: u64,
    pub track_title: String,
    pub artist_name: String,
    pub album_title: String,
    pub track_number: Option<u32>,
    pub genre: Option<String>,
    pub year: Option<i32>,
    pub cover_url: Option<String>,
    pub source_collection_id: i64,
    pub remote_track_id: String,
    pub dest_collection_id: i64,
    pub dest_collection_path: String,
    pub format: DownloadFormat,
    /// If true, this is the last track in a batch (album download). FTS rebuild happens after this one.
    pub is_batch_last: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadStatus {
    pub id: u64,
    pub track_title: String,
    pub artist_name: String,
    pub status: String,
    pub progress_pct: u8,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadQueueInfo {
    pub active: Option<DownloadStatus>,
    pub queued: Vec<DownloadStatus>,
    pub completed: Vec<DownloadStatus>,
}

pub struct DownloadManager {
    pub queue: Mutex<VecDeque<DownloadRequest>>,
    pub condvar: Condvar,
    pub active: Mutex<Option<DownloadStatus>>,
    pub next_id: AtomicU64,
    pub completed: Mutex<VecDeque<DownloadStatus>>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            condvar: Condvar::new(),
            active: Mutex::new(None),
            next_id: AtomicU64::new(1),
            completed: Mutex::new(VecDeque::new()),
        }
    }

    pub fn enqueue(&self, request: DownloadRequest) {
        let mut queue = self.queue.lock().unwrap();
        queue.push_back(request);
        self.condvar.notify_one();
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn cancel(&self, download_id: u64) -> bool {
        let mut queue = self.queue.lock().unwrap();
        let len_before = queue.len();
        queue.retain(|r| r.id != download_id);
        queue.len() < len_before
    }

    pub fn get_status(&self) -> DownloadQueueInfo {
        let active = self.active.lock().unwrap().clone();
        let queued: Vec<DownloadStatus> = self
            .queue
            .lock()
            .unwrap()
            .iter()
            .map(|r| DownloadStatus {
                id: r.id,
                track_title: r.track_title.clone(),
                artist_name: r.artist_name.clone(),
                status: "queued".to_string(),
                progress_pct: 0,
                error: None,
            })
            .collect();
        let completed: Vec<DownloadStatus> = self.completed.lock().unwrap().iter().cloned().collect();
        DownloadQueueInfo {
            active,
            queued,
            completed,
        }
    }

    pub fn set_active(&self, status: Option<DownloadStatus>) {
        *self.active.lock().unwrap() = status;
    }

    pub fn push_completed(&self, status: DownloadStatus) {
        let mut completed = self.completed.lock().unwrap();
        completed.push_back(status);
        while completed.len() > 10 {
            completed.pop_front();
        }
    }

    /// Wait for next request from the queue (blocks until available)
    pub fn wait_for_next(&self) -> DownloadRequest {
        let mut queue = self.queue.lock().unwrap();
        while queue.is_empty() {
            queue = self.condvar.wait(queue).unwrap();
        }
        queue.pop_front().unwrap()
    }
}
```

- [ ] **Step 2: Verify it compiles**

Add `mod downloader;` to `lib.rs` (after `mod tidal;` line 12) and run:
```bash
cd src-tauri && cargo check
```
Expected: compiles with warnings about unused code (OK for now).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/downloader.rs src-tauri/src/lib.rs
git commit -m "feat(download): add DownloadManager core data structures (#76)"
```

---

## Task 2: Download Pipeline (Rust)

**Files:**
- Modify: `src-tauri/src/downloader.rs`
- Modify: `src-tauri/src/subsonic.rs:260-262`

**Docs to check:**
- lofty 0.22 tag writing API: `TaggedFile`, `Tag`, `TagType`, `Accessor` trait (`set_title`, `set_artist`, etc.), `TagExt::save_to_path()`, `Picture::new()`

- [ ] **Step 1: Add `stream_url_with_format` to SubsonicClient**

In `src-tauri/src/subsonic.rs`, add a new method after the existing `stream_url` (line 262):

```rust
pub fn stream_url_with_format(&self, track_id: &str, format: Option<&str>) -> String {
    let mut url = format!("{}/rest/stream.view?id={}&{}", self.base_url, track_id, self.auth_params);
    if let Some(fmt) = format {
        url.push_str(&format!("&format={}", fmt));
    }
    url
}
```

- [ ] **Step 2: Add filesystem helpers to `downloader.rs`**

Append to `downloader.rs`:

```rust
use std::path::{Path, PathBuf};

/// Sanitize a string for use as a filename/directory name
pub fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let trimmed = sanitized.trim().trim_matches('.');
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Build the destination path: {dest_root}/{Artist}/{Album}/{TrackNum} - {Title}.{ext}
pub fn build_dest_path(request: &DownloadRequest) -> PathBuf {
    let artist_dir = sanitize_filename(&request.artist_name);
    let album_dir = sanitize_filename(&request.album_title);
    let filename = match request.track_number {
        Some(num) => format!(
            "{:02} - {}.{}",
            num,
            sanitize_filename(&request.track_title),
            request.format.extension()
        ),
        None => format!(
            "{}.{}",
            sanitize_filename(&request.track_title),
            request.format.extension()
        ),
    };
    Path::new(&request.dest_collection_path)
        .join(artist_dir)
        .join(album_dir)
        .join(filename)
}
```

- [ ] **Step 3: Add the download pipeline function**

Append to `downloader.rs`:

```rust
use std::io::Write;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use crate::db::Database;
use crate::scanner;
use crate::subsonic::SubsonicClient;
use crate::tidal::TidalClient;

/// Run a single download: fetch stream -> write to file -> tag -> move -> register
pub fn process_download(
    request: &DownloadRequest,
    db: &Arc<Database>,
    app: &AppHandle,
    manager: &Arc<DownloadManager>,
) -> Result<PathBuf, String> {
    let dest_path = build_dest_path(request);

    // Check for duplicates
    if dest_path.exists() {
        return Err(format!("File already exists: {}", dest_path.display()));
    }

    // Create parent directories
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    // Step 1: Resolve stream URL
    let collection = db
        .get_collection_by_id(request.source_collection_id)
        .map_err(|e| e.to_string())?;

    let stream_url = match collection.kind.as_str() {
        "tidal" => {
            let base_url = collection.url.as_deref().ok_or("TIDAL collection has no URL")?;
            let client = TidalClient::new(base_url);
            client
                .get_stream_url(&request.remote_track_id, request.format.tidal_quality())
                .map_err(|e| e.to_string())?
        }
        "subsonic" => {
            let creds = db
                .get_collection_credentials(request.source_collection_id)
                .map_err(|e| e.to_string())?;
            let client = SubsonicClient::from_stored(
                &creds.url,
                &creds.username,
                &creds.password_token,
                creds.salt.as_deref(),
                &creds.auth_method,
            );
            client.stream_url_with_format(
                &request.remote_track_id,
                request.format.subsonic_format_param(),
            )
        }
        _ => return Err(format!("Unsupported collection kind: {}", collection.kind)),
    };

    // Step 2: Download to temp file
    let temp_path = dest_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!(".viboplr-download-{}.tmp", request.id));

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .get(&stream_url)
        .send()
        .map_err(|e| format!("Download failed: {}", e))?;

    let total_bytes = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    let mut file =
        std::fs::File::create(&temp_path).map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut reader = std::io::BufReader::new(resp);
    let mut buf = [0u8; 8192];
    loop {
        use std::io::Read;
        let n = reader.read(&mut buf).map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Read error: {}", e)
        })?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Write error: {}", e)
        })?;
        downloaded += n as u64;

        // Emit progress every 500ms
        if last_emit.elapsed() >= std::time::Duration::from_millis(500) {
            let pct = if total_bytes > 0 {
                ((downloaded as f64 / total_bytes as f64) * 100.0) as u8
            } else {
                0
            };
            let status = DownloadStatus {
                id: request.id,
                track_title: request.track_title.clone(),
                artist_name: request.artist_name.clone(),
                status: "downloading".to_string(),
                progress_pct: pct,
                error: None,
            };
            manager.set_active(Some(status.clone()));
            let _ = app.emit("download-progress", &status);
            last_emit = std::time::Instant::now();
        }
    }
    file.flush().map_err(|e| format!("Flush error: {}", e))?;
    drop(file);

    // Step 3 & 4: Write tags + cover art
    let tag_status = DownloadStatus {
        id: request.id,
        track_title: request.track_title.clone(),
        artist_name: request.artist_name.clone(),
        status: "writing_tags".to_string(),
        progress_pct: 100,
        error: None,
    };
    manager.set_active(Some(tag_status.clone()));
    let _ = app.emit("download-progress", &tag_status);

    if let Err(e) = write_tags(&temp_path, request, &client) {
        log::warn!("Failed to write tags: {}", e);
        // Non-fatal: continue even if tagging fails
    }

    // Step 5: Move to final path
    std::fs::rename(&temp_path, &dest_path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to move file: {}", e)
    })?;

    // Step 6: Register in library
    scanner::process_media_file(db, &dest_path, Some(request.dest_collection_id));

    if request.is_batch_last {
        let _ = db.rebuild_fts();
        let _ = db.recompute_counts();
    }

    Ok(dest_path)
}

fn write_tags(
    path: &Path,
    request: &DownloadRequest,
    http_client: &reqwest::blocking::Client,
) -> Result<(), String> {
    use lofty::prelude::*;
    use lofty::probe::Probe;
    use lofty::picture::{Picture, PictureType, MimeType};

    let mut tagged_file = Probe::open(path)
        .map_err(|e| format!("Probe open: {}", e))?
        .read()
        .map_err(|e| format!("Probe read: {}", e))?;

    let tag_type = tagged_file.primary_tag_type();
    let tag = match tagged_file.tag_mut(tag_type) {
        Some(t) => t,
        None => {
            tagged_file.insert_tag(lofty::tag::Tag::new(tag_type));
            tagged_file.tag_mut(tag_type).unwrap()
        }
    };

    tag.set_title(request.track_title.clone());
    tag.set_artist(request.artist_name.clone());
    tag.set_album(request.album_title.clone());
    if let Some(num) = request.track_number {
        tag.set_track(num);
    }
    if let Some(genre) = &request.genre {
        tag.set_genre(genre.clone());
    }
    if let Some(year) = request.year {
        tag.set_year(year as u32);
    }

    // Embed cover art
    if let Some(cover_url) = &request.cover_url {
        match http_client.get(cover_url).send() {
            Ok(resp) => {
                if let Ok(bytes) = resp.bytes() {
                    let mime = if cover_url.contains(".png") {
                        MimeType::Png
                    } else {
                        MimeType::Jpeg
                    };
                    let picture = Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, bytes.to_vec());
                    tag.push_picture(picture);

                    // Also save as cover.jpg alongside the file
                    if let Some(parent) = path.parent() {
                        let cover_path = parent.join("cover.jpg");
                        if !cover_path.exists() {
                            let _ = std::fs::write(&cover_path, &bytes);
                        }
                    }
                }
            }
            Err(e) => log::warn!("Failed to fetch cover art: {}", e),
        }
    }

    use lofty::config::WriteOptions;
    tagged_file
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("Save tags: {}", e))?;

    Ok(())
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/downloader.rs src-tauri/src/subsonic.rs
git commit -m "feat(download): add download pipeline with tag writing and cover art (#76)"
```

---

## Task 3: Tauri Commands & Worker Thread (Rust)

**Files:**
- Modify: `src-tauri/src/commands.rs:34-40` (AppState)
- Modify: `src-tauri/src/lib.rs:15,230-233,256-338,420-427` (setup, worker spawn, state)

- [ ] **Step 1: Add `DownloadManager` to `AppState` in `commands.rs`**

In `commands.rs`, add the import at the top (after line 10):
```rust
use crate::downloader::{DownloadManager, DownloadFormat, DownloadRequest, DownloadStatus};
```

Update `AppState` struct (lines 34-40) to add the download manager:
```rust
pub struct AppState {
    pub db: Arc<Database>,
    pub app_dir: std::path::PathBuf,
    pub download_queue: Arc<DownloadQueue>,
    pub track_download_manager: Arc<DownloadManager>,
    pub lastfm: LastfmClient,
    pub lastfm_session: Mutex<Option<(String, String)>>,
}
```

- [ ] **Step 2: Add download commands in `commands.rs`**

Append these commands at the end of `commands.rs` (before the closing of the file):

```rust
// --- Download commands ---

#[tauri::command]
pub fn download_track(
    state: State<'_, AppState>,
    source_collection_id: i64,
    remote_track_id: String,
    dest_collection_id: i64,
    format: String,
) -> Result<u64, String> {
    let fmt = DownloadFormat::from_str(&format)?;

    // Look up track metadata from DB
    let tracks = state.db.get_tracks_by_subsonic_id(&remote_track_id, source_collection_id)
        .map_err(|e| e.to_string())?;
    let track = tracks.first().ok_or("Track not found in database")?;

    // Look up destination collection path
    let dest_collection = state.db.get_collection_by_id(dest_collection_id).map_err(|e| e.to_string())?;
    let dest_path = dest_collection.path.ok_or("Destination collection has no path")?;

    // Resolve cover URL
    let cover_url = resolve_cover_url(&state.db, track, source_collection_id);

    let id = state.track_download_manager.next_id();
    let request = DownloadRequest {
        id,
        track_title: track.title.clone(),
        artist_name: track.artist_name.clone().unwrap_or_else(|| "Unknown Artist".to_string()),
        album_title: track.album_title.clone().unwrap_or_else(|| "Unknown Album".to_string()),
        track_number: track.track_number.map(|n| n as u32),
        genre: None, // tags not stored on Track struct directly
        year: track.year,
        cover_url,
        source_collection_id,
        remote_track_id,
        dest_collection_id,
        dest_collection_path: dest_path,
        format: fmt,
        is_batch_last: true, // single track = always rebuild FTS
    };

    state.track_download_manager.enqueue(request);
    Ok(id)
}

#[tauri::command]
pub fn download_album(
    state: State<'_, AppState>,
    source_collection_id: i64,
    album_id: String,
    dest_collection_id: i64,
    format: String,
) -> Result<Vec<u64>, String> {
    let fmt = DownloadFormat::from_str(&format)?;

    let collection = state.db.get_collection_by_id(source_collection_id).map_err(|e| e.to_string())?;
    let dest_collection = state.db.get_collection_by_id(dest_collection_id).map_err(|e| e.to_string())?;
    let dest_path = dest_collection.path.ok_or("Destination collection has no path")?;

    // Fetch album tracks from remote API
    let tracks_info = match collection.kind.as_str() {
        "tidal" => {
            let base_url = collection.url.as_deref().ok_or("TIDAL collection has no URL")?;
            let client = TidalClient::new(base_url);
            let album = client.get_album(&album_id).map_err(|e| e.to_string())?;
            let cover_url = album.cover_id.as_deref().map(|id| TidalClient::cover_url(id, 1280));
            album.tracks.into_iter().map(|t| {
                (t.id, t.title, t.artist_name.unwrap_or_default(), album.title.clone(),
                 t.track_number.map(|n| n as u32), album.year, cover_url.clone())
            }).collect::<Vec<_>>()
        }
        _ => return Err("Album download currently only supported for TIDAL".to_string()),
    };

    let count = tracks_info.len();
    let mut ids = Vec::with_capacity(count);

    for (i, (remote_id, title, artist, album_title, track_num, year, cover_url)) in tracks_info.into_iter().enumerate() {
        let id = state.track_download_manager.next_id();
        let request = DownloadRequest {
            id,
            track_title: title,
            artist_name: artist,
            album_title,
            track_number: track_num,
            genre: None,
            year,
            cover_url,
            source_collection_id,
            remote_track_id: remote_id,
            dest_collection_id,
            dest_collection_path: dest_path.clone(),
            format: fmt,
            is_batch_last: i == count - 1,
        };
        state.track_download_manager.enqueue(request);
        ids.push(id);
    }

    Ok(ids)
}

#[tauri::command]
pub fn get_download_status(state: State<'_, AppState>) -> Result<crate::downloader::DownloadQueueInfo, String> {
    Ok(state.track_download_manager.get_status())
}

#[tauri::command]
pub fn cancel_download(state: State<'_, AppState>, download_id: u64) -> Result<bool, String> {
    Ok(state.track_download_manager.cancel(download_id))
}

fn resolve_cover_url(db: &Arc<Database>, track: &Track, collection_id: i64) -> Option<String> {
    // For TIDAL tracks, try to find cover_id from the track path pattern tidal://{coll_id}/{tidal_id}
    // The cover_id isn't stored in the tracks table, so we look it up from the album
    // For now, return None — the download pipeline will still work without embedded art
    // TODO: store cover_id in a metadata field or look up via TIDAL API
    let _ = (db, track, collection_id);
    None
}
```

- [ ] **Step 3: Add `get_tracks_by_subsonic_id` to `db.rs`**

This helper is needed by the `download_track` command. Find the DB methods section and add:

```rust
pub fn get_tracks_by_subsonic_id(&self, subsonic_id: &str, collection_id: i64) -> SqlResult<Vec<Track>> {
    let conn = self.conn.lock().unwrap();
    let mut stmt = conn.prepare(&format!(
        "{} WHERE t.subsonic_id = ?1 AND t.collection_id = ?2",
        TRACK_SELECT
    ))?;
    let tracks = stmt
        .query_map(params![subsonic_id, collection_id], |row| track_from_row(row))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tracks)
}
```

- [ ] **Step 4: Spawn download worker thread in `lib.rs`**

In `lib.rs`, update imports (line 15):
```rust
use commands::{AppState, DownloadQueue, ImageDownloadRequest};
use crate::downloader::DownloadManager;
```

After the image worker spawn block (after line 338), add the download worker:

```rust
// Spawn the track download worker thread
let dl_manager = Arc::new(DownloadManager::new());
let dl_worker_manager = dl_manager.clone();
let dl_worker_db = db.clone();
let dl_app_handle = app.handle().clone();
timer.time("spawn_download_worker", || { std::thread::spawn(move || {
    loop {
        let request = dl_worker_manager.wait_for_next();
        let status = crate::downloader::DownloadStatus {
            id: request.id,
            track_title: request.track_title.clone(),
            artist_name: request.artist_name.clone(),
            status: "downloading".to_string(),
            progress_pct: 0,
            error: None,
        };
        dl_worker_manager.set_active(Some(status.clone()));
        let _ = dl_app_handle.emit("download-progress", &status);

        match crate::downloader::process_download(&request, &dl_worker_db, &dl_app_handle, &dl_worker_manager) {
            Ok(dest_path) => {
                let complete = crate::downloader::DownloadStatus {
                    id: request.id,
                    track_title: request.track_title.clone(),
                    artist_name: request.artist_name.clone(),
                    status: "complete".to_string(),
                    progress_pct: 100,
                    error: None,
                };
                dl_worker_manager.set_active(None);
                dl_worker_manager.push_completed(complete.clone());
                let _ = dl_app_handle.emit("download-complete", serde_json::json!({
                    "id": request.id,
                    "trackTitle": request.track_title,
                    "destPath": dest_path.to_string_lossy(),
                }));

                // Emit scan-complete so frontend refreshes library
                let _ = dl_app_handle.emit("scan-complete", serde_json::json!({
                    "folder": request.dest_collection_path,
                }));
            }
            Err(e) => {
                log::error!("Download failed for {}: {}", request.track_title, e);
                let error_status = crate::downloader::DownloadStatus {
                    id: request.id,
                    track_title: request.track_title.clone(),
                    artist_name: request.artist_name.clone(),
                    status: "error".to_string(),
                    progress_pct: 0,
                    error: Some(e.clone()),
                };
                dl_worker_manager.set_active(None);
                dl_worker_manager.push_completed(error_status);
                let _ = dl_app_handle.emit("download-error", serde_json::json!({
                    "id": request.id,
                    "trackTitle": request.track_title,
                    "error": e,
                }));
            }
        }
    }
}); });
```

Update the `AppState` in `manage_app_state` (around line 420-427) to include the download manager:

```rust
timer.time("manage_app_state", || {
    app.manage(AppState {
        db,
        app_dir,
        download_queue,
        track_download_manager: dl_manager,
        lastfm: crate::lastfm::LastfmClient::new(crate::commands::LASTFM_API_KEY, crate::commands::LASTFM_API_SECRET),
        lastfm_session: Mutex::new(None),
    });
});
```

- [ ] **Step 5: Register new commands in both `get_invoke_handler` functions**

In `lib.rs`, add these 4 commands to BOTH the debug and release handler lists (after the lastfm commands):

```rust
commands::download_track,
commands::download_album,
commands::get_download_status,
commands::cancel_download,
```

- [ ] **Step 6: Verify it compiles**

```bash
cd src-tauri && cargo check
```

Fix any compilation errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/db.rs src-tauri/src/downloader.rs
git commit -m "feat(download): add download commands and worker thread (#76)"
```

---

## Task 4: Context Menu "Download to Library" (Frontend)

**Files:**
- Modify: `src/components/ContextMenu.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [ ] **Step 1: Add download handler prop to ContextMenu**

In `src/components/ContextMenu.tsx`, add to `ContextMenuProps` interface (after `onDelete`):
```typescript
onDownload?: (destCollectionId: number) => void;
localCollections?: { id: number; name: string }[];
```

Add the import for an icon (use existing IconFolder or add a simple download arrow). Use IconFolder for now.

In the component destructuring, add `onDownload, localCollections`.

- [ ] **Step 2: Add "Download to Library" menu item**

In the context menu JSX (after the YouTube item, around line 138), add:

```tsx
{target.kind === "track" && target.subsonic && onDownload && localCollections && localCollections.length > 0 && (
  <>
    <div className="context-menu-separator" />
    {localCollections.length === 1 ? (
      <div className="context-menu-item" onClick={() => { onDownload(localCollections[0].id); onClose(); }}>
        <IconFolder size={14} /><span>Download to {localCollections[0].name}</span>
      </div>
    ) : (
      <div className="context-menu-submenu">
        <div className="context-menu-item">
          <IconFolder size={14} /><span>Download to...</span>
        </div>
        <div className="context-menu-submenu-list">
          {localCollections.map(c => (
            <div key={c.id} className="context-menu-item" onClick={() => { onDownload(c.id); onClose(); }}>
              <span>{c.name}</span>
            </div>
          ))}
        </div>
      </div>
    )}
  </>
)}
```

- [ ] **Step 3: Wire up in App.tsx**

In `App.tsx`, add state and handler for track downloads. Find where `handleContextMenuAction` / context menu actions are defined and add:

```typescript
// Compute local collections list for download destination
const localCollections = collections.filter(c => c.kind === "local" && c.enabled).map(c => ({ id: c.id, name: c.name }));
```

Add the download handler:
```typescript
async function handleDownloadTrack(trackId: number, destCollectionId: number) {
  const downloadFormat = await store.get<string>("downloadFormat") ?? "flac";
  const track = tracks.find(t => t.id === trackId);
  if (!track?.subsonic_id) return;
  try {
    await invoke("download_track", {
      sourceCollectionId: track.collection_id,
      remoteTrackId: track.subsonic_id,
      destCollectionId,
      format: downloadFormat,
    });
    addLog(`Downloading: ${track.title}`);
  } catch (e) {
    addLog(`Download failed: ${e}`);
  }
}
```

Pass `onDownload` and `localCollections` to the `ContextMenu` component:
```tsx
onDownload={contextMenu?.target.kind === "track" ? (destId) => handleDownloadTrack(contextMenu.target.trackId, destId) : undefined}
localCollections={localCollections}
```

- [ ] **Step 4: Add submenu CSS to App.css**

```css
/* Download submenu */
.context-menu-submenu {
  position: relative;
}

.context-menu-submenu-list {
  display: none;
  position: absolute;
  left: 100%;
  top: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  min-width: 160px;
  padding: 4px 0;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 10001;
}

.context-menu-submenu:hover .context-menu-submenu-list {
  display: block;
}
```

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/components/ContextMenu.tsx src/App.tsx src/App.css
git commit -m "feat(download): add 'Download to Library' context menu option (#76)"
```

---

## Task 5: TIDAL Album Download Button (Frontend)

**Files:**
- Modify: `src/components/TidalView.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add download props to TidalView**

In `TidalView.tsx`, the main `TidalView` component needs a new prop for album download. Find the component props and add:

```typescript
onDownloadAlbum?: (albumId: string, sourceCollectionId: number) => void;
```

Pass it through to `AlbumDetailView`:
```typescript
onDownloadAlbum?: (albumId: string) => void;
```

- [ ] **Step 2: Add "Download Album" button in AlbumDetailView**

In `AlbumDetailView` (around line 374-380), after the "Play Album" button, add:

```tsx
{onDownloadAlbum && (
  <button
    className="tidal-btn tidal-btn-play-all"
    onClick={() => onDownloadAlbum(album.tidal_id)}
    style={{ marginLeft: 8 }}
  >
    {"\u2B07"} Download Album
  </button>
)}
```

- [ ] **Step 3: Wire up album download in App.tsx**

Add the handler in App.tsx where TIDAL handlers are defined:

```typescript
async function handleDownloadAlbum(albumId: string, sourceCollectionId: number) {
  const downloadFormat = await store.get<string>("downloadFormat") ?? "flac";
  if (localCollections.length === 0) {
    addLog("No local collections available for download");
    return;
  }
  // Use first local collection as destination (or could prompt)
  const destId = localCollections[0].id;
  try {
    const ids = await invoke<number[]>("download_album", {
      sourceCollectionId,
      albumId,
      destCollectionId: destId,
      format: downloadFormat,
    });
    addLog(`Queued ${ids.length} tracks for download`);
  } catch (e) {
    addLog(`Album download failed: ${e}`);
  }
}
```

Pass to `TidalView`:
```tsx
onDownloadAlbum={(albumId) => handleDownloadAlbum(albumId, tidalCollectionId)}
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/components/TidalView.tsx src/App.tsx
git commit -m "feat(download): add 'Download Album' button to TIDAL view (#76)"
```

---

## Task 6: Download Status Indicator (Frontend)

**Files:**
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [ ] **Step 1: Add download state to StatusBar props**

In `StatusBar.tsx`, update the interface:

```typescript
interface StatusBarProps {
  sessionLog: { time: Date; message: string }[];
  activity?: string | null;
  feedback?: {
    message: string;
    onYes: () => void;
    onNo: () => void;
  } | null;
  downloadStatus?: {
    active: { id: number; track_title: string; artist_name: string; progress_pct: number } | null;
    queued: { id: number; track_title: string; artist_name: string }[];
    completed: { id: number; track_title: string; status: string; error?: string }[];
  } | null;
  onCancelDownload?: (id: number) => void;
}
```

- [ ] **Step 2: Add download indicator UI**

In the `StatusBar` component, add a download section before the existing content area. Add a new state for showing the download popover:

```typescript
const [showDownloads, setShowDownloads] = useState(false);
const hasDownloads = downloadStatus && (downloadStatus.active || downloadStatus.queued.length > 0 || downloadStatus.completed.length > 0);
```

Add the download indicator in the JSX (before the main `status-bar-content` div):

```tsx
{hasDownloads && (
  <div className="status-bar-downloads">
    <button
      className="status-bar-download-btn"
      onClick={(e) => { e.stopPropagation(); setShowDownloads(!showDownloads); }}
    >
      {"\u2B07"}{" "}
      {downloadStatus.active ? `${downloadStatus.active.progress_pct}%` : ""}
      {downloadStatus.queued.length > 0 && ` +${downloadStatus.queued.length}`}
    </button>
    {showDownloads && (
      <div className="status-bar-download-popover">
        {downloadStatus.active && (
          <div className="download-item download-item-active">
            <div className="download-item-info">
              <span className="download-item-title">{downloadStatus.active.track_title}</span>
              <span className="download-item-artist">{downloadStatus.active.artist_name}</span>
            </div>
            <div className="download-progress-bar">
              <div className="download-progress-fill" style={{ width: `${downloadStatus.active.progress_pct}%` }} />
            </div>
          </div>
        )}
        {downloadStatus.queued.map(q => (
          <div key={q.id} className="download-item">
            <div className="download-item-info">
              <span className="download-item-title">{q.track_title}</span>
              <span className="download-item-artist">{q.artist_name}</span>
            </div>
            {onCancelDownload && (
              <button className="download-cancel-btn" onClick={() => onCancelDownload(q.id)}>X</button>
            )}
          </div>
        ))}
        {downloadStatus.completed.slice(-5).map(c => (
          <div key={c.id} className={`download-item download-item-${c.status}`}>
            <span className="download-item-title">{c.track_title}</span>
            <span className="download-item-status">{c.status === "complete" ? "\u2713" : "\u2717"}</span>
          </div>
        ))}
      </div>
    )}
  </div>
)}
```

- [ ] **Step 3: Wire up download events in App.tsx**

In `App.tsx`, add download status state and event listeners:

```typescript
const [downloadStatus, setDownloadStatus] = useState<{
  active: { id: number; track_title: string; artist_name: string; progress_pct: number } | null;
  queued: { id: number; track_title: string; artist_name: string }[];
  completed: { id: number; track_title: string; status: string; error?: string }[];
} | null>(null);
```

In the event listener setup (where `scan-progress`, `scan-complete`, etc. are listened to), add:

```typescript
const unlistenDownloadProgress = await listen<any>("download-progress", (event) => {
  // Refresh full status from backend
  invoke<any>("get_download_status").then(setDownloadStatus);
});

const unlistenDownloadComplete = await listen<any>("download-complete", (event) => {
  addLog(`Downloaded: ${event.payload.trackTitle}`);
  invoke<any>("get_download_status").then(setDownloadStatus);
});

const unlistenDownloadError = await listen<any>("download-error", (event) => {
  addLog(`Download error: ${event.payload.trackTitle} - ${event.payload.error}`);
  invoke<any>("get_download_status").then(setDownloadStatus);
});
```

Add cleanup in the return:
```typescript
unlistenDownloadProgress();
unlistenDownloadComplete();
unlistenDownloadError();
```

Pass to `StatusBar`:
```tsx
downloadStatus={downloadStatus}
onCancelDownload={async (id) => { await invoke("cancel_download", { downloadId: id }); invoke<any>("get_download_status").then(setDownloadStatus); }}
```

- [ ] **Step 4: Add download popover CSS to App.css**

```css
/* Download status indicator */
.status-bar-downloads {
  position: relative;
  margin-right: 12px;
}

.status-bar-download-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}

.status-bar-download-btn:hover {
  background: var(--bg-surface);
}

.status-bar-download-popover {
  position: absolute;
  bottom: 100%;
  right: 0;
  width: 300px;
  max-height: 400px;
  overflow-y: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  z-index: 10001;
  margin-bottom: 4px;
}

.download-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.download-item-active {
  background: var(--bg-surface);
}

.download-item-info {
  flex: 1;
  min-width: 0;
}

.download-item-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.download-item-artist {
  display: block;
  color: var(--text-secondary);
  font-size: 11px;
}

.download-progress-bar {
  height: 3px;
  background: var(--border);
  border-radius: 2px;
  margin-top: 4px;
  overflow: hidden;
}

.download-progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.3s;
}

.download-cancel-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
}

.download-cancel-btn:hover {
  color: var(--text-primary);
}

.download-item-complete .download-item-status {
  color: var(--accent);
}

.download-item-error .download-item-status {
  color: #ef4444;
}
```

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/components/StatusBar.tsx src/App.tsx src/App.css
git commit -m "feat(download): add download status indicator with progress popover (#76)"
```

---

## Task 7: Download Format Setting (Frontend)

**Files:**
- Modify: `src/store.ts`
- Modify: `src/components/SettingsPanel.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `downloadFormat` to store defaults**

In `src/store.ts`, add after `sidebarCollapsed: false,` (line 38):
```typescript
downloadFormat: "flac",
```

- [ ] **Step 2: Add format dropdown to SettingsPanel**

In `SettingsPanel.tsx`, add to the props interface:
```typescript
downloadFormat: string;
onDownloadFormatChange: (format: string) => void;
```

In the JSX, add a new "Downloads" section (after the existing sections, before the closing):

```tsx
<div className="settings-section">
  <h3>Downloads</h3>
  <div className="settings-row">
    <label>Default format</label>
    <select value={downloadFormat} onChange={(e) => onDownloadFormatChange(e.target.value)}>
      <option value="flac">FLAC (Lossless)</option>
      <option value="aac">AAC</option>
      <option value="mp3">MP3</option>
    </select>
  </div>
</div>
```

- [ ] **Step 3: Wire up in App.tsx**

Add state for download format and restore/save logic. In the restore block, add:
```typescript
store.get<string>("downloadFormat"),
```

Add the state:
```typescript
const [downloadFormat, setDownloadFormat] = useState("flac");
```

Add the change handler:
```typescript
function handleDownloadFormatChange(format: string) {
  setDownloadFormat(format);
  store.set("downloadFormat", format);
}
```

Pass to `SettingsPanel`:
```tsx
downloadFormat={downloadFormat}
onDownloadFormatChange={handleDownloadFormatChange}
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/components/SettingsPanel.tsx src/App.tsx
git commit -m "feat(download): add download format setting (#76)"
```

---

## Task 8: Build Verification & Final Check

**Files:** None (verification only)

- [ ] **Step 1: Run Rust checks**

```bash
cd src-tauri && cargo check
cd src-tauri && cargo check --release
```

- [ ] **Step 2: Run TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Run all tests**

```bash
npm run test:all
```

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(download): address build issues (#76)"
```
