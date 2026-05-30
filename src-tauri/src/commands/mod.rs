use serde::{Serialize, Deserialize};
use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::Database;
use crate::downloader::{DownloadFormat, DownloadManager, DownloadResolveRegistry};
use crate::models::*;
use crate::p2p::P2pNode;
use crate::scanner;
use crate::skins;
use crate::subsonic::SubsonicClient;
use crate::transcode_server;

// --- command submodules (split out of this file) ---
mod app;
pub use app::*;
mod collections;
pub use collections::*;
mod downloads;
pub use downloads::*;
mod extensions;
pub use extensions::*;
mod history;
pub use history::*;
mod images;
pub use images::*;
mod library;
pub use library::*;
mod main_playlist;
pub use main_playlist::*;
mod media;
pub use media::*;
mod mixtapes;
pub use mixtapes::*;
mod p2p;
pub use p2p::*;
mod playlists;
pub use playlists::*;
mod plugin_files;
pub use plugin_files::*;
mod plugins;
pub use plugins::*;
mod skins_cmd;
pub use skins_cmd::*;
mod transcode;
pub use transcode::*;
mod waveforms;
pub use waveforms::*;
mod youtube;
pub use youtube::*;

macro_rules! env_or_empty {
    ($name:expr) => {
        match option_env!($name) {
            Some(v) => v,
            None => "",
        }
    };
}

pub const LASTFM_API_KEY: &str = env_or_empty!("LASTFM_API_KEY");
pub const LASTFM_API_SECRET: &str = env_or_empty!("LASTFM_API_SECRET");

pub enum ImageDownloadRequest {
    Artist { name: String, force: bool },
    Album { title: String, artist_name: Option<String>, force: bool },
    Tag { name: String, force: bool },
}

pub struct DownloadQueue {
    pub queue: Mutex<Vec<ImageDownloadRequest>>,
    pub condvar: Condvar,
}

/// Result sent back from frontend after resolving an image URL via plugins
#[derive(Debug, Clone, Deserialize)]
pub struct ImageResolveResult {
    pub url: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub data: Option<String>,  // base64 encoded image bytes
    pub error: Option<String>,
}

/// Registry for pending image resolve requests (Rust worker -> frontend bridge)
pub struct ImageResolveRegistry {
    pub pending: Mutex<std::collections::HashMap<String, mpsc::Sender<ImageResolveResult>>>,
}

pub struct AppState {
    pub db: Arc<Database>,
    pub app_dir: std::path::PathBuf,
    pub profile_name: String,
    pub download_queue: Arc<DownloadQueue>,
    pub track_download_manager: Arc<DownloadManager>,
    pub native_plugins_dir: Option<std::path::PathBuf>,
    pub image_resolve_registry: Arc<ImageResolveRegistry>,
    pub download_resolve_registry: Arc<DownloadResolveRegistry>,
    pub direct_download_cancel: Arc<AtomicBool>,
    pub mixtape_cancel: Arc<AtomicBool>,
    pub resyncing_collections: Arc<Mutex<HashSet<i64>>>,
    pub cursor_tracker_active: Arc<AtomicBool>,
    pub transcode_port: u16,
    pub transcode_sessions: transcode_server::Sessions,
    pub dep_cache: Arc<crate::dependencies::DepCache>,
    pub p2p_node: Arc<tokio::sync::RwLock<Option<P2pNode>>>,
}

#[derive(Debug, Deserialize)]
pub struct BulkUpdateFields {
    pub artist_name: Option<String>,
    pub album_title: Option<String>,
    pub year: Option<i32>,
    pub tag_names: Option<Vec<String>>,
}

fn detect_image_format(data: &[u8]) -> &'static str {
    if data.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        "png"
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else {
        "png"
    }
}










struct ResyncGuard {
    id: i64,
    set: Arc<Mutex<HashSet<i64>>>,
}

impl Drop for ResyncGuard {
    fn drop(&mut self) {
        self.set.lock().unwrap().remove(&self.id);
    }
}

