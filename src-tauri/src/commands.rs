use serde::{Serialize, Deserialize};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::Database;
use crate::downloader::{DownloadFormat, DownloadManager, DownloadRequest};
use crate::lastfm::LastfmClient;
use crate::models::*;
use crate::musicgateway::{self, MusicGatewayClient};
use crate::scanner;
use crate::skins;
use crate::subsonic::SubsonicClient;

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
    Artist { id: i64, name: String },
    Album { id: i64, title: String, artist_name: Option<String> },
    Tag { id: i64, name: String },
}

pub struct DownloadQueue {
    pub queue: Mutex<Vec<ImageDownloadRequest>>,
    pub condvar: Condvar,
}

pub struct AppState {
    pub db: Arc<Database>,
    pub app_dir: std::path::PathBuf,
    pub app_data_dir: std::path::PathBuf,
    pub profile_name: String,
    pub download_queue: Arc<DownloadQueue>,
    pub track_download_manager: Arc<DownloadManager>,
    pub lastfm: LastfmClient,
    pub lastfm_session: Mutex<Option<(String, String)>>,  // (session_key, username)
    pub lastfm_importing: Arc<AtomicBool>,
    pub auto_import_running: Arc<AtomicBool>,
    pub auto_import_interval: Arc<AtomicU64>,  // minutes
    pub auto_import_last_at: Arc<AtomicI64>,   // unix timestamp, 0 = never
    pub musicgateway_url: Mutex<Option<String>>,
    pub musicgateway_process: Mutex<Option<std::process::Child>>,
    pub native_plugins_dir: Option<std::path::PathBuf>,
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

// --- Profile commands ---

#[tauri::command]
pub fn get_profile_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "profileName": state.profile_name,
        "storePath": format!("profiles/{}/app-state.json", state.profile_name),
    }))
}

// --- Debug commands ---

#[tauri::command]
pub fn open_devtools(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
    }
}

// --- Collection commands ---

#[tauri::command]
pub fn add_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    name: String,
    path: Option<String>,
    url: Option<String>,
    username: Option<String>,
    password: Option<String>,
) -> Result<Collection, String> {
    match kind.as_str() {
        "local" => {
            let folder_path = path.as_deref().ok_or("Path is required for local collections")?;
            let collection = state
                .db
                .add_collection("local", &name, Some(folder_path), None, None, None, None, None)
                .map_err(|e| e.to_string())?;
            let collection_id = collection.id;

            // Start background scan
            let db = state.db.clone();
            let scan_path = folder_path.to_string();
            thread::spawn(move || {
                let start = std::time::Instant::now();
                scanner::scan_folder(&db, &scan_path, Some(collection_id), |scanned, total| {
                    let _ = app.emit(
                        "scan-progress",
                        ScanProgress {
                            folder: scan_path.clone(),
                            scanned,
                            total,
                        },
                    );
                });
                let _ = db.rebuild_fts();
                let _ = db.recompute_counts();
                let _ = db.update_collection_synced(collection_id, start.elapsed().as_secs_f64());
                let _ = app.emit("scan-complete", serde_json::json!({ "folder": scan_path }));
            });

            Ok(collection)
        }
        "subsonic" => {
            let server_url = url.as_deref().ok_or("URL is required for subsonic collections")?;
            let user = username.as_deref().ok_or("Username is required for subsonic collections")?;
            let pass = password.as_deref().ok_or("Password is required for subsonic collections")?;

            // Test connection and determine auth method
            let client = SubsonicClient::new(server_url, user, pass)
                .map_err(|e| format!("Failed to connect: {}", e))?;

            let collection = state
                .db
                .add_collection(
                    "subsonic",
                    &name,
                    None,
                    Some(server_url),
                    Some(user),
                    Some(&client.password_token),
                    client.salt.as_deref(),
                    Some(&client.auth_method),
                )
                .map_err(|e| e.to_string())?;

            let collection_id = collection.id;
            let collection_name = collection.name.clone();

            // Start background sync
            let db = state.db.clone();
            let creds_url = server_url.to_string();
            let creds_user = user.to_string();
            let creds_token = client.password_token.clone();
            let creds_salt = client.salt.clone();
            let creds_method = client.auth_method.clone();

            thread::spawn(move || {
                let client = SubsonicClient::from_stored(
                    &creds_url,
                    &creds_user,
                    &creds_token,
                    creds_salt.as_deref(),
                    &creds_method,
                );
                let _ = app.emit(
                    "sync-progress",
                    SyncProgress {
                        collection: collection_name.clone(),
                        synced: 0,
                        total: 0,
                    },
                );
                match crate::sync::sync_collection(&db, &client, collection_id, |synced, total| {
                    let _ = app.emit(
                        "sync-progress",
                        SyncProgress {
                            collection: collection_name.clone(),
                            synced,
                            total,
                        },
                    );
                }) {
                    Ok(()) => {
                        let _ = app.emit(
                            "sync-complete",
                            serde_json::json!({ "collectionId": collection_id }),
                        );
                    }
                    Err(e) => {
                        log::error!("Sync failed for collection {}: {}", collection_id, e);
                        let _ = db.update_collection_sync_error(collection_id, &e);
                        let _ = app.emit(
                            "sync-error",
                            serde_json::json!({ "collectionId": collection_id, "error": e }),
                        );
                    }
                }
            });

            Ok(collection)
        }
        "tidal" => {
            Err("TIDAL is configured as an integration in Settings, not as a collection".to_string())
        }
        "seed" => {
            #[cfg(debug_assertions)]
            {
                let collection = state
                    .db
                    .add_collection("seed", &name, None, None, None, None, None, None)
                    .map_err(|e| e.to_string())?;
                crate::seed::seed_database(&state.db, collection.id, 50, 200, 2000)?;
                Ok(collection)
            }
            #[cfg(not(debug_assertions))]
            {
                Err("Seed collections are only available in debug mode".to_string())
            }
        }
        _ => Err(format!("Unknown collection kind: {}", kind)),
    }
}

#[tauri::command]
pub fn remove_collection(state: State<'_, AppState>, collection_id: i64) -> Result<(), String> {
    state
        .db
        .remove_collection(collection_id)
        .map_err(|e| e.to_string())?;
    let _ = state.db.rebuild_fts();
    let _ = state.db.recompute_counts();
    Ok(())
}

