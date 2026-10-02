// Latest play snapshots (see recent_plays.rs). Async + spawn_blocking: the
// writer resizes a cover image and every call touches the disk, and a
// non-async command runs inline on the main thread.
use super::*;

#[tauri::command]
pub async fn recent_play_write(
    state: State<'_, AppState>,
    id: String,
    manifest: crate::models::BundleManifest,
    cover: Option<String>,
) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || crate::recent_plays::write(&dir, &id, manifest, cover.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn recent_play_read(state: State<'_, AppState>, id: String) -> Result<crate::models::BundleManifest, String> {
    let dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || crate::recent_plays::read(&dir, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn recent_play_delete(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for id in &ids {
            crate::recent_plays::delete(&dir, id)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Startup sweep: delete every snapshot no session names. Returns the count.
#[tauri::command]
pub async fn recent_play_gc(state: State<'_, AppState>, keep: Vec<String>) -> Result<usize, String> {
    let dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || crate::recent_plays::gc(&dir, &keep))
        .await
        .map_err(|e| e.to_string())?
}