pub fn run_collection_resync(
    db: Arc<Database>,
    app: AppHandle,
    collection: Collection,
    resyncing: Arc<Mutex<HashSet<i64>>>,
) {
    let collection_id = collection.id;

    {
        let mut set = resyncing.lock().unwrap();
        if set.contains(&collection_id) {
            return;
        }
        set.insert(collection_id);
    }

    match collection.kind.as_str() {
        "local" => {
            let folder_path = match collection.path {
                Some(p) => p,
                None => {
                    resyncing.lock().unwrap().remove(&collection_id);
                    return;
                }
            };
            let scan_path = folder_path.clone();
            let track_count_before = db.get_track_count_for_collection(collection_id).unwrap_or(0);
            thread::spawn(move || {
                let _guard = ResyncGuard { id: collection_id, set: resyncing };
                let start = std::time::Instant::now();
                let removed_tracks = scanner::scan_folder(&db, &scan_path, Some(collection_id), |scanned, total| {
                    let _ = app.emit(
                        "scan-progress",
                        ScanProgress {
                            folder: scan_path.clone(),
                            scanned,
                            total,
                            collection_id,
                        },
                    );
                });
                let _ = db.rebuild_fts();
                let _ = db.recompute_counts();
                let _ = db.update_collection_synced(collection_id, start.elapsed().as_secs_f64());
                let track_count_after = db.get_track_count_for_collection(collection_id).unwrap_or(0);
                let new_tracks = (track_count_after - track_count_before).max(0);
                let _ = app.emit("scan-complete", serde_json::json!({
                    "folder": scan_path,
                    "collectionId": collection_id,
                    "newTracks": new_tracks,
                    "removedTracks": removed_tracks,
                }));
            });
        }
        "subsonic" => {
            let creds = match db.get_collection_credentials(collection_id) {
                Ok(c) => c,
                Err(_) => {
                    resyncing.lock().unwrap().remove(&collection_id);
                    return;
                }
            };
            let collection_name = collection.name.clone();
            let track_count_before = db.get_track_count_for_collection(collection_id).unwrap_or(0);

            thread::spawn(move || {
                let _guard = ResyncGuard { id: collection_id, set: resyncing };
                let client = SubsonicClient::from_stored(
                    &creds.url,
                    &creds.username,
                    &creds.password_token,
                    creds.salt.as_deref(),
                    &creds.auth_method,
                );
                match crate::sync::sync_collection(&db, &client, collection_id, |synced, total| {
                    let _ = app.emit(
                        "sync-progress",
                        SyncProgress {
                            collection: collection_name.clone(),
                            synced,
                            total,
                            collection_id,
                        },
                    );
                }) {
                    Ok(removed_tracks) => {
                        let track_count_after = db.get_track_count_for_collection(collection_id).unwrap_or(0);
                        let new_tracks = (track_count_after - track_count_before).max(0);
                        let _ = app.emit(
                            "sync-complete",
                            serde_json::json!({
                                "collectionId": collection_id,
                                "newTracks": new_tracks,
                                "removedTracks": removed_tracks,
                            }),
                        );
                    }
                    Err(e) => {
                        log::error!("Resync failed for collection {}: {}", collection_id, e);
                        let _ = db.update_collection_sync_error(collection_id, &e);
                        let _ = app.emit(
                            "sync-error",
                            serde_json::json!({ "collectionId": collection_id, "error": e }),
                        );
                    }
                }
            });
        }
        _ => {
            resyncing.lock().unwrap().remove(&collection_id);
        }
    }
}
































































// --- Playlist commands ---

