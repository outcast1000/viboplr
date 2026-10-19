// Home view snapshot (see home_snapshot.rs). Async + spawn_blocking: a
// non-async command runs inline on the main thread, and this is a few hundred
// KB of disk I/O.
use super::*;

/// The file's raw bytes (an `ArrayBuffer` in the webview; empty when there is
/// no snapshot). Raw rather than parsed JSON: this is on the startup path, and
/// a `serde_json::Value` would be parsed here only to be serialized again.
#[tauri::command]
pub async fn home_snapshot_read(state: State<'_, AppState>) -> Result<tauri::ipc::Response, String> {
    let dir = state.app_dir.clone();
    let bytes = run_blocking(move || crate::home_snapshot::read(&dir))
        .await?;
    Ok(tauri::ipc::Response::new(bytes.unwrap_or_default()))
}

#[tauri::command]
pub async fn home_snapshot_write(state: State<'_, AppState>, snapshot: serde_json::Value) -> Result<(), String> {
    let dir = state.app_dir.clone();
    run_blocking(move || crate::home_snapshot::write(&dir, &snapshot))
        .await
}
