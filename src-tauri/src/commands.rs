use serde::{Serialize, Deserialize};
use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::Database;
use crate::downloader::{DownloadFormat, DownloadManager, DownloadResolveRegistry};
use crate::models::*;
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
    Artist { id: i64, name: String, force: bool },
    Album { id: i64, title: String, artist_name: Option<String>, force: bool },
    Tag { id: i64, name: String },
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
    pub app_data_dir: std::path::PathBuf,
    pub profile_name: String,
    pub download_queue: Arc<DownloadQueue>,
    pub track_download_manager: Arc<DownloadManager>,
    pub native_plugins_dir: Option<std::path::PathBuf>,
    pub image_resolve_registry: Arc<ImageResolveRegistry>,
    pub download_resolve_registry: Arc<DownloadResolveRegistry>,
    pub direct_download_cancel: Arc<AtomicBool>,
    pub mixtape_cancel: Arc<AtomicBool>,
    pub update_checker_cancel: Arc<AtomicBool>,
    pub resyncing_collections: Arc<Mutex<HashSet<i64>>>,
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
            let track_count_before = db.get_track_count_for_collection(collection_id).unwrap_or(0);
            thread::spawn(move || {
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

            let track_count_before = db.get_track_count_for_collection(collection_id).unwrap_or(0);
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
                        collection_id,
                    },
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
pub fn find_track_in_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    title: String,
    artist_name: String,
) -> Result<Option<Track>, String> {
    state.db.find_track_in_collection(collection_id, &title, &artist_name).map_err(|e| e.to_string())
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

    if !matches!(collection.kind.as_str(), "local" | "subsonic") {
        return Err(format!("Resync not supported for '{}' collections", collection.kind));
    }

    run_collection_resync(
        state.db.clone(),
        app,
        collection,
        state.resyncing_collections.clone(),
    );
    Ok(())
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
pub async fn get_tracks(
    state: State<'_, AppState>,
    opts: TrackQuery,
) -> Result<Vec<Track>, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || db.get_tracks(&opts).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn search_all(
    state: State<'_, AppState>,
    query: String,
    artist_limit: i64,
    album_limit: i64,
    track_limit: i64,
) -> Result<SearchAllResults, String> {
    state
        .db
        .search_all(&query, artist_limit, album_limit, track_limit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_entity(
    state: State<'_, AppState>,
    query: String,
    entity: String,
    limit: i64,
    offset: i64,
    sort_field: Option<String>,
    sort_dir: Option<String>,
    media_type: Option<String>,
    liked_only: Option<bool>,
    has_youtube_url: Option<bool>,
) -> Result<SearchEntityResult, String> {
    let track_opts = TrackQuery {
        limit: Some(limit),
        offset: Some(offset),
        sort_field,
        sort_dir,
        media_type,
        liked_only: liked_only.unwrap_or(false),
        has_youtube_url: has_youtube_url.unwrap_or(false),
        ..Default::default()
    };
    state
        .db
        .search_entity(&query, &entity, &track_opts)
        .map_err(|e| e.to_string())
}

// --- Track lookup command ---

#[tauri::command]
pub fn get_track_by_id(state: State<'_, AppState>, track_id: i64) -> Result<Track, String> {
    state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_artist_by_name(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<Artist>, String> {
    state
        .db
        .find_artist_by_name(&name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_album_by_name(
    state: State<'_, AppState>,
    title: String,
    artist_name: Option<String>,
) -> Result<Option<Album>, String> {
    state
        .db
        .find_album_by_name(&title, artist_name.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_track_by_metadata(
    state: State<'_, AppState>,
    title: String,
    artist_name: Option<String>,
    album_name: Option<String>,
) -> Result<Option<Track>, String> {
    state
        .db
        .find_track_by_metadata(&title, artist_name.as_deref(), album_name.as_deref())
        .map_err(|e| e.to_string())
}

// --- Track path command ---

#[tauri::command]
pub fn get_track_path(state: State<'_, AppState>, track_id: i64) -> Result<String, String> {
    let track = state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())?;

    log::info!("Playing: {} — {} (id={})", track.artist_name.as_deref().unwrap_or("?"), track.title, track_id);

    if let Some(remote_id) = track.remote_id() {
        let collection_id = track
            .collection_id
            .ok_or("Track has remote path but no collection_id")?;
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
    } else {
        Ok(track.filesystem_path().unwrap_or(&track.path).to_string())
    }
}

#[tauri::command]
pub fn resolve_subsonic_location(
    state: State<'_, AppState>,
    location: String,
) -> Result<String, String> {
    // Parse: subsonic://{host}/{subsonic_id}
    let without_scheme = location
        .strip_prefix("subsonic://")
        .ok_or("Invalid subsonic location: missing subsonic:// prefix")?;
    let last_slash = without_scheme
        .rfind('/')
        .ok_or("Invalid subsonic location: missing track id")?;
    let host = &without_scheme[..last_slash];
    let track_id = &without_scheme[last_slash + 1..];

    if track_id.is_empty() {
        return Err("Invalid subsonic location: empty track id".to_string());
    }

    let collections = state.db.get_collections().map_err(|e| e.to_string())?;
    let collection = collections
        .iter()
        .find(|c| {
            c.kind == "subsonic"
                && c.url.as_ref().map_or(false, |u| {
                    let normalized = u
                        .trim_start_matches("https://")
                        .trim_start_matches("http://")
                        .trim_end_matches('/');
                    normalized == host
                })
        })
        .ok_or_else(|| format!("No subsonic collection found matching host: {}", host))?;

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
    if track.is_remote() {
        return Err("Cannot open folder for server tracks".to_string());
    }

    let fs_path = track.filesystem_path().ok_or("Track has no local file path")?;
    tauri_plugin_opener::reveal_item_in_dir(fs_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_in_folder_path(file_path: String) -> Result<(), String> {
    let bare = file_path.strip_prefix("file://").unwrap_or(&file_path);
    let path = std::path::Path::new(bare);
    if !path.exists() {
        return Err(format!("File not found: {}", bare));
    }
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_folder(folder_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&folder_path);
    if !path.exists() {
        return Err(format!("Folder not found: {}", folder_path));
    }
    tauri_plugin_opener::open_path(folder_path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_profile_folder(state: State<'_, AppState>) -> Result<(), String> {
    open_folder(state.app_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_logs_folder(state: State<'_, AppState>) -> Result<(), String> {
    let logs_dir = state.app_dir.join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| e.to_string())?;
    open_folder(logs_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_app_paths(state: State<'_, AppState>) -> Result<(String, String), String> {
    let logs_dir = state.app_dir.join("logs");
    Ok((
        state.app_dir.to_string_lossy().to_string(),
        logs_dir.to_string_lossy().to_string(),
    ))
}

#[tauri::command]
pub fn write_frontend_log(level: String, message: String, section: Option<String>) -> Result<(), String> {
    let target = section.unwrap_or_else(|| "frontend".to_string());
    match level.as_str() {
        "error" => log::log!(target: &target, log::Level::Error, "{}", message),
        "warn" => log::log!(target: &target, log::Level::Warn, "{}", message),
        _ => log::log!(target: &target, log::Level::Info, "{}", message),
    }
    Ok(())
}

#[tauri::command]
pub fn delete_tracks(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    track_ids: Vec<i64>,
) -> Result<DeleteTracksResult, String> {
    let tracks = state.db.get_tracks_by_ids(&track_ids).map_err(|e| e.to_string())?;
    let mut deleted_ids = Vec::new();
    let mut failures = Vec::new();
    for track in &tracks {
        if track.is_remote() {
            failures.push(DeleteFailure {
                title: track.title.clone(),
                reason: "Remote tracks cannot be deleted locally".to_string(),
            });
            continue;
        }
        let fs_path = track.filesystem_path().unwrap_or(&track.path);
        let path = std::path::Path::new(fs_path);
        if path.exists() {
            if let Err(e) = std::fs::remove_file(path) {
                log::warn!("Failed to delete file {}: {}", track.path, e);
                failures.push(DeleteFailure {
                    title: track.title.clone(),
                    reason: e.to_string(),
                });
                continue;
            }
        }
        deleted_ids.push(track.id);
    }
    if !deleted_ids.is_empty() {
        state.db.delete_tracks_by_ids(&deleted_ids).map_err(|e| e.to_string())?;
        state.db.recompute_counts().map_err(|e| e.to_string())?;
        for track in &tracks {
            if deleted_ids.contains(&track.id) {
                let _ = app.emit("track-removed", serde_json::json!({
                    "trackId": track.id,
                    "path": track.path,
                }));
            }
        }
    }
    Ok(DeleteTracksResult { deleted_ids, failures })
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

    for (_track_id, path, collection_id) in &track_info {
        // Skip non-local files
        if path.starts_with("subsonic://") || path.starts_with("tidal://") {
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

        // Strip file:// prefix for filesystem access
        let bare_path = path.strip_prefix("file://").unwrap_or(path);
        let file_path = std::path::Path::new(bare_path);
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
pub fn paste_entity_image_from_clipboard(
    state: State<'_, AppState>,
    kind: String,
    id: i64,
) -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("Clipboard error: {}", e))?;
    let img = clipboard.get_image().map_err(|_| "No image in clipboard".to_string())?;
    // Encode RGBA data as PNG
    let mut buf = Vec::new();
    {
        let encoder = image::codecs::png::PngEncoder::new(&mut buf);
        image::ImageEncoder::write_image(
            encoder,
            &img.bytes,
            img.width as u32,
            img.height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("Failed to encode image: {}", e))?;
    }
    let slug = resolve_entity_slug(&state, &kind, id)?;
    crate::entity_image::remove_image(&state.app_dir, &kind, &slug);
    let dest_dir = crate::entity_image::image_dir(&state.app_dir, &kind);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.png", slug));
    std::fs::write(&dest, &buf).map_err(|e| format!("Failed to write image: {}", e))?;
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
    force: Option<bool>,
) {
    let force = force.unwrap_or(false);
    if force {
        let _ = state.db.clear_image_failure("artist", artist_id);
        if let Ok(slug) = resolve_entity_slug(&state, "artist", artist_id) {
            crate::entity_image::remove_image(&state.app_dir, "artist", &slug);
        }
    }
    log::info!("Queued artist image download: {} (id={}, force={})", artist_name, artist_id, force);
    let mut queue = state.download_queue.queue.lock().unwrap();
    queue.push(ImageDownloadRequest::Artist { id: artist_id, name: artist_name, force });
    state.download_queue.condvar.notify_one();
}

#[tauri::command]
pub fn fetch_album_image(
    state: State<'_, AppState>,
    album_id: i64,
    album_title: String,
    artist_name: Option<String>,
    force: Option<bool>,
) {
    let force = force.unwrap_or(false);
    if force {
        let _ = state.db.clear_image_failure("album", album_id);
        if let Ok(slug) = resolve_entity_slug(&state, "album", album_id) {
            crate::entity_image::remove_image(&state.app_dir, "album", &slug);
        }
    }
    log::info!("Queued album image download: {} (id={}, force={})", album_title, album_id, force);
    let mut queue = state.download_queue.queue.lock().unwrap();
    queue.push(ImageDownloadRequest::Album { id: album_id, title: album_title, artist_name, force });
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
pub fn record_play(state: State<'_, AppState>, title: String, artist_name: Option<String>) -> Result<(), String> {
    state.db.record_play_by_metadata(&title, artist_name.as_deref()).map_err(|e| e.to_string())
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
pub fn get_track_rank(state: State<'_, AppState>, title: String, artist_name: Option<String>) -> Result<Option<i64>, String> {
    state.db.get_track_rank(&title, artist_name.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_artist_rank(state: State<'_, AppState>, artist_name: String) -> Result<Option<i64>, String> {
    state.db.get_artist_rank(&artist_name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_track_play_history(state: State<'_, AppState>, title: String, artist_name: Option<String>, limit: i64) -> Result<Vec<TrackPlayEntry>, String> {
    state.db.get_track_play_history(&title, artist_name.as_deref(), limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_track_play_stats(state: State<'_, AppState>, title: String, artist_name: Option<String>) -> Result<Option<TrackPlayStats>, String> {
    state.db.get_track_play_stats(&title, artist_name.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_auto_continue_track(
    state: State<'_, AppState>,
    strategy: String,
    current_title: String,
    current_artist: Option<String>,
    format_filter: Option<String>,
    exclude_ids: Option<Vec<i64>>,
) -> Result<Option<Track>, String> {
    state
        .db
        .get_auto_continue_track(&strategy, &current_title, current_artist.as_deref(), format_filter.as_deref(), exclude_ids.as_deref().unwrap_or(&[]))
        .map_err(|e| e.to_string())
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
    path: String,
) -> Result<PlaylistLoadResult, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read playlist: {}", e))?;
    let playlist_path = std::path::Path::new(&path);
    let parent_dir = playlist_path.parent();

    let mut entries: Vec<PlaylistEntry> = Vec::new();
    let mut pending_extinf: Option<(String, Option<String>, f64)> = None; // (title, artist, duration)

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if line.starts_with("#EXTINF:") {
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

        // Resolve the location to a URI
        let url = if line.contains("://") || std::path::Path::new(line).is_absolute() {
            // Absolute path without scheme → add file://
            if !line.contains("://") {
                format!("file://{}", line)
            } else {
                line.to_string()
            }
        } else if let Some(parent) = parent_dir {
            // Relative path — resolve relative to playlist
            format!("file://{}", parent.join(line).to_string_lossy())
        } else {
            format!("file://{}", line)
        };

        let (title, artist, dur) = pending_extinf.take().unwrap_or_else(|| {
            let name = url.rsplit('/').next().unwrap_or(&url).to_string();
            (name, None, 0.0)
        });

        entries.push(PlaylistEntry {
            url,
            title,
            artist_name: artist,
            duration_secs: Some(dur),
        });
    }

    let playlist_name = playlist_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Playlist")
        .to_string();

    Ok(PlaylistLoadResult {
        entries,
        playlist_name,
    })
}

#[tauri::command]
pub fn save_playlist_record(
    state: State<'_, AppState>,
    name: String,
    source: Option<String>,
    image_url: Option<String>,
    tracks: Vec<PlaylistTrackPayload>,
) -> Result<i64, String> {
    let db = &state.db;
    let playlist_id = db
        .save_playlist(&name, source.as_deref(), None)
        .map_err(|e| e.to_string())?;

    let track_tuples: Vec<(&str, Option<&str>, Option<&str>, Option<f64>, Option<&str>, Option<&str>)> =
        tracks.iter().map(|t| {
            (
                t.title.as_str(),
                t.artist_name.as_deref(),
                t.album_name.as_deref(),
                t.duration_secs,
                t.source.as_deref(),
                None,
            )
        }).collect();

    db.save_playlist_tracks(playlist_id, &track_tuples)
        .map_err(|e| e.to_string())?;

    // Background image download
    let app_dir = state.app_dir.clone();
    let db_arc = state.db.clone();
    let image_url_clone = image_url.clone();
    let track_image_urls: Vec<(i64, Option<String>)> = {
        let saved_tracks = db.get_playlist_tracks(playlist_id).map_err(|e| e.to_string())?;
        saved_tracks.iter().zip(tracks.iter()).map(|(saved, payload)| {
            (saved.id, payload.image_url.clone())
        }).collect()
    };

    std::thread::spawn(move || {
        let img_dir = app_dir.join("playlist_images");
        let _ = std::fs::create_dir_all(&img_dir);
        let client = reqwest::blocking::Client::new();

        // Download/copy playlist cover
        if let Some(url) = image_url_clone {
            let dest = img_dir.join(format!("{}.jpg", playlist_id));
            let ok = if url.starts_with("http://") || url.starts_with("https://") {
                client.get(&url).send().ok()
                    .filter(|r| r.status().is_success())
                    .and_then(|r| r.bytes().ok())
                    .and_then(|bytes| std::fs::write(&dest, &bytes).ok())
                    .is_some()
            } else {
                let src = std::path::Path::new(&url);
                src.exists() && std::fs::copy(src, &dest).is_ok()
            };
            if ok {
                let abs = dest.to_string_lossy().to_string();
                let _ = db_arc.update_playlist_image(playlist_id, &abs);
            }
        }

        // Download/copy track images
        for (track_id, maybe_url) in track_image_urls {
            if let Some(url) = maybe_url {
                let dest = img_dir.join(format!("{}_{}.jpg", playlist_id, track_id));
                let ok = if url.starts_with("http://") || url.starts_with("https://") {
                    client.get(&url).send().ok()
                        .filter(|r| r.status().is_success())
                        .and_then(|r| r.bytes().ok())
                        .and_then(|bytes| std::fs::write(&dest, &bytes).ok())
                        .is_some()
                } else {
                    let src = std::path::Path::new(&url);
                    src.exists() && std::fs::copy(src, &dest).is_ok()
                };
                if ok {
                    let abs = dest.to_string_lossy().to_string();
                    let _ = db_arc.update_playlist_track_image(track_id, &abs);
                }
            }
        }
    });

    Ok(playlist_id)
}

#[tauri::command]
pub fn get_playlists(state: State<'_, AppState>) -> Result<Vec<Playlist>, String> {
    state.db.get_playlists().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_playlist_tracks(state: State<'_, AppState>, playlist_id: i64) -> Result<Vec<PlaylistTrack>, String> {
    state.db.get_playlist_tracks(playlist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_playlist_record(state: State<'_, AppState>, playlist_id: i64) -> Result<(), String> {
    // Collect image paths before deleting DB rows (cascade deletes tracks)
    let playlist_image = state.db.get_playlists().ok()
        .and_then(|ps| ps.into_iter().find(|p| p.id == playlist_id))
        .and_then(|p| p.image_path);
    let track_images: Vec<String> = state.db.get_playlist_tracks(playlist_id).ok()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|t| t.image_path)
        .collect();

    state.db.delete_playlist(playlist_id).map_err(|e| e.to_string())?;

    // Clean up image files (absolute paths stored in DB)
    if let Some(path) = playlist_image {
        let _ = std::fs::remove_file(&path);
    }
    for path in track_images {
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

#[tauri::command]
pub fn update_playlist_image(
    state: State<'_, AppState>,
    playlist_id: i64,
    image_path: String,
) -> Result<(), String> {
    state.db.update_playlist_image(playlist_id, &image_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn paste_clipboard_to_playlist_images(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("Clipboard error: {}", e))?;
    let img = clipboard.get_image().map_err(|_| "No image in clipboard".to_string())?;
    let mut buf = Vec::new();
    {
        let encoder = image::codecs::png::PngEncoder::new(&mut buf);
        image::ImageEncoder::write_image(
            encoder,
            &img.bytes,
            img.width as u32,
            img.height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("Failed to encode image: {}", e))?;
    }
    let img_dir = state.app_dir.join("playlist_images");
    std::fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dest = img_dir.join(format!("pasted_{}.png", timestamp));
    std::fs::write(&dest, &buf).map_err(|e| format!("Failed to write image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn copy_to_playlist_images(
    state: State<'_, AppState>,
    source_path: String,
) -> Result<String, String> {
    let img_dir = state.app_dir.join("playlist_images");
    std::fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
    let ext = std::path::Path::new(&source_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dest = img_dir.join(format!("custom_{}.{}", timestamp, ext));
    std::fs::copy(&source_path, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn generate_playlist_composite(
    state: State<'_, AppState>,
    artist_names: Vec<String>,
) -> Result<Option<String>, String> {
    if artist_names.is_empty() {
        return Ok(None);
    }
    let app_dir = &state.app_dir;
    let artist_image_paths: Vec<std::path::PathBuf> = artist_names
        .iter()
        .take(3)
        .filter_map(|name| {
            let slug = crate::entity_image::entity_image_slug("artist", name, None);
            crate::entity_image::get_image_path(app_dir, "artist", &slug)
        })
        .collect();
    if artist_image_paths.is_empty() {
        return Ok(None);
    }
    let img_dir = app_dir.join("playlist_images");
    std::fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dest = img_dir.join(format!("composite_{}.png", timestamp));
    crate::composite_image::generate_tag_composite(&artist_image_paths, &dest, 400)?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn export_playlist_m3u(state: State<'_, AppState>, playlist_id: i64, path: String) -> Result<(), String> {
    let tracks = state.db.get_playlist_tracks(playlist_id).map_err(|e| e.to_string())?;
    let mut content = String::from("#EXTM3U\n");
    for track in &tracks {
        let duration = track.duration_secs.unwrap_or(0.0) as i64;
        let artist = track.artist_name.as_deref().unwrap_or("Unknown");
        content.push_str(&format!("#EXTINF:{},{} - {}\n", duration, artist, track.title));
        content.push_str(track.source.as_deref().unwrap_or(""));
        content.push('\n');
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
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

#[tauri::command]
pub fn search_youtube(title: String, artist_name: Option<String>, duration_secs: Option<f64>) -> Result<YouTubeResult, String> {
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

    let candidates = extract_video_candidates(&data, 7);
    if candidates.is_empty() {
        return Err("No video found in search results".into());
    }

    let best = if let Some(target) = duration_secs {
        candidates.iter()
            .find(|c| c.duration_secs.map_or(false, |d| (d - target).abs() <= 3.0))
            .unwrap_or(&candidates[0])
    } else {
        &candidates[0]
    };

    Ok(YouTubeResult {
        url: format!("https://www.youtube.com/watch?v={}", best.video_id),
        video_title: best.title.clone(),
    })
}

// --- yt-dlp commands ---

#[tauri::command]
pub async fn yt_dlp_check() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut cmd = std::process::Command::new("yt-dlp");
        cmd.arg("--version");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string())
                } else {
                    None
                }
            })
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn ffmpeg_check() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut cmd = std::process::Command::new("ffmpeg");
        cmd.arg("-version");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    String::from_utf8(o.stdout).ok().and_then(|s| {
                        s.lines()
                            .next()
                            .and_then(|line| {
                                // "ffmpeg version 7.1 Copyright ..." or "ffmpeg version N-..."
                                line.strip_prefix("ffmpeg version ")
                                    .map(|rest| rest.split_whitespace().next().unwrap_or("unknown").to_string())
                            })
                    })
                } else {
                    None
                }
            })
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn yt_dlp_stream_audio(
    state: State<'_, AppState>,
    youtube_url: String,
) -> Result<String, String> {
    let app_dir = state.app_dir.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let temp_dir = app_dir.join("yt_cache");
        std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create yt_cache: {}", e))?;

        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let dest = temp_dir.join(format!("{}.webm", ts));

        log::info!("yt-dlp downloading {} -> {}", youtube_url, dest.display());

        let dest_str = dest.to_string_lossy().to_string();
        let mut cmd = std::process::Command::new("yt-dlp");
        cmd.args(["-f", "bestaudio", "--no-warnings", "-o", &dest_str, &youtube_url]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = cmd.output()
            .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("yt-dlp failed: {}", stderr));
        }

        if !dest.exists() {
            return Err("yt-dlp produced no output file".to_string());
        }

        log::info!("yt-dlp download complete: {} ({} bytes)", dest.display(),
            std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0));

        Ok(dest_str)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Convert a local audio file to a different format using ffmpeg.
/// Returns the path to the converted file. If ffmpeg is unavailable, returns the original path.
#[tauri::command]
pub async fn ffmpeg_convert_audio(
    source_path: String,
    audio_format: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ext = match audio_format.as_str() {
            "aac" | "m4a" => "m4a",
            "mp3" => "mp3",
            "flac" => "flac",
            _ => return Ok(source_path),
        };

        let has_ffmpeg = {
            let mut cmd = std::process::Command::new("ffmpeg");
            cmd.arg("-version");
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            cmd.output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };

        if !has_ffmpeg {
            return Ok(source_path);
        }

        let src = std::path::Path::new(&source_path);
        let dest = src.with_extension(ext);
        if dest == src {
            return Ok(source_path);
        }

        let dest_str = dest.to_string_lossy().to_string();
        log::info!("ffmpeg converting {} -> {}", source_path, dest_str);

        let codec = match audio_format.as_str() {
            "aac" | "m4a" => "aac",
            "mp3" => "libmp3lame",
            "flac" => "flac",
            _ => "copy",
        };

        let mut cmd = std::process::Command::new("ffmpeg");
        cmd.args(["-i", &source_path, "-vn", "-c:a", codec, "-y", &dest_str]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = cmd.output()
            .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!("ffmpeg conversion failed, using original: {}", stderr);
            return Ok(source_path);
        }

        log::info!("ffmpeg conversion complete: {} ({} bytes)", dest_str,
            std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0));

        Ok(dest_str)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
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
    let bare_path = track.filesystem_path()
        .ok_or("Track has no local file path")?
        .to_string();

    use lofty::prelude::*;

    let tagged_file = lofty::probe::Probe::open(&bare_path)
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

#[tauri::command]
pub fn replace_track_tags(state: State<'_, AppState>, track_id: i64, tag_names: Vec<String>) -> Result<Vec<(i64, String)>, String> {
    let result = state.db.replace_track_tags(track_id, &tag_names).map_err(|e| e.to_string())?;
    let _ = state.db.rebuild_fts();
    Ok(result)
}

// --- Download commands ---

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

// --- Generic download commands ---

#[tauri::command]
pub fn enqueue_download(
    state: State<'_, AppState>,
    title: String,
    artist_name: Option<String>,
    album_title: Option<String>,
    source_provider_id: Option<String>,
    source_track_id: Option<String>,
    source_collection_id: Option<i64>,
    dest_collection_id: Option<i64>,
    dest_collection_path: Option<String>,
    format: Option<String>,
    path_pattern: Option<String>,
    is_batch_last: Option<bool>,
) -> Result<u64, String> {
    let (dest_cid, dest_path) = resolve_dest_collection(&state, dest_collection_id, dest_collection_path)?;

    let fmt = format
        .as_deref()
        .map(|s| DownloadFormat::from_str(s).unwrap_or(DownloadFormat::Flac))
        .unwrap_or(DownloadFormat::Flac);

    let id = state.track_download_manager.next_id();
    let request = crate::downloader::DownloadRequest {
        id,
        title,
        artist_name,
        album_title,
        dest_collection_id: dest_cid,
        dest_collection_path: dest_path,
        format: fmt,
        path_pattern,
        is_batch_last: is_batch_last.unwrap_or(true),
        source_provider_id,
        source_track_id,
        source_collection_id,
    };
    state.track_download_manager.enqueue(request);
    Ok(id)
}

#[tauri::command]
pub fn download_resolve_response(
    state: State<'_, AppState>,
    id: u64,
    result: Option<crate::downloader::DownloadResolveResponse>,
) -> Result<(), String> {
    state.download_resolve_registry.respond(id, result);
    Ok(())
}

#[tauri::command]
pub fn resolve_subsonic_download_url(
    state: State<'_, AppState>,
    collection_id: i64,
    remote_track_id: String,
    format: Option<String>,
) -> Result<String, String> {
    let creds = state.db.get_collection_credentials(collection_id)
        .map_err(|e| format!("Failed to get collection credentials: {}", e))?;
    let client = SubsonicClient::from_stored(
        &creds.url,
        &creds.username,
        &creds.password_token,
        creds.salt.as_deref(),
        &creds.auth_method,
    );
    let format_param = format
        .as_deref()
        .and_then(|f| DownloadFormat::from_str(f).ok())
        .and_then(|f| f.subsonic_format_param());
    Ok(client.stream_url_with_format(&remote_track_id, format_param))
}

// --- Download provider CRUD commands ---

#[tauri::command]
pub fn sync_download_providers(
    state: State<'_, AppState>,
    providers: Vec<(String, String, String, i64)>,
) -> Result<(), String> {
    state.db.sync_download_providers(&providers).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_download_providers(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String, String, i64, bool)>, String> {
    state.db.get_download_providers().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_active_download_providers(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String, String, i64)>, String> {
    state.db.get_active_download_providers().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_download_provider_priority(
    state: State<'_, AppState>,
    plugin_id: String,
    provider_id: String,
    priority: i64,
) -> Result<(), String> {
    state.db.update_download_provider_priority(&plugin_id, &provider_id, priority)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_download_provider_active(
    state: State<'_, AppState>,
    plugin_id: String,
    provider_id: String,
    active: bool,
) -> Result<(), String> {
    state.db.update_download_provider_active(&plugin_id, &provider_id, active)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reset_download_provider_priorities(
    state: State<'_, AppState>,
    defaults: Vec<(String, String, String, i64)>,
) -> Result<(), String> {
    state.db.reset_download_provider_priorities(&defaults).map_err(|e| e.to_string())
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

#[tauri::command]
pub async fn check_dest_conflict(
    artist_name: String,
    track_title: String,
    dest_dir: String,
    format: String,
) -> Result<ConflictCheck, String> {
    let fmt = DownloadFormat::from_str(&format)?;
    let filename = format!(
        "{} - {}.{}",
        crate::downloader::sanitize_filename(&artist_name),
        crate::downloader::sanitize_filename(&track_title),
        fmt.extension()
    );
    let dest_path = std::path::Path::new(&dest_dir).join(&filename);
    let dest_str = dest_path.to_string_lossy().to_string();

    if dest_path.exists() {
        let meta = std::fs::metadata(&dest_path).ok();
        Ok(ConflictCheck {
            has_conflict: true,
            dest_path: dest_str,
            existing_size: meta.as_ref().map(|m| m.len()),
            existing_format: dest_path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_uppercase()),
        })
    } else {
        Ok(ConflictCheck {
            has_conflict: false,
            dest_path: dest_str,
            existing_size: None,
            existing_format: None,
        })
    }
}

#[tauri::command]
pub async fn cancel_direct_download(
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.direct_download_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn download_to_path(
    stream_url: String,
    dest_path: String,
    format: String,
    overwrite: bool,
    title: Option<String>,
    artist_name: Option<String>,
    album_title: Option<String>,
    track_number: Option<u32>,
    cover_url: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<DownloadPathResult, String> {
    let fmt = DownloadFormat::from_str(&format)?;
    let dest = std::path::PathBuf::from(&dest_path);

    // Pre-check: if not overwriting and file exists, error
    if !overwrite && dest.exists() {
        return Err("File already exists and overwrite is false".to_string());
    }

    // Reset cancel flag
    state.direct_download_cancel.store(false, Ordering::SeqCst);
    let cancel_flag = state.direct_download_cancel.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<DownloadPathResult, String> {
        let final_dest = dest.clone();

        // Ensure parent directory exists
        if let Some(parent) = final_dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        // Download to temp file first
        let ext = final_dest.extension().and_then(|e| e.to_str()).unwrap_or(fmt.extension());
        let temp_path = final_dest.with_extension(format!("viboplr-dl.{}", ext));

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
            .map_err(|e| format!("Failed to create file: {}", e))?;

        let mut reader = std::io::BufReader::new(resp);
        let mut buf = [0u8; 8192];
        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                drop(file);
                let _ = std::fs::remove_file(&temp_path);
                return Err("Download cancelled".to_string());
            }
            use std::io::Read;
            let n = reader.read(&mut buf).map_err(|e| {
                let _ = std::fs::remove_file(&temp_path);
                format!("Read error: {}", e)
            })?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| {
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
                let _ = app.emit("direct-download-progress", pct);
                last_emit = std::time::Instant::now();
            }
        }
        let _ = app.emit("direct-download-progress", 100u8);

        // Write tags if metadata was provided
        if title.is_some() || artist_name.is_some() {
            let _ = crate::downloader::write_tags(
                &temp_path,
                title.as_deref().unwrap_or("Unknown"),
                artist_name.as_deref().unwrap_or("Unknown Artist"),
                album_title.as_deref().unwrap_or("Unknown Album"),
                track_number,
                None, // year
                None, // genre
                cover_url.as_deref(),
                &fmt,
            );
        }

        // Move temp to final destination
        if overwrite && final_dest.exists() {
            std::fs::remove_file(&final_dest)
                .map_err(|e| format!("Failed to remove existing file: {}", e))?;
        }
        std::fs::rename(&temp_path, &final_dest)
            .map_err(|e| format!("Failed to move downloaded file: {}", e))?;

        let file_size = std::fs::metadata(&final_dest)
            .map(|m| m.len())
            .unwrap_or(0);

        let actual_format = final_dest.extension()
            .and_then(|e| e.to_str())
            .unwrap_or(fmt.extension())
            .to_uppercase();

        Ok(DownloadPathResult {
            path: final_dest.to_string_lossy().to_string(),
            format: actual_format,
            file_size,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_downloaded_track(
    path: String,
    collection_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(&path);
    if !file_path.exists() {
        return Err("File does not exist".to_string());
    }
    let db = state.db.clone();
    let collection_root = db.get_collection_by_id(collection_id)
        .map_err(|e| e.to_string())?
        .path;
    tauri::async_runtime::spawn_blocking(move || {
        scanner::process_media_file(&db, &file_path, Some(collection_id), collection_root.as_deref());
        let _ = db.rebuild_fts();
        let _ = db.recompute_counts();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_preview(
    state: State<'_, AppState>,
    app: AppHandle,
    track_id: i64,
    stream_url: String,
    format: String,
    title: Option<String>,
    artist_name: Option<String>,
    album_title: Option<String>,
    track_number: Option<u32>,
    cover_url: Option<String>,
) -> Result<UpgradePreviewInfo, String> {
    let fmt = DownloadFormat::from_str(&format)?;
    let db = state.db.clone();
    let track = db.get_track_by_id(track_id).map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || -> Result<UpgradePreviewInfo, String> {
        let actual_ext = fmt.extension();

        // Build temp path next to original file
        let bare = track.filesystem_path()
            .ok_or("Track has no local file path")?
            .to_string();
        let old_path = std::path::Path::new(&bare);
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
            .get(&stream_url)
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

        // Write tags if metadata was provided
        if title.is_some() || artist_name.is_some() {
            if let Err(e) = crate::downloader::write_tags(
                &new_path,
                title.as_deref().unwrap_or("Unknown"),
                artist_name.as_deref().unwrap_or("Unknown Artist"),
                album_title.as_deref().unwrap_or("Unknown Album"),
                track_number,
                None, // year
                None, // genre
                cover_url.as_deref(),
                &fmt,
            ) {
                log::warn!("Failed to write tags to upgrade preview: {}", e);
            }
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

    let bare_old = track.filesystem_path()
        .ok_or("Track has no local file path")?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let old_path = std::path::Path::new(&bare_old);
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
        let _ = db.remove_track_by_id(track.id);
        let collection_id = track.collection_id;
        let collection_root = collection_id
            .and_then(|cid| db.get_collection_by_id(cid).ok())
            .and_then(|c| c.path);
        crate::scanner::process_media_file(&db, &final_path, collection_id, collection_root.as_deref());
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
        let collection_root = collection_id
            .and_then(|cid| db.get_collection_by_id(cid).ok())
            .and_then(|c| c.path);
        crate::scanner::process_media_file(&db, &final_path, collection_id, collection_root.as_deref());
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
pub fn get_cached_waveform(state: State<'_, AppState>, key: String) -> Option<serde_json::Value> {
    let hash = format!("{:x}", md5::compute(&key));
    let cache_path = state.app_dir.join("waveforms").join(format!("{}.json", hash));
    log::info!("Waveform lookup: key={} hash={}", key, hash);
    let data = std::fs::read_to_string(&cache_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&data).ok()?;
    let name = value.get("name").and_then(|v| v.as_str()).unwrap_or("?");
    let duration = value.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
    log::info!("Waveform hit: \"{}\" ({}s)", name, duration);
    Some(value)
}

#[tauri::command]
pub fn cache_waveform(state: State<'_, AppState>, key: String, waveform: serde_json::Value) -> Result<(), String> {
    let dir = state.app_dir.join("waveforms");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", md5::compute(&key));
    let cache_path = dir.join(format!("{}.json", hash));
    let json = serde_json::to_string(&waveform).map_err(|e| e.to_string())?;
    std::fs::write(&cache_path, json).map_err(|e| e.to_string())?;
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
pub fn plugin_get_lastfm_credentials() -> (String, String) {
    (LASTFM_API_KEY.to_string(), LASTFM_API_SECRET.to_string())
}

#[tauri::command]
pub fn plugin_record_history_plays_batch(
    state: State<'_, AppState>,
    plays: Vec<(String, String, i64)>,
) -> Result<(u64, u64), String> {
    state.db.record_history_plays_batch(&plays).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_apply_tags(
    state: State<'_, AppState>,
    track_id: i64,
    tag_names: Vec<String>,
) -> Result<Vec<(i64, String)>, String> {
    let mut result = Vec::new();
    for name in &tag_names {
        let tag_id = state.db.get_or_create_tag(name).map_err(|e| e.to_string())?;
        state.db.add_track_tag(track_id, tag_id).map_err(|e| e.to_string())?;
        result.push((tag_id, name.clone()));
    }
    let _ = state.db.rebuild_fts();
    Ok(result)
}

// ── Image Provider sync command ──────────────────────────────

#[tauri::command]
pub fn sync_image_providers(
    state: State<'_, AppState>,
    providers: Vec<(String, String, i64)>,
) -> Result<(), String> {
    state.db.sync_image_providers(&providers).map_err(|e| e.to_string())
}

// ── Information Type commands ────────────────────────────────

#[tauri::command]
pub fn info_sync_types(
    state: State<'_, AppState>,
    types: Vec<(String, String, String, String, String, i64, i64, i64, String)>,
) -> Result<(), String> {
    state.db.info_sync_types(&types).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn info_get_types_for_entity(
    state: State<'_, AppState>,
    entity: String,
) -> Result<Vec<(String, String, String, i64, i64, Vec<(String, i64)>, String)>, String> {
    state.db.info_get_types_for_entity(&entity).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn info_get_value(
    state: State<'_, AppState>,
    information_type_id: i64,
    entity_key: String,
) -> Result<Option<(String, String, i64)>, String> {
    state.db.info_get_value(information_type_id, &entity_key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn info_get_values_for_entity(
    state: State<'_, AppState>,
    entity_key: String,
) -> Result<Vec<(i64, String, String, String, i64)>, String> {
    state.db.info_get_values_for_entity(&entity_key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn info_upsert_value(
    state: State<'_, AppState>,
    information_type_id: i64,
    entity_key: String,
    value: String,
    status: String,
) -> Result<(), String> {
    log::info!("Info upsert: type_id={} key={} status={}", information_type_id, entity_key, status);
    state.db.info_upsert_value(information_type_id, &entity_key, &value, &status).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn info_delete_value(
    state: State<'_, AppState>,
    information_type_id: i64,
    entity_key: String,
) -> Result<(), String> {
    state.db.info_delete_value(information_type_id, &entity_key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn info_delete_values_for_type(
    state: State<'_, AppState>,
    type_id: String,
) -> Result<usize, String> {
    state.db.info_delete_values_for_type(&type_id).map_err(|e| e.to_string())
}

// ── Image / Info provider commands ─────────────────────────────

#[tauri::command]
pub fn get_image_providers(
    state: State<'_, AppState>,
    entity: String,
) -> Result<Vec<(String, i64, i64)>, String> {
    state.db.get_image_providers(&entity).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_provider_config(
    state: State<'_, AppState>,
) -> Result<(
    Vec<(String, String, String, String, i64, String, i64, bool)>,
    Vec<(String, String, i64, bool, i64)>,
    Vec<(String, String, String, i64, bool)>,
), String> {
    state.db.get_all_provider_config().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_image_provider_priority(
    state: State<'_, AppState>,
    plugin_id: String,
    entity: String,
    priority: i64,
) -> Result<(), String> {
    state.db.update_image_provider_priority(&plugin_id, &entity, priority).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_image_provider_active(
    state: State<'_, AppState>,
    plugin_id: String,
    entity: String,
    active: bool,
) -> Result<(), String> {
    state.db.update_image_provider_active(&plugin_id, &entity, active).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_info_type_priority(
    state: State<'_, AppState>,
    type_id: String,
    plugin_id: String,
    priority: i64,
) -> Result<(), String> {
    state.db.update_info_type_priority(&type_id, &plugin_id, priority).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_info_type_active(
    state: State<'_, AppState>,
    type_id: String,
    plugin_id: String,
    active: bool,
) -> Result<(), String> {
    state.db.update_info_type_active(&type_id, &plugin_id, active).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reset_provider_priorities(
    state: State<'_, AppState>,
    image_defaults: Vec<(String, String, i64)>,
    info_defaults: Vec<(String, String, i64)>,
) -> Result<(), String> {
    state.db.reset_provider_priorities(&image_defaults, &info_defaults).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn image_resolve_response(
    state: State<'_, AppState>,
    request_id: String,
    result: ImageResolveResult,
) -> Result<(), String> {
    let sender = {
        let mut pending = state.image_resolve_registry.pending.lock().unwrap();
        pending.remove(&request_id)
    };
    match sender {
        Some(tx) => {
            let _ = tx.send(result);
            Ok(())
        }
        None => Err(format!("No pending image resolve request with id: {}", request_id)),
    }
}

#[tauri::command]
pub async fn plugin_fetch(url: String, method: Option<String>, headers: Option<std::collections::HashMap<String, String>>, body: Option<String>) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("Viboplr/0.1.0 (https://github.com/viboplr)")
        .build()
        .map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn fetch_plugin_gallery() -> Result<String, String> {
    crate::skins::fetch_url("https://raw.githubusercontent.com/outcast1000/viboplr-plugins/main/index.json")
}

#[tauri::command]
pub fn install_gallery_plugin(
    state: State<'_, AppState>,
    plugin_id: String,
    base_url: String,
    files: Vec<String>,
) -> Result<String, String> {
    crate::plugins::install_gallery_plugin(&state.app_dir, &base_url, &plugin_id, &files)
}

#[tauri::command]
pub fn delete_user_plugin(state: State<'_, AppState>, plugin_id: String) -> Result<(), String> {
    let user_dir = crate::plugins::plugins_dir(&state.app_dir).join(&plugin_id);
    if !user_dir.exists() {
        return Err(format!("Plugin '{}' is not a user plugin or does not exist", plugin_id));
    }
    let _ = state.db.plugin_scheduler_unregister_all(&plugin_id);
    crate::plugins::delete_plugin(&state.app_dir, &plugin_id)
}

#[tauri::command]
pub fn plugin_scheduler_register(state: State<'_, AppState>, plugin_id: String, task_id: String, interval_ms: i64) -> Result<(), String> {
    state.db.plugin_scheduler_register(&plugin_id, &task_id, interval_ms)
}

#[tauri::command]
pub fn plugin_scheduler_unregister(state: State<'_, AppState>, plugin_id: String, task_id: String) -> Result<(), String> {
    state.db.plugin_scheduler_unregister(&plugin_id, &task_id)
}

#[tauri::command]
pub fn plugin_scheduler_complete(state: State<'_, AppState>, plugin_id: String, task_id: String) -> Result<bool, String> {
    state.db.plugin_scheduler_complete(&plugin_id, &task_id)
}

/// Start a one-shot HTTP server on localhost for OAuth callbacks.
/// Returns the port. Emits "oauth-callback" event with the full query string when a request arrives.
#[tauri::command]
pub async fn oauth_listen(app: tauri::AppHandle) -> Result<u16, String> {
    use std::io::{Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    // Spawn a thread to accept exactly one connection
    tauri::async_runtime::spawn_blocking(move || {
        // Set a timeout so we don't block forever
        listener
            .set_nonblocking(false)
            .ok();
        let _ = listener
            .incoming()
            .next()
            .and_then(|stream| stream.ok())
            .map(|mut stream| {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();

                // Extract the query string from "GET /callback?code=...&state=... HTTP/1.1"
                let query = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .and_then(|path| path.split_once('?'))
                    .map(|(_, q)| q.to_string())
                    .unwrap_or_default();

                // Send a response page
                let body = "<!DOCTYPE html><html><body><h3>Authorization complete</h3><p>You can close this tab and return to Viboplr.</p><script>window.close()</script></body></html>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();

                let _ = app.emit("oauth-callback", query);
            });
    });

    Ok(port)
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

#[tauri::command]
pub async fn plugin_cache_image(
    state: State<'_, AppState>,
    plugin_id: String,
    subdir: String,
    filename: String,
    url: String,
) -> Result<String, String> {
    validate_plugin_cache_path(&plugin_id, &subdir, Some(&filename))?;

    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("URL must start with http:// or https://".to_string());
    }

    let cache_dir = state.app_dir.join("plugin-cache").join(&plugin_id).join(&subdir);
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("Failed to create cache dir: {}", e))?;

    let file_path = cache_dir.join(&filename);

    // Verify canonical path is within expected directory
    let canonical_parent = cache_dir.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    let expected_root = state.app_dir.join("plugin-cache").join(&plugin_id);
    std::fs::create_dir_all(&expected_root).ok();
    let canonical_root = expected_root.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("Invalid path".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent("Viboplr/0.1.0 (https://github.com/viboplr)")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url).send().await.map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let content_length = resp.content_length().unwrap_or(0);
    if content_length > 10 * 1024 * 1024 {
        return Err("Image too large (>10MB)".to_string());
    }

    let bytes = resp.bytes().await.map_err(|e| format!("Download failed: {}", e))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("Image too large (>10MB)".to_string());
    }

    std::fs::write(&file_path, &bytes).map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn plugin_cache_get_path(
    state: State<'_, AppState>,
    plugin_id: String,
    subdir: String,
    filename: String,
) -> Result<Option<String>, String> {
    validate_plugin_cache_path(&plugin_id, &subdir, Some(&filename))?;

    let file_path = state.app_dir.join("plugin-cache").join(&plugin_id).join(&subdir).join(&filename);
    if file_path.exists() {
        Ok(Some(file_path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn plugin_cache_delete_dir(
    state: State<'_, AppState>,
    plugin_id: String,
    subdir: String,
) -> Result<(), String> {
    validate_plugin_cache_path(&plugin_id, &subdir, None)?;

    let dir_path = state.app_dir.join("plugin-cache").join(&plugin_id).join(&subdir);
    if !dir_path.exists() {
        return Ok(());
    }

    // Verify canonical path is within expected root
    let canonical = dir_path.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    let expected_root = state.app_dir.join("plugin-cache").join(&plugin_id);
    if !expected_root.exists() {
        return Ok(());
    }
    let canonical_root = expected_root.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Invalid path".to_string());
    }

    std::fs::remove_dir_all(&dir_path).map_err(|e| format!("Failed to delete: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn plugin_cache_list_dirs(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<Vec<String>, String> {
    if plugin_id.is_empty() || plugin_id.contains("..") || plugin_id.contains('/') || plugin_id.contains('\\') {
        return Err("Invalid plugin ID".to_string());
    }

    let dir = state.app_dir.join("plugin-cache").join(&plugin_id);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut dirs = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Failed to read dir: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Read error: {}", e))?;
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                dirs.push(name.to_string());
            }
        }
    }
    Ok(dirs)
}

// ── Mixtape operations ───────────────────────────────────────────

#[tauri::command]
pub fn preview_mixtape(
    path: String,
    state: State<'_, AppState>,
) -> Result<crate::models::MixtapePreview, String> {
    let temp_dir = state.app_dir.join("temp");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    crate::mixtape::read_mixtape(std::path::Path::new(&path), &temp_dir)
}

#[tauri::command]
pub fn export_mixtape(
    dest_path: String,
    options: crate::models::MixtapeExportOptions,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let db = state.db.clone();
    let cancel = state.mixtape_cancel.clone();
    let app_dir = state.app_dir.clone();
    cancel.store(false, Ordering::Relaxed);

    let tracks = db.get_tracks_by_ids(&options.track_ids)
        .map_err(|e| format!("Failed to get tracks: {}", e))?;

    let mut sources = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for track in &tracks {
        let audio_path = if let Some(fs_path) = track.filesystem_path() {
            if std::path::Path::new(fs_path).exists() {
                fs_path.to_string()
            } else {
                skipped.push(format!("{} (file missing)", track.title));
                continue;
            }
        } else {
            skipped.push(format!("{} (remote track — download first)", track.title));
            continue;
        };

        let thumb_path = if let (Some(album_title), Some(artist_name)) = (&track.album_title, &track.artist_name) {
            let slug = crate::entity_image::entity_image_slug("album", album_title, Some(artist_name));
            crate::entity_image::get_image_path(&app_dir, "album", &slug)
                .map(|p| p.to_string_lossy().to_string())
        } else {
            None
        };

        sources.push(crate::mixtape::MixtapeTrackSource {
            title: track.title.clone(),
            artist: track.artist_name.clone().unwrap_or_default(),
            album: track.album_title.clone(),
            duration_secs: track.duration_secs,
            audio_path,
            thumb_path,
        });
    }
    if sources.is_empty() {
        return Err(format!("No exportable tracks. Skipped: {}", skipped.join(", ")));
    }

    let manifest = crate::mixtape::build_manifest(
        options.title, options.mixtape_type, options.metadata,
        options.created_by, vec![],
    );

    let cover_image_path = options.cover_image_path.clone();
    let include_thumbs = options.include_thumbs;

    thread::spawn(move || {
        let dest = std::path::Path::new(&dest_path);
        let cover = cover_image_path.as_ref().map(|p| std::path::Path::new(p.as_str()));

        match crate::mixtape::build_mixtape(
            dest, cover, &sources, manifest, include_thumbs, &cancel,
            |current, total, title, _sub_progress| {
                let _ = app.emit("mixtape-export-progress", crate::models::MixtapeExportProgress {
                    current_track: current, total_tracks: total,
                    phase: "packing".to_string(), track_title: title.to_string(),
                });
            },
        ) {
            Ok(file_size) => {
                let _ = app.emit("mixtape-export-complete", serde_json::json!({
                    "path": dest_path, "fileSize": file_size,
                }));
            }
            Err(e) => {
                let _ = app.emit("mixtape-export-error", serde_json::json!({ "message": e }));
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn import_mixtape(
    path: String,
    mode: crate::models::MixtapeImportMode,
    dest_dir: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let db = state.db.clone();
    let cancel = state.mixtape_cancel.clone();
    let app_dir = state.app_dir.clone();
    cancel.store(false, Ordering::Relaxed);

    thread::spawn(move || {
        let mixtape_path = std::path::Path::new(&path);

        match mode {
            crate::models::MixtapeImportMode::PlaylistAndFiles => {
                // Read the manifest first to get metadata
                let temp_dir = app_dir.join("temp");
                let _ = std::fs::create_dir_all(&temp_dir);
                let preview = match crate::mixtape::read_mixtape(mixtape_path, &temp_dir) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e }));
                        return;
                    }
                };

                let track_count = preview.manifest.tracks.len() as u32;
                let mixtape_title = preview.manifest.title.clone();

                // Extract to app_dir/mixtapes/{slug}/
                let slug = crate::entity_image::canonical_slug(&mixtape_title);
                let extract_dir = app_dir.join("mixtapes").join(&slug);
                let extract_opts = crate::mixtape::ExtractOptions { audio: true, images: true };

                let manifest = match crate::mixtape::extract_mixtape(
                    mixtape_path, &extract_dir, &extract_opts, &cancel,
                    |current, total, title| {
                        let _ = app.emit("mixtape-import-progress", crate::models::MixtapeImportProgress {
                            current_track: current, total_tracks: total,
                            track_title: title.to_string(),
                        });
                    },
                ) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e }));
                        return;
                    }
                };

                // Create playlist
                let source = Some("mixtape");
                let playlist_id = match db.save_playlist(&mixtape_title, source, None) {
                    Ok(id) => id,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e.to_string() }));
                        return;
                    }
                };

                // Save playlist tracks with file:// paths to extracted audio
                let track_tuples: Vec<(String, Option<String>, Option<String>, Option<f64>, Option<String>, Option<String>)> =
                    manifest.tracks.iter().map(|t| {
                        let audio_path = format!("file://{}", extract_dir.join(&t.file).to_string_lossy());
                        (
                            t.title.clone(),
                            Some(t.artist.clone()),
                            t.album.clone(),
                            t.duration_secs,
                            Some(audio_path),
                            None,
                        )
                    }).collect();

                let track_refs: Vec<(&str, Option<&str>, Option<&str>, Option<f64>, Option<&str>, Option<&str>)> =
                    track_tuples.iter().map(|(title, artist, album, dur, source, img)| {
                        (
                            title.as_str(),
                            artist.as_deref(),
                            album.as_deref(),
                            *dur,
                            source.as_deref(),
                            img.as_deref(),
                        )
                    }).collect();

                if let Err(e) = db.save_playlist_tracks(playlist_id, &track_refs) {
                    let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e.to_string() }));
                    return;
                }

                // Save cover as playlist image
                let cover_path = extract_dir.join("cover.jpg");
                if cover_path.exists() {
                    let img_dir = app_dir.join("playlist_images");
                    let _ = std::fs::create_dir_all(&img_dir);
                    let dest_img = img_dir.join(format!("{}.jpg", playlist_id));
                    if std::fs::copy(&cover_path, &dest_img).is_ok() {
                        let abs = dest_img.to_string_lossy().to_string();
                        let _ = db.update_playlist_image(playlist_id, &abs);
                    }
                }

                let _ = app.emit("mixtape-import-complete", serde_json::json!({
                    "mode": "PlaylistAndFiles", "trackCount": track_count, "playlistId": playlist_id,
                }));
            }

            crate::models::MixtapeImportMode::PlaylistOnly => {
                // Read manifest without extracting audio
                let temp_dir = app_dir.join("temp");
                let _ = std::fs::create_dir_all(&temp_dir);
                let preview = match crate::mixtape::read_mixtape(mixtape_path, &temp_dir) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e }));
                        return;
                    }
                };

                let track_count = preview.manifest.tracks.len() as u32;
                let mixtape_title = preview.manifest.title.clone();

                // Create playlist with metadata only (no file paths)
                let source = Some("mixtape");
                let playlist_id = match db.save_playlist(&mixtape_title, source, None) {
                    Ok(id) => id,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e.to_string() }));
                        return;
                    }
                };

                let track_tuples: Vec<(String, Option<String>, Option<String>, Option<f64>, Option<String>, Option<String>)> =
                    preview.manifest.tracks.iter().map(|t| {
                        (
                            t.title.clone(),
                            Some(t.artist.clone()),
                            t.album.clone(),
                            t.duration_secs,
                            None,
                            None,
                        )
                    }).collect();

                let track_refs: Vec<(&str, Option<&str>, Option<&str>, Option<f64>, Option<&str>, Option<&str>)> =
                    track_tuples.iter().map(|(title, artist, album, dur, source, img)| {
                        (
                            title.as_str(),
                            artist.as_deref(),
                            album.as_deref(),
                            *dur,
                            source.as_deref(),
                            img.as_deref(),
                        )
                    }).collect();

                if let Err(e) = db.save_playlist_tracks(playlist_id, &track_refs) {
                    let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e.to_string() }));
                    return;
                }

                // Save cover as playlist image from the temp preview
                if let Some(ref cover_temp_str) = preview.cover_temp_path {
                    let cover_temp = std::path::Path::new(cover_temp_str);
                    if cover_temp.exists() {
                        let img_dir = app_dir.join("playlist_images");
                        let _ = std::fs::create_dir_all(&img_dir);
                        let dest_img = img_dir.join(format!("{}.jpg", playlist_id));
                        if std::fs::copy(cover_temp, &dest_img).is_ok() {
                            let abs = dest_img.to_string_lossy().to_string();
                            let _ = db.update_playlist_image(playlist_id, &abs);
                        }
                    }
                }

                let _ = app.emit("mixtape-import-complete", serde_json::json!({
                    "mode": "PlaylistOnly", "trackCount": track_count, "playlistId": playlist_id,
                }));
            }

            crate::models::MixtapeImportMode::FilesOnly => {
                let extract_dest = match dest_dir {
                    Some(ref d) => std::path::PathBuf::from(d),
                    None => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({
                            "message": "dest_dir is required for FilesOnly mode"
                        }));
                        return;
                    }
                };

                let extract_opts = crate::mixtape::ExtractOptions { audio: true, images: false };

                let manifest = match crate::mixtape::extract_mixtape(
                    mixtape_path, &extract_dest, &extract_opts, &cancel,
                    |current, total, title| {
                        let _ = app.emit("mixtape-import-progress", crate::models::MixtapeImportProgress {
                            current_track: current, total_tracks: total,
                            track_title: title.to_string(),
                        });
                    },
                ) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e }));
                        return;
                    }
                };

                let track_count = manifest.tracks.len() as u32;
                let _ = app.emit("mixtape-import-complete", serde_json::json!({
                    "mode": "FilesOnly", "trackCount": track_count,
                }));
            }

            crate::models::MixtapeImportMode::JustPlay => {
                // Extract to temp directory for immediate playback
                let playback_dir = app_dir.join("temp").join("mixtape_playback");
                let _ = std::fs::remove_dir_all(&playback_dir);
                let _ = std::fs::create_dir_all(&playback_dir);

                let extract_opts = crate::mixtape::ExtractOptions { audio: true, images: true };

                let manifest = match crate::mixtape::extract_mixtape(
                    mixtape_path, &playback_dir, &extract_opts, &cancel,
                    |current, total, title| {
                        let _ = app.emit("mixtape-import-progress", crate::models::MixtapeImportProgress {
                            current_track: current, total_tracks: total,
                            track_title: title.to_string(),
                        });
                    },
                ) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e }));
                        return;
                    }
                };

                let track_paths: Vec<serde_json::Value> = manifest.tracks.iter().map(|t| {
                    serde_json::json!({
                        "title": t.title,
                        "artist": t.artist,
                        "album": t.album,
                        "durationSecs": t.duration_secs,
                        "path": format!("file://{}", playback_dir.join(&t.file).to_string_lossy()),
                    })
                }).collect();

                let track_count = manifest.tracks.len() as u32;

                let _ = app.emit("mixtape-just-play", serde_json::json!({
                    "tracks": track_paths,
                    "coverPath": playback_dir.join("cover.jpg").to_string_lossy(),
                }));

                let _ = app.emit("mixtape-import-complete", serde_json::json!({
                    "mode": "JustPlay", "trackCount": track_count,
                }));
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_mixtape_operation(state: State<'_, AppState>) -> Result<(), String> {
    state.mixtape_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn cleanup_temp_mixtapes(state: State<'_, AppState>) -> Result<(), String> {
    let temp_mixtape_dir = state.app_dir.join("temp").join("mixtape_playback");
    if temp_mixtape_dir.exists() {
        std::fs::remove_dir_all(&temp_mixtape_dir)
            .map_err(|e| format!("Cleanup failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn check_for_extension_updates(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<crate::models::ExtensionUpdate>, String> {
    let app_version = app.package_info().version.to_string();
    let empty = std::path::PathBuf::new();
    let native_dir = state.native_plugins_dir.as_deref().unwrap_or(&empty);
    Ok(crate::update_checker::check_all_updates(
        &state.app_dir,
        native_dir,
        &app_version,
    ))
}

#[tauri::command]
pub fn download_and_install_plugin_update(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    plugin_id: String,
    download_url: String,
) -> Result<(), String> {
    let resp = reqwest::blocking::get(&download_url)
        .map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().map_err(|e| format!("Read error: {}", e))?;
    crate::plugins::install_plugin_from_zip(&state.app_dir, &plugin_id, &bytes)?;
    let _ = app.emit("extension-update-installed", &plugin_id);
    Ok(())
}

#[tauri::command]
pub fn download_and_install_skin_update(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    skin_id: String,
    download_url: String,
) -> Result<(), String> {
    let content = crate::skins::fetch_url(&download_url)?;
    let dir = crate::skins::skins_dir(&state.app_dir);
    crate::skins::update_skin_in_dir(&dir, &skin_id, &content)?;
    let _ = app.emit("extension-update-installed", &skin_id);
    Ok(())
}

#[tauri::command]
pub fn install_plugin_from_url(
    state: State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    crate::plugins::install_plugin_from_url(&state.app_dir, &url)
}

/// Determines if a collection is due for an auto-update based on its settings and last sync time.
///
/// Returns true if:
/// - The collection is enabled and has auto_update enabled
/// - The collection kind is "local" or "subsonic"
/// - Either the collection has never been synced (last_synced_at is None)
///   OR the configured interval has elapsed since the last sync
///
/// Note: Error backoff is handled naturally through last_synced_at updates.
/// When a sync fails, update_collection_sync_error sets last_synced_at to the current time,
/// so the full interval must elapse before the next retry.
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
            native_plugins_dir: None,
            image_resolve_registry: Arc::new(ImageResolveRegistry {
                pending: Mutex::new(std::collections::HashMap::new()),
            }),
            download_resolve_registry: Arc::new(DownloadResolveRegistry::new()),
            direct_download_cancel: Arc::new(AtomicBool::new(false)),
            mixtape_cancel: Arc::new(AtomicBool::new(false)),
            update_checker_cancel: Arc::new(AtomicBool::new(false)),
            resyncing_collections: Arc::new(Mutex::new(HashSet::new())),

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
    fn test_auto_update_not_due_tidal_kind() {
        let mut col = make_collection(true, 60, Some(0), None);
        col.kind = "tidal".to_string();
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
}