#[derive(Debug, Deserialize)]
pub struct QueueEntryPayload {
    pub location: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub duration_secs: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct PlaylistTrackPayload {
    pub title: String,
    pub artist_name: Option<String>,
    pub album_name: Option<String>,
    pub duration_secs: Option<f64>,
    pub source: Option<String>,
    pub image_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityLikePayload {
    pub title: String,                  // for tracks: title; for artist/album/tag: the name
    pub artist_name: Option<String>,
    pub album_title: Option<String>,
    pub duration_secs: Option<f64>,
    pub source: Option<String>,
    pub image_url: Option<String>,
}
















/// Resolve destination collection: use provided values or find first enabled local collection.
fn resolve_dest_collection(
    state: &AppState,
    dest_collection_id: Option<i64>,
    custom_dest_path: Option<String>,
) -> Result<(i64, String), String> {
    if let (Some(cid), Some(path)) = (dest_collection_id, custom_dest_path.as_ref()) {
        return Ok((cid, path.clone()));
    }
    let collections = state.db.get_collections().map_err(|e| e.to_string())?;
    // Look up by ID if provided
    if let Some(cid) = dest_collection_id {
        if let Some(c) = collections.iter().find(|c| c.id == cid && c.path.is_some()) {
            return Ok((c.id, c.path.clone().unwrap()));
        }
    }
    // Fall back to first enabled local collection
    let local = collections
        .iter()
        .find(|c| c.kind == "local" && c.enabled && c.path.is_some())
        .ok_or("No enabled local collection found for download destination")?;
    Ok((local.id, local.path.clone().unwrap()))
}

// --- Direct download commands ---

#[cfg(debug_assertions)]
#[tauri::command]
pub fn clear_database(state: State<'_, AppState>) -> Result<String, String> {
    state.db.clear_database().map_err(|e| e.to_string())?;
    Ok("Database cleared".to_string())
}



// --- YouTube search command ---

#[derive(serde::Serialize)]
pub struct YouTubeResult {
    pub url: String,
    pub video_title: Option<String>,
}

struct VideoCandidate {
    video_id: String,
    title: Option<String>,
    duration_secs: Option<f64>,
}

fn parse_duration_text(text: &str) -> Option<f64> {
    let parts: Vec<&str> = text.split(':').collect();
    match parts.len() {
        2 => {
            let mins = parts[0].parse::<f64>().ok()?;
            let secs = parts[1].parse::<f64>().ok()?;
            Some(mins * 60.0 + secs)
        }
        3 => {
            let hrs = parts[0].parse::<f64>().ok()?;
            let mins = parts[1].parse::<f64>().ok()?;
            let secs = parts[2].parse::<f64>().ok()?;
            Some(hrs * 3600.0 + mins * 60.0 + secs)
        }
        _ => None,
    }
}

fn extract_video_candidates(data: &serde_json::Value, max: usize) -> Vec<VideoCandidate> {
    let items = data.get("contents")
        .and_then(|v| v.get("twoColumnSearchResultsRenderer"))
        .and_then(|v| v.get("primaryContents"))
        .and_then(|v| v.get("sectionListRenderer"))
        .and_then(|v| v.get("contents"))
        .and_then(|v| v.as_array());

    let Some(sections) = items else { return vec![] };

    sections.iter()
        .filter_map(|section| {
            section.get("itemSectionRenderer")?.get("contents")?.as_array()
        })
        .flatten()
        .filter_map(|item| {
            let renderer = item.get("videoRenderer")?;
            let video_id = renderer.get("videoId")?.as_str()?.to_string();
            let title = renderer.get("title")
                .and_then(|t| t.get("runs"))
                .and_then(|r| r.as_array())
                .and_then(|a| a.first())
                .and_then(|r| r.get("text"))
                .and_then(|t| t.as_str())
                .map(String::from);
            let duration_secs = renderer.get("lengthText")
                .and_then(|lt| lt.get("simpleText"))
                .and_then(|t| t.as_str())
                .and_then(parse_duration_text);
            Some(VideoCandidate { video_id, title, duration_secs })
        })
        .take(max)
        .collect()
}


// --- Plugin system exec ---

use crate::dependencies;

fn command_with_path(program: &str) -> std::process::Command {
    dependencies::command_with_path(program)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}




#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDepDeclaration {
    pub name: String,
    pub plugin_name: String,
    pub reason: String,
}




// --- Video frame extraction commands ---

#[derive(serde::Serialize)]
pub struct VideoFrameResult {
    pub status: String,
    pub paths: Option<Vec<String>>,
    pub timestamps: Option<Vec<f64>>,
}



// --- Track audio properties command ---

#[derive(serde::Serialize)]
pub struct AudioProperties {
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub channels: Option<u8>,
    pub bitrate: Option<u32>,
}
















#[derive(Debug, Clone, Serialize)]
pub struct UpgradePreviewInfo {
    pub old_path: String,
    pub old_format: Option<String>,
    pub old_file_size: Option<i64>,
    pub new_path: String,
    pub new_format: Option<String>,
    pub new_file_size: Option<i64>,
}

#[derive(Serialize)]
pub struct ConflictCheck {
    pub has_conflict: bool,
    pub dest_path: String,
    pub existing_size: Option<u64>,
    pub existing_format: Option<String>,
}

#[derive(Serialize)]
pub struct DownloadPathResult {
    pub path: String,
    pub format: String,
    pub file_size: u64,
}



















fn scan_plugins_dir(dir: &std::path::Path, builtin: bool) -> Vec<serde_json::Value> {
    let mut plugins = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("Failed to read plugins dir {}: {}", dir.display(), e);
            return plugins;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        match std::fs::read_to_string(&manifest_path) {
            Ok(content) => {
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(manifest) => {
                        let dir_name = path.file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("")
                            .to_string();
                        // Bundle index.js content alongside the manifest so the
                        // frontend can activate plugins without a second IPC
                        // round-trip per plugin.
                        let code = std::fs::read_to_string(path.join("index.js")).ok();
                        plugins.push(serde_json::json!({
                            "id": dir_name,
                            "manifest": manifest,
                            "builtin": builtin,
                            "code": code,
                        }));
                    }
                    Err(e) => {
                        log::warn!("Invalid manifest in plugin {}: {}", path.display(), e);
                    }
                }
            }
            Err(e) => {
                log::warn!("Failed to read manifest for plugin {}: {}", path.display(), e);
            }
        }
    }
    plugins
}

































// ── Plugin caching ───────────────────────────────────────────────

fn validate_plugin_cache_path(plugin_id: &str, subdir: &str, filename: Option<&str>) -> Result<(), String> {
    if plugin_id.is_empty() || plugin_id.contains("..") || plugin_id.contains('/') || plugin_id.contains('\\') {
        return Err("Invalid plugin ID".to_string());
    }
    if subdir.is_empty() || subdir.contains("..") || subdir.contains('/') || subdir.contains('\\') {
        return Err("Invalid subdir".to_string());
    }
    if let Some(f) = filename {
        if f.is_empty() || f.contains("..") || f.contains('/') || f.contains('\\') {
            return Err("Invalid filename".to_string());
        }
    }
    Ok(())
}





