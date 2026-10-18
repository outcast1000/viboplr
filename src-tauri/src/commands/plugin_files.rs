// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

/// Client for downloading a plugin-supplied URL. With a scope (worker-runtime
/// plugins) redirects are held to the plugin's network grant — see
/// `plugin_worker::NetworkScope`; without one this is the old client exactly.
pub(super) fn plugin_download_client(scope: Option<crate::plugin_worker::NetworkScope>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15");
    if let Some(scope) = scope {
        builder = builder.redirect(scope.redirect_policy());
    }
    builder.build().map_err(|e| e.to_string())
}

/// GET with the plugin's own headers on top. The client's browser-style
/// `User-Agent` is only a default — a plugin's header replaces it.
pub(super) fn plugin_download_request(
    client: &reqwest::Client,
    url: &str,
    headers: Option<std::collections::HashMap<String, String>>,
) -> reqwest::RequestBuilder {
    let mut req = client.get(url);
    for (k, v) in headers.into_iter().flatten() {
        req = req.header(k, v);
    }
    req
}

/// A download that ended on a non-success status. Under a scope a redirect
/// means the scope stopped it (an unscoped client follows redirects itself),
/// so say so rather than surfacing a bare "HTTP 302". Without one — a
/// main-realm plugin — a 3xx is just the server's answer (304, a 300, a 302
/// with no Location), and blaming a permission that doesn't exist would send
/// the plugin's author looking in the wrong place.
pub(super) fn download_status_error(resp: &reqwest::Response, scoped: bool) -> String {
    if scoped && resp.status().is_redirection() {
        let to = resp.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or("?");
        return format!("Redirected to {} — outside this plugin's network permission", to);
    }
    format!("HTTP {}", resp.status())
}

