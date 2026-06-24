// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

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
pub fn open_skin_in_editor(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let dir = skins::skins_dir(&state.app_dir);
    let path = skins::skin_path(&dir, &id);
    if !path.exists() {
        return Err(format!("Skin '{}' not found", id));
    }
    tauri_plugin_opener::open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
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
