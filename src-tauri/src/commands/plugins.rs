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
    enabled_ids: Option<Vec<String>>,
) -> Result<Vec<serde_json::Value>, String> {
    let user_plugins_dir = state.app_dir.join("plugins");
    if !user_plugins_dir.exists() {
        std::fs::create_dir_all(&user_plugins_dir).map_err(|e| e.to_string())?;
    }

    // Only read `index.js` for plugins the frontend will actually activate.
    // `None` (first launch — no saved enabled set yet) means "read all", so the
    // auto-enable-all-builtins path still has bundled code without extra IPC.
    let code_filter: Option<std::collections::HashSet<String>> =
        enabled_ids.map(|ids| ids.into_iter().collect());
    let code_filter_ref = code_filter.as_ref();

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
    for p in scan_plugins_dir(&user_plugins_dir, false, code_filter_ref) {
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
        for p in scan_plugins_dir(native_dir, true, code_filter_ref) {
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

/// One track like a plugin wants to persist (used by the Last.fm loved-tracks
/// import). `liked` defaults to 1 (a "love"); `updatedAt` is the Last.fm love
/// time in unix seconds when known, so the newer-wins merge is time-correct.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTrackLike {
    pub title: String,
    pub artist_name: Option<String>,
    #[serde(default = "plugin_track_like_default")]
    pub liked: i32,
    pub updated_at: Option<i64>,
}

fn plugin_track_like_default() -> i32 {
    1
}

/// Persist a batch of track likes/dislikes from a plugin, funnelled through the
/// same newer-wins merge as the Import-likes file path. Backs
/// `api.library.setTrackLikesBatch`. Emits `entity-likes-changed { kind: "bulk" }`.
/// Returns the number of rows applied.
#[tauri::command]
pub fn plugin_set_track_likes_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    tracks: Vec<PluginTrackLike>,
) -> Result<usize, String> {
    if tracks.is_empty() {
        return Ok(0);
    }
    let now_ts: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let rows: Vec<LikeExportRow> = tracks
        .into_iter()
        .map(|t| {
            let entity_key =
                crate::db::likes::build_entity_key("track", &t.title, t.artist_name.as_deref());
            let metadata = serde_json::json!({
                "title": t.title,
                "name": t.title,
                "artist_name": t.artist_name,
            })
            .to_string();
            LikeExportRow {
                kind: "track".to_string(),
                entity_key,
                liked: t.liked,
                metadata: Some(metadata),
                updated_at: t.updated_at.unwrap_or(now_ts),
            }
        })
        .collect();
    let applied = state.db.import_likes_rows(&rows).map_err(|e| e.to_string())?;
    let _ = app.emit("entity-likes-changed", serde_json::json!({ "kind": "bulk" }));
    Ok(applied)
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

/// Flatten a response's headers to an ordered `[name, value]` list.
///
/// Ordered pairs rather than a map because `Set-Cookie` may legitimately repeat
/// and a map keeps only the last one — which is exactly the header a plugin
/// authenticating against a session API needs (see `getSetCookie()` on the JS
/// side). Names are lowercased so callers can look one up without case games.
/// A value that isn't valid UTF-8 is dropped, not emitted as an empty string:
/// a header we can't read is one a plugin can't use, and "" would read as a
/// real value.
fn flatten_response_headers(headers: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_lowercase(), v.to_string())))
        .collect()
}

#[tauri::command]
pub async fn plugin_fetch(url: String, method: Option<String>, headers: Option<std::collections::HashMap<String, String>>, body: Option<String>, insecure: Option<bool>, timeout_ms: Option<u64>) -> Result<serde_json::Value, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15");
    if insecure.unwrap_or(false) {
        builder = builder.danger_accept_invalid_certs(true);
    }
    // Opt-in only: reqwest has no default timeout, so an unreachable host hangs
    // the plugin's promise until the OS gives up. A plugin that polls needs a
    // bound; one that legitimately waits minutes (a slow API) must not get one
    // imposed on it, so there is no default here.
    if let Some(ms) = timeout_ms.filter(|ms| *ms > 0) {
        builder = builder.timeout(std::time::Duration::from_millis(ms));
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
    // Before `text()`, which consumes the response.
    let resp_headers = flatten_response_headers(resp.headers());
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "status": status,
        "body": text,
        "headers": resp_headers,
    }))
}