#[tauri::command]
pub async fn plugin_cache_image(
    state: State<'_, AppState>,
    plugin_id: String,
    subdir: String,
    filename: String,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    allowed_hosts: Option<Vec<String>>,
) -> Result<String, String> {
    validate_plugin_cache_path(&plugin_id, &subdir, Some(&filename))?;

    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("URL must start with http:// or https://".to_string());
    }
    let scope = crate::plugin_worker::NetworkScope::from_arg(allowed_hosts);
    if let Some(scope) = &scope {
        scope.check(&url)?;
    }

    let cache_dir = state.app_dir.join("plugin-cache").join(&plugin_id).join(&subdir);
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("Failed to create cache dir: {}", e))?;

    let file_path = cache_dir.join(&filename);

    // Verify canonical path is within expected directory
    let canonical_parent = cache_dir.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    let expected_root = state.app_dir.join("plugin-cache").join(&plugin_id);
    std::fs::create_dir_all(&expected_root).ok();
    let canonical_root = expected_root.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("Invalid path".to_string());
    }

    let scoped = scope.is_some();
    let client = plugin_download_client(scope)?;

    let resp = plugin_download_request(&client, &url, headers).send().await.map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(download_status_error(&resp, scoped));
    }

    let content_length = resp.content_length().unwrap_or(0);
    if content_length > 10 * 1024 * 1024 {
        return Err("Image too large (>10MB)".to_string());
    }

    let bytes = resp.bytes().await.map_err(|e| format!("Download failed: {}", e))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("Image too large (>10MB)".to_string());
    }

    // Never while a program start is between its approval check and its exec.
    let _store = crate::plugin_programs::approved::store_lock();
    std::fs::write(&file_path, &bytes).map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn plugin_cache_get_path(
    state: State<'_, AppState>,
    plugin_id: String,
    subdir: String,
    filename: String,
) -> Result<Option<String>, String> {
    validate_plugin_cache_path(&plugin_id, &subdir, Some(&filename))?;

    let file_path = state.app_dir.join("plugin-cache").join(&plugin_id).join(&subdir).join(&filename);
    if file_path.exists() {
        Ok(Some(file_path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn plugin_cache_delete_dir(
    state: State<'_, AppState>,
    plugin_id: String,
    subdir: String,
) -> Result<(), String> {
    validate_plugin_cache_path(&plugin_id, &subdir, None)?;

    let dir_path = state.app_dir.join("plugin-cache").join(&plugin_id).join(&subdir);
    if !dir_path.exists() {
        return Ok(());
    }

    // Verify canonical path is within expected root
    let canonical = dir_path.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    let expected_root = state.app_dir.join("plugin-cache").join(&plugin_id);
    if !expected_root.exists() {
        return Ok(());
    }
    let canonical_root = expected_root.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Invalid path".to_string());
    }

    // Never while a program start is between its approval check and its exec.
    let _store = crate::plugin_programs::approved::store_lock();
    std::fs::remove_dir_all(&dir_path).map_err(|e| format!("Failed to delete: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn plugin_cache_list_dirs(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<Vec<String>, String> {
    if plugin_id.is_empty() || plugin_id.contains("..") || plugin_id.contains('/') || plugin_id.contains('\\') {
        return Err("Invalid plugin ID".to_string());
    }

    let dir = state.app_dir.join("plugin-cache").join(&plugin_id);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut dirs = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Failed to read dir: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Read error: {}", e))?;
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                dirs.push(name.to_string());
            }
        }
    }
    Ok(dirs)
}

#[tauri::command]
pub fn plugin_files_write_text(
    state: State<'_, AppState>,
    plugin_id: String,
    path: Vec<String>,
    content: String,
) -> Result<String, String> {
    if content.len() as u64 > PLUGIN_FILE_MAX_BYTES {
        return Err(format!("Content too large (max {} bytes)", PLUGIN_FILE_MAX_BYTES));
    }
    let (root, target) = resolve_plugin_path(&state.app_dir, &plugin_id, &path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    ensure_within_root(&root, &target)?;

    // Atomic write: temp file + rename
    let mut tmp = target.clone();
    let tmp_name = format!(
        "{}.tmp-{}",
        target.file_name().and_then(|s| s.to_str()).unwrap_or("file"),
        std::process::id()
    );
    tmp.set_file_name(tmp_name);
    // Never while a program start is between its approval check and its exec.
    let _store = crate::plugin_programs::approved::store_lock();
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("Failed to write: {}", e))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to rename: {}", e)
    })?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn plugin_files_read_text(
    state: State<'_, AppState>,
    plugin_id: String,
    path: Vec<String>,
) -> Result<Option<String>, String> {
    let (root, target) = resolve_plugin_path(&state.app_dir, &plugin_id, &path)?;
    ensure_within_root(&root, &target)?;
    if !target.exists() {
        return Ok(None);
    }
    let meta = std::fs::metadata(&target).map_err(|e| format!("Stat error: {}", e))?;
    if meta.len() > PLUGIN_FILE_MAX_BYTES {
        return Err(format!("File too large (max {} bytes)", PLUGIN_FILE_MAX_BYTES));
    }
    let content = std::fs::read_to_string(&target).map_err(|e| format!("Read error: {}", e))?;
    Ok(Some(content))
}

#[tauri::command]
pub async fn plugin_files_download(
    state: State<'_, AppState>,
    plugin_id: String,
    path: Vec<String>,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    allowed_hosts: Option<Vec<String>>,
) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("URL must start with http:// or https://".to_string());
    }
    let scope = crate::plugin_worker::NetworkScope::from_arg(allowed_hosts);
    if let Some(scope) = &scope {
        scope.check(&url)?;
    }
    let (root, target) = resolve_plugin_path(&state.app_dir, &plugin_id, &path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    ensure_within_root(&root, &target)?;

    let scoped = scope.is_some();
    let client = plugin_download_client(scope)?;
    let resp = plugin_download_request(&client, &url, headers).send().await.map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(download_status_error(&resp, scoped));
    }
    let content_length = resp.content_length().unwrap_or(0);
    if content_length > 10 * 1024 * 1024 {
        return Err("Download too large (>10MB)".to_string());
    }
    let bytes = resp.bytes().await.map_err(|e| format!("Download failed: {}", e))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("Download too large (>10MB)".to_string());
    }

    let mut tmp = target.clone();
    let tmp_name = format!(
        "{}.tmp-{}",
        target.file_name().and_then(|s| s.to_str()).unwrap_or("file"),
        std::process::id()
    );
    tmp.set_file_name(tmp_name);
    // Never while a program start is between its approval check and its exec.
    let _store = crate::plugin_programs::approved::store_lock();
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write: {}", e))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to rename: {}", e)
    })?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn plugin_files_get_path(
    state: State<'_, AppState>,
    plugin_id: String,
    path: Vec<String>,
) -> Result<Option<String>, String> {
    let (root, target) = resolve_plugin_path(&state.app_dir, &plugin_id, &path)?;
    ensure_within_root(&root, &target)?;
    if target.exists() {
        Ok(Some(target.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn plugin_files_exists(
    state: State<'_, AppState>,
    plugin_id: String,
    path: Vec<String>,
) -> Result<bool, String> {
    let (root, target) = resolve_plugin_path(&state.app_dir, &plugin_id, &path)?;
    ensure_within_root(&root, &target)?;
    Ok(target.exists())
}

#[tauri::command]
pub fn plugin_files_list(
    state: State<'_, AppState>,
    plugin_id: String,
    path: Vec<String>,
) -> Result<Vec<PluginDirEntry>, String> {
    // path may be empty here — means "list the plugin root"
    if plugin_id.is_empty() || plugin_id.contains("..") || plugin_id.contains('/') || plugin_id.contains('\\') {
        return Err("Invalid plugin ID".to_string());
    }
    for seg in &path {
        validate_path_segment(seg)?;
    }
    let root = state.app_dir.join("plugin-cache").join(&plugin_id);
    let mut target = root.clone();
    for seg in &path {
        target.push(seg);
    }
    if !target.exists() {
        return Ok(vec![]);
    }
    ensure_within_root(&root, &target)?;
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&target).map_err(|e| format!("Failed to read dir: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Read error: {}", e))?;
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue, // skip non-UTF8
        };
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        let (size, modified_at) = match entry.metadata() {
            Ok(meta) => {
                let sz = if is_dir { None } else { Some(meta.len()) };
                let mt = meta.modified().ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs());
                (sz, mt)
            }
            Err(_) => (None, None),
        };
        out.push(PluginDirEntry { name, is_dir, size, modified_at });
    }
    Ok(out)
}

