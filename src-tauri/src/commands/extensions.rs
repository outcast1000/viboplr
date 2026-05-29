// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

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
