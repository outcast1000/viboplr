// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

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

#[tauri::command]
pub fn open_devtools_for_window(app: AppHandle, label: String) {
    if let Some(window) = app.get_webview_window(&label) {
        window.open_devtools();
    }
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
pub fn get_startup_timings() -> Vec<crate::timing::TimingEntry> {
    crate::timing::timer().get_entries()
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
#[tauri::command]
pub fn set_cursor_tracker(state: State<'_, AppState>, active: bool) {
    state.cursor_tracker_active.store(active, Ordering::Relaxed);
}
