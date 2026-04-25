use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use tauri::AppHandle;

use crate::db::Database;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
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

impl std::fmt::Display for DownloadFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DownloadFormat::Flac => write!(f, "flac"),
            DownloadFormat::Aac => write!(f, "aac"),
            DownloadFormat::Mp3 => write!(f, "mp3"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadRequest {
    pub id: u64,
    pub title: String,
    pub artist_name: Option<String>,
    pub album_title: Option<String>,
    pub dest_collection_id: i64,
    pub dest_collection_path: String,
    pub format: DownloadFormat,
    pub path_pattern: Option<String>,
    /// If true, this is the last track in a batch (album download). FTS rebuild happens after this one.
    pub is_batch_last: bool,
    /// Plugin ID of the source provider (e.g., "tidal-browse")
    pub source_provider_id: Option<String>,
    /// Track ID within the source provider (e.g., TIDAL track ID)
    pub source_track_id: Option<String>,
    /// Collection ID for the source (e.g., subsonic collection)
    pub source_collection_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DownloadResolveResponse {
    pub url: String,
    pub headers: Option<HashMap<String, String>>,
    pub metadata: Option<DownloadMetadata>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DownloadMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track_number: Option<u32>,
    pub year: Option<u32>,
    pub genre: Option<String>,
    pub cover_url: Option<String>,
}

pub struct DownloadResolveRegistry {
    pub pending: Mutex<HashMap<u64, mpsc::Sender<Option<DownloadResolveResponse>>>>,
}

impl DownloadResolveRegistry {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }
    pub fn register(&self, id: u64) -> mpsc::Receiver<Option<DownloadResolveResponse>> {
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        rx
    }
    pub fn respond(&self, id: u64, response: Option<DownloadResolveResponse>) -> bool {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            tx.send(response).is_ok()
        } else {
            false
        }
    }
    pub fn cancel(&self, id: u64) {
        self.pending.lock().unwrap().remove(&id);
    }
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
                track_title: r.title.clone(),
                artist_name: r.artist_name.clone().unwrap_or_default(),
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

/// Build the destination path from a pattern or default `{Artist}/{Album}/{TrackNum} - {Title}.{ext}`.
/// Pattern tokens: `[artist]`, `[album]`, `[track_number]`, `[title]`.
/// Use `/` or `\` in the pattern to create subdirectories.
pub fn build_dest_path(
    collection_path: &str,
    title: &str,
    artist: &str,
    album: &str,
    track_number: Option<u32>,
    ext: &str,
    path_pattern: Option<&str>,
) -> PathBuf {
    let track_num = track_number.map(|n| format!("{:02}", n)).unwrap_or_default();

    if let Some(pattern) = path_pattern {
        let expanded = pattern
            .replace("[artist]", &sanitize_filename(artist))
            .replace("[album]", &sanitize_filename(album))
            .replace("[track_number]", &track_num)
            .replace("[title]", &sanitize_filename(title));
        let full = format!("{}.{}", expanded, ext);
        let mut path = PathBuf::from(collection_path);
        for component in full.split(['/', '\\']) {
            if !component.is_empty() {
                path.push(component);
            }
        }
        return path;
    }

    let artist_dir = sanitize_filename(artist);
    let album_dir = sanitize_filename(album);
    let filename = if track_num.is_empty() {
        format!("{}.{}", sanitize_filename(title), ext)
    } else {
        format!("{} - {}.{}", track_num, sanitize_filename(title), ext)
    };
    Path::new(collection_path)
        .join(artist_dir)
        .join(album_dir)
        .join(filename)
}

// --- Download pipeline ---

/// Run a single download: download from resolved URL -> tag -> index in library.
pub fn process_download(
    request: &DownloadRequest,
    resolved: &DownloadResolveResponse,
    db: &Arc<Database>,
    app: &AppHandle,
    manager: &Arc<DownloadManager>,
) -> Result<PathBuf, String> {
    use std::io::{Read, Write};
    use tauri::Emitter;

    // Merge metadata: resolved overrides request
    let metadata = resolved.metadata.as_ref();
    let title = metadata
        .and_then(|m| m.title.as_deref())
        .unwrap_or(&request.title);
    let artist = metadata
        .and_then(|m| m.artist.as_deref())
        .or(request.artist_name.as_deref())
        .unwrap_or("");
    let album = metadata
        .and_then(|m| m.album.as_deref())
        .or(request.album_title.as_deref())
        .unwrap_or("");
    let track_number = metadata.and_then(|m| m.track_number);
    let year = metadata.and_then(|m| m.year).map(|y| y as i32);
    let genre = metadata.and_then(|m| m.genre.as_deref());
    let cover_url = metadata.and_then(|m| m.cover_url.as_deref());

    let ext = request.format.extension();

    // Build destination path
    let dest_path = build_dest_path(
        &request.dest_collection_path,
        title,
        artist,
        album,
        track_number,
        ext,
        request.path_pattern.as_deref(),
    );

    // Create parent directories
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    // Download to temp file
    let temp_filename = format!(".viboplr-download-{}.{}", request.id, ext);
    let temp_path = dest_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(&temp_filename);

    if resolved.url.starts_with("file://") {
        let src_path = &resolved.url[7..];
        std::fs::copy(src_path, &temp_path)
            .map_err(|e| format!("Failed to copy local file: {}", e))?;
    } else {
    let http_client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut req_builder = http_client.get(&resolved.url);
    if let Some(headers) = &resolved.headers {
        for (k, v) in headers {
            req_builder = req_builder.header(k.as_str(), v.as_str());
        }
    }

    let mut response = req_builder
        .send()
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {} from stream URL", response.status()));
    }

    let content_length = response.content_length();
    let mut file = std::fs::File::create(&temp_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut buf = [0u8; 32768];
    let mut last_progress_emit = std::time::Instant::now();

    loop {
        let n = response
            .read(&mut buf)
            .map_err(|e| format!("Read error: {}", e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("Write error: {}", e))?;
        downloaded += n as u64;

        // Emit progress every 500ms
        if last_progress_emit.elapsed() >= std::time::Duration::from_millis(500) {
            let pct = if let Some(total) = content_length {
                if total > 0 {
                    ((downloaded as f64 / total as f64) * 100.0).min(99.0) as u8
                } else {
                    0
                }
            } else {
                0
            };
            let progress_status = DownloadStatus {
                id: request.id,
                track_title: request.title.clone(),
                artist_name: request.artist_name.clone().unwrap_or_default(),
                status: "downloading".to_string(),
                progress_pct: pct,
                error: None,
            };
            manager.set_active(Some(progress_status.clone()));
            let _ = app.emit("download-progress", &progress_status);
            last_progress_emit = std::time::Instant::now();
        }
    }

    drop(file);
    } // else (remote URL)

    // Write tags to the downloaded file
    if let Err(e) = write_tags(
        &temp_path,
        title,
        artist,
        album,
        track_number,
        year,
        genre,
        cover_url,
        &request.format,
    ) {
        log::warn!("Failed to write tags for {}: {}", title, e);
        // Continue even if tagging fails — the file is still valid
    }

    // Rename temp to final path
    std::fs::rename(&temp_path, &dest_path).map_err(|e| {
        // Clean up temp file on rename failure
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to rename temp file: {}", e)
    })?;

    // Index the new file in the library
    crate::scanner::process_media_file(
        db,
        &dest_path,
        Some(request.dest_collection_id),
        Some(&request.dest_collection_path),
    );

    Ok(dest_path)
}

pub fn write_tags(
    path: &Path,
    title: &str,
    artist: &str,
    album: &str,
    track_number: Option<u32>,
    year: Option<i32>,
    genre: Option<&str>,
    cover_url: Option<&str>,
    _format: &DownloadFormat,
) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::prelude::*;
    use lofty::probe::Probe;
    use lofty::tag::items::Timestamp;

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

    tag.set_title(title.to_string());
    tag.set_artist(artist.to_string());
    tag.set_album(album.to_string());
    if let Some(num) = track_number {
        tag.set_track(num);
    }
    if let Some(genre) = genre {
        tag.set_genre(genre.to_string());
    }
    if let Some(year) = year {
        tag.set_date(Timestamp { year: year as u16, month: None, day: None, hour: None, minute: None, second: None });
    }

    // Embed cover art
    if let Some(cover_url) = cover_url {
        let http_client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        match http_client.get(cover_url).send() {
            Ok(resp) => {
                if let Ok(bytes) = resp.bytes() {
                    let mime = if cover_url.contains(".png") {
                        MimeType::Png
                    } else {
                        MimeType::Jpeg
                    };
                    let picture = Picture::unchecked(bytes.to_vec())
                        .pic_type(PictureType::CoverFront)
                        .mime_type(mime)
                        .build();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_request() -> DownloadRequest {
        DownloadRequest {
            id: 1,
            title: "Test Song".to_string(),
            artist_name: Some("Test Artist".to_string()),
            album_title: Some("Test Album".to_string()),
            dest_collection_id: 1,
            dest_collection_path: "/music".to_string(),
            format: DownloadFormat::Flac,
            is_batch_last: false,
            path_pattern: None,
            source_provider_id: None,
            source_track_id: Some("123".to_string()),
            source_collection_id: None,
        }
    }

    // --- sanitize_filename tests ---

    #[test]
    fn test_sanitize_filename_normal() {
        assert_eq!(sanitize_filename("My Song"), "My Song");
        assert_eq!(sanitize_filename("Track 01"), "Track 01");
    }

    #[test]
    fn test_sanitize_filename_illegal_chars() {
        assert_eq!(sanitize_filename("A/B\\C:D*E?F\"G<H>I|J"), "A_B_C_D_E_F_G_H_I_J");
        assert_eq!(sanitize_filename("file:name"), "file_name");
    }

    #[test]
    fn test_sanitize_filename_whitespace_trim() {
        assert_eq!(sanitize_filename("  spaced  "), "spaced");
        assert_eq!(sanitize_filename("\t\ntab\n\t"), "tab");
    }

    #[test]
    fn test_sanitize_filename_dots_trim() {
        assert_eq!(sanitize_filename("...dots..."), "dots");
        assert_eq!(sanitize_filename(".hidden"), "hidden");
        assert_eq!(sanitize_filename("file."), "file");
    }

    #[test]
    fn test_sanitize_filename_empty() {
        assert_eq!(sanitize_filename(""), "Unknown");
        assert_eq!(sanitize_filename("   "), "Unknown");
        assert_eq!(sanitize_filename("..."), "Unknown");
        assert_eq!(sanitize_filename(" . "), "Unknown");
    }

    #[test]
    fn test_sanitize_filename_unicode() {
        assert_eq!(sanitize_filename("Café"), "Café");
        assert_eq!(sanitize_filename("日本語"), "日本語");
        assert_eq!(sanitize_filename("Привет"), "Привет");
    }

    #[test]
    fn test_sanitize_filename_mixed() {
        assert_eq!(sanitize_filename(" Café:2024 "), "Café_2024");
        assert_eq!(sanitize_filename("...Song/Title?..."), "Song_Title_");
    }

    // --- DownloadFormat tests ---

    #[test]
    fn test_download_format_from_str_valid() {
        assert_eq!(DownloadFormat::from_str("flac").unwrap(), DownloadFormat::Flac);
        assert_eq!(DownloadFormat::from_str("aac").unwrap(), DownloadFormat::Aac);
        assert_eq!(DownloadFormat::from_str("mp3").unwrap(), DownloadFormat::Mp3);
    }

    #[test]
    fn test_download_format_from_str_invalid() {
        assert!(DownloadFormat::from_str("wav").is_err());
        assert!(DownloadFormat::from_str("ogg").is_err());
        assert!(DownloadFormat::from_str("").is_err());
    }

    #[test]
    fn test_download_format_extension() {
        assert_eq!(DownloadFormat::Flac.extension(), "flac");
        assert_eq!(DownloadFormat::Aac.extension(), "m4a");
        assert_eq!(DownloadFormat::Mp3.extension(), "mp3");
    }

    #[test]
    fn test_download_format_tidal_quality() {
        assert_eq!(DownloadFormat::Flac.tidal_quality(), "LOSSLESS");
        assert_eq!(DownloadFormat::Aac.tidal_quality(), "HIGH");
        assert_eq!(DownloadFormat::Mp3.tidal_quality(), "HIGH");
    }

    #[test]
    fn test_download_format_subsonic_format_param() {
        assert_eq!(DownloadFormat::Flac.subsonic_format_param(), None);
        assert_eq!(DownloadFormat::Aac.subsonic_format_param(), Some("aac"));
        assert_eq!(DownloadFormat::Mp3.subsonic_format_param(), Some("mp3"));
    }

    #[test]
    fn test_download_format_display() {
        assert_eq!(format!("{}", DownloadFormat::Flac), "flac");
        assert_eq!(format!("{}", DownloadFormat::Aac), "aac");
        assert_eq!(format!("{}", DownloadFormat::Mp3), "mp3");
    }

    // --- build_dest_path tests ---

    #[test]
    fn test_build_dest_path_default_with_track_number() {
        let path = build_dest_path("/music", "Test Song", "Test Artist", "Test Album", Some(3), "flac", None);
        assert_eq!(
            path,
            PathBuf::from("/music/Test Artist/Test Album/03 - Test Song.flac")
        );
    }

    #[test]
    fn test_build_dest_path_default_without_track_number() {
        let path = build_dest_path("/music", "Test Song", "Test Artist", "Test Album", None, "flac", None);
        assert_eq!(
            path,
            PathBuf::from("/music/Test Artist/Test Album/Test Song.flac")
        );
    }

    #[test]
    fn test_build_dest_path_custom_pattern_all_tokens() {
        let path = build_dest_path(
            "/music", "Test Song", "Test Artist", "Test Album", Some(3), "flac",
            Some("[artist]/[album]/[track_number] - [title]"),
        );
        assert_eq!(
            path,
            PathBuf::from("/music/Test Artist/Test Album/03 - Test Song.flac")
        );
    }

    #[test]
    fn test_build_dest_path_custom_pattern_subdirectories() {
        let path = build_dest_path(
            "/music", "Test Song", "Test Artist", "Test Album", Some(3), "flac",
            Some("Artists/[artist]/Albums/[album]/[track_number]-[title]"),
        );
        assert_eq!(
            path,
            PathBuf::from("/music/Artists/Test Artist/Albums/Test Album/03-Test Song.flac")
        );
    }

    #[test]
    fn test_build_dest_path_extension_override() {
        let path = build_dest_path("/music", "Test Song", "Test Artist", "Test Album", Some(3), "m4a", None);
        assert_eq!(
            path,
            PathBuf::from("/music/Test Artist/Test Album/03 - Test Song.m4a")
        );
    }

    #[test]
    fn test_build_dest_path_sanitizes_filenames() {
        let path = build_dest_path("/music", "Track?Name", "Artist/Name", "Album:Title", Some(3), "flac", None);
        assert_eq!(
            path,
            PathBuf::from("/music/Artist_Name/Album_Title/03 - Track_Name.flac")
        );
    }

    #[test]
    fn test_build_dest_path_custom_pattern_no_track_number() {
        let path = build_dest_path(
            "/music", "Test Song", "Test Artist", "Test Album", None, "flac",
            Some("[artist] - [title]"),
        );
        assert_eq!(
            path,
            PathBuf::from("/music/Test Artist - Test Song.flac")
        );
    }

    #[test]
    fn test_build_dest_path_mp3_format() {
        let path = build_dest_path("/music", "Test Song", "Test Artist", "Test Album", Some(3), "mp3", None);
        assert_eq!(
            path,
            PathBuf::from("/music/Test Artist/Test Album/03 - Test Song.mp3")
        );
    }

    #[test]
    fn test_build_dest_path_aac_format() {
        let path = build_dest_path("/music", "Test Song", "Test Artist", "Test Album", Some(3), "m4a", None);
        assert_eq!(
            path,
            PathBuf::from("/music/Test Artist/Test Album/03 - Test Song.m4a")
        );
    }

    // --- DownloadManager tests ---

    #[test]
    fn test_download_manager_next_id_increments() {
        let manager = DownloadManager::new();
        assert_eq!(manager.next_id(), 1);
        assert_eq!(manager.next_id(), 2);
        assert_eq!(manager.next_id(), 3);
    }

    #[test]
    fn test_download_manager_enqueue_and_cancel() {
        let manager = DownloadManager::new();
        let request = test_request();

        manager.enqueue(request.clone());
        assert_eq!(manager.queue.lock().unwrap().len(), 1);

        let cancelled = manager.cancel(1);
        assert!(cancelled);
        assert_eq!(manager.queue.lock().unwrap().len(), 0);
    }

    #[test]
    fn test_download_manager_cancel_nonexistent() {
        let manager = DownloadManager::new();
        let request = test_request();

        manager.enqueue(request.clone());
        let cancelled = manager.cancel(999);
        assert!(!cancelled);
        assert_eq!(manager.queue.lock().unwrap().len(), 1);
    }

    #[test]
    fn test_download_manager_get_status_queued() {
        let manager = DownloadManager::new();
        let request = test_request();

        manager.enqueue(request.clone());
        let status = manager.get_status();

        assert_eq!(status.queued.len(), 1);
        assert_eq!(status.queued[0].track_title, "Test Song");
        assert_eq!(status.queued[0].status, "queued");
        assert!(status.active.is_none());
    }

    #[test]
    fn test_download_manager_push_completed_respects_limit() {
        let manager = DownloadManager::new();

        for i in 1..=15 {
            let status = DownloadStatus {
                id: i,
                track_title: format!("Track {}", i),
                artist_name: "Artist".to_string(),
                status: "completed".to_string(),
                progress_pct: 100,
                error: None,
            };
            manager.push_completed(status);
        }

        let completed = manager.completed.lock().unwrap();
        assert_eq!(completed.len(), 10);
        // First 5 should be removed, so we should have items 6-15
        assert_eq!(completed[0].id, 6);
        assert_eq!(completed[9].id, 15);
    }

    #[test]
    fn test_download_manager_set_active() {
        let manager = DownloadManager::new();

        assert!(manager.active.lock().unwrap().is_none());

        let status = DownloadStatus {
            id: 1,
            track_title: "Active Track".to_string(),
            artist_name: "Artist".to_string(),
            status: "downloading".to_string(),
            progress_pct: 50,
            error: None,
        };

        manager.set_active(Some(status.clone()));
        let active = manager.active.lock().unwrap();
        assert!(active.is_some());
        assert_eq!(active.as_ref().unwrap().track_title, "Active Track");
        assert_eq!(active.as_ref().unwrap().progress_pct, 50);
    }

    // --- DownloadResolveRegistry tests ---

    #[test]
    fn test_resolve_registry_respond() {
        let registry = DownloadResolveRegistry::new();
        let rx = registry.register(42);

        let response = DownloadResolveResponse {
            url: "https://example.com/stream".to_string(),
            headers: None,
            metadata: None,
        };
        assert!(registry.respond(42, Some(response)));

        let received = rx.recv().unwrap();
        assert!(received.is_some());
        assert_eq!(received.unwrap().url, "https://example.com/stream");
    }

    #[test]
    fn test_resolve_registry_respond_none() {
        let registry = DownloadResolveRegistry::new();
        let rx = registry.register(42);

        assert!(registry.respond(42, None));

        let received = rx.recv().unwrap();
        assert!(received.is_none());
    }

    #[test]
    fn test_resolve_registry_respond_unknown_id() {
        let registry = DownloadResolveRegistry::new();
        assert!(!registry.respond(999, None));
    }

    #[test]
    fn test_resolve_registry_cancel() {
        let registry = DownloadResolveRegistry::new();
        let _rx = registry.register(42);

        registry.cancel(42);
        assert!(registry.pending.lock().unwrap().is_empty());
    }
}

