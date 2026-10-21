// Commands behind `api.system.programs` — see `crate::plugin_programs` for the
// model. Every one is `async` and does its process / file work off the main
// thread: a sync command runs inline on it, and starting or stopping a program
// can take seconds.
use super::*;
use crate::plugin_programs as programs;
use std::time::Duration;

/// Largest download a plugin may ask for, and the default when it names none.
/// The file store's own cap (`PLUGIN_FILE_MAX_BYTES`) is for data files; a
/// program release (slskd is ~40 MB zipped) needs more.
const PROGRAM_DOWNLOAD_MAX_BYTES: u64 = 1024 * 1024 * 1024;
const PROGRAM_DOWNLOAD_DEFAULT_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// A response that sends nothing for this long is abandoned.
const PROGRAM_DOWNLOAD_STALL: Duration = Duration::from_secs(60);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramDownload {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgramDownloadProgress {
    download_id: String,
    received: u64,
    total: Option<u64>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Download a release into the plugin's store, streaming to disk and hashing
/// as it goes. With `sha256` the file is kept only when it matches — the way a
/// plugin pins the exact build it was signed with. Progress goes out as
/// `plugin-program-download-progress` when a `downloadId` is given.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn plugin_program_download(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    path: Vec<String>,
    url: String,
    sha256: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    allowed_hosts: Option<Vec<String>>,
    max_bytes: Option<u64>,
    download_id: Option<String>,
) -> Result<ProgramDownload, String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("URL must start with http:// or https://".to_string());
    }
    let expected = match sha256 {
        Some(s) => {
            let s = s.trim().to_ascii_lowercase();
            if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err("sha256 must be 64 hex characters".to_string());
            }
            Some(s)
        }
        None => None,
    };
    let cap = max_bytes.unwrap_or(PROGRAM_DOWNLOAD_DEFAULT_MAX_BYTES).min(PROGRAM_DOWNLOAD_MAX_BYTES);
    let scope = crate::plugin_worker::NetworkScope::from_arg(allowed_hosts);
    if let Some(scope) = &scope {
        scope.check(&url)?;
    }
    let (root, target) = resolve_plugin_path(&state.app_dir, &plugin_id, &path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create the folder: {e}"))?;
    }
    ensure_within_root(&root, &target)?;

    let scoped = scope.is_some();
    let client = plugin_download_client(scope)?;
    let mut resp = tokio::time::timeout(PROGRAM_DOWNLOAD_STALL, plugin_download_request(&client, &url, headers).send())
        .await
        .map_err(|_| "The download didn't start within a minute".to_string())?
        .map_err(|e| format!("Download failed: {}", crate::error_chain::err_chain(&e)))?;
    if !resp.status().is_success() {
        return Err(download_status_error(&resp, scoped));
    }
    let total = resp.content_length();
    if total.is_some_and(|t| t > cap) {
        return Err(format!("The download is larger than {} MB", cap / (1024 * 1024)));
    }

    let tmp = target.with_file_name(format!(
        ".{}.part-{}",
        target.file_name().and_then(|s| s.to_str()).unwrap_or("download"),
        std::process::id()
    ));
    let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| format!("Couldn't write the download: {e}"))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_report = std::time::Instant::now() - PROGRESS_INTERVAL;
    let outcome: Result<(), String> = async {
        loop {
            let chunk = tokio::time::timeout(PROGRAM_DOWNLOAD_STALL, resp.chunk())
                .await
                .map_err(|_| "The download stalled".to_string())?
                .map_err(|e| format!("Download failed: {}", crate::error_chain::err_chain(&e)))?;
            let Some(chunk) = chunk else { break };
            received += chunk.len() as u64;
            if received > cap {
                return Err(format!("The download is larger than {} MB", cap / (1024 * 1024)));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| format!("Couldn't write the download: {e}"))?;
            if let Some(id) = &download_id {
                if last_report.elapsed() >= PROGRESS_INTERVAL {
                    last_report = std::time::Instant::now();
                    let _ = app.emit("plugin-program-download-progress", ProgramDownloadProgress { download_id: id.clone(), received, total });
                }
            }
        }
        file.flush().await.map_err(|e| format!("Couldn't write the download: {e}"))?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(e) = outcome {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let digest = hex(&hasher.finalize());
    if let Some(expected) = expected {
        if digest != expected {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("The download doesn't match its expected checksum (got {digest})"));
        }
    }
    {
        // The rename and the record land together: this is the file the user
        // agreed to install, so it is the one `start` / `run` will accept.
        let _store = programs::approved::store_lock();
        std::fs::rename(&tmp, &target).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("Couldn't move the download into place: {e}")
        })?;
        programs::approved::record(&state.app_dir, &plugin_id, [(programs::approved::key(&path), digest.clone())])?;
    }
    if let Some(id) = &download_id {
        let _ = app.emit("plugin-program-download-progress", ProgramDownloadProgress { download_id: id.clone(), received, total: Some(received) });
    }
    log::info!("plugin programs: {plugin_id} downloaded {url} ({received} bytes, sha256 {digest})");
    Ok(ProgramDownload { path: target.to_string_lossy().into_owned(), sha256: digest, size: received })
}

