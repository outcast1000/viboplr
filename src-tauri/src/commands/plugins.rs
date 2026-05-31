// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

#[tauri::command]
pub fn plugin_get_dir(state: State<'_, AppState>) -> Result<String, String> {
    let plugins_dir = state.app_dir.join("plugins");
    if !plugins_dir.exists() {
        std::fs::create_dir_all(&plugins_dir).map_err(|e| e.to_string())?;
    }
    Ok(plugins_dir.to_string_lossy().to_string())
}

// Scan a single external "dev" plugin folder (one folder = one plugin). Unlike
// scan_plugins_dir, the plugin id comes from the MANIFEST's "id" field (not the
// directory name) so a dev folder named e.g. "viboplr-spotify" can correctly
// shadow the installed/built-in "spotify-browse". Returns the plugin JSON
// (with "dev": true) or None if the folder has no valid manifest.json.
fn scan_dev_plugin(dir: &std::path::Path) -> Option<serde_json::Value> {
    let manifest_path = dir.join("manifest.json");
    if !manifest_path.exists() {
        return None;
    }
    let content = match std::fs::read_to_string(&manifest_path) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("Dev plugin: failed to read manifest {}: {}", manifest_path.display(), e);
            return None;
        }
    };
    let manifest: serde_json::Value = match serde_json::from_str(&content) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("Dev plugin: invalid manifest {}: {}", manifest_path.display(), e);
            return None;
        }
    };
    let id = match manifest.get("id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            log::warn!("Dev plugin: manifest {} missing 'id' field", manifest_path.display());
            return None;
        }
    };
    let code = std::fs::read_to_string(dir.join("index.js")).ok();
    Some(serde_json::json!({
        "id": id,
        "manifest": manifest,
        "builtin": false,
        "dev": true,
        "devPath": dir.to_string_lossy(),
        "code": code,
    }))
}

#[tauri::command]
pub fn plugin_list_installed(
    state: State<'_, AppState>,
    dev_plugin_dir: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let user_plugins_dir = state.app_dir.join("plugins");
    if !user_plugins_dir.exists() {
        std::fs::create_dir_all(&user_plugins_dir).map_err(|e| e.to_string())?;
    }

    let mut seen_ids = std::collections::HashSet::new();
    let mut plugins = Vec::new();

    // Dev plugin (if set) takes highest precedence — overrides user AND native.
    if let Some(path) = dev_plugin_dir.as_ref().filter(|p| !p.is_empty()) {
        if let Some(p) = scan_dev_plugin(std::path::Path::new(path)) {
            if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
                seen_ids.insert(id.to_string());
            }
            plugins.push(p);
        }
    }

    // User plugins take precedence over native (loaded next).
    for p in scan_plugins_dir(&user_plugins_dir, false) {
        if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
            if seen_ids.contains(id) {
                continue; // dev plugin overrides user
            }
            seen_ids.insert(id.to_string());
        }
        plugins.push(p);
    }

    // Native/builtin plugins (skipped if dev or user has same id)
    if let Some(ref native_dir) = state.native_plugins_dir {
        for p in scan_plugins_dir(native_dir, true) {
            if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
                if seen_ids.contains(id) {
                    continue;
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
pub fn plugin_getenv(key: String) -> Result<Option<String>, String> {
    let allowed = ["LASTFM_API_KEY", "LASTFM_API_SECRET"];
    if !allowed.contains(&key.as_str()) {
        return Err(format!("Environment variable not allowed: {}", key));
    }
    let value = match key.as_str() {
        "LASTFM_API_KEY" => LASTFM_API_KEY,
        "LASTFM_API_SECRET" => LASTFM_API_SECRET,
        _ => "",
    };
    Ok(if value.is_empty() { None } else { Some(value.to_string()) })
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
    let _ = state.db.update_fts_for_track(track_id);
    Ok(result)
}

#[tauri::command]
pub fn plugin_apply_tags_bulk(
    state: State<'_, AppState>,
    assignments: Vec<(i64, Vec<String>)>,
) -> Result<usize, String> {
    let count = assignments.len();
    state.db.apply_tags_bulk(&assignments).map_err(|e| e.to_string())?;
    Ok(count)
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
    info_defaults: Vec<(String, String, i64, i64)>,
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
pub async fn plugin_fetch(url: String, method: Option<String>, headers: Option<std::collections::HashMap<String, String>>, body: Option<String>, insecure: Option<bool>) -> Result<serde_json::Value, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15");
    if insecure.unwrap_or(false) {
        builder = builder.danger_accept_invalid_certs(true);
    }
    let client = builder
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
pub fn install_gallery_plugin_by_update_url(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    plugin_id: String,
    update_url: String,
) -> Result<(), String> {
    // Resolve the plugin's own-repo updateUrl to a zip URL (enforces minAppVersion).
    let app_version = app.package_info().version.to_string();
    let zip_url = crate::update_checker::resolve_install_zip_url(&update_url, &app_version)?;
    // Download + install via the same path the auto-updater uses.
    let resp = reqwest::blocking::get(&zip_url).map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().map_err(|e| format!("Read error: {}", e))?;
    crate::plugins::install_plugin_from_zip(&state.app_dir, &plugin_id, &bytes)?;
    let _ = app.emit("extension-update-installed", &plugin_id);
    Ok(())
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