// ── Plugin file storage (nested path segments) ──────────────────

const PLUGIN_FILE_MAX_BYTES: u64 = 50 * 1024 * 1024;

fn validate_path_segment(segment: &str) -> Result<(), String> {
    if segment.is_empty() {
        return Err("Empty path segment".to_string());
    }
    if segment.len() > 255 {
        return Err("Path segment too long".to_string());
    }
    if segment == "." || segment == ".." {
        return Err("Path segment may not be '.' or '..'".to_string());
    }
    if segment.contains('/') || segment.contains('\\') || segment.contains('\0') {
        return Err("Path segment contains invalid characters".to_string());
    }
    if segment.chars().any(|c| (c as u32) < 0x20) {
        return Err("Path segment contains control characters".to_string());
    }
    // Windows reserved device names
    let upper = segment.to_uppercase();
    let base = upper.split('.').next().unwrap_or(&upper);
    matches!(base, "CON" | "PRN" | "AUX" | "NUL"
        | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
        | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9")
        .then(|| Err::<(), String>("Path segment is a reserved name".to_string()))
        .transpose()?;
    Ok(())
}

fn resolve_plugin_path(
    app_dir: &std::path::Path,
    plugin_id: &str,
    path: &[String],
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    if plugin_id.is_empty() || plugin_id.contains("..") || plugin_id.contains('/') || plugin_id.contains('\\') {
        return Err("Invalid plugin ID".to_string());
    }
    if path.is_empty() {
        return Err("Path must have at least one segment".to_string());
    }
    for seg in path {
        validate_path_segment(seg)?;
    }
    let root = app_dir.join("plugin-cache").join(plugin_id);
    let mut full = root.clone();
    for seg in path {
        full.push(seg);
    }
    Ok((root, full))
}

fn ensure_within_root(root: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(root).ok();
    let canonical_root = root.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    // Canonicalize the deepest ancestor that exists so we can also validate paths
    // for files that do not yet exist (e.g. when we're about to create them).
    let mut probe = target.to_path_buf();
    loop {
        if probe.exists() {
            break;
        }
        if !probe.pop() {
            // Nothing exists yet — use the root itself.
            probe = canonical_root.clone();
            break;
        }
    }
    let canonical_probe = probe.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    if !canonical_probe.starts_with(&canonical_root) {
        return Err("Path escapes plugin root".to_string());
    }
    Ok(())
}

#[derive(Serialize)]
pub struct PluginDirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
}








fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}















fn resolve_and_download_track(
    resolve_registry: &Arc<crate::downloader::DownloadResolveRegistry>,
    app: &tauri::AppHandle,
    temp_dir: &std::path::Path,
    i: usize,
    total: usize,
    track: &crate::models::MixtapeExportTrackInput,
    source: &str,
    cancel: &std::sync::atomic::AtomicBool,
    format: &str,
) -> Option<String> {
    use tauri::Emitter;

    let _ = app.emit("mixtape-export-progress", crate::models::MixtapeExportProgress {
        current_track: (i + 1) as u32,
        total_tracks: total as u32,
        phase: format!("resolving:{}", source),
        track_title: track.title.clone(),
    });

    let resolve_id = (i as u64) + 10000;
    log::info!("[mixtape-export] resolve #{}: \"{}\" by {:?}, path={:?}",
        resolve_id, track.title, track.artist, track.path);
    let rx = resolve_registry.register(resolve_id);
    let uri = track.path.clone();
    let _ = app.emit("download-resolve-request", serde_json::json!({
        "id": resolve_id,
        "title": track.title,
        "artist_name": track.artist,
        "album_title": track.album,
        "duration_secs": track.duration_secs,
        "uri": uri,
        "format": format,
    }));

    match rx.recv_timeout(std::time::Duration::from_secs(60)) {
        Ok(Some(response)) => {
            log::info!("[mixtape-export] resolve #{}: got URL {} ({})",
                resolve_id, &response.url[..response.url.len().min(80)],
                if response.headers.is_some() { "with headers" } else { "no headers" });
            let ext = if response.url.contains(".flac") { "flac" }
                else if response.url.contains(".m4a") { "m4a" }
                else { "mp3" };
            let temp_file = temp_dir.join(
                format!("{:03}-{}.{}", i + 1,
                    crate::entity_image::canonical_slug(&track.title), ext));

            let _ = app.emit("mixtape-export-progress", crate::models::MixtapeExportProgress {
                current_track: (i + 1) as u32,
                total_tracks: total as u32,
                phase: format!("downloading:{}", source),
                track_title: track.title.clone(),
            });

            log::info!("[mixtape-export] downloading to {}", temp_file.display());
            match crate::downloader::download_file(
                &response.url, response.headers.as_ref(), &temp_file, Some(cancel), None,
            ) {
                Ok(_) => {
                    let size = std::fs::metadata(&temp_file).map(|m| m.len()).unwrap_or(0);
                    log::info!("[mixtape-export] download complete: {} ({} bytes)", temp_file.display(), size);
                    Some(temp_file.to_string_lossy().to_string())
                }
                Err(e) => {
                    log::error!("[mixtape-export] download failed for \"{}\": {}", track.title, e);
                    None
                }
            }
        }
        Ok(None) => {
            log::warn!("[mixtape-export] resolve #{}: provider returned None for \"{}\"", resolve_id, track.title);
            None
        }
        Err(e) => {
            log::warn!("[mixtape-export] resolve #{}: timeout/error for \"{}\": {}", resolve_id, track.title, e);
            resolve_registry.cancel(resolve_id);
            None
        }
    }
}