#[tauri::command]
pub fn get_collections(state: State<'_, AppState>) -> Result<Vec<Collection>, String> {
    state.db.get_collections().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_collection_stats(state: State<'_, AppState>) -> Result<Vec<CollectionStats>, String> {
    state.db.get_collection_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    name: String,
    auto_update: bool,
    auto_update_interval_mins: i64,
    enabled: bool,
) -> Result<(), String> {
    state
        .db
        .update_collection(collection_id, &name, auto_update, auto_update_interval_mins, enabled)
        .map_err(|e| e.to_string())?;
    state.db.rebuild_fts().map_err(|e| e.to_string())?;
    state.db.recompute_counts().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resync_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    collection_id: i64,
) -> Result<(), String> {
    let collection = state
        .db
        .get_collection_by_id(collection_id)
        .map_err(|e| e.to_string())?;

    match collection.kind.as_str() {
        "local" => {
            let folder_path = collection.path.ok_or("Collection has no path")?;
            let db = state.db.clone();
            let scan_path = folder_path.clone();
            thread::spawn(move || {
                let start = std::time::Instant::now();
                scanner::scan_folder(&db, &scan_path, Some(collection_id), |scanned, total| {
                    let _ = app.emit(
                        "scan-progress",
                        ScanProgress {
                            folder: scan_path.clone(),
                            scanned,
                            total,
                        },
                    );
                });
                let _ = db.rebuild_fts();
                let _ = db.recompute_counts();
                let _ = db.update_collection_synced(collection_id, start.elapsed().as_secs_f64());
                let _ = app.emit("scan-complete", serde_json::json!({ "folder": scan_path }));
            });
            Ok(())
        }
        "subsonic" => {
            let creds = state
                .db
                .get_collection_credentials(collection_id)
                .map_err(|e| e.to_string())?;
            let collection_name = collection.name.clone();
            let db = state.db.clone();

            thread::spawn(move || {
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
                        },
                    );
                }) {
                    Ok(()) => {
                        let _ = app.emit(
                            "sync-complete",
                            serde_json::json!({ "collectionId": collection_id }),
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
            Ok(())
        }
        _ => Ok(()),
    }
}

// --- Library commands ---

#[tauri::command]
pub fn get_artists(state: State<'_, AppState>) -> Result<Vec<Artist>, String> {
    state.db.get_artists().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_albums(
    state: State<'_, AppState>,
    artist_id: Option<i64>,
) -> Result<Vec<Album>, String> {
    state.db.get_albums(artist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_track_count(state: State<'_, AppState>) -> Result<i64, String> {
    state.db.get_track_count().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tracks(
    state: State<'_, AppState>,
    opts: TrackQuery,
) -> Result<Vec<Track>, String> {
    state.db.get_tracks(&opts).map_err(|e| e.to_string())
}

// --- Track lookup command ---

#[tauri::command]
pub fn get_track_by_id(state: State<'_, AppState>, track_id: i64) -> Result<Track, String> {
    state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())
}

// --- Track path command ---

#[tauri::command]
pub fn get_track_path(state: State<'_, AppState>, track_id: i64) -> Result<String, String> {
    let track = state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())?;

    if let Some(remote_id) = &track.subsonic_id {
        let collection_id = track
            .collection_id
            .ok_or("Track has remote_id but no collection_id")?;
        let collection = state
            .db
            .get_collection_by_id(collection_id)
            .map_err(|e| e.to_string())?;

        match collection.kind.as_str() {
            "subsonic" => {
                let creds = state
                    .db
                    .get_collection_credentials(collection_id)
                    .map_err(|e| e.to_string())?;
                let client = SubsonicClient::from_stored(
                    &creds.url,
                    &creds.username,
                    &creds.password_token,
                    creds.salt.as_deref(),
                    &creds.auth_method,
                );
                Ok(client.stream_url(remote_id))
            }
            _ => Err(format!("Unknown collection kind: {}", collection.kind)),
        }
    } else {
        Ok(track.path)
    }
}

#[tauri::command]
pub fn resolve_subsonic_location(
    state: State<'_, AppState>,
    location: String,
) -> Result<String, String> {
    // Parse: subsonic://host(:port)(/path)/rest/stream.view?id=XYZ
    let without_scheme = location
        .strip_prefix("subsonic://")
        .ok_or("Invalid subsonic location: missing subsonic:// prefix")?;
    let host_end = without_scheme
        .find("/rest/")
        .ok_or("Invalid subsonic location: missing /rest/ path")?;
    let host_with_path = &without_scheme[..host_end];

    let track_id = without_scheme
        .split("id=")
        .nth(1)
        .and_then(|s| s.split('&').next())
        .ok_or("No id parameter in subsonic location")?;

    let collections = state.db.get_collections().map_err(|e| e.to_string())?;
    let collection = collections
        .iter()
        .find(|c| {
            c.kind == "subsonic"
                && c.url.as_ref().map_or(false, |u| {
                    u.contains(host_with_path)
                })
        })
        .ok_or_else(|| format!("No subsonic collection found matching host: {}", host_with_path))?;

    let creds = state
        .db
        .get_collection_credentials(collection.id)
        .map_err(|e| e.to_string())?;
    let client = crate::subsonic::SubsonicClient::from_stored(
        &creds.url,
        &creds.username,
        &creds.password_token,
        creds.salt.as_deref(),
        &creds.auth_method,
    );
    Ok(client.stream_url(track_id))
}

#[tauri::command]
pub fn get_tracks_by_paths(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<Track>, String> {
    state.db.get_tracks_by_paths(&paths).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tracks_by_ids(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<Vec<Track>, String> {
    state
        .db
        .get_tracks_by_ids(&ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tracks_by_artist(
    state: State<'_, AppState>,
    artist_id: i64,
) -> Result<Vec<Track>, String> {
    state
        .db
        .get_tracks_by_artist(artist_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tags(state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    state.db.get_tags().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tags_for_track(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<Vec<Tag>, String> {
    state
        .db
        .get_tags_for_track(track_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tracks_by_tag(
    state: State<'_, AppState>,
    tag_id: i64,
) -> Result<Vec<Track>, String> {
    state
        .db
        .get_tracks_by_tag(tag_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_liked(
    state: State<'_, AppState>,
    kind: String,
    id: i64,
    liked: i32,
) -> Result<(), String> {
    let table = match kind.as_str() {
        "track" => "tracks",
        "artist" => "artists",
        "album" => "albums",
        "tag" => "tags",
        _ => return Err(format!("Unknown kind: {}", kind)),
    };
    state.db.toggle_liked(table, id, liked).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_liked_tracks(state: State<'_, AppState>) -> Result<Vec<Track>, String> {
    state.db.get_liked_tracks().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rebuild_search_index(state: State<'_, AppState>) -> Result<(), String> {
    state.db.rebuild_fts().map_err(|e| e.to_string())?;
    state.db.recompute_counts().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_in_folder(state: State<'_, AppState>, track_id: i64) -> Result<(), String> {
    let track = state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())?;

    // Only show in folder for local tracks
    if track.subsonic_id.is_some() {
        return Err("Cannot open folder for server tracks".to_string());
    }

    let path = std::path::Path::new(&track.path);
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(path))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn show_in_folder_path(file_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(path))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_folder(folder_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&folder_path);
    if !path.exists() {
        return Err(format!("Folder not found: {}", folder_path));
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("\"{}\"", path.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_logs_folder(state: State<'_, AppState>) -> Result<(), String> {
    let logs_dir = state.app_data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| e.to_string())?;
    open_folder(logs_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn write_frontend_log(level: String, message: String) -> Result<(), String> {
    match level.as_str() {
        "error" => log::error!("[frontend] {}", message),
        "warn" => log::warn!("[frontend] {}", message),
        _ => log::info!("[frontend] {}", message),
    }
    Ok(())
}

#[tauri::command]
pub fn delete_tracks(state: State<'_, AppState>, track_ids: Vec<i64>) -> Result<Vec<i64>, String> {
    let tracks = state.db.get_tracks_by_ids(&track_ids).map_err(|e| e.to_string())?;
    let mut deleted_ids = Vec::new();
    for track in &tracks {
        if track.subsonic_id.is_some() {
            continue;
        }
        let path = std::path::Path::new(&track.path);
        if path.exists() {
            if let Err(e) = std::fs::remove_file(path) {
                log::warn!("Failed to delete file {}: {}", track.path, e);
                continue;
            }
        }
        deleted_ids.push(track.id);
    }
    state.db.delete_tracks_by_ids(&deleted_ids).map_err(|e| e.to_string())?;
    state.db.recompute_counts().map_err(|e| e.to_string())?;
    Ok(deleted_ids)
}

#[tauri::command]
pub fn bulk_update_tracks(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    track_ids: Vec<i64>,
    fields: BulkUpdateFields,
) -> Result<Vec<String>, String> {
    // Perform DB updates
    let track_info = state.db.bulk_update_tracks(
        &track_ids,
        fields.artist_name.as_deref(),
        fields.album_title.as_deref(),
        fields.year,
        fields.tag_names.as_deref(),
    ).map_err(|e| e.to_string())?;

    // Determine which collections are TIDAL (to skip file writing)
    let tidal_collection_ids: std::collections::HashSet<i64> = state.db.get_collections()
        .unwrap_or_default()
        .iter()
        .filter(|c| c.kind == "tidal")
        .map(|c| c.id)
        .collect();

    // Write tags to local files
    let mut errors = Vec::new();
    let updates = crate::tag_writer::TagUpdates {
        artist: fields.artist_name.clone(),
        album: fields.album_title.clone(),
        year: fields.year.map(|y| y as u32),
        genre: fields.tag_names.as_ref().map(|tags| tags.join(", ")),
    };

    for (_track_id, path, subsonic_id, collection_id) in &track_info {
        // Skip non-local files
        if subsonic_id.is_some() {
            continue;
        }
        if let Some(cid) = collection_id {
            if tidal_collection_ids.contains(cid) {
                continue;
            }
        }
        if path.starts_with("http://") || path.starts_with("https://") {
            continue;
        }

        let file_path = std::path::Path::new(path);
        if !file_path.exists() {
            continue;
        }

        if let Err(e) = crate::tag_writer::write_tags(file_path, &updates) {
            errors.push(format!("{}: {}", path, e));
        }
    }

    let _ = app.emit("bulk-edit-complete", serde_json::json!({}));

    if errors.is_empty() {
        Ok(vec![])
    } else {
        Ok(errors)
    }
}

// --- Entity image commands (generic) ---

fn resolve_entity_slug(state: &AppState, kind: &str, id: i64) -> Result<String, String> {
    let (name, artist_name) = state.db.get_entity_image_name(kind, id).map_err(|e| e.to_string())?;
    Ok(crate::entity_image::entity_image_slug(kind, &name, artist_name.as_deref()))
}

#[tauri::command]
pub fn get_entity_image(state: State<'_, AppState>, kind: String, id: i64) -> Option<String> {
    let slug = resolve_entity_slug(&state, &kind, id).ok()?;
    crate::entity_image::get_image_path(&state.app_dir, &kind, &slug)
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_entity_image_by_name(
    state: State<'_, AppState>,
    kind: String,
    name: String,
    artist_name: Option<String>,
) -> Option<String> {
    let slug = crate::entity_image::entity_image_slug(&kind, &name, artist_name.as_deref());
    crate::entity_image::get_image_path(&state.app_dir, &kind, &slug)
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_entity_image(
    state: State<'_, AppState>,
    kind: String,
    id: i64,
    source_path: String,
) -> Result<String, String> {
    let slug = resolve_entity_slug(&state, &kind, id)?;
    let source = std::path::Path::new(&source_path);
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();
    crate::entity_image::remove_image(&state.app_dir, &kind, &slug);
    let dest_dir = crate::entity_image::image_dir(&state.app_dir, &kind);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.{}", slug, ext));
    std::fs::copy(source, &dest).map_err(|e| format!("Failed to copy image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn paste_entity_image(
    state: State<'_, AppState>,
    kind: String,
    id: i64,
    image_data: Vec<u8>,
) -> Result<String, String> {
    let slug = resolve_entity_slug(&state, &kind, id)?;
    let ext = detect_image_format(&image_data);
    crate::entity_image::remove_image(&state.app_dir, &kind, &slug);
    let dest_dir = crate::entity_image::image_dir(&state.app_dir, &kind);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.{}", slug, ext));
    std::fs::write(&dest, &image_data).map_err(|e| format!("Failed to write image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn remove_entity_image(state: State<'_, AppState>, kind: String, id: i64) {
    if let Ok(slug) = resolve_entity_slug(&state, &kind, id) {
        crate::entity_image::remove_image(&state.app_dir, &kind, &slug);
    }
}

// --- Artist/album image fetch commands ---

#[tauri::command]
pub fn fetch_artist_image(
    state: State<'_, AppState>,
    artist_id: i64,
    artist_name: String,
) {
    log::info!("Queued artist image download: {} (id={})", artist_name, artist_id);
    let mut queue = state.download_queue.queue.lock().unwrap();
    queue.push(ImageDownloadRequest::Artist { id: artist_id, name: artist_name });
    state.download_queue.condvar.notify_one();
}

#[tauri::command]
pub fn fetch_album_image(
    state: State<'_, AppState>,
    album_id: i64,
    album_title: String,
    artist_name: Option<String>,
) {
    log::info!("Queued album image download: {} (id={})", album_title, album_id);
    let mut queue = state.download_queue.queue.lock().unwrap();
    queue.push(ImageDownloadRequest::Album { id: album_id, title: album_title, artist_name });
    state.download_queue.condvar.notify_one();
}

#[tauri::command]
pub fn fetch_tag_image(
    state: State<'_, AppState>,
    tag_id: i64,
    tag_name: String,
) {
    log::info!("Queued tag image generation: {} (id={})", tag_name, tag_id);
    let mut queue = state.download_queue.queue.lock().unwrap();
    queue.push(ImageDownloadRequest::Tag { id: tag_id, name: tag_name });
    state.download_queue.condvar.notify_one();
}

#[tauri::command]
pub fn clear_image_failures(state: State<'_, AppState>) -> Result<(), String> {
    state.db.clear_image_failures().map_err(|e| e.to_string())
}

// --- Play history commands ---

#[tauri::command]
pub fn record_play(state: State<'_, AppState>, track_id: i64) -> Result<(), String> {
    state.db.record_play(track_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history_recent(state: State<'_, AppState>, limit: i64) -> Result<Vec<HistoryEntry>, String> {
    state.db.get_history_recent(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history_most_played(state: State<'_, AppState>, limit: i64) -> Result<Vec<HistoryMostPlayed>, String> {
    state.db.get_history_most_played(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history_most_played_since(state: State<'_, AppState>, since_ts: i64, limit: i64) -> Result<Vec<HistoryMostPlayed>, String> {
    state.db.get_history_most_played_since(since_ts, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history_most_played_artists(state: State<'_, AppState>, limit: i64) -> Result<Vec<HistoryArtistStats>, String> {
    state.db.get_history_most_played_artists(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_history_artists(state: State<'_, AppState>, query: String, limit: i64) -> Result<Vec<HistoryArtistStats>, String> {
    state.db.search_history_artists(&query, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_history_tracks(state: State<'_, AppState>, query: String, limit: i64) -> Result<Vec<HistoryMostPlayed>, String> {
    state.db.search_history_tracks(&query, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reconnect_history_track(state: State<'_, AppState>, history_track_id: i64) -> Result<Option<Track>, String> {
    state.db.reconnect_history_track(history_track_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reconnect_history_artist(state: State<'_, AppState>, history_artist_id: i64) -> Result<Option<i64>, String> {
    state.db.reconnect_history_artist(history_artist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_track_rank(state: State<'_, AppState>, track_id: i64) -> Result<Option<i64>, String> {
    state.db.get_track_rank(track_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_artist_rank(state: State<'_, AppState>, artist_id: i64) -> Result<Option<i64>, String> {
    state.db.get_artist_rank(artist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_auto_continue_track(
    state: State<'_, AppState>,
    strategy: String,
    current_track_id: i64,
    format_filter: Option<String>,
) -> Result<Option<Track>, String> {
    state
        .db
        .get_auto_continue_track(&strategy, current_track_id, format_filter.as_deref())
        .map_err(|e| e.to_string())
}

// --- Playlist commands ---

#[tauri::command]
pub fn save_playlist(
    state: State<'_, AppState>,
    path: String,
    track_ids: Vec<i64>,
) -> Result<(), String> {
    let tracks = state.db.get_tracks_by_ids(&track_ids).map_err(|e| e.to_string())?;
    let mut content = String::from("#EXTM3U\n");
    for track in &tracks {
        let duration = track.duration_secs.unwrap_or(0.0) as i64;
        let artist = track.artist_name.as_deref().unwrap_or("Unknown");
        content.push_str(&format!("#EXTINF:{},{} - {}\n", duration, artist, track.title));
        content.push_str(&track.path);
        content.push('\n');
    }
    std::fs::write(&path, content).map_err(|e| format!("Failed to write playlist: {}", e))
}

#[derive(Debug, Deserialize)]
pub struct QueueEntryPayload {
    pub location: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub duration_secs: Option<f64>,
}

#[tauri::command]
pub fn save_playlist_entries(
    path: String,
    entries: Vec<QueueEntryPayload>,
) -> Result<(), String> {
    let mut content = String::from("#EXTM3U\n");
    for entry in &entries {
        let duration = entry.duration_secs.unwrap_or(0.0) as i64;
        let artist = entry.artist_name.as_deref().unwrap_or("Unknown");
        content.push_str(&format!("#EXTINF:{},{} - {}\n", duration, artist, entry.title));
        content.push_str(&entry.location);
        content.push('\n');
    }
    std::fs::write(&path, content).map_err(|e| format!("Failed to write playlist: {}", e))
}

#[tauri::command]
pub fn load_playlist(
    state: State<'_, AppState>,
    path: String,
) -> Result<PlaylistLoadResult, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read playlist: {}", e))?;
    let playlist_path = std::path::Path::new(&path);
    let parent_dir = playlist_path.parent();

    // Parse EXTINF metadata alongside locations
    let mut entries: Vec<(String, Option<String>, Option<String>, Option<f64>)> = Vec::new(); // (location, title, artist, duration)
    let mut pending_extinf: Option<(String, Option<String>, f64)> = None; // (title, artist, duration)

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if line.starts_with("#EXTINF:") {
            // Parse: #EXTINF:duration,Artist - Title
            if let Some(rest) = line.strip_prefix("#EXTINF:") {
                let parts: Vec<&str> = rest.splitn(2, ',').collect();
                let dur = parts.first().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                let display = parts.get(1).unwrap_or(&"");
                let (artist, title) = if let Some(idx) = display.find(" - ") {
                    (Some(display[..idx].to_string()), display[idx + 3..].to_string())
                } else {
                    (None, display.to_string())
                };
                pending_extinf = Some((title, artist, dur));
            }
            continue;
        }
        if line.starts_with('#') { continue; }

        // Resolve the location
        let location = if line.contains("://") || std::path::Path::new(line).is_absolute() {
            line.to_string()
        } else if let Some(parent) = parent_dir {
            // Relative path — resolve relative to playlist, treat as file://
            format!("file://{}", parent.join(line).to_string_lossy())
        } else {
            format!("file://{}", line)
        };

        let (title, artist, dur) = pending_extinf.take().unwrap_or_else(|| {
            // Derive title from location
            let name = location.rsplit('/').next().unwrap_or(&location).to_string();
            (name, None, 0.0)
        });

        entries.push((location, Some(title), artist, Some(dur)));
    }

    // Resolve entries to Track objects
    let mut tracks: Vec<Track> = Vec::new();
    let mut not_found = 0usize;

    // Batch-resolve file:// paths
    let file_paths: Vec<String> = entries.iter()
        .filter(|(loc, _, _, _)| loc.starts_with("file://"))
        .map(|(loc, _, _, _)| loc[7..].to_string())
        .collect();
    let db_tracks = if !file_paths.is_empty() {
        state.db.get_tracks_by_paths(&file_paths).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let db_by_path: std::collections::HashMap<String, &Track> =
        db_tracks.iter().map(|t| (t.path.clone(), t)).collect();

    let mut tidal_counter: i64 = -200000;

    for (location, title, artist, dur) in &entries {
        if location.starts_with("file://") {
            let file_path = &location[7..];
            if let Some(track) = db_by_path.get(file_path) {
                tracks.push((*track).clone());
            } else {
                not_found += 1;
            }
        } else if location.starts_with("tidal://") {
            let tidal_id = &location[8..];
            tidal_counter -= 1;
            tracks.push(Track {
                id: tidal_counter,
                path: String::new(),
                title: title.clone().unwrap_or_default(),
                artist_id: None,
                artist_name: artist.clone(),
                album_id: None,
                album_title: None,
                year: None,
                track_number: None,
                duration_secs: *dur,
                format: None,
                file_size: None,
                collection_id: None,
                collection_name: None,
                subsonic_id: Some(tidal_id.to_string()),
                liked: 0,
                youtube_url: None,
                added_at: None,
                modified_at: None,
            });
        } else if location.starts_with("subsonic://") {
            // Try to find in DB by subsonic_id
            let id_match = location.split("id=").nth(1).and_then(|s| s.split('&').next());
            if let Some(remote_id) = id_match {
                let collections = state.db.get_collections().map_err(|e| e.to_string())?;
                let mut found = false;
                for col in collections.iter().filter(|c| c.kind == "subsonic") {
                    if let Ok(matched) = state.db.get_tracks_by_subsonic_id(remote_id, col.id) {
                        if let Some(track) = matched.into_iter().next() {
                            tracks.push(track);
                            found = true;
                            break;
                        }
                    }
                }
                if !found {
                    // Create minimal track
                    tracks.push(Track {
                        id: 0,
                        path: String::new(),
                        title: title.clone().unwrap_or_default(),
                        artist_id: None,
                        artist_name: artist.clone(),
                        album_id: None,
                        album_title: None,
                        year: None,
                        track_number: None,
                        duration_secs: *dur,
                        format: None,
                        file_size: None,
                        collection_id: None,
                        collection_name: None,
                        subsonic_id: Some(remote_id.to_string()),
                        liked: 0,
                        youtube_url: None,
                        added_at: None,
                        modified_at: None,
                    });
                }
            } else {
                not_found += 1;
            }
        } else {
            // Legacy: plain file path (backward compat with old M3U files)
            if let Some(track) = db_by_path.get(location.as_str()) {
                tracks.push((*track).clone());
            } else {
                not_found += 1;
            }
        }
    }

    let playlist_name = playlist_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Playlist")
        .to_string();

    Ok(PlaylistLoadResult {
        tracks,
        not_found_count: not_found,
        playlist_name,
    })
}

#[tauri::command]
pub fn get_startup_timings() -> Vec<crate::timing::TimingEntry> {
    crate::timing::timer().get_entries()
}

// --- Connection test commands ---

#[tauri::command]
pub fn test_collection_connection(
    state: State<'_, AppState>,
    collection_id: i64,
) -> Result<String, String> {
    let collection = state
        .db
        .get_collection_by_id(collection_id)
        .map_err(|e| e.to_string())?;

    let result = match collection.kind.as_str() {
        "subsonic" => {
            let creds = state
                .db
                .get_collection_credentials(collection_id)
                .map_err(|e| e.to_string())?;
            let client = SubsonicClient::from_stored(
                &creds.url,
                &creds.username,
                &creds.password_token,
                creds.salt.as_deref(),
                &creds.auth_method,
            );
            client.ping().map_err(|e| format!("{}", e))?;
            Ok("Connected successfully".to_string())
        }
        "tidal" => {
            let url = collection.url.ok_or("Collection has no URL")?;
            let api_url = format!("{}/", url.trim_end_matches('/'));
            let resp = reqwest::blocking::get(&api_url)
                .map_err(|e| format!("HTTP error: {}", e))?;
            let body = resp.text().map_err(|e| format!("Failed to read response: {}", e))?;
            let json: serde_json::Value =
                serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;
            let version = json["version"].as_str().unwrap_or("unknown");
            Ok(format!("Connected (API v{})", version))
        }
        _ => Err(format!("Connection test not supported for '{}' collections", collection.kind)),
    };

    match &result {
        Ok(_) => { let _ = state.db.clear_collection_sync_error(collection_id); }
        Err(e) => { let _ = state.db.update_collection_sync_error(collection_id, e); }
    }

    result
}

#[tauri::command]
pub fn subsonic_test_connection(
    url: String,
    username: String,
    password: String,
) -> Result<String, String> {
    log::info!("subsonic_test_connection called with url: {}", url);
    SubsonicClient::new(&url, &username, &password)
        .map_err(|e| format!("{}", e))?;
    Ok("Connected successfully".to_string())
}

// --- TIDAL commands ---

/// Legacy alias — delegates to musicgateway_ping.
#[tauri::command]
pub async fn tidal_test_connection(url: String) -> Result<MusicGatewayPingResult, String> {
    musicgateway_ping(url).await
}

#[tauri::command]
pub fn set_musicgateway_url(state: State<'_, AppState>, url: Option<String>) -> Result<(), String> {
    let cleaned = url
        .filter(|u| !u.trim().is_empty())
        .map(|u| u.trim().trim_end_matches('/').to_string());
    musicgateway::set_global_url(cleaned.clone());
    *state.musicgateway_url.lock().unwrap() = cleaned;
    Ok(())
}

#[tauri::command]
pub fn get_musicgateway_url(state: State<'_, AppState>) -> Option<String> {
    state.musicgateway_url.lock().unwrap().clone()
}

#[derive(Serialize)]
pub struct MusicGatewayPingResult {
    pub version: String,
    pub bin: Option<String>,
}

#[tauri::command]
pub async fn musicgateway_ping(url: String) -> Result<MusicGatewayPingResult, String> {
    let trimmed = url.trim().trim_end_matches('/').to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<MusicGatewayPingResult, String> {
        let client = MusicGatewayClient::new(&trimmed);
        let identity = client.ping().map_err(|e| e.to_string())?;
        Ok(MusicGatewayPingResult {
            version: identity.version,
            bin: identity.bin,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn start_musicgateway_server(
    state: State<'_, AppState>,
    exe_path: String,
) -> Result<(), String> {
    // Kill any existing managed process first
    let mut proc = state.musicgateway_process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        let _ = child.kill();
        let _ = child.wait();
    }

    let child = std::process::Command::new(&exe_path)
        .arg("--silent")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start MusicGateAway: {}", e))?;

    log::info!("Started MusicGateAway (pid {}): {}", child.id(), exe_path);
    *proc = Some(child);
    Ok(())
}

#[tauri::command]
pub fn stop_musicgateway_server(state: State<'_, AppState>) -> Result<(), String> {
    // Try graceful API shutdown first
    if let Some(url) = state.musicgateway_url.lock().unwrap().clone() {
        let client = MusicGatewayClient::new(&url);
        let _ = client.shutdown();
        log::info!("Sent shutdown request to MusicGateAway");
    }
    // Clean up the process handle (wait for exit, kill as fallback)
    let mut proc = state.musicgateway_process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        match child.try_wait() {
            Ok(Some(_)) => log::info!("MusicGateAway exited after shutdown"),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                log::info!("MusicGateAway killed as fallback");
            }
        }
    }
    *proc = None;
    Ok(())
}

#[tauri::command]
pub async fn tidal_search(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
    offset: u32,
) -> Result<TidalSearchResult, String> {
    let mga_url = state.musicgateway_url.lock().unwrap().clone()
        .ok_or("MusicGateAway URL not configured. Set it in Settings > Integrations.")?;
    tauri::async_runtime::spawn_blocking(move || -> Result<TidalSearchResult, String> {
        let client = MusicGatewayClient::new(&mga_url);
        client.search(&query, limit, offset).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn tidal_save_track(
    state: State<'_, AppState>,
    tidal_track_id: String,
    dest_collection_id: Option<i64>,
    custom_dest_path: Option<String>,
    format: String,
) -> Result<u64, String> {
    let mga_url = state.musicgateway_url.lock().unwrap().clone()
        .ok_or("MusicGateAway URL not configured. Set it in Settings > Integrations.")?;
    let fmt = DownloadFormat::from_str(&format)?;
    let client = MusicGatewayClient::new(&mga_url);

    let info = client
        .get_track(&tidal_track_id)
        .map_err(|e| e.to_string())?;

    let (collection_id, dest_path) = if let Some(custom) = custom_dest_path {
        (0, custom)
    } else {
        let cid = dest_collection_id.ok_or("Either dest_collection_id or custom_dest_path is required")?;
        let dest_collection = state
            .db
            .get_collection_by_id(cid)
            .map_err(|e| e.to_string())?;
        let path = dest_collection
            .path
            .ok_or("Destination collection has no path")?;
        (cid, path)
    };

    let cover_url = info
        .cover_id
        .as_deref()
        .map(|id| musicgateway::cover_url(id, 1280));

    let id = state.track_download_manager.next_id();
    let request = DownloadRequest {
        id,
        track_title: info.title,
        artist_name: info
            .artist_name
            .unwrap_or_else(|| "Unknown Artist".to_string()),
        album_title: info
            .album_title
            .unwrap_or_else(|| "Unknown Album".to_string()),
        track_number: info.track_number.map(|n| n as u32),
        genre: None,
        year: None,
        cover_url,
        source_kind: "tidal".to_string(),
        source_collection_id: None,
        source_override_url: Some(mga_url),
        remote_track_id: tidal_track_id,
        dest_collection_id: collection_id,
        dest_collection_path: dest_path,
        format: fmt,
        is_batch_last: true,
    };

    state.track_download_manager.enqueue(request);
    Ok(id)
}

#[tauri::command]
pub fn tidal_get_stream_url(
    state: State<'_, AppState>,
    tidal_track_id: String,
    quality: Option<String>,
) -> Result<String, String> {
    let mga_url = state.musicgateway_url.lock().unwrap().clone()
        .ok_or("MusicGateAway URL not configured. Set it in Settings > Integrations.")?;
    let client = MusicGatewayClient::new(&mga_url);
    let info = client
        .get_stream_url(&tidal_track_id, quality.as_deref().unwrap_or("LOSSLESS"))
        .map_err(|e| e.to_string())?;
    Ok(info.url)
}

#[tauri::command]
pub fn tidal_get_album(
    state: State<'_, AppState>,
    album_id: String,
) -> Result<TidalAlbumDetail, String> {
    let mga_url = state.musicgateway_url.lock().unwrap().clone()
        .ok_or("MusicGateAway URL not configured. Set it in Settings > Integrations.")?;
    let client = MusicGatewayClient::new(&mga_url);
    client.get_album(&album_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tidal_get_artist(
    state: State<'_, AppState>,
    artist_id: String,
) -> Result<TidalArtistDetail, String> {
    let mga_url = state.musicgateway_url.lock().unwrap().clone()
        .ok_or("MusicGateAway URL not configured. Set it in Settings > Integrations.")?;
    let client = MusicGatewayClient::new(&mga_url);
    client.get_artist(&artist_id).map_err(|e| e.to_string())
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn clear_database(state: State<'_, AppState>) -> Result<String, String> {
    state.db.clear_database().map_err(|e| e.to_string())?;
    Ok("Database cleared".to_string())
}

// --- YouTube URL commands ---

#[tauri::command]
pub fn set_track_youtube_url(
    state: State<'_, AppState>,
    track_id: i64,
    url: String,
) -> Result<(), String> {
    state
        .db
        .set_track_youtube_url(track_id, &url)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_track_youtube_url(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<(), String> {
    state
        .db
        .clear_track_youtube_url(track_id)
        .map_err(|e| e.to_string())
}

// --- YouTube search command ---

#[derive(serde::Serialize)]
pub struct YouTubeResult {
    pub url: String,
    pub video_title: Option<String>,
}

fn extract_first_video_id(data: &serde_json::Value) -> Option<String> {
    data.get("contents")?
        .get("twoColumnSearchResultsRenderer")?
        .get("primaryContents")?
        .get("sectionListRenderer")?
        .get("contents")?
        .as_array()?
        .iter()
        .filter_map(|section| {
            section
                .get("itemSectionRenderer")?
                .get("contents")?
                .as_array()
        })
        .flatten()
        .find_map(|item| {
            item.get("videoRenderer")?
                .get("videoId")?
                .as_str()
                .map(String::from)
        })
}

fn extract_video_title(data: &serde_json::Value) -> Option<String> {
    data.get("contents")?
        .get("twoColumnSearchResultsRenderer")?
        .get("primaryContents")?
        .get("sectionListRenderer")?
        .get("contents")?
        .as_array()?
        .iter()
        .filter_map(|section| {
            section
                .get("itemSectionRenderer")?
                .get("contents")?
                .as_array()
        })
        .flatten()
        .find_map(|item| {
            item.get("videoRenderer")?
                .get("title")?
                .get("runs")?
                .as_array()?
                .first()?
                .get("text")?
                .as_str()
                .map(String::from)
        })
}

#[tauri::command]
pub fn search_youtube(title: String, artist_name: Option<String>) -> Result<YouTubeResult, String> {
    let query = match &artist_name {
        Some(artist) => format!("{} {}", title, artist),
        None => title,
    };
    let encoded = urlencoding::encode(&query);
    let url = format!("https://www.youtube.com/results?search_query={}", encoded);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let start = std::time::Instant::now();
    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send()
        .map_err(|e| format!("HTTP request failed: {}", e))?;
    log::info!("HTTP GET youtube/search -> {} ({:.0}ms)", resp.status(), start.elapsed().as_secs_f64() * 1000.0);

    let body = resp.text().map_err(|e| format!("Failed to read response: {}", e))?;

    let re = regex::Regex::new(r"var ytInitialData = (\{.*?\});</script>")
        .map_err(|e| e.to_string())?;

    let json_str = re
        .captures(&body)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str())
        .ok_or("Could not find ytInitialData in page")?;

    let data: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("Failed to parse ytInitialData: {}", e))?;

    let video_id = extract_first_video_id(&data)
        .ok_or("No video found in search results")?;

    let video_title = extract_video_title(&data);

    Ok(YouTubeResult {
        url: format!("https://www.youtube.com/watch?v={}", video_id),
        video_title,
    })
}

// --- Track audio properties command ---

#[derive(serde::Serialize)]
pub struct AudioProperties {
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u8>,
    pub channels: Option<u8>,
    pub bitrate: Option<u32>,
}

#[tauri::command]
pub fn get_track_audio_properties(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<AudioProperties, String> {
    let track = state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())?;
    let path = track.path;

    use lofty::prelude::*;

    let tagged_file = lofty::probe::Probe::open(&path)
        .and_then(|p| p.read())
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let props = tagged_file.properties();

    Ok(AudioProperties {
        sample_rate: props.sample_rate(),
        bit_depth: props.bit_depth(),
        channels: props.channels(),
        bitrate: props.overall_bitrate(),
    })
}

// --- Last.fm commands ---

#[tauri::command]
pub fn lastfm_get_auth_url(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.lastfm.get_auth_url("viboplr://lastfm-callback"))
}

#[tauri::command]
pub fn lastfm_authenticate(state: State<'_, AppState>, token: String) -> Result<(LastfmStatus, String), String> {
    let (session_key, username) = state.lastfm.get_session(&token).map_err(|e| e.to_string())?;
    *state.lastfm_session.lock().unwrap() = Some((session_key.clone(), username.clone()));
    Ok((LastfmStatus { connected: true, username: Some(username) }, session_key))
}

#[tauri::command]
pub fn lastfm_set_session(state: State<'_, AppState>, session_key: String, username: String) {
    *state.lastfm_session.lock().unwrap() = Some((session_key, username));
}

#[tauri::command]
pub fn lastfm_disconnect(state: State<'_, AppState>) {
    *state.lastfm_session.lock().unwrap() = None;
}

#[tauri::command]
pub fn lastfm_get_status(state: State<'_, AppState>) -> LastfmStatus {
    let session = state.lastfm_session.lock().unwrap();
    match session.as_ref() {
        Some((_, username)) => LastfmStatus { connected: true, username: Some(username.clone()) },
        None => LastfmStatus { connected: false, username: None },
    }
}

#[tauri::command]
pub fn lastfm_now_playing(state: State<'_, AppState>, app: AppHandle, track_id: i64) {
    let session = state.lastfm_session.lock().unwrap().clone();
    let Some((session_key, _)) = session else { return };

    let track = match state.db.get_track_by_id(track_id) {
        Ok(t) => t,
        _ => return,
    };
    let Some(artist) = track.artist_name.as_deref() else { return };

    let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
    let title = track.title.clone();
    let artist_str = artist.to_string();
    let album = track.album_title.clone();
    let duration = track.duration_secs;
    let app_handle = app.clone();

    thread::spawn(move || {
        if let Err(e) = lastfm.update_now_playing(
            &session_key, &artist_str, &title, album.as_deref(), duration,
        ) {
            log::warn!("Last.fm now_playing error: {}", e);
            if e.to_string().starts_with("auth_error:") {
                let _ = app_handle.emit("lastfm-auth-error", ());
            }
        }
    });
}

#[tauri::command]
pub fn lastfm_scrobble(state: State<'_, AppState>, app: AppHandle, track_id: i64, started_at: i64) {
    let session = state.lastfm_session.lock().unwrap().clone();
    let Some((session_key, _)) = session else { return };

    let track = match state.db.get_track_by_id(track_id) {
        Ok(t) => t,
        _ => return,
    };
    let Some(artist) = track.artist_name.as_deref() else { return };

    let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
    let title = track.title.clone();
    let artist_str = artist.to_string();
    let album = track.album_title.clone();
    let duration = track.duration_secs;
    let app_handle = app.clone();

    thread::spawn(move || {
        if let Err(e) = lastfm.scrobble(
            &session_key, &artist_str, &title, started_at, album.as_deref(), duration,
        ) {
            log::warn!("Last.fm scrobble error: {}", e);
            if e.to_string().starts_with("auth_error:") {
                let _ = app_handle.emit("lastfm-auth-error", ());
            }
        }
    });
}

#[tauri::command]
pub fn lastfm_import_history(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    // Concurrency guard
    if state.lastfm_importing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("Import already in progress".to_string());
    }

    let session = state.lastfm_session.lock().unwrap().clone();
    let (_, username) = session.ok_or("Not connected to Last.fm")?;

    let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
    let db = state.db.clone();
    let app_handle = app.clone();
    let importing_flag = state.lastfm_importing.clone();

    thread::spawn(move || {
        let mut total_imported: u64 = 0;
        let mut total_skipped: u64 = 0;
        let mut page: u32 = 1;
        let limit: u32 = 200;

        let result: Result<(), String> = (|| {
            // First call to get total pages
            let first_resp = lastfm.get_recent_tracks(&username, 1, limit, None)
                .map_err(|e| e.to_string())?;
            let total_pages: u32 = first_resp.recenttracks.attr.total_pages.parse().unwrap_or(1);

            // Process first page
            let plays: Vec<(String, String, i64)> = first_resp.recenttracks.track.iter()
                .filter(|t| t.date.is_some()) // skip "now playing"
                .filter_map(|t| {
                    t.date.as_ref().and_then(|d| d.uts.parse::<i64>().ok())
                        .map(|ts| (t.artist.text.clone(), t.name.clone(), ts))
                })
                .collect();

            if !plays.is_empty() {
                let (imp, skip) = db.record_history_plays_batch(&plays).map_err(|e| e.to_string())?;
                total_imported += imp;
                total_skipped += skip;
            }

            let _ = app_handle.emit("lastfm-import-progress", LastfmImportProgress {
                page: 1, total_pages, imported: total_imported, skipped: total_skipped,
            });

            page = 2;
            while page <= total_pages {
                // Check for cancellation
                if !importing_flag.load(Ordering::SeqCst) {
                    return Err("cancelled".to_string());
                }

                std::thread::sleep(std::time::Duration::from_millis(200));

                let resp = lastfm.get_recent_tracks(&username, page, limit, None)
                    .map_err(|e| e.to_string())?;

                let plays: Vec<(String, String, i64)> = resp.recenttracks.track.iter()
                    .filter(|t| t.date.is_some())
                    .filter_map(|t| {
                        t.date.as_ref().and_then(|d| d.uts.parse::<i64>().ok())
                            .map(|ts| (t.artist.text.clone(), t.name.clone(), ts))
                    })
                    .collect();

                if !plays.is_empty() {
                    let (imp, skip) = db.record_history_plays_batch(&plays).map_err(|e| e.to_string())?;
                    total_imported += imp;
                    total_skipped += skip;
                }

                let _ = app_handle.emit("lastfm-import-progress", LastfmImportProgress {
                    page, total_pages, imported: total_imported, skipped: total_skipped,
                });

                page += 1;
            }

            Ok(())
        })();

        importing_flag.store(false, Ordering::SeqCst);

        match result {
            Ok(()) => {
                let _ = app_handle.emit("lastfm-import-complete", serde_json::json!({
                    "imported": total_imported,
                    "skipped": total_skipped,
                }));
            }
            Err(e) => {
                let _ = app_handle.emit("lastfm-import-error", e);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn lastfm_cancel_import(state: State<'_, AppState>) {
    state.lastfm_importing.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn lastfm_start_auto_import(
    state: State<'_, AppState>,
    app: AppHandle,
    interval_mins: u64,
    last_import_at: Option<i64>,
) -> Result<(), String> {
    // Double-start guard
    if state.auto_import_running.load(Ordering::SeqCst) {
        return Ok(());
    }
    state.auto_import_running.store(true, Ordering::SeqCst);
    state.auto_import_interval.store(interval_mins, Ordering::SeqCst);
    if let Some(ts) = last_import_at {
        state.auto_import_last_at.store(ts, Ordering::SeqCst);
    }

    let running = state.auto_import_running.clone();
    let interval = state.auto_import_interval.clone();
    let last_at = state.auto_import_last_at.clone();
    let importing = state.lastfm_importing.clone();
    let db = state.db.clone();
    let app_handle = app.clone();

    thread::spawn(move || {
        // Initial delay to let the app finish initializing
        for _ in 0..1 {
            if !running.load(Ordering::SeqCst) { return; }
            thread::sleep(std::time::Duration::from_secs(10));
        }

        loop {
            let interval_secs = interval.load(Ordering::SeqCst) * 60;
            let mut elapsed = 0u64;

            // Sleep in 10-sec chunks, checking running flag
            while elapsed < interval_secs {
                if !running.load(Ordering::SeqCst) { return; }
                thread::sleep(std::time::Duration::from_secs(10));
                elapsed += 10;
            }

            if !running.load(Ordering::SeqCst) { return; }

            // Re-read session each cycle (may have reconnected/disconnected)
            let username = {
                let state = app_handle.state::<AppState>();
                let session = state.lastfm_session.lock().unwrap().clone();
                match session {
                    Some((_, u)) => u,
                    None => {
                        log::info!("Last.fm auto-import: not connected, skipping cycle");
                        continue;
                    }
                }
            };

            // Try to acquire the import lock
            if importing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                log::info!("Last.fm auto-import: manual import in progress, skipping cycle");
                continue;
            }

            let timestamp_before = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;

            let stored_last_at = last_at.load(Ordering::SeqCst);
            let from = if stored_last_at > 0 { Some(stored_last_at + 1) } else { None };

            log::info!("Last.fm auto-import: starting (from={:?})", from);

            let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
            let mut total_imported: u64 = 0;
            let mut total_skipped: u64 = 0;

            let result: Result<(), String> = (|| {
                let first_resp = lastfm.get_recent_tracks(&username, 1, 200, from)
                    .map_err(|e| e.to_string())?;
                let total_pages: u32 = first_resp.recenttracks.attr.total_pages.parse().unwrap_or(1);

                let plays: Vec<(String, String, i64)> = first_resp.recenttracks.track.iter()
                    .filter(|t| t.date.is_some())
                    .filter_map(|t| {
                        t.date.as_ref().and_then(|d| d.uts.parse::<i64>().ok())
                            .map(|ts| (t.artist.text.clone(), t.name.clone(), ts))
                    })
                    .collect();

                if !plays.is_empty() {
                    let (imp, skip) = db.record_history_plays_batch(&plays).map_err(|e| e.to_string())?;
                    total_imported += imp;
                    total_skipped += skip;
                }

                // Early stop: if first page yielded nothing new and we had a from filter
                if from.is_some() && total_imported == 0 && total_pages <= 1 {
                    return Ok(());
                }

                let mut page: u32 = 2;
                while page <= total_pages {
                    if !running.load(Ordering::SeqCst) || !importing.load(Ordering::SeqCst) {
                        return Err("cancelled".to_string());
                    }

                    thread::sleep(std::time::Duration::from_millis(200));

                    let resp = lastfm.get_recent_tracks(&username, page, 200, from)
                        .map_err(|e| e.to_string())?;

                    let plays: Vec<(String, String, i64)> = resp.recenttracks.track.iter()
                        .filter(|t| t.date.is_some())
                        .filter_map(|t| {
                            t.date.as_ref().and_then(|d| d.uts.parse::<i64>().ok())
                                .map(|ts| (t.artist.text.clone(), t.name.clone(), ts))
                        })
                        .collect();

                    if !plays.is_empty() {
                        let (imp, skip) = db.record_history_plays_batch(&plays).map_err(|e| e.to_string())?;
                        total_imported += imp;
                        total_skipped += skip;

                        // Early stop: full page all skipped
                        if imp == 0 {
                            break;
                        }
                    }

                    page += 1;
                }

                Ok(())
            })();

            importing.store(false, Ordering::SeqCst);

            match result {
                Ok(()) => {
                    last_at.store(timestamp_before, Ordering::SeqCst);
                    log::info!("Last.fm auto-import complete: {} imported, {} skipped", total_imported, total_skipped);
                    let _ = app_handle.emit("lastfm-import-complete", serde_json::json!({
                        "imported": total_imported,
                        "skipped": total_skipped,
                        "timestamp": timestamp_before,
                        "source": "auto",
                    }));
                }
                Err(ref e) if e == "cancelled" => {
                    log::info!("Last.fm auto-import cancelled");
                }
                Err(e) => {
                    log::warn!("Last.fm auto-import error: {}", e);
                    let _ = app_handle.emit("lastfm-import-error", serde_json::json!({
                        "message": e,
                        "source": "auto",
                    }));
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn lastfm_stop_auto_import(state: State<'_, AppState>) {
    state.auto_import_running.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn lastfm_set_auto_import_interval(state: State<'_, AppState>, interval_mins: u64) {
    state.auto_import_interval.store(interval_mins, Ordering::SeqCst);
}

#[tauri::command]
pub fn lastfm_love_track(state: State<'_, AppState>, app: AppHandle, track_id: i64) {
    let session = state.lastfm_session.lock().unwrap().clone();
    let Some((session_key, _)) = session else { return };

    let track = match state.db.get_track_by_id(track_id) {
        Ok(t) => t,
        _ => return,
    };
    let Some(artist) = track.artist_name.as_deref() else { return };

    let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
    let title = track.title.clone();
    let artist_str = artist.to_string();
    let app_handle = app.clone();

    thread::spawn(move || {
        if let Err(e) = lastfm.love_track(&session_key, &artist_str, &title) {
            log::warn!("Last.fm love error: {}", e);
            if e.to_string().starts_with("auth_error:") {
                let _ = app_handle.emit("lastfm-auth-error", ());
            }
        }
    });
}

#[tauri::command]
pub fn lastfm_unlove_track(state: State<'_, AppState>, app: AppHandle, track_id: i64) {
    let session = state.lastfm_session.lock().unwrap().clone();
    let Some((session_key, _)) = session else { return };

    let track = match state.db.get_track_by_id(track_id) {
        Ok(t) => t,
        _ => return,
    };
    let Some(artist) = track.artist_name.as_deref() else { return };

    let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
    let title = track.title.clone();
    let artist_str = artist.to_string();
    let app_handle = app.clone();

    thread::spawn(move || {
        if let Err(e) = lastfm.unlove_track(&session_key, &artist_str, &title) {
            log::warn!("Last.fm unlove error: {}", e);
            if e.to_string().starts_with("auth_error:") {
                let _ = app_handle.emit("lastfm-auth-error", ());
            }
        }
    });
}

#[tauri::command]
pub fn lastfm_get_similar_artists(state: State<'_, AppState>, app: AppHandle, artist_name: String, limit: Option<u32>) -> Option<serde_json::Value> {
    let cache_key = format!("similar_artists:{}", artist_name.to_lowercase());
    if let Ok(Some(cached)) = state.db.lastfm_cache_get(&cache_key) {
        return Some(cached);
    }
    let db = state.db.clone();
    let lim = limit.unwrap_or(10);
    let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
    thread::spawn(move || {
        if let Ok(value) = lastfm.get_similar_artists(&artist_name, lim) {
            let _ = db.lastfm_cache_set(&cache_key, &value);
            let _ = app.emit("lastfm-similar-artists", value);
        }
    });
    None
}

#[tauri::command]
pub fn lastfm_get_similar_tracks(state: State<'_, AppState>, app: AppHandle, artist_name: String, track_title: String, limit: Option<u32>) -> Option<serde_json::Value> {
    let cache_key = format!("similar_tracks:{}:{}", artist_name.to_lowercase(), track_title.to_lowercase());
    if let Ok(Some(cached)) = state.db.lastfm_cache_get(&cache_key) {
        return Some(cached);
    }
    let db = state.db.clone();
    let lim = limit.unwrap_or(10);
    let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
    thread::spawn(move || {
        if let Ok(value) = lastfm.get_similar_tracks(&artist_name, &track_title, lim) {
            let _ = db.lastfm_cache_set(&cache_key, &value);
            let _ = app.emit("lastfm-similar-tracks", value);
        }
    });
    None
}

#[tauri::command]
pub fn lastfm_get_artist_info(state: State<'_, AppState>, app: AppHandle, artist_name: String) -> Option<serde_json::Value> {
    let cache_key = format!("artist_info:{}", artist_name.to_lowercase());
    if let Ok(Some(cached)) = state.db.lastfm_cache_get(&cache_key) {
        return Some(cached);
    }
    let db = state.db.clone();
    let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
    thread::spawn(move || {
        if let Ok(value) = lastfm.get_artist_info(&artist_name) {
            let _ = db.lastfm_cache_set(&cache_key, &value);
            let _ = app.emit("lastfm-artist-info", value);
        }
    });
    None
}

#[tauri::command]
pub fn lastfm_get_album_info(state: State<'_, AppState>, app: AppHandle, artist_name: String, album_title: String) -> Option<serde_json::Value> {
    let cache_key = format!("album_info:{}:{}", artist_name.to_lowercase(), album_title.to_lowercase());
    if let Ok(Some(cached)) = state.db.lastfm_cache_get(&cache_key) {
        return Some(cached);
    }
    let db = state.db.clone();
    let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
    thread::spawn(move || {
        if let Ok(value) = lastfm.get_album_info(&artist_name, &album_title) {
            let _ = db.lastfm_cache_set(&cache_key, &value);
            let _ = app.emit("lastfm-album-info", value);
        }
    });
    None
}

#[tauri::command]
pub fn lastfm_get_track_tags(state: State<'_, AppState>, app: AppHandle, artist_name: String, track_title: String) -> Option<serde_json::Value> {
    let cache_key = format!("track_tags:{}:{}", artist_name.to_lowercase(), track_title.to_lowercase());
    if let Ok(Some(cached)) = state.db.lastfm_cache_get(&cache_key) {
        return Some(cached);
    }
    let db = state.db.clone();
    let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
    thread::spawn(move || {
        if let Ok(value) = lastfm.get_track_top_tags(&artist_name, &track_title) {
            let _ = db.lastfm_cache_set(&cache_key, &value);
            let _ = app.emit("lastfm-track-tags", value);
        }
    });
    None
}

#[tauri::command]
pub fn lastfm_get_artist_tags(state: State<'_, AppState>, app: AppHandle, artist_name: String) -> Option<serde_json::Value> {
    let cache_key = format!("artist_tags:{}", artist_name.to_lowercase());
    if let Ok(Some(cached)) = state.db.lastfm_cache_get(&cache_key) {
        return Some(cached);
    }
    let db = state.db.clone();
    let lastfm = LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET);
    thread::spawn(move || {
        if let Ok(value) = lastfm.get_artist_top_tags(&artist_name) {
            let _ = db.lastfm_cache_set(&cache_key, &value);
            let _ = app.emit("lastfm-artist-tags", value);
        }
    });
    None
}

#[tauri::command]
pub fn lastfm_apply_community_tags(state: State<'_, AppState>, track_id: i64, tag_names: Vec<String>) -> Result<Vec<(i64, String)>, String> {
    let mut applied = Vec::new();
    for name in &tag_names {
        let tag_id = state.db.get_or_create_tag(name).map_err(|e| e.to_string())?;
        state.db.add_track_tag(track_id, tag_id).map_err(|e| e.to_string())?;
        applied.push((tag_id, name.clone()));
    }
    Ok(applied)
}

#[tauri::command]
pub fn replace_track_tags(state: State<'_, AppState>, track_id: i64, tag_names: Vec<String>) -> Result<Vec<(i64, String)>, String> {
    state.db.replace_track_tags(track_id, &tag_names).map_err(|e| e.to_string())
}

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
    let tracks = state
        .db
        .get_tracks_by_subsonic_id(&remote_track_id, source_collection_id)
        .map_err(|e| e.to_string())?;
    let track = tracks.first().ok_or("Track not found in database")?;

    // Look up destination collection path
    let dest_collection = state
        .db
        .get_collection_by_id(dest_collection_id)
        .map_err(|e| e.to_string())?;
    let dest_path = dest_collection
        .path
        .ok_or("Destination collection has no path")?;

    // Resolve cover URL
    let cover_url = resolve_cover_url(&state.db, track, source_collection_id);

    let collection = state
        .db
        .get_collection_by_id(source_collection_id)
        .map_err(|e| e.to_string())?;

    let id = state.track_download_manager.next_id();
    let request = DownloadRequest {
        id,
        track_title: track.title.clone(),
        artist_name: track
            .artist_name
            .clone()
            .unwrap_or_else(|| "Unknown Artist".to_string()),
        album_title: track
            .album_title
            .clone()
            .unwrap_or_else(|| "Unknown Album".to_string()),
        track_number: track.track_number.map(|n| n as u32),
        genre: None,
        year: track.year,
        cover_url,
        source_kind: collection.kind.clone(),
        source_collection_id: Some(source_collection_id),
        source_override_url: collection.url.clone(),
        remote_track_id,
        dest_collection_id,
        dest_collection_path: dest_path,
        format: fmt,
        is_batch_last: true,
    };

    state.track_download_manager.enqueue(request);
    Ok(id)
}

#[tauri::command]
pub fn download_album(
    state: State<'_, AppState>,
    album_id: String,
    dest_collection_id: Option<i64>,
    custom_dest_path: Option<String>,
    format: String,
) -> Result<Vec<u64>, String> {
    let mga_url = state.musicgateway_url.lock().unwrap().clone()
        .ok_or("MusicGateAway URL not configured. Set it in Settings > Integrations.")?;
    let fmt = DownloadFormat::from_str(&format)?;

    let (collection_id, dest_path) = if let Some(custom) = custom_dest_path {
        (0, custom)
    } else {
        let cid = dest_collection_id.ok_or("Either dest_collection_id or custom_dest_path is required")?;
        let dest_collection = state
            .db
            .get_collection_by_id(cid)
            .map_err(|e| e.to_string())?;
        let path = dest_collection
            .path
            .ok_or("Destination collection has no path")?;
        (cid, path)
    };

    let client = MusicGatewayClient::new(&mga_url);
    let album = client.get_album(&album_id).map_err(|e| e.to_string())?;
    let cover_url = album
        .cover_id
        .as_deref()
        .map(|id| musicgateway::cover_url(id, 1280));

    let count = album.tracks.len();
    let mut ids = Vec::with_capacity(count);

    for (i, t) in album.tracks.into_iter().enumerate() {
        let id = state.track_download_manager.next_id();
        let request = DownloadRequest {
            id,
            track_title: t.title,
            artist_name: t.artist_name.unwrap_or_default(),
            album_title: album.title.clone(),
            track_number: t.track_number.map(|n| n as u32),
            genre: None,
            year: album.year,
            cover_url: cover_url.clone(),
            source_kind: "tidal".to_string(),
            source_collection_id: None,
            source_override_url: Some(mga_url.clone()),
            remote_track_id: t.tidal_id,
            dest_collection_id: collection_id,
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
pub fn get_download_status(
    state: State<'_, AppState>,
) -> Result<crate::downloader::DownloadQueueInfo, String> {
    Ok(state.track_download_manager.get_status())
}

#[tauri::command]
pub fn cancel_download(state: State<'_, AppState>, download_id: u64) -> Result<bool, String> {
    Ok(state.track_download_manager.cancel(download_id))
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

#[tauri::command]
pub async fn tidal_download_preview(
    state: State<'_, AppState>,
    app: AppHandle,
    track_id: i64,
    tidal_track_id: String,
    format: String,
) -> Result<UpgradePreviewInfo, String> {
    let fmt = DownloadFormat::from_str(&format)?;
    let db = state.db.clone();
    let track = db.get_track_by_id(track_id).map_err(|e| e.to_string())?;
    let mga_url = state.musicgateway_url.lock().unwrap().clone()
        .ok_or("MusicGateAway URL not configured. Set it in Settings > Integrations.")?;

    tauri::async_runtime::spawn_blocking(move || -> Result<UpgradePreviewInfo, String> {
        let mga_client = MusicGatewayClient::new(&mga_url);
        let stream_info = mga_client
            .get_stream_url(&tidal_track_id, fmt.tidal_quality())
            .map_err(|e| e.to_string())?;
        let actual_ext = stream_info.extension();

        // Build temp path next to original file
        let old_path = std::path::Path::new(&track.path);
        let parent = old_path.parent().ok_or("Track has no parent directory")?;
        let stem = old_path.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
        let new_filename = format!("{}.upgrade.{}", stem, actual_ext);
        let new_path = parent.join(&new_filename);

        if new_path.exists() {
            std::fs::remove_file(&new_path)
                .map_err(|e| format!("Failed to remove existing preview: {}", e))?;
        }

        // Download to temp path with progress events
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

        let mut file = std::fs::File::create(&new_path)
            .map_err(|e| format!("Failed to create file: {}", e))?;

        let mut reader = std::io::BufReader::new(resp);
        let mut buf = [0u8; 8192];
        loop {
            use std::io::Read;
            let n = reader.read(&mut buf).map_err(|e| {
                let _ = std::fs::remove_file(&new_path);
                format!("Read error: {}", e)
            })?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| {
                let _ = std::fs::remove_file(&new_path);
                format!("Write error: {}", e)
            })?;
            downloaded += n as u64;

            if last_emit.elapsed() >= std::time::Duration::from_millis(500) {
                let pct = if total_bytes > 0 {
                    ((downloaded as f64 / total_bytes as f64) * 100.0) as u8
                } else {
                    0
                };
                let _ = app.emit("upgrade-download-progress", pct);
                last_emit = std::time::Instant::now();
            }
        }
        std::io::Write::flush(&mut file).map_err(|e| format!("Flush error: {}", e))?;
        drop(file);

        // Write tags to the new file
        let info = mga_client
            .get_track(&tidal_track_id)
            .map_err(|e| e.to_string())?;
        let cover_url = info
            .cover_id
            .as_deref()
            .map(|id| musicgateway::cover_url(id, 1280));
        let request = DownloadRequest {
            id: 0,
            track_title: info.title,
            artist_name: info.artist_name.unwrap_or_else(|| "Unknown Artist".to_string()),
            album_title: info.album_title.unwrap_or_else(|| "Unknown Album".to_string()),
            track_number: info.track_number.map(|n| n as u32),
            genre: None,
            year: None,
            cover_url,
            source_kind: "tidal".to_string(),
            source_collection_id: None,
            source_override_url: Some(mga_url),
            remote_track_id: tidal_track_id,
            dest_collection_id: 0,
            dest_collection_path: String::new(),
            format: fmt,
            is_batch_last: true,
        };
        if let Err(e) = crate::downloader::write_tags(&new_path, &request, &http_client) {
            log::warn!("Failed to write tags to upgrade preview: {}", e);
        }

        let new_file_size = std::fs::metadata(&new_path).ok().map(|m| m.len() as i64);
        let new_format = Some(actual_ext.to_string());

        Ok(UpgradePreviewInfo {
            old_path: track.path.clone(),
            old_format: track.format.clone(),
            old_file_size: track.file_size,
            new_path: new_path.to_string_lossy().to_string(),
            new_format,
            new_file_size,
        })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn confirm_track_upgrade(
    state: State<'_, AppState>,
    track_id: i64,
    new_path: String,
) -> Result<(), String> {
    let db = state.db.clone();
    let track = db.get_track_by_id(track_id).map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let old_path = std::path::Path::new(&track.path);
        let new_file = std::path::Path::new(&new_path);

        if !new_file.exists() {
            return Err("Preview file not found".to_string());
        }

        // Delete old file
        if old_path.exists() {
            std::fs::remove_file(old_path)
                .map_err(|e| format!("Failed to delete old file: {}", e))?;
        }

        // Rename: remove ".upgrade" from filename
        let parent = new_file.parent().ok_or("No parent directory")?;
        let filename = new_file.file_name().and_then(|f| f.to_str()).ok_or("Invalid filename")?;
        let final_filename = filename.replace(".upgrade.", ".");
        let final_path = parent.join(&final_filename);

        // If final path already exists (same extension as old), remove it
        if final_path.exists() && final_path != new_file {
            std::fs::remove_file(&final_path)
                .map_err(|e| format!("Failed to remove existing file at target: {}", e))?;
        }

        std::fs::rename(new_file, &final_path)
            .map_err(|e| format!("Failed to rename file: {}", e))?;

        // Remove old track from DB and re-scan the new file
        let _ = db.remove_track_by_path(&track.path);
        let collection_id = track.collection_id;
        crate::scanner::process_media_file(&db, &final_path, collection_id);
        let _ = db.rebuild_fts();
        let _ = db.recompute_counts();

        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cancel_track_upgrade(new_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let path = std::path::Path::new(&new_path);
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("Failed to remove preview file: {}", e))?;
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_track_as_copy(
    state: State<'_, AppState>,
    track_id: i64,
    new_path: String,
) -> Result<(), String> {
    let db = state.db.clone();
    let track = db.get_track_by_id(track_id).map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let new_file = std::path::Path::new(&new_path);

        if !new_file.exists() {
            return Err("Preview file not found".to_string());
        }

        // Rename: {stem}.upgrade.{ext} -> {stem} (TIDAL).{ext}
        let parent = new_file.parent().ok_or("No parent directory")?;
        let filename = new_file.file_name().and_then(|f| f.to_str()).ok_or("Invalid filename")?;
        let final_filename = if let Some(pos) = filename.find(".upgrade.") {
            let stem = &filename[..pos];
            let ext = &filename[pos + ".upgrade.".len()..];
            format!("{} (TIDAL).{}", stem, ext)
        } else {
            let p = std::path::Path::new(filename);
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("flac");
            format!("{} (TIDAL).{}", stem, ext)
        };
        let final_path = parent.join(&final_filename);

        if final_path.exists() {
            return Err(format!("File already exists: {}", final_path.display()));
        }

        std::fs::rename(new_file, &final_path)
            .map_err(|e| format!("Failed to rename file: {}", e))?;

        // Register in library
        let collection_id = track.collection_id;
        crate::scanner::process_media_file(&db, &final_path, collection_id);
        let _ = db.rebuild_fts();
        let _ = db.recompute_counts();

        Ok(())
    }).await.map_err(|e| e.to_string())?
}

fn resolve_cover_url(db: &Arc<Database>, track: &Track, collection_id: i64) -> Option<String> {
    // For TIDAL tracks, try to find cover_id from the track path pattern tidal://{coll_id}/{tidal_id}
    // The cover_id isn't stored in the tracks table, so we look it up from the album
    // For now, return None -- the download pipeline will still work without embedded art
    // TODO: store cover_id in a metadata field or look up via TIDAL API
    let _ = (db, track, collection_id);
    None
}

#[tauri::command]
pub fn get_cached_waveform(state: State<'_, AppState>, track_id: i64) -> Option<Vec<f32>> {
    let path = state.app_dir.join("waveforms").join("v2").join(format!("{}.json", track_id));
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

#[tauri::command]
pub fn cache_waveform(state: State<'_, AppState>, track_id: i64, peaks: Vec<f32>) -> Result<(), String> {
    let dir = state.app_dir.join("waveforms").join("v2");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", track_id));
    let json = serde_json::to_string(&peaks).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_user_skins(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let dir = skins::skins_dir(&state.app_dir);
    skins::list_skins_in_dir(&dir)
}

#[tauri::command]
pub fn read_user_skin(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let dir = skins::skins_dir(&state.app_dir);
    skins::read_skin_from_dir(&dir, &id)
}

#[tauri::command]
pub fn save_user_skin(state: State<'_, AppState>, skin_json: String) -> Result<String, String> {
    let dir = skins::skins_dir(&state.app_dir);
    skins::save_skin_to_dir(&dir, &skin_json)
}

#[tauri::command]
pub fn delete_user_skin(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let dir = skins::skins_dir(&state.app_dir);
    skins::delete_skin_from_dir(&dir, &id)
}

#[tauri::command]
pub fn import_skin_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let dir = skins::skins_dir(&state.app_dir);
    skins::import_skin_from_path(&dir, &path)
}

#[tauri::command]
pub fn fetch_skin_gallery() -> Result<String, String> {
    skins::fetch_url("https://raw.githubusercontent.com/outcast1000/viboplr-skins/main/index.json")
}

#[tauri::command]
pub fn install_gallery_skin(state: State<'_, AppState>, url: String) -> Result<String, String> {
    let content = skins::fetch_url(&url)?;
    let dir = skins::skins_dir(&state.app_dir);
    skins::save_skin_to_dir(&dir, &content)
}

#[tauri::command]
pub fn plugin_get_dir(state: State<'_, AppState>) -> Result<String, String> {
    let plugins_dir = state.app_dir.join("plugins");
    if !plugins_dir.exists() {
        std::fs::create_dir_all(&plugins_dir).map_err(|e| e.to_string())?;
    }
    Ok(plugins_dir.to_string_lossy().to_string())
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
                        plugins.push(serde_json::json!({
                            "id": dir_name,
                            "manifest": manifest,
                            "builtin": builtin,
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

#[tauri::command]
pub fn plugin_list_installed(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let user_plugins_dir = state.app_dir.join("plugins");
    if !user_plugins_dir.exists() {
        std::fs::create_dir_all(&user_plugins_dir).map_err(|e| e.to_string())?;
    }

    let mut seen_ids = std::collections::HashSet::new();
    let mut plugins = Vec::new();

    // User plugins take precedence (loaded first)
    for p in scan_plugins_dir(&user_plugins_dir, false) {
        if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
            seen_ids.insert(id.to_string());
        }
        plugins.push(p);
    }

    // Native/builtin plugins (skipped if user has same id)
    if let Some(ref native_dir) = state.native_plugins_dir {
        for p in scan_plugins_dir(native_dir, true) {
            if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
                if seen_ids.contains(id) {
                    continue; // user plugin overrides native
                }
            }
            plugins.push(p);
        }
    }

    Ok(plugins)
}

#[tauri::command]
pub fn plugin_read_file(state: State<'_, AppState>, plugin_id: String, path: String) -> Result<String, String> {
    // Sanitize: prevent directory traversal
    if plugin_id.contains("..") || plugin_id.contains('/') || plugin_id.contains('\\') {
        return Err("Invalid plugin ID".to_string());
    }
    if path.contains("..") || path.starts_with('/') || path.starts_with('\\') {
        return Err("Invalid file path".to_string());
    }

    // Try user plugins first, then native plugins
    let user_plugins_dir = state.app_dir.join("plugins");
    let dirs: Vec<&std::path::Path> = {
        let mut d = vec![user_plugins_dir.as_path()];
        if let Some(ref native) = state.native_plugins_dir {
            d.push(native.as_path());
        }
        d
    };

    for plugins_dir in dirs {
        let file_path = plugins_dir.join(&plugin_id).join(&path);
        if !file_path.exists() {
            continue;
        }
        let canonical = file_path.canonicalize().map_err(|e| format!("Failed to read plugin file: {}", e))?;
        let canonical_plugins = plugins_dir.canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&canonical_plugins) {
            return Err("Invalid file path".to_string());
        }
        return std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read plugin file: {}", e));
    }

    Err(format!("Plugin file not found: {}/{}", plugin_id, path))
}

#[tauri::command]
pub fn plugin_storage_get(state: State<'_, AppState>, plugin_id: String, key: String) -> Result<Option<String>, String> {
    state.db.plugin_storage_get(&plugin_id, &key)
}

#[tauri::command]
pub fn plugin_storage_set(state: State<'_, AppState>, plugin_id: String, key: String, value: String) -> Result<(), String> {
    state.db.plugin_storage_set(&plugin_id, &key, &value)
}

#[tauri::command]
pub fn plugin_storage_delete(state: State<'_, AppState>, plugin_id: String, key: String) -> Result<(), String> {
    state.db.plugin_storage_delete(&plugin_id, &key)
}

#[tauri::command]
pub async fn plugin_fetch(url: String, method: Option<String>, headers: Option<std::collections::HashMap<String, String>>, body: Option<String>) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let method_str = method.as_deref().unwrap_or("GET");
    let mut req = match method_str {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "PATCH" => client.patch(&url),
        _ => client.get(&url),
    };
    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            req = req.header(&k, &v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let start = std::time::Instant::now();
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    log::info!("HTTP {} plugin_fetch {} -> {} ({:.0}ms)", method_str, url, status, start.elapsed().as_secs_f64() * 1000.0);
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "status": status,
        "body": text,
    }))
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
            app_data_dir: std::path::PathBuf::from("/tmp/viboplr-test"),
            profile_name: "default".to_string(),
            download_queue: Arc::new(DownloadQueue {
                queue: Mutex::new(Vec::new()),
                condvar: Condvar::new(),
            }),
            track_download_manager: Arc::new(DownloadManager::new()),
            lastfm: LastfmClient::new(LASTFM_API_KEY, LASTFM_API_SECRET),
            lastfm_session: Mutex::new(None),
            lastfm_importing: Arc::new(AtomicBool::new(false)),
            musicgateway_url: Mutex::new(None),
            musicgateway_process: Mutex::new(None),
            native_plugins_dir: None,
        }
    }

    /// Helper: insert a track directly through the DB layer
    fn insert_track(state: &AppState, path: &str, title: &str, artist_id: Option<i64>, album_id: Option<i64>) -> i64 {
        state.db.upsert_track(path, title, artist_id, album_id, None, Some(200.0), Some("mp3"), Some(5_000_000), None, None, None, None)
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
        insert_track(&state, "/a.mp3", "Alpha Song", Some(artist_id), Some(album_id));
        insert_track(&state, "/b.mp3", "Beta Song", Some(artist_id), None);

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
        let track_id = insert_track(&state, "/t.mp3", "Track", Some(artist_id), Some(album_id));

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
        let t1 = insert_track(&state, "/a.mp3", "Song A", None, None);
        let t2 = insert_track(&state, "/b.mp3", "Song B", None, None);

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
    fn test_extract_first_video_id() {
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
                                                "title": { "runs": [{ "text": "Rick Astley - Never Gonna Give You Up" }] }
                                            }
                                        },
                                        {
                                            "videoRenderer": {
                                                "videoId": "second_id",
                                                "title": { "runs": [{ "text": "Second Video" }] }
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

        assert_eq!(extract_first_video_id(&data), Some("dQw4w9WgXcQ".to_string()));
        assert_eq!(extract_video_title(&data), Some("Rick Astley - Never Gonna Give You Up".to_string()));
    }

    #[test]
    fn test_extract_video_id_missing() {
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

        assert_eq!(extract_first_video_id(&data), None);
        assert_eq!(extract_video_title(&data), None);
    }

    #[test]
    fn test_extract_video_id_empty() {
        let data: serde_json::Value = serde_json::json!({});
        assert_eq!(extract_first_video_id(&data), None);
        assert_eq!(extract_video_title(&data), None);
    }
}
