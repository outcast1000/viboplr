// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
//
// Every command here is `async` on purpose. Tauri classifies a non-`async`
// `#[tauri::command]` as `ExecutionContext::Blocking` and runs it inline on the
// main thread, so these — which all do network I/O — used to freeze the webview
// for the whole download. They now hand the blocking work to `spawn_blocking`,
// matching `dependency_install` in `media.rs`.
use super::*;

#[tauri::command]
pub async fn check_for_extension_updates(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<crate::update_checker::UpdateCheckReport, String> {
    let app_dir = state.app_dir.clone();
    let native_dir = state.native_plugins_dir.clone().unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        let app_version = app.package_info().version.to_string();
        crate::update_checker::check_all_updates(&app_dir, &native_dir, &app_version)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))
}

#[tauri::command]
pub async fn download_and_install_plugin_update(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    plugin_id: String,
    download_url: String,
) -> Result<(), String> {
    let app_dir = state.app_dir.clone();
    let cancel = Arc::clone(&state.plugin_install_cancel);

    tauri::async_runtime::spawn_blocking(move || {
        // Same streamed download the gallery install uses, so an update reports
        // real progress instead of the single opaque `resp.bytes()` it was.
        let bytes = super::plugins::download_plugin_zip(&app, &cancel, &plugin_id, &download_url)?;
        crate::plugins::install_plugin_from_zip(&app_dir, &plugin_id, &bytes)?;
        let _ = app.emit("extension-update-installed", &plugin_id);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn download_and_install_skin_update(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    skin_id: String,
    download_url: String,
) -> Result<(), String> {
    let app_dir = state.app_dir.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let content = crate::skins::fetch_url(&download_url)?;
        let dir = crate::skins::skins_dir(&app_dir);
        crate::skins::update_skin_in_dir(&dir, &skin_id, &content)?;
        let _ = app.emit("extension-update-installed", &skin_id);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn install_plugin_from_url(
    state: State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    let app_dir = state.app_dir.clone();

    tauri::async_runtime::spawn_blocking(move || {
        crate::plugins::install_plugin_from_url(&app_dir, &url)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