/// Unpack an archive in the plugin's store into a folder there, replacing it.
/// The archive must be one a `download` brought (and unchanged since); what it
/// unpacks is recorded as approved in turn, so its binaries can run.
#[tauri::command]
pub async fn plugin_program_extract(
    state: State<'_, AppState>,
    plugin_id: String,
    archive: Vec<String>,
    dest: Vec<String>,
) -> Result<usize, String> {
    let app_dir = state.app_dir.clone();
    run_blocking(move || -> Result<_, String> {
        // Unpacking replaces the destination, so it must be a folder inside the
        // store — never the store itself.
        if dest.is_empty() {
            return Err("Unpack into a folder inside the plugin's store, not the store itself".to_string());
        }
        let archive_path = programs::resolve_in_store(&app_dir, &plugin_id, &archive, true)?;
        let dest_path = programs::resolve_in_store(&app_dir, &plugin_id, &dest, false)?;
        // Held for the whole unpack: the archive is checked, then read, and
        // must not change in between.
        let _store = programs::approved::store_lock();
        programs::approved::require(&app_dir, &plugin_id, &archive_path)?;
        let unpacked = programs::archive::extract(&archive_path, &dest_path)?;
        programs::approved::record_unpacked(&app_dir, &plugin_id, &dest, &unpacked)?;
        Ok(unpacked.len())
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn plugin_program_run(
    state: State<'_, AppState>,
    plugin_id: String,
    path: Vec<String>,
    args: Option<Vec<String>>,
    env: Option<std::collections::BTreeMap<String, String>>,
    cwd: Option<Vec<String>>,
    timeout_secs: Option<u64>,
) -> Result<ExecResult, String> {
    let app_dir = state.app_dir.clone();
    run_blocking(move || -> Result<_, String> {
        let timeout = Duration::from_secs(
            timeout_secs.unwrap_or(programs::RUN_DEFAULT_TIMEOUT_SECS).clamp(1, programs::RUN_MAX_TIMEOUT_SECS),
        );
        let out = programs::run(&app_dir, &plugin_id, &path, &args.unwrap_or_default(), &env.unwrap_or_default(), cwd.as_deref(), timeout)?;
        Ok(ExecResult { exit_code: out.exit_code, stdout: out.stdout, stderr: out.stderr })
    })
    .await
}

#[tauri::command]
pub async fn plugin_program_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    name: String,
    spec: programs::StartSpec,
) -> Result<programs::ProgramStatus, String> {
    let app_dir = state.app_dir.clone();
    let event = (plugin_id.clone(), name.clone());
    let result = run_blocking(move || programs::start(&app_dir, &plugin_id, &name, &spec)).await;
    emit_program_changed(&app, &event.0, &event.1);
    result
}

/// A plugin started or stopped one of its programs: the Tools status lines
/// (`useDependencies` services) re-read.
fn emit_program_changed(app: &tauri::AppHandle, plugin_id: &str, name: &str) {
    use tauri::Emitter;
    let _ = app.emit("program-changed", serde_json::json!({ "pluginId": plugin_id, "name": name }));
}

/// The user agreed, in the host's dialog, that this plugin may run Vibo's copy
/// of `dependency` in the background (asked when `start` answered
/// `DEPENDENCY_RUN_UNCONFIRMED`). Recorded per source, so an update of the tool
/// doesn't ask again.
#[tauri::command]
pub async fn plugin_program_confirm_dependency(
    state: State<'_, AppState>,
    plugin_id: String,
    dependency: String,
) -> Result<(), String> {
    let app_dir = state.app_dir.clone();
    run_blocking(move || programs::confirm_dependency_run(&app_dir, &plugin_id, &dependency)).await
}

#[tauri::command]
pub async fn plugin_program_status(
    state: State<'_, AppState>,
    plugin_id: String,
    name: String,
) -> Result<programs::ProgramStatus, String> {
    let app_dir = state.app_dir.clone();
    run_blocking(move || programs::status(&app_dir, &plugin_id, &name)).await
}

#[tauri::command]
pub async fn plugin_program_list(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<Vec<programs::ProgramStatus>, String> {
    let app_dir = state.app_dir.clone();
    run_blocking(move || programs::list(&app_dir, &plugin_id)).await
}

#[tauri::command]
pub async fn plugin_program_stop(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    name: String,
    grace_secs: Option<u64>,
) -> Result<programs::ProgramStatus, String> {
    let app_dir = state.app_dir.clone();
    let grace = Duration::from_secs(grace_secs.unwrap_or(10).clamp(1, 120));
    let event = (plugin_id.clone(), name.clone());
    let result = run_blocking(move || programs::stop(&app_dir, &plugin_id, &name, grace)).await;
    emit_program_changed(&app, &event.0, &event.1);
    result
}

#[tauri::command]
pub async fn plugin_program_remove(
    state: State<'_, AppState>,
    plugin_id: String,
    name: String,
) -> Result<(), String> {
    let app_dir = state.app_dir.clone();
    run_blocking(move || programs::remove(&app_dir, &plugin_id, &name)).await
}

#[derive(Serialize)]
pub struct PluginPlatform {
    /// `macos` | `windows` | `linux` (Rust's `std::env::consts::OS`).
    pub os: &'static str,
    /// `aarch64` is reported as `arm64`, `x86_64` as `x64` — the names release
    /// assets use.
    pub arch: &'static str,
}

/// Which build of a program to fetch: the OS and CPU Vibo itself runs on.
#[tauri::command]
pub fn plugin_platform() -> PluginPlatform {
    PluginPlatform { os: std::env::consts::OS, arch: platform_arch(std::env::consts::ARCH) }
}

fn platform_arch(arch: &'static str) -> &'static str {
    match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_arch_names_match_release_assets() {
        assert_eq!(platform_arch("aarch64"), "arm64");
        assert_eq!(platform_arch("x86_64"), "x64");
        assert_eq!(platform_arch("riscv64"), "riscv64");
        assert!(["macos", "windows", "linux"].contains(&plugin_platform().os));
    }
}