#[tauri::command]
pub fn plugin_files_remove(
    state: State<'_, AppState>,
    plugin_id: String,
    path: Vec<String>,
) -> Result<(), String> {
    let (root, target) = resolve_plugin_path(&state.app_dir, &plugin_id, &path)?;
    if !target.exists() {
        return Ok(());
    }
    ensure_within_root(&root, &target)?;
    // Never while a program start is between its approval check and its exec.
    let _store = crate::plugin_programs::approved::store_lock();
    let meta = std::fs::metadata(&target).map_err(|e| format!("Stat error: {}", e))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("Failed to delete: {}", e))?;
    } else {
        std::fs::remove_file(&target).map_err(|e| format!("Failed to delete: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_files_copy(
    state: State<'_, AppState>,
    plugin_id: String,
    src: Vec<String>,
    dst: Vec<String>,
) -> Result<(), String> {
    let (root, src_path) = resolve_plugin_path(&state.app_dir, &plugin_id, &src)?;
    let (_, dst_path) = resolve_plugin_path(&state.app_dir, &plugin_id, &dst)?;
    if !src_path.exists() {
        return Err("Source does not exist".to_string());
    }
    if let Some(parent) = dst_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    ensure_within_root(&root, &src_path)?;
    ensure_within_root(&root, &dst_path)?;
    // Never while a program start is between its approval check and its exec.
    let _store = crate::plugin_programs::approved::store_lock();
    let meta = std::fs::metadata(&src_path).map_err(|e| format!("Stat error: {}", e))?;
    if meta.is_dir() {
        copy_dir_recursive(&src_path, &dst_path).map_err(|e| format!("Copy failed: {}", e))?;
    } else {
        std::fs::copy(&src_path, &dst_path).map_err(|e| format!("Copy failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_files_move(
    state: State<'_, AppState>,
    plugin_id: String,
    src: Vec<String>,
    dst: Vec<String>,
) -> Result<(), String> {
    let (root, src_path) = resolve_plugin_path(&state.app_dir, &plugin_id, &src)?;
    let (_, dst_path) = resolve_plugin_path(&state.app_dir, &plugin_id, &dst)?;
    if !src_path.exists() {
        return Err("Source does not exist".to_string());
    }
    if let Some(parent) = dst_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    ensure_within_root(&root, &src_path)?;
    ensure_within_root(&root, &dst_path)?;
    // Never while a program start is between its approval check and its exec.
    let _store = crate::plugin_programs::approved::store_lock();
    std::fs::rename(&src_path, &dst_path).map_err(|e| format!("Move failed: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against a real socket: a plugin's `User-Agent` replaces the client's
    /// browser-style default instead of being sent alongside it, and without
    /// one the default still goes out.
    #[test]
    fn a_plugin_user_agent_replaces_the_default() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut stream = stream.unwrap();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let agents: Vec<&str> = req
                    .lines()
                    .filter(|l| l.to_ascii_lowercase().starts_with("user-agent:"))
                    .collect();
                let body = agents.join("\n");
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let client = plugin_download_client(None).unwrap();
            let url = format!("http://127.0.0.1:{port}/");

            let mut headers = std::collections::HashMap::new();
            headers.insert("User-Agent".to_string(), "Vibo".to_string());
            let sent = plugin_download_request(&client, &url, Some(headers))
                .send().await.unwrap().text().await.unwrap();
            assert_eq!(sent.to_ascii_lowercase(), "user-agent: vibo", "exactly one User-Agent, the plugin's");

            let default = plugin_download_request(&client, &url, None)
                .send().await.unwrap().text().await.unwrap();
            assert!(default.contains("Safari"), "no plugin header keeps the default: {default}");
        });
    }
}