pub fn is_collection_due_for_auto_update(collection: &Collection, now_secs: i64) -> bool {
    if !collection.enabled || !collection.auto_update {
        return false;
    }
    if !matches!(collection.kind.as_str(), "local" | "subsonic") {
        return false;
    }
    let interval_secs = collection.auto_update_interval_mins * 60;
    match collection.last_synced_at {
        None => true,
        Some(last) => (now_secs - last) >= interval_secs,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeInfo {
    pub url: String,
    pub session_id: String,
    pub duration_secs: Option<f64>,
}














#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn test_state() -> AppState {
        let db = Database::new_in_memory().expect("Failed to create test DB");
        AppState {
            db: Arc::new(db),
            app_dir: std::path::PathBuf::from("/tmp/viboplr-test"),
            profile_name: "default".to_string(),
            download_queue: Arc::new(DownloadQueue {
                queue: Mutex::new(Vec::new()),
                condvar: Condvar::new(),
            }),
            track_download_manager: Arc::new(DownloadManager::new()),
            native_plugins_dir: None,
            image_resolve_registry: Arc::new(ImageResolveRegistry {
                pending: Mutex::new(std::collections::HashMap::new()),
            }),
            download_resolve_registry: Arc::new(DownloadResolveRegistry::new()),
            direct_download_cancel: Arc::new(AtomicBool::new(false)),
            mixtape_cancel: Arc::new(AtomicBool::new(false)),
            resyncing_collections: Arc::new(Mutex::new(HashSet::new())),
            cursor_tracker_active: Arc::new(AtomicBool::new(false)),
            transcode_port: 0,
            transcode_sessions: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            dep_cache: Arc::new(crate::dependencies::DepCache::new()),
            p2p_node: Arc::new(tokio::sync::RwLock::new(None)),
        }
    }

    /// Helper: get or create a test collection
    fn test_collection_id(state: &AppState) -> i64 {
        let collections = state.db.get_collections().unwrap();
        if let Some(c) = collections.iter().find(|c| c.name == "TestCol") {
            return c.id;
        }
        state.db.add_collection("local", "TestCol", Some("/test"), None, None, None, None, None)
            .expect("add_collection failed")
            .id
    }

    /// Helper: insert a track directly through the DB layer
    fn insert_track(state: &AppState, path: &str, title: &str, artist_id: Option<i64>, album_id: Option<i64>) -> i64 {
        let cid = test_collection_id(state);
        state.db.upsert_track(path, title, artist_id, album_id, None, Some(200.0), Some("mp3"), Some(5_000_000), None, Some(cid), None)
            .expect("upsert_track failed")
    }

    #[test]
    fn test_collection_flow() {
        let state = test_state();
        let col = state.db.add_collection("local", "Test", Some("/test"), None, None, None, None, None).unwrap();

        let collections = state.db.get_collections().unwrap();
        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].name, "Test");

        state.db.update_collection(col.id, "Updated", false, 60, true).unwrap();
        let updated = state.db.get_collection_by_id(col.id).unwrap();
        assert_eq!(updated.name, "Updated");

        state.db.remove_collection(col.id).unwrap();
        assert!(state.db.get_collections().unwrap().is_empty());
    }

    #[test]
    fn test_search_flow() {
        let state = test_state();
        let artist_id = state.db.get_or_create_artist("Test Artist").unwrap();
        let album_id = state.db.get_or_create_album("Test Album", Some(artist_id), None).unwrap();
        insert_track(&state, "a.mp3", "Alpha Song", Some(artist_id), Some(album_id));
        insert_track(&state, "b.mp3", "Beta Song", Some(artist_id), None);

        state.db.rebuild_fts().unwrap();

        let results = state.db.get_tracks(&TrackQuery { query: Some("Alpha".to_string()), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Alpha Song");

        // Search with artist filter
        let results = state.db.get_tracks(&TrackQuery { query: Some("Song".to_string()), artist_id: Some(artist_id), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_toggle_liked() {
        let state = test_state();
        let artist_id = state.db.get_or_create_artist("Artist").unwrap();
        let album_id = state.db.get_or_create_album("Album", Some(artist_id), None).unwrap();
        let track_id = insert_track(&state, "t.mp3", "Track", Some(artist_id), Some(album_id));

        // Track liked
        state.db.toggle_liked("tracks", track_id, 1).unwrap();
        let track = state.db.get_track_by_id(track_id).unwrap();
        assert_eq!(track.liked, 1);
        state.db.toggle_liked("tracks", track_id, 0).unwrap();
        let track = state.db.get_track_by_id(track_id).unwrap();
        assert_eq!(track.liked, 0);

        // Track disliked
        state.db.toggle_liked("tracks", track_id, -1).unwrap();
        let track = state.db.get_track_by_id(track_id).unwrap();
        assert_eq!(track.liked, -1);
        state.db.toggle_liked("tracks", track_id, 0).unwrap();
        let track = state.db.get_track_by_id(track_id).unwrap();
        assert_eq!(track.liked, 0);

        // Artist liked — need recompute_counts for artist to show up (track_count > 0 filter)
        state.db.toggle_liked("artists", artist_id, 1).unwrap();
        state.db.recompute_counts().unwrap();
        let artists = state.db.get_artists().unwrap();
        assert!(!artists.is_empty());
        assert!(artists.iter().any(|a| a.id == artist_id && a.liked == 1));

        // Album liked
        state.db.toggle_liked("albums", album_id, 1).unwrap();
        state.db.recompute_counts().unwrap();
        let albums = state.db.get_albums(None).unwrap();
        assert!(albums.iter().any(|a| a.id == album_id && a.liked == 1));
    }

    #[test]
    fn test_record_and_get_plays() {
        let state = test_state();
        let t1 = insert_track(&state, "a.mp3", "Song A", None, None);
        let t2 = insert_track(&state, "b.mp3", "Song B", None, None);

        state.db.record_play(t1).unwrap();
        state.db.record_play(t1).unwrap(); // deduplicated (same track within 30s)
        state.db.record_play(t2).unwrap();

        let recent = state.db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 2); // deduped: Song A once + Song B once

        let most = state.db.get_history_most_played(10).unwrap();
        assert_eq!(most.len(), 2);
        assert!(most.iter().all(|m| m.play_count == 1));
    }

    #[test]
    fn test_parse_duration_text() {
        assert_eq!(parse_duration_text("3:33"), Some(213.0));
        assert_eq!(parse_duration_text("0:30"), Some(30.0));
        assert_eq!(parse_duration_text("1:00:00"), Some(3600.0));
        assert_eq!(parse_duration_text("1:02:03"), Some(3723.0));
        assert_eq!(parse_duration_text("bad"), None);
        assert_eq!(parse_duration_text(""), None);
    }

    #[test]
    fn test_extract_video_candidates() {
        let data: serde_json::Value = serde_json::json!({
            "contents": {
                "twoColumnSearchResultsRenderer": {
                    "primaryContents": {
                        "sectionListRenderer": {
                            "contents": [{
                                "itemSectionRenderer": {
                                    "contents": [
                                        {
                                            "videoRenderer": {
                                                "videoId": "dQw4w9WgXcQ",
                                                "title": { "runs": [{ "text": "Rick Astley - Never Gonna Give You Up" }] },
                                                "lengthText": { "simpleText": "3:33" }
                                            }
                                        },
                                        {
                                            "videoRenderer": {
                                                "videoId": "second_id",
                                                "title": { "runs": [{ "text": "Second Video" }] },
                                                "lengthText": { "simpleText": "5:00" }
                                            }
                                        }
                                    ]
                                }
                            }]
                        }
                    }
                }
            }
        });

        let candidates = extract_video_candidates(&data, 7);
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].video_id, "dQw4w9WgXcQ");
        assert_eq!(candidates[0].title, Some("Rick Astley - Never Gonna Give You Up".to_string()));
        assert_eq!(candidates[0].duration_secs, Some(213.0));
        assert_eq!(candidates[1].video_id, "second_id");
        assert_eq!(candidates[1].duration_secs, Some(300.0));
    }

    #[test]
    fn test_extract_video_candidates_duration_matching() {
        let data: serde_json::Value = serde_json::json!({
            "contents": {
                "twoColumnSearchResultsRenderer": {
                    "primaryContents": {
                        "sectionListRenderer": {
                            "contents": [{
                                "itemSectionRenderer": {
                                    "contents": [
                                        {
                                            "videoRenderer": {
                                                "videoId": "wrong_duration",
                                                "title": { "runs": [{ "text": "Extended Mix" }] },
                                                "lengthText": { "simpleText": "7:00" }
                                            }
                                        },
                                        {
                                            "videoRenderer": {
                                                "videoId": "right_duration",
                                                "title": { "runs": [{ "text": "Original" }] },
                                                "lengthText": { "simpleText": "3:32" }
                                            }
                                        }
                                    ]
                                }
                            }]
                        }
                    }
                }
            }
        });

        let candidates = extract_video_candidates(&data, 7);
        // With duration_secs=213 (3:33), should match "right_duration" (3:32 = 212s, within ±3s)
        let target = 213.0;
        let best = candidates.iter()
            .find(|c| c.duration_secs.map_or(false, |d| (d - target).abs() <= 3.0))
            .unwrap_or(&candidates[0]);
        assert_eq!(best.video_id, "right_duration");
    }

    #[test]
    fn test_extract_video_candidates_no_duration_match_falls_back() {
        let data: serde_json::Value = serde_json::json!({
            "contents": {
                "twoColumnSearchResultsRenderer": {
                    "primaryContents": {
                        "sectionListRenderer": {
                            "contents": [{
                                "itemSectionRenderer": {
                                    "contents": [
                                        {
                                            "videoRenderer": {
                                                "videoId": "first",
                                                "title": { "runs": [{ "text": "First" }] },
                                                "lengthText": { "simpleText": "7:00" }
                                            }
                                        },
                                        {
                                            "videoRenderer": {
                                                "videoId": "second",
                                                "title": { "runs": [{ "text": "Second" }] },
                                                "lengthText": { "simpleText": "8:00" }
                                            }
                                        }
                                    ]
                                }
                            }]
                        }
                    }
                }
            }
        });

        let candidates = extract_video_candidates(&data, 7);
        // With duration_secs=213 (3:33), no match within ±3s, should fall back to first
        let target = 213.0;
        let best = candidates.iter()
            .find(|c| c.duration_secs.map_or(false, |d| (d - target).abs() <= 3.0))
            .unwrap_or(&candidates[0]);
        assert_eq!(best.video_id, "first");
    }

    #[test]
    fn test_extract_video_candidates_missing() {
        let data: serde_json::Value = serde_json::json!({
            "contents": {
                "twoColumnSearchResultsRenderer": {
                    "primaryContents": {
                        "sectionListRenderer": {
                            "contents": [{
                                "itemSectionRenderer": {
                                    "contents": [
                                        { "adRenderer": { "some": "ad" } }
                                    ]
                                }
                            }]
                        }
                    }
                }
            }
        });

        assert!(extract_video_candidates(&data, 7).is_empty());
    }

    #[test]
    fn test_extract_video_candidates_empty() {
        let data: serde_json::Value = serde_json::json!({});
        assert!(extract_video_candidates(&data, 7).is_empty());
    }

    // Auto-update helper
    fn make_collection(auto_update: bool, interval_mins: i64, last_synced_at: Option<i64>, last_sync_error: Option<String>) -> Collection {
        Collection {
            id: 1,
            kind: "local".to_string(),
            name: "Test".to_string(),
            path: Some("/test".to_string()),
            url: None,
            username: None,
            last_synced_at,
            auto_update,
            auto_update_interval_mins: interval_mins,
            enabled: true,
            last_sync_duration_secs: None,
            last_sync_error,
        }
    }

    #[test]
    fn test_auto_update_due_never_synced() {
        let col = make_collection(true, 60, None, None);
        assert!(is_collection_due_for_auto_update(&col, 1000));
    }

    #[test]
    fn test_auto_update_due_interval_elapsed() {
        let col = make_collection(true, 60, Some(1000), None);
        assert!(is_collection_due_for_auto_update(&col, 1000 + 3600));
    }

    #[test]
    fn test_auto_update_not_due_interval_not_elapsed() {
        let col = make_collection(true, 60, Some(1000), None);
        assert!(!is_collection_due_for_auto_update(&col, 1000 + 1800));
    }

    #[test]
    fn test_auto_update_not_due_disabled() {
        let col = make_collection(false, 60, Some(0), None);
        assert!(!is_collection_due_for_auto_update(&col, 99999));
    }

    #[test]
    fn test_auto_update_not_due_plugin_kind() {
        let mut col = make_collection(true, 60, Some(0), None);
        col.kind = "plugin-example".to_string();
        assert!(!is_collection_due_for_auto_update(&col, 99999));
    }

    #[test]
    fn test_auto_update_subsonic_supported() {
        let mut col = make_collection(true, 60, Some(0), None);
        col.kind = "subsonic".to_string();
        assert!(is_collection_due_for_auto_update(&col, 99999));
    }

    #[test]
    fn test_auto_update_error_backoff() {
        // Error with last_synced_at updated (by the fixed update_collection_sync_error):
        // At time 1000 a sync failed. Interval is 60 min = 3600s.
        let col = make_collection(true, 60, Some(1000), Some("connection refused".to_string()));
        // At time 2800 (30 min later): not yet due
        assert!(!is_collection_due_for_auto_update(&col, 2800));
        // At time 4600 (60 min later): interval elapsed, should retry despite error
        assert!(is_collection_due_for_auto_update(&col, 4600));
    }

    #[test]
    fn test_auto_update_error_never_synced() {
        // Error present but last_synced_at is None (edge case): treat as due
        let col = make_collection(true, 60, None, Some("error".to_string()));
        assert!(is_collection_due_for_auto_update(&col, 1000));
    }
}

#[cfg(test)]
mod plugin_cache_tests {
    use super::*;

    #[test]
    fn test_validate_plugin_cache_path_valid() {
        assert!(validate_plugin_cache_path("spotify-browse", "abc123", Some("cover.jpg")).is_ok());
        assert!(validate_plugin_cache_path("my-plugin", "subdir", Some("file.png")).is_ok());
    }

    #[test]
    fn test_validate_plugin_cache_path_rejects_traversal() {
        assert!(validate_plugin_cache_path("..", "sub", Some("f.jpg")).is_err());
        assert!(validate_plugin_cache_path("ok", "..", Some("f.jpg")).is_err());
        assert!(validate_plugin_cache_path("ok", "sub", Some("../f.jpg")).is_err());
    }

    #[test]
    fn test_validate_plugin_cache_path_rejects_slashes() {
        assert!(validate_plugin_cache_path("a/b", "sub", Some("f.jpg")).is_err());
        assert!(validate_plugin_cache_path("ok", "a/b", Some("f.jpg")).is_err());
        assert!(validate_plugin_cache_path("ok", "sub", Some("a/b.jpg")).is_err());
        assert!(validate_plugin_cache_path("a\\b", "sub", Some("f.jpg")).is_err());
        assert!(validate_plugin_cache_path("ok", "a\\b", Some("f.jpg")).is_err());
    }

    #[test]
    fn test_validate_plugin_cache_path_rejects_empty() {
        assert!(validate_plugin_cache_path("", "sub", Some("f.jpg")).is_err());
        assert!(validate_plugin_cache_path("ok", "", Some("f.jpg")).is_err());
        assert!(validate_plugin_cache_path("ok", "sub", Some("")).is_err());
    }

    #[test]
    fn test_validate_plugin_cache_path_filename_optional() {
        assert!(validate_plugin_cache_path("ok", "sub", None).is_ok());
    }

    // ---- New path-segment validator ----

    #[test]
    fn test_validate_path_segment_accepts_normal() {
        assert!(validate_path_segment("playlists").is_ok());
        assert!(validate_path_segment("Made for You").is_ok());
        assert!(validate_path_segment("Your '90s Top Hits").is_ok());
        assert!(validate_path_segment("abc123").is_ok());
        assert!(validate_path_segment("tracks.json").is_ok());
        assert!(validate_path_segment("cover.jpg").is_ok());
    }

    #[test]
    fn test_validate_path_segment_rejects_traversal() {
        assert!(validate_path_segment("..").is_err());
        assert!(validate_path_segment(".").is_err());
    }

    #[test]
    fn test_validate_path_segment_rejects_separators() {
        assert!(validate_path_segment("a/b").is_err());
        assert!(validate_path_segment("a\\b").is_err());
        assert!(validate_path_segment("a\0b").is_err());
    }

    #[test]
    fn test_validate_path_segment_rejects_empty() {
        assert!(validate_path_segment("").is_err());
    }

    #[test]
    fn test_validate_path_segment_rejects_control_chars() {
        assert!(validate_path_segment("hello\nworld").is_err());
        assert!(validate_path_segment("hello\x01").is_err());
    }

    #[test]
    fn test_validate_path_segment_rejects_windows_reserved() {
        assert!(validate_path_segment("CON").is_err());
        assert!(validate_path_segment("PRN.txt").is_err());
        assert!(validate_path_segment("nul").is_err()); // case-insensitive
        assert!(validate_path_segment("COM1").is_err());
    }

    #[test]
    fn test_validate_path_segment_length_cap() {
        assert!(validate_path_segment(&"a".repeat(255)).is_ok());
        assert!(validate_path_segment(&"a".repeat(256)).is_err());
    }

    #[test]
    fn test_resolve_plugin_path_builds_nested() {
        let tmp = std::env::temp_dir();
        let (root, target) = resolve_plugin_path(
            &tmp,
            "spotify-browse",
            &["playlists".to_string(), "Made for You".to_string(), "abc".to_string(), "meta.json".to_string()],
        )
        .expect("should build path");
        assert!(target.starts_with(&root));
        assert!(target.ends_with("meta.json"));
        assert!(target.to_string_lossy().contains("Made for You"));
    }

    #[test]
    fn test_resolve_plugin_path_rejects_empty_path() {
        let tmp = std::env::temp_dir();
        assert!(resolve_plugin_path(&tmp, "ok", &[]).is_err());
    }

    #[test]
    fn test_resolve_plugin_path_rejects_bad_plugin_id() {
        let tmp = std::env::temp_dir();
        assert!(resolve_plugin_path(&tmp, "../evil", &["x".to_string()]).is_err());
        assert!(resolve_plugin_path(&tmp, "a/b", &["x".to_string()]).is_err());
    }
}

