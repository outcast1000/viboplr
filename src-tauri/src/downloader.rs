use serde::Serialize;
use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{AppHandle, Emitter};

use crate::db::Database;
use crate::scanner;
use crate::subsonic::SubsonicClient;
use crate::tidal;

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
#[allow(dead_code)]
pub struct DownloadRequest {
    pub id: u64,
    pub track_title: String,
    pub artist_name: String,
    pub album_title: String,
    pub track_number: Option<u32>,
    pub genre: Option<String>,
    pub year: Option<i32>,
    pub cover_url: Option<String>,
    pub source_kind: String,                  // "tidal" or "subsonic"
    pub source_collection_id: Option<i64>,    // needed for subsonic credentials
    pub source_override_url: Option<String>,  // MusicGateAway URL (tidal) or collection URL (subsonic)
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
        let completed: Vec<DownloadStatus> =
            self.completed.lock().unwrap().iter().cloned().collect();
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

// --- Filesystem helpers ---

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
/// If `ext_override` is provided, it is used instead of the request's format extension.
pub fn build_dest_path(request: &DownloadRequest, ext_override: Option<&str>) -> PathBuf {
    let ext = ext_override.unwrap_or_else(|| request.format.extension());
    let artist_dir = sanitize_filename(&request.artist_name);
    let album_dir = sanitize_filename(&request.album_title);
    let filename = match request.track_number {
        Some(num) => format!(
            "{:02} - {}.{}",
            num,
            sanitize_filename(&request.track_title),
            ext
        ),
        None => format!(
            "{}.{}",
            sanitize_filename(&request.track_title),
            ext
        ),
    };
    Path::new(&request.dest_collection_path)
        .join(artist_dir)
        .join(album_dir)
        .join(filename)
}

// --- Download pipeline ---

/// Run a single download: fetch stream -> write to file -> tag -> move -> register
pub fn process_download(
    request: &DownloadRequest,
    db: &Arc<Database>,
    app: &AppHandle,
    manager: &Arc<DownloadManager>,
) -> Result<PathBuf, String> {
    // Step 1: Resolve stream URL
    // For TIDAL, use the native TidalClient (direct download + tagging)
    if request.source_kind == "tidal" {
        let tidal_client = tidal::get_global_client()
            .ok_or("TIDAL client not available")?;

        // Get stream URL
        let stream_info = tidal_client
            .get_stream_url(&request.remote_track_id, request.format.tidal_quality())
            .map_err(|e| e.to_string())?;

        let actual_ext = stream_info.extension();
        let dest_path = build_dest_path(request, Some(actual_ext));

        if dest_path.exists() {
            return Err(format!("File already exists: {}", dest_path.display()));
        }

        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }

        // Download from CDN URL with progress
        let dest_ext = dest_path.extension().and_then(|e| e.to_str()).unwrap_or("tmp");
        let temp_path = dest_path
            .parent()
            .unwrap_or(Path::new("."))
            .join(format!(".viboplr-download-{}.{}", request.id, dest_ext));

        let http_client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        let resp = http_client
            .get(&stream_info.url)
            .send()
            .map_err(|e| format!("Download failed: {}", e))?;

        let total_bytes = resp.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut last_emit = std::time::Instant::now();

        let mut file = std::fs::File::create(&temp_path)
            .map_err(|e| format!("Failed to create temp file: {}", e))?;

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

        // Write tags + cover art
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

        if let Err(e) = write_tags(&temp_path, request, &http_client) {
            log::warn!("Failed to write tags: {}", e);
        }

        // Move to final path
        std::fs::rename(&temp_path, &dest_path).map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Failed to move file: {}", e)
        })?;

        // Register in library
        if request.dest_collection_id > 0 {
            scanner::process_media_file(db, &dest_path, Some(request.dest_collection_id), Some(&request.dest_collection_path));

            if request.is_batch_last {
                let _ = db.rebuild_fts();
                let _ = db.recompute_counts();
            }
        }

        return Ok(dest_path);
    }

    // Subsonic download path
    let (stream_url, actual_ext) = match request.source_kind.as_str() {
        "subsonic" => {
            let collection_id = request.source_collection_id
                .ok_or("Subsonic download requires source_collection_id")?;
            let creds = db
                .get_collection_credentials(collection_id)
                .map_err(|e| e.to_string())?;
            let client = SubsonicClient::from_stored(
                &creds.url,
                &creds.username,
                &creds.password_token,
                creds.salt.as_deref(),
                &creds.auth_method,
            );
            (client.stream_url_with_format(
                &request.remote_track_id,
                request.format.subsonic_format_param(),
            ), None::<String>)
        }
        _ => return Err(format!("Unsupported source kind: {}", request.source_kind)),
    };

    let dest_path = build_dest_path(request, actual_ext.as_deref());

    // Check for duplicates
    if dest_path.exists() {
        return Err(format!("File already exists: {}", dest_path.display()));
    }

    // Create parent directories
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    // Step 2: Download to temp file (preserve extension so lofty can detect format for tagging)
    let dest_ext = dest_path.extension().and_then(|e| e.to_str()).unwrap_or("tmp");
    let temp_path = dest_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!(".viboplr-download-{}.{}", request.id, dest_ext));

    let http_client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = http_client
        .get(&stream_url)
        .send()
        .map_err(|e| format!("Download failed: {}", e))?;

    let total_bytes = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    let mut file = std::fs::File::create(&temp_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

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

    if let Err(e) = write_tags(&temp_path, request, &http_client) {
        log::warn!("Failed to write tags: {}", e);
        // Non-fatal: continue even if tagging fails
    }

    // Step 5: Move to final path
    std::fs::rename(&temp_path, &dest_path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to move file: {}", e)
    })?;

    // Step 6: Register in library
    scanner::process_media_file(db, &dest_path, Some(request.dest_collection_id), Some(&request.dest_collection_path));

    if request.is_batch_last {
        let _ = db.rebuild_fts();
        let _ = db.recompute_counts();
    }

    Ok(dest_path)
}

pub fn write_tags(
    path: &Path,
    request: &DownloadRequest,
    http_client: &reqwest::blocking::Client,
) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::prelude::*;
    use lofty::probe::Probe;

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
                    let picture = Picture::new_unchecked(
                        PictureType::CoverFront,
                        Some(mime),
                        None,
                        bytes.to_vec(),
                    );
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

    tagged_file
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("Save tags: {}", e))?;

    Ok(())
}