#[tauri::command]
pub fn fetch_plugin_gallery() -> Result<String, String> {
    crate::skins::fetch_url("https://raw.githubusercontent.com/outcast1000/viboplr-plugins/main/index.json")
}

/// Sentinel error returned when the user cancels an in-flight install. The
/// frontend matches this exact string to close its progress dialog silently
/// instead of surfacing it as a failure.
pub const INSTALL_CANCELLED: &str = "__install_cancelled__";

#[derive(serde::Serialize, Clone)]
struct PluginInstallProgress<'a> {
    plugin_id: &'a str,
    /// "resolving" | "downloading" | "installing"
    phase: &'a str,
    downloaded: u64,
    total: Option<u64>,
}

/// Remove `plugin_id` from the cancel set, returning whether it was present
/// (i.e. a cancel had been requested). Poisoned-lock-safe.
fn take_install_cancel(set: &Mutex<HashSet<String>>, plugin_id: &str) -> bool {
    match set.lock() {
        Ok(mut s) => s.remove(plugin_id),
        Err(_) => false,
    }
}

/// Ceiling on a single plugin zip download. Every network call in the extension
/// paths needs one: without it a stalled socket hangs until the OS gives up,
/// which on a captive portal or half-open connection can be minutes.
pub(crate) const PLUGIN_DOWNLOAD_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(120);

/// Stream a plugin zip into memory, emitting `plugin-install-progress` and
/// honouring the cooperative cancel set. Shared by the gallery install and the
/// update path so both report progress the same way — the update path used to
/// do a single blocking `resp.bytes()` with no events at all.
///
/// Blocking by design: callers must already be inside `spawn_blocking`.
pub(crate) fn download_plugin_zip(
    app: &tauri::AppHandle,
    cancel: &Mutex<HashSet<String>>,
    plugin_id: &str,
    zip_url: &str,
) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let emit = |phase: &str, downloaded: u64, total: Option<u64>| {
        let _ = app.emit(
            "plugin-install-progress",
            PluginInstallProgress { plugin_id, phase, downloaded, total },
        );
    };

    let client = reqwest::blocking::Client::builder()
        .user_agent("Viboplr")
        .timeout(PLUGIN_DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let mut resp = client
        .get(zip_url)
        .send()
        .map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    emit("downloading", 0, total);

    let mut bytes: Vec<u8> = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    // Throttle progress like downloader.rs: an emit per 64 KB chunk lands in a
    // React setState per event, and a fast connection turned an install into a
    // render storm (a 10 MB zip ≈ 160 events in a burst).
    let mut last_progress = std::time::Instant::now();
    loop {
        // Cooperative cancel — only meaningful during the download (extraction
        // that follows is the point of no return; the UI hides Cancel by then).
        if take_install_cancel(cancel, plugin_id) {
            return Err(INSTALL_CANCELLED.to_string());
        }
        let n = resp.read(&mut buf).map_err(|e| format!("Read error: {}", e))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
        downloaded += n as u64;
        if last_progress.elapsed() >= std::time::Duration::from_millis(250) {
            emit("downloading", downloaded, total);
            last_progress = std::time::Instant::now();
        }
    }

    // Always emit the final total so the bar lands on 100%.
    emit("downloading", downloaded, total);
    emit("installing", downloaded, total);
    Ok(bytes)
}

