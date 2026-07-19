// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

// ─── Main Playlist Folder Commands ───────────────────────────────────────────

#[tauri::command]
pub async fn main_playlist_write(
    state: State<'_, AppState>,
    manifest: Option<crate::models::BundleManifest>,
    state_data: Option<crate::models::MainPlaylistState>,
) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::main_playlist::write(&dir, manifest.as_ref(), state_data.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn main_playlist_read(
    state: State<'_, AppState>,
) -> Result<crate::models::MainPlaylistReadResult, String> {
    let dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || crate::main_playlist::read(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn main_playlist_clear(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || crate::main_playlist::clear(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn main_playlist_gc(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || crate::main_playlist::gc(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn main_playlist_set_cover(
    state: State<'_, AppState>,
    source: Option<crate::models::ImageSource>,
) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || crate::main_playlist::set_cover(&dir, source.as_ref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn main_playlist_set_thumb(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    source: crate::models::ImageSource,
) -> Result<(), String> {
    let dir = state.app_dir.clone();
    let key_clone = key.clone();
    let filename = tauri::async_runtime::spawn_blocking(move || crate::main_playlist::set_thumb(&dir, &key_clone, &source))
        .await
        .map_err(|e| e.to_string())??;
    let _ = app.emit(
        "main-playlist-thumb-ready",
        serde_json::json!({ "key": key, "filename": filename }),
    );
    Ok(())
}

#[tauri::command]
pub async fn main_playlist_remove_thumb(
    state: State<'_, AppState>,
    key: String,
) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || crate::main_playlist::remove_thumb(&dir, &key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn main_playlist_dir(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.app_dir.join("main-playlist").to_string_lossy().into_owned())
}
