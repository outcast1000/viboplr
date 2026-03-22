use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};

use crate::db::Database;
use crate::models::*;
use crate::scanner;
use crate::subsonic::SubsonicClient;
use crate::tidal::TidalClient;

pub enum ImageDownloadRequest {
    Artist { id: i64, name: String },
    Album { id: i64, title: String, artist_name: Option<String> },
}

pub struct DownloadQueue {
    pub queue: Mutex<Vec<ImageDownloadRequest>>,
    pub condvar: Condvar,
}

pub struct AppState {
    pub db: Arc<Database>,
    pub app_dir: std::path::PathBuf,
    pub download_queue: Arc<DownloadQueue>,
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
            let api_url = url.as_deref().ok_or("URL is required for TIDAL collections")?;

            // Test connection
            let client = TidalClient::new(api_url);
            client
                .ping()
                .map_err(|e| format!("Failed to connect: {}", e))?;

            let collection = state
                .db
                .add_collection("tidal", &name, None, Some(api_url), None, None, None, None)
                .map_err(|e| e.to_string())?;

            Ok(collection)
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
    album_id: Option<i64>,
    sort_field: Option<String>,
    sort_dir: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    has_youtube_url: Option<bool>,
) -> Result<Vec<Track>, String> {
    state.db.get_tracks(
        album_id,
        sort_field.as_deref(),
        sort_dir.as_deref(),
        limit.unwrap_or(100),
        offset.unwrap_or(0),
        has_youtube_url.unwrap_or(false),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search(
    state: State<'_, AppState>,
    query: String,
    artist_id: Option<i64>,
    album_id: Option<i64>,
    tag_id: Option<i64>,
    liked_only: Option<bool>,
    sort_field: Option<String>,
    sort_dir: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    has_youtube_url: Option<bool>,
) -> Result<Vec<Track>, String> {
    let yt = has_youtube_url.unwrap_or(false);
    if query.trim().is_empty() {
        return state.db.get_tracks(
            None,
            sort_field.as_deref(),
            sort_dir.as_deref(),
            limit.unwrap_or(100),
            offset.unwrap_or(0),
            yt,
        ).map_err(|e| e.to_string());
    }
    state
        .db
        .search_tracks(
            &query, artist_id, album_id, tag_id, liked_only.unwrap_or(false),
            sort_field.as_deref(), sort_dir.as_deref(),
            limit.unwrap_or(100), offset.unwrap_or(0),
            yt,
        )
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
            "tidal" => {
                let base_url = collection
                    .url
                    .as_deref()
                    .ok_or("TIDAL collection has no URL")?;
                let client = TidalClient::new(base_url);
                client
                    .get_stream_url(remote_id, "LOSSLESS")
                    .map_err(|e| e.to_string())
            }
            _ => Err(format!("Unknown collection kind: {}", collection.kind)),
        }
    } else {
        Ok(track.path)
    }
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
pub fn toggle_track_liked(
    state: State<'_, AppState>,
    track_id: i64,
    liked: bool,
) -> Result<(), String> {
    state
        .db
        .toggle_track_liked(track_id, liked)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_artist_liked(
    state: State<'_, AppState>,
    artist_id: i64,
    liked: bool,
) -> Result<(), String> {
    state
        .db
        .toggle_artist_liked(artist_id, liked)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_album_liked(
    state: State<'_, AppState>,
    album_id: i64,
    liked: bool,
) -> Result<(), String> {
    state
        .db
        .toggle_album_liked(album_id, liked)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_tag_liked(
    state: State<'_, AppState>,
    tag_id: i64,
    liked: bool,
) -> Result<(), String> {
    state
        .db
        .toggle_tag_liked(tag_id, liked)
        .map_err(|e| e.to_string())
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

// --- Artist image commands ---

#[tauri::command]
pub fn get_artist_image(state: State<'_, AppState>, artist_id: i64) -> Option<String> {
    crate::artist_image::get_image_path(&state.app_dir, artist_id)
        .map(|p| p.to_string_lossy().to_string())
}

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
pub fn set_artist_image(
    state: State<'_, AppState>,
    artist_id: i64,
    source_path: String,
) -> Result<String, String> {
    let source = std::path::Path::new(&source_path);
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();

    // Remove any existing image first
    crate::artist_image::remove_image(&state.app_dir, artist_id);

    let dest_dir = state.app_dir.join("artist_images");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.{}", artist_id, ext));
    std::fs::copy(source, &dest).map_err(|e| format!("Failed to copy image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn paste_artist_image(
    state: State<'_, AppState>,
    artist_id: i64,
    image_data: Vec<u8>,
) -> Result<String, String> {
    let ext = detect_image_format(&image_data);
    crate::artist_image::remove_image(&state.app_dir, artist_id);
    let dest_dir = state.app_dir.join("artist_images");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.{}", artist_id, ext));
    std::fs::write(&dest, &image_data).map_err(|e| format!("Failed to write image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn remove_artist_image(state: State<'_, AppState>, artist_id: i64) {
    crate::artist_image::remove_image(&state.app_dir, artist_id);
}

// --- Album image commands ---

#[tauri::command]
pub fn get_album_image(state: State<'_, AppState>, album_id: i64) -> Option<String> {
    crate::album_image::get_image_path(&state.app_dir, album_id)
        .map(|p| p.to_string_lossy().to_string())
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
pub fn set_album_image(
    state: State<'_, AppState>,
    album_id: i64,
    source_path: String,
) -> Result<String, String> {
    let source = std::path::Path::new(&source_path);
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();

    crate::album_image::remove_image(&state.app_dir, album_id);

    let dest_dir = state.app_dir.join("album_images");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.{}", album_id, ext));
    std::fs::copy(source, &dest).map_err(|e| format!("Failed to copy image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn paste_album_image(
    state: State<'_, AppState>,
    album_id: i64,
    image_data: Vec<u8>,
) -> Result<String, String> {
    let ext = detect_image_format(&image_data);
    crate::album_image::remove_image(&state.app_dir, album_id);
    let dest_dir = state.app_dir.join("album_images");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.{}", album_id, ext));
    std::fs::write(&dest, &image_data).map_err(|e| format!("Failed to write image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn remove_album_image(state: State<'_, AppState>, album_id: i64) {
    crate::album_image::remove_image(&state.app_dir, album_id);
}

// --- Tag image commands ---

#[tauri::command]
pub fn get_tag_image(state: State<'_, AppState>, tag_id: i64) -> Option<String> {
    crate::tag_image::get_image_path(&state.app_dir, tag_id)
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_tag_image(
    state: State<'_, AppState>,
    tag_id: i64,
    source_path: String,
) -> Result<String, String> {
    let source = std::path::Path::new(&source_path);
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();

    crate::tag_image::remove_image(&state.app_dir, tag_id);

    let dest_dir = state.app_dir.join("tag_images");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.{}", tag_id, ext));
    std::fs::copy(source, &dest).map_err(|e| format!("Failed to copy image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn paste_tag_image(
    state: State<'_, AppState>,
    tag_id: i64,
    image_data: Vec<u8>,
) -> Result<String, String> {
    let ext = detect_image_format(&image_data);
    crate::tag_image::remove_image(&state.app_dir, tag_id);
    let dest_dir = state.app_dir.join("tag_images");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.{}", tag_id, ext));
    std::fs::write(&dest, &image_data).map_err(|e| format!("Failed to write image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn remove_tag_image(state: State<'_, AppState>, tag_id: i64) {
    crate::tag_image::remove_image(&state.app_dir, tag_id);
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
pub fn get_recent_plays(state: State<'_, AppState>, limit: i64) -> Result<Vec<PlayHistoryEntry>, String> {
    state.db.get_recent_plays(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_most_played(state: State<'_, AppState>, limit: i64) -> Result<Vec<MostPlayedTrack>, String> {
    state.db.get_most_played(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_most_played_since(state: State<'_, AppState>, since_ts: i64, limit: i64) -> Result<Vec<MostPlayedTrack>, String> {
    state.db.get_most_played_since(since_ts, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_auto_continue_track(
    state: State<'_, AppState>,
    strategy: String,
    current_track_id: i64,
) -> Result<Option<Track>, String> {
    state
        .db
        .get_auto_continue_track(&strategy, current_track_id)
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

#[tauri::command]
pub fn load_playlist(
    state: State<'_, AppState>,
    path: String,
) -> Result<PlaylistLoadResult, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read playlist: {}", e))?;
    let playlist_path = std::path::Path::new(&path);
    let parent_dir = playlist_path.parent();

    let mut file_paths: Vec<String> = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let resolved = if line.contains("://") || std::path::Path::new(line).is_absolute() {
            line.to_string()
        } else if let Some(parent) = parent_dir {
            parent.join(line).to_string_lossy().to_string()
        } else {
            line.to_string()
        };
        file_paths.push(resolved);
    }

    let total_count = file_paths.len();
    let tracks = state.db.get_tracks_by_paths(&file_paths).map_err(|e| e.to_string())?;
    let not_found_count = total_count - tracks.len();

    let playlist_name = playlist_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Playlist")
        .to_string();

    Ok(PlaylistLoadResult {
        tracks,
        not_found_count,
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

#[tauri::command]
pub async fn tidal_test_connection(url: String) -> Result<String, String> {
    log::info!("tidal_test_connection called with url: {}", url);
    let api_url = format!("{}/", url.trim_end_matches('/'));
    let resp = reqwest::get(&api_url)
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;
    let version = json["version"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    log::info!("tidal_test_connection success: version={}", version);
    Ok(version)
}

#[tauri::command]
pub fn tidal_search(
    state: State<'_, AppState>,
    collection_id: i64,
    query: String,
    limit: u32,
    offset: u32,
) -> Result<TidalSearchResult, String> {
    let collection = state
        .db
        .get_collection_by_id(collection_id)
        .map_err(|e| e.to_string())?;
    let base_url = collection.url.as_deref().ok_or("Collection has no URL")?;
    let client = TidalClient::new(base_url);

    let tracks = client
        .search_tracks(&query, limit, offset)
        .map_err(|e| e.to_string())?;
    let artists = client
        .search_artists(&query, limit, offset)
        .map_err(|e| e.to_string())?;
    let albums = client
        .search_albums(&query, limit, offset)
        .map_err(|e| e.to_string())?;

    Ok(TidalSearchResult {
        tracks: tracks
            .into_iter()
            .map(|t| TidalSearchTrack {
                tidal_id: t.id,
                title: t.title,
                artist_name: t.artist_name,
                artist_id: t.artist_id,
                album_title: t.album_title,
                album_id: t.album_id,
                cover_id: t.cover_id,
                duration_secs: t.duration_secs,
                track_number: t.track_number,
            })
            .collect(),
        albums: albums
            .into_iter()
            .map(|a| TidalSearchAlbum {
                tidal_id: a.id,
                title: a.title,
                artist_name: a.artist_name,
                cover_id: a.cover_id,
                year: a.year,
            })
            .collect(),
        artists: artists
            .into_iter()
            .map(|a| TidalSearchArtist {
                tidal_id: a.id,
                name: a.name,
                picture_id: a.picture_id,
            })
            .collect(),
    })
}

#[tauri::command]
pub fn tidal_save_track(
    state: State<'_, AppState>,
    collection_id: i64,
    tidal_track_id: String,
) -> Result<Track, String> {
    let collection = state
        .db
        .get_collection_by_id(collection_id)
        .map_err(|e| e.to_string())?;
    let base_url = collection.url.as_deref().ok_or("Collection has no URL")?;
    let client = TidalClient::new(base_url);

    let info = client
        .get_track_info(&tidal_track_id)
        .map_err(|e| e.to_string())?;

    let artist_id = if let Some(artist_name) = &info.artist_name {
        Some(
            state
                .db
                .get_or_create_artist(artist_name)
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };

    let album_id = if let Some(album_title) = &info.album_title {
        Some(
            state
                .db
                .get_or_create_album(album_title, artist_id, None)
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };

    let path = format!("tidal://{}/{}", collection_id, tidal_track_id);
    let format_str = "flac"; // TIDAL streams are typically FLAC

    let track_id = state
        .db
        .upsert_track(
            &path,
            &info.title,
            artist_id,
            album_id,
            info.track_number,
            info.duration_secs,
            Some(format_str),
            None, // file_size
            None, // modified_at
            Some(collection_id),
            Some(&tidal_track_id),
        )
        .map_err(|e| e.to_string())?;

    let _ = state.db.rebuild_fts();

    state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tidal_get_album(
    state: State<'_, AppState>,
    collection_id: i64,
    album_id: String,
) -> Result<TidalAlbumDetail, String> {
    let collection = state
        .db
        .get_collection_by_id(collection_id)
        .map_err(|e| e.to_string())?;
    let base_url = collection.url.as_deref().ok_or("Collection has no URL")?;
    let client = TidalClient::new(base_url);

    let album = client.get_album(&album_id).map_err(|e| e.to_string())?;

    Ok(TidalAlbumDetail {
        tidal_id: album.id,
        title: album.title,
        artist_name: album.artist_name,
        cover_id: album.cover_id,
        year: album.year,
        tracks: album
            .tracks
            .into_iter()
            .map(|t| TidalSearchTrack {
                tidal_id: t.id,
                title: t.title,
                artist_name: t.artist_name,
                artist_id: t.artist_id,
                album_title: t.album_title,
                album_id: t.album_id,
                cover_id: t.cover_id,
                duration_secs: t.duration_secs,
                track_number: t.track_number,
            })
            .collect(),
    })
}

#[tauri::command]
pub fn tidal_get_artist(
    state: State<'_, AppState>,
    collection_id: i64,
    artist_id: String,
) -> Result<TidalArtistDetail, String> {
    let collection = state
        .db
        .get_collection_by_id(collection_id)
        .map_err(|e| e.to_string())?;
    let base_url = collection.url.as_deref().ok_or("Collection has no URL")?;
    let client = TidalClient::new(base_url);

    let artist = client.get_artist(&artist_id).map_err(|e| e.to_string())?;
    let albums = client
        .get_artist_albums(&artist_id)
        .map_err(|e| e.to_string())?;

    Ok(TidalArtistDetail {
        tidal_id: artist.id,
        name: artist.name,
        picture_id: artist.picture_id,
        albums: albums
            .into_iter()
            .map(|a| TidalSearchAlbum {
                tidal_id: a.id,
                title: a.title,
                artist_name: a.artist_name,
                cover_id: a.cover_id,
                year: a.year,
            })
            .collect(),
    })
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

    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send()
        .map_err(|e| format!("HTTP request failed: {}", e))?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn test_state() -> AppState {
        let db = Database::new_in_memory().expect("Failed to create test DB");
        AppState {
            db: Arc::new(db),
            app_dir: std::path::PathBuf::from("/tmp/viboplr-test"),
            download_queue: Arc::new(DownloadQueue {
                queue: Mutex::new(Vec::new()),
                condvar: Condvar::new(),
            }),
        }
    }

    /// Helper: insert a track directly through the DB layer
    fn insert_track(state: &AppState, path: &str, title: &str, artist_id: Option<i64>, album_id: Option<i64>) -> i64 {
        state.db.upsert_track(path, title, artist_id, album_id, None, Some(200.0), Some("mp3"), Some(5_000_000), None, None, None)
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

        let results = state.db.search_tracks("Alpha", None, None, None, false, None, None, 100, 0, false).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Alpha Song");

        // Search with artist filter
        let results = state.db.search_tracks("Song", Some(artist_id), None, None, false, None, None, 100, 0, false).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_toggle_liked() {
        let state = test_state();
        let artist_id = state.db.get_or_create_artist("Artist").unwrap();
        let album_id = state.db.get_or_create_album("Album", Some(artist_id), None).unwrap();
        let track_id = insert_track(&state, "/t.mp3", "Track", Some(artist_id), Some(album_id));

        // Track liked
        state.db.toggle_track_liked(track_id, true).unwrap();
        let track = state.db.get_track_by_id(track_id).unwrap();
        assert!(track.liked);
        state.db.toggle_track_liked(track_id, false).unwrap();
        let track = state.db.get_track_by_id(track_id).unwrap();
        assert!(!track.liked);

        // Artist liked — need recompute_counts for artist to show up (track_count > 0 filter)
        state.db.toggle_artist_liked(artist_id, true).unwrap();
        state.db.recompute_counts().unwrap();
        let artists = state.db.get_artists().unwrap();
        assert!(!artists.is_empty());
        assert!(artists.iter().any(|a| a.id == artist_id && a.liked));

        // Album liked
        state.db.toggle_album_liked(album_id, true).unwrap();
        state.db.recompute_counts().unwrap();
        let albums = state.db.get_albums(None).unwrap();
        assert!(albums.iter().any(|a| a.id == album_id && a.liked));
    }

    #[test]
    fn test_record_and_get_plays() {
        let state = test_state();
        let t1 = insert_track(&state, "/a.mp3", "Song A", None, None);
        let t2 = insert_track(&state, "/b.mp3", "Song B", None, None);

        state.db.record_play(t1).unwrap();
        state.db.record_play(t1).unwrap();
        state.db.record_play(t2).unwrap();

        let recent = state.db.get_recent_plays(10).unwrap();
        assert_eq!(recent.len(), 3);
        let t1_plays = recent.iter().filter(|r| r.track_id == t1).count();
        let t2_plays = recent.iter().filter(|r| r.track_id == t2).count();
        assert_eq!(t1_plays, 2);
        assert_eq!(t2_plays, 1);

        let most = state.db.get_most_played(10).unwrap();
        assert_eq!(most[0].track_id, t1);
        assert_eq!(most[0].play_count, 2);
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