/// `async` so Tauri runs it off the main thread — a sync command is classified
/// `ExecutionContext::Blocking` and executes inline on the event loop, which
/// froze the whole webview for the length of the download.
#[tauri::command]
pub async fn install_gallery_plugin_by_update_url(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    plugin_id: String,
    update_url: String,
) -> Result<(), String> {
    let app_dir = state.app_dir.clone();
    let cancel = Arc::clone(&state.plugin_install_cancel);

    tauri::async_runtime::spawn_blocking(move || {
        // Fresh install — drop any stale cancel request left over for this id.
        take_install_cancel(&cancel, &plugin_id);

        // Resolve the plugin's own-repo updateUrl to a zip URL (enforces minAppVersion).
        let _ = app.emit(
            "plugin-install-progress",
            PluginInstallProgress { plugin_id: &plugin_id, phase: "resolving", downloaded: 0, total: None },
        );
        let app_version = app.package_info().version.to_string();
        let zip_url = crate::update_checker::resolve_install_zip_url(&update_url, &app_version)?;

        if take_install_cancel(&cancel, &plugin_id) {
            return Err(INSTALL_CANCELLED.to_string());
        }

        let bytes = download_plugin_zip(&app, &cancel, &plugin_id, &zip_url)?;
        crate::plugins::install_plugin_from_zip(&app_dir, &plugin_id, &bytes)?;
        // The gallery knows the updateUrl; the plugin's own manifest may not, and
        // the update checker only reads the manifest. Stamp it so this copy can
        // hear about its next release even if the author forgot the field. Never
        // fatal — the plugin is installed and working either way.
        if let Err(e) = crate::plugins::stamp_update_url(&app_dir, &plugin_id, &update_url) {
            log::warn!("could not stamp updateUrl for {}: {}", plugin_id, e);
        }
        let _ = app.emit("extension-update-installed", &plugin_id);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Request cancellation of an in-flight `install_gallery_plugin_by_update_url`.
/// Cooperative: the running install checks this between download chunks and
/// bails with `INSTALL_CANCELLED`. A no-op if that install already finished.
#[tauri::command]
pub fn cancel_plugin_install(state: State<'_, AppState>, plugin_id: String) {
    if let Ok(mut set) = state.plugin_install_cancel.lock() {
        set.insert(plugin_id);
    }
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

#[cfg(test)]
mod tests {
    use super::flatten_response_headers;
    use reqwest::header::{HeaderMap, HeaderValue, SET_COOKIE};

    #[test]
    fn test_repeated_set_cookie_headers_all_survive() {
        // The reason this returns pairs and not a map: a session API can send
        // several Set-Cookie headers, and a map would silently keep only one.
        let mut headers = HeaderMap::new();
        headers.append(SET_COOKIE, HeaderValue::from_static("SID=abc; path=/"));
        headers.append(SET_COOKIE, HeaderValue::from_static("theme=dark"));

        let flat = flatten_response_headers(&headers);

        let cookies: Vec<&str> = flat
            .iter()
            .filter(|(k, _)| k == "set-cookie")
            .map(|(_, v)| v.as_str())
            .collect();
        assert_eq!(cookies, vec!["SID=abc; path=/", "theme=dark"]);
    }

    #[test]
    fn test_header_names_are_lowercased() {
        let mut headers = HeaderMap::new();
        headers.insert("Content-Type", HeaderValue::from_static("application/json"));

        let flat = flatten_response_headers(&headers);

        assert_eq!(flat, vec![("content-type".to_string(), "application/json".to_string())]);
    }

    #[test]
    fn test_non_utf8_header_value_is_dropped_not_emptied() {
        // An unreadable header must not arrive as `""` — that reads like a real
        // value the server sent.
        let mut headers = HeaderMap::new();
        headers.insert("x-binary", HeaderValue::from_bytes(&[0xff, 0xfe]).unwrap());
        headers.insert("x-ok", HeaderValue::from_static("fine"));

        let flat = flatten_response_headers(&headers);

        assert_eq!(flat, vec![("x-ok".to_string(), "fine".to_string())]);
    }
}
