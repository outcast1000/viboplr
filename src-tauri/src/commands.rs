use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, State};

use crate::db::Database;
use crate::models::*;
use crate::scanner;
use crate::watcher;

pub struct AppState {
    pub db: Arc<Database>,
}

// --- Folder commands ---

#[tauri::command]
pub fn add_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<FolderInfo, String> {
    let folder = state.db.add_folder(&path).map_err(|e| e.to_string())?;
    let folder_id = folder.id;

    // Start background scan
    let db = state.db.clone();
    let scan_path = path.clone();
    thread::spawn(move || {
        scanner::scan_folder(&db, &scan_path, |scanned, total| {
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
        let _ = db.update_folder_scanned(folder_id);
        let _ = app.emit("scan-complete", serde_json::json!({ "folder": scan_path }));
    });

    // Start watching this folder
    let db2 = state.db.clone();
    let _ = watcher::start_watcher(db2, vec![path]);

    Ok(folder)
}

#[tauri::command]
pub fn remove_folder(state: State<'_, AppState>, folder_id: i64) -> Result<(), String> {
    state
        .db
        .remove_folder(folder_id)
        .map_err(|e| e.to_string())?;
    let _ = state.db.rebuild_fts();
    Ok(())
}

#[tauri::command]
pub fn get_folders(state: State<'_, AppState>) -> Result<Vec<FolderInfo>, String> {
    state.db.get_folders().map_err(|e| e.to_string())
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
pub fn get_tracks(
    state: State<'_, AppState>,
    album_id: Option<i64>,
) -> Result<Vec<Track>, String> {
    state.db.get_tracks(album_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search(state: State<'_, AppState>, query: String) -> Result<Vec<Track>, String> {
    if query.trim().is_empty() {
        return state.db.get_tracks(None).map_err(|e| e.to_string());
    }
    state.db.search_tracks(&query).map_err(|e| e.to_string())
}

// --- Track path command ---

#[tauri::command]
pub fn get_track_path(state: State<'_, AppState>, track_id: i64) -> Result<String, String> {
    let track = state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())?;
    Ok(track.path)
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
pub fn rebuild_search_index(state: State<'_, AppState>) -> Result<(), String> {
    state.db.rebuild_fts().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_in_folder(state: State<'_, AppState>, track_id: i64) -> Result<(), String> {
    let track = state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())?;
    let path = std::path::Path::new(&track.path);
    let folder = path.parent().unwrap_or(path);
    std::process::Command::new("open")
        .arg(folder)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
