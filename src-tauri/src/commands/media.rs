// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

/// The error text a killed exec resolves to. The frontend matches on it to tell
/// "the user cancelled" apart from "the tool failed", so don't reword it without
/// updating `isExecCancelled` in `usePlugins.ts`.
pub const EXEC_CANCELLED: &str = "Cancelled";

struct ExecEntry {
    /// Process-group leader pid — `None` between registration and spawn.
    pid: Option<u32>,
    cancelled: bool,
}

/// Live `plugin_exec` runs that carry an `execId`, so a long tool run (a yt-dlp
/// video download can be minutes) can be killed from the UI instead of being
/// abandoned to finish invisibly. Entries are keyed by the frontend's exec id
/// and removed the moment the child is reaped.
pub struct PluginExecRegistry {
    running: Mutex<std::collections::HashMap<String, ExecEntry>>,
}

impl PluginExecRegistry {
    pub fn new() -> Self {
        Self { running: Mutex::new(std::collections::HashMap::new()) }
    }

    /// Claim an id before spawning. Returns false when a cancel for this id
    /// already landed — the cancel invoke can win the race against the exec
    /// invoke it is cancelling, and the child must not outlive that.
    fn claim(&self, id: &str) -> bool {
        let mut map = self.running.lock().unwrap();
        match map.get(id) {
            Some(e) if e.cancelled => false,
            _ => {
                map.insert(id.to_string(), ExecEntry { pid: None, cancelled: false });
                true
            }
        }
    }

    /// Record the spawned pid. Returns false if a cancel landed in the window
    /// between `claim` and the spawn, in which case the caller kills its child.
    fn attach(&self, id: &str, pid: u32) -> bool {
        let mut map = self.running.lock().unwrap();
        match map.get_mut(id) {
            Some(e) if e.cancelled => false,
            Some(e) => { e.pid = Some(pid); true }
            None => false, // cancelled and swept
        }
    }

    fn finish(&self, id: &str) -> bool {
        self.running.lock().unwrap().remove(id).map(|e| e.cancelled).unwrap_or(false)
    }

    /// Mark the id cancelled and kill its child if one is already running.
    /// Records the cancel even for an unknown id so a not-yet-spawned exec is
    /// stopped at `claim` — the two invokes race and the cancel can arrive
    /// first. Cancelling an id that already finished therefore leaves a small
    /// tombstone behind; exec ids are unique per session, so it is inert, and
    /// it only happens when a cancel lands in the instant a run completes.
    fn cancel(&self, id: &str) -> bool {
        let mut map = self.running.lock().unwrap();
        let entry = map.entry(id.to_string())
            .or_insert(ExecEntry { pid: None, cancelled: false });
        entry.cancelled = true;
        match entry.pid {
            Some(pid) => { kill_process_tree(pid); true }
            None => false,
        }
    }
}

/// SIGKILL the whole process group (helper children — yt-dlp spawns ffmpeg, and
/// the PyInstaller build forks a bootstrap pair — must die with it), falling back
/// to the leader alone. Mirrors the probe-timeout kill in `dependencies.rs`.
fn kill_process_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::process::Stdio;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecOutputEvent {
    exec_id: String,
    stream: &'static str,
    line: String,
}

/// Drain a child pipe, forwarding each completed line to `sink` and returning the
/// output **verbatim** (the returned text is the raw bytes, so a caller parsing
/// stdout sees exactly what `Command::output()` would have given it).
///
/// Lines are split on `\r` as well as `\n`: progress-reporting CLIs (yt-dlp
/// without `--newline`, ffmpeg) redraw one line with carriage returns, and a
/// `\n`-only reader would hold the entire run in its buffer — which is precisely
/// the output a caller streaming for progress is asking for.
fn pump_lines<R: std::io::Read>(reader: R, mut sink: impl FnMut(String)) -> String {
    use std::io::Read;
    let mut reader = std::io::BufReader::new(reader);
    let mut all: Vec<u8> = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                all.extend_from_slice(&buf[..n]);
                for &b in &buf[..n] {
                    if b == b'\n' || b == b'\r' {
                        if !line.is_empty() {
                            sink(String::from_utf8_lossy(&line).to_string());
                            line.clear();
                        }
                    } else {
                        line.push(b);
                    }
                }
            }
            Err(_) => break,
        }
    }
    if !line.is_empty() {
        sink(String::from_utf8_lossy(&line).to_string());
    }
    String::from_utf8_lossy(&all).to_string()
}

#[tauri::command]
pub async fn plugin_exec(
    app: AppHandle,
    state: State<'_, AppState>,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    exec_id: Option<String>,
    stream_output: Option<bool>,
) -> Result<ExecResult, String> {
    let allowed = dependencies::allowed_names();
    if !allowed.contains(&program.as_str()) {
        return Err(format!("Program not allowed: {}. Allowed: {:?}", program, allowed));
    }

    let app_dir = state.app_dir.clone();
    let registry = Arc::clone(&state.plugin_execs);

    // No exec id → the original fire-and-wait path, byte for byte. Most plugin
    // execs are short probes that need neither cancellation nor a line stream,
    // and they must not start paying for pipes and threads.
    let Some(exec_id) = exec_id else {
        return tauri::async_runtime::spawn_blocking(move || {
            let mut cmd = build_plugin_command(&program, &args, cwd, &app_dir);
            let output = cmd.output()
                .map_err(|e| format!("Failed to run {}: {}", program, e))?;
            Ok(ExecResult {
                exit_code: output.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            })
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;
    };

    if !registry.claim(&exec_id) {
        registry.finish(&exec_id);
        return Err(EXEC_CANCELLED.to_string());
    }

    let stream = stream_output.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        use std::process::Stdio;
        let mut cmd = build_plugin_command(&program, &args, cwd, &app_dir);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            // Own process group so a cancel takes the helper children with it.
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                registry.finish(&exec_id);
                return Err(format!("Failed to run {}: {}", program, e));
            }
        };
        if !registry.attach(&exec_id, child.id()) {
            kill_process_tree(child.id());
            let _ = child.wait();
            registry.finish(&exec_id);
            return Err(EXEC_CANCELLED.to_string());
        }

        // Both pipes must be drained concurrently — a child that fills the one
        // we aren't reading blocks forever, and yt-dlp writes to both.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let emit = |stream_name: &'static str, line: String| {
            if !stream {
                return;
            }
            let _ = app.emit("plugin-exec-output", ExecOutputEvent {
                exec_id: exec_id.clone(), stream: stream_name, line,
            });
        };
        let (out_text, err_text) = std::thread::scope(|scope| {
            let out_handle = scope.spawn(|| {
                stdout.map(|p| pump_lines(p, |l| emit("stdout", l))).unwrap_or_default()
            });
            let err_handle = scope.spawn(|| {
                stderr.map(|p| pump_lines(p, |l| emit("stderr", l))).unwrap_or_default()
            });
            (
                out_handle.join().unwrap_or_default(),
                err_handle.join().unwrap_or_default(),
            )
        });

        let status = child.wait();
        let cancelled = registry.finish(&exec_id);
        if cancelled {
            return Err(EXEC_CANCELLED.to_string());
        }
        let status = status.map_err(|e| format!("Failed to wait for {}: {}", program, e))?;
        Ok(ExecResult {
            exit_code: status.code().unwrap_or(-1),
            stdout: out_text,
            stderr: err_text,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn build_plugin_command(
    program: &str,
    args: &[String],
    cwd: Option<String>,
    app_dir: &std::path::Path,
) -> std::process::Command {
    let mut cmd = command_with_path(program);
    cmd.args(args);
    match cwd {
        Some(dir) => { cmd.current_dir(dir); }
        None => { cmd.current_dir(app_dir); }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Kill a running `plugin_exec` by its exec id. Returns true when a live child
/// was signalled; false when the id is unknown or hasn't spawned yet (the cancel
/// is still recorded, so the exec dies as it starts).
#[tauri::command]
pub async fn plugin_exec_cancel(
    state: State<'_, AppState>,
    exec_id: String,
) -> Result<bool, String> {
    Ok(state.plugin_execs.cancel(&exec_id))
}

// --- yt-dlp commands ---

#[tauri::command]
pub async fn yt_dlp_check(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let cache = Arc::clone(&state.dep_cache);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        match dependencies::check_single("yt-dlp", &cache) {
            dependencies::DepStatus::Installed { version, .. } => Some(version),
            _ => None,
        }
    })
    .await
    .map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn ffmpeg_check(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let cache = Arc::clone(&state.dep_cache);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        match dependencies::check_single("ffmpeg", &cache) {
            dependencies::DepStatus::Installed { version, .. } => Some(version),
            _ => None,
        }
    })
    .await
    .map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn check_dependencies(
    state: State<'_, AppState>,
    names: Option<Vec<String>>,
    plugin_deps: Option<Vec<PluginDepDeclaration>>,
    force_refresh: bool,
) -> Result<Vec<dependencies::DependencyInfo>, String> {
    let cache = Arc::clone(&state.dep_cache);
    let plugin_deps = plugin_deps.unwrap_or_default();

    Ok(tauri::async_runtime::spawn_blocking(move || {
        if force_refresh {
            cache.clear();
        }

        let defs_to_check: Vec<&dependencies::DependencyDef> = match &names {
            Some(names) => dependencies::REGISTRY
                .iter()
                .filter(|d| names.iter().any(|n| n == d.name))
                .collect(),
            None => dependencies::REGISTRY.iter().collect(),
        };

        defs_to_check
            .iter()
            .map(|def| {
                let status = dependencies::check_single(def.name, &cache);
                let plugin_consumers: Vec<dependencies::ConsumerInfo> = plugin_deps
                    .iter()
                    .filter(|pd| pd.name == def.name)
                    .map(|pd| dependencies::ConsumerInfo {
                        name: pd.plugin_name.clone(),
                        reason: pd.reason.clone(),
                        required: pd.required,
                    })
                    .collect();

                dependencies::DependencyInfo {
                    name: def.name.to_string(),
                    description: def.description.to_string(),
                    status,
                    internal_consumers: def.internal_consumers.iter().map(|(n, r)| {
                        // Internal (host) consumers always need the dependency.
                        dependencies::ConsumerInfo { name: n.to_string(), reason: r.to_string(), required: true }
                    }).collect(),
                    plugin_consumers,
                    install: def.install.clone(),
                    managed_available: def
                        .managed
                        .as_ref()
                        .is_some_and(|m| m.platform_asset().is_some()),
                    // Cache-only — this command must stay fast and offline.
                    latest_version: cache.get_latest(def.name).flatten(),
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?)
}

/// Install (or update — same code path, the download URL always points at the
/// latest release) the app-managed copy of a dependency.
#[tauri::command]
pub async fn dependency_install(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<String, String> {
    let cache = Arc::clone(&state.dep_cache);
    tauri::async_runtime::spawn_blocking(move || {
        let progress_name = name.clone();
        let version = dependencies::install_managed(&name, &cache, |downloaded, total| {
            let _ = app.emit(
                "dependency-install-progress",
                serde_json::json!({ "name": progress_name, "downloaded": downloaded, "total": total }),
            );
        })?;
        let _ = app.emit(
            "dependency-installed",
            serde_json::json!({ "name": name, "version": version }),
        );
        log::info!("Installed managed {} {}", name, version);
        Ok(version)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Remove the app-managed copy of a dependency, falling back to any system
/// copy on PATH. Returns the new origin ("system") or null if nothing remains.
#[tauri::command]
pub async fn dependency_uninstall_managed(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<String>, String> {
    let cache = Arc::clone(&state.dep_cache);
    tauri::async_runtime::spawn_blocking(move || {
        let status = dependencies::uninstall_managed(&name, &cache)?;
        log::info!("Removed managed copy of {}", name);
        Ok(match status {
            dependencies::DepStatus::Installed { origin, .. } => Some(
                match origin {
                    dependencies::DepOrigin::Managed => "managed",
                    dependencies::DepOrigin::System => "system",
                }
                .to_string(),
            ),
            _ => None,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Latest-vs-installed comparison for every managed dependency. Hits the
/// GitHub API at most once per dep per 24h (TTL-cached, failures included).
#[tauri::command]
pub async fn dependency_check_updates(
    state: State<'_, AppState>,
) -> Result<Vec<dependencies::DepUpdateInfo>, String> {
    let cache = Arc::clone(&state.dep_cache);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        dependencies::REGISTRY
            .iter()
            .filter(|def| def.managed.as_ref().is_some_and(|m| m.platform_asset().is_some()))
            .map(|def| {
                let (installed, origin) = match dependencies::check_single(def.name, &cache) {
                    dependencies::DepStatus::Installed { version, origin } => {
                        (Some(version), Some(origin))
                    }
                    _ => (None, None),
                };
                let latest = dependencies::latest_version(def.name, &cache).ok();
                let outdated = match (&installed, &latest) {
                    (Some(i), Some(l)) => dependencies::version_lt(i, l),
                    _ => false,
                };
                dependencies::DepUpdateInfo {
                    name: def.name.to_string(),
                    installed,
                    latest,
                    outdated,
                    origin,
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn yt_dlp_stream_audio(
    state: State<'_, AppState>,
    youtube_url: String,
) -> Result<String, String> {
    let app_dir = state.app_dir.clone();
    let dep_cache = Arc::clone(&state.dep_cache);

    tauri::async_runtime::spawn_blocking(move || {
        let temp_dir = app_dir.join("yt_cache");
        std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create yt_cache: {}", e))?;

        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let dest = temp_dir.join(format!("{}.webm", ts));

        log::info!("yt-dlp downloading {} -> {}", youtube_url, dest.display());

        let dest_str = dest.to_string_lossy().to_string();
        let mut cmd = command_with_path("yt-dlp");
        cmd.args(["-f", "bestaudio", "--no-warnings", "-o", &dest_str, &youtube_url]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = cmd.output()
            .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Stale yt-dlp is the most common cause of failures and looks like
            // an app bug to users — call it out when we already know (cached,
            // no network here) that a newer release exists.
            let outdated_hint = match (
                dependencies::check_single("yt-dlp", &dep_cache),
                dep_cache.get_latest("yt-dlp").flatten(),
            ) {
                (dependencies::DepStatus::Installed { version, .. }, Some(latest))
                    if dependencies::version_lt(&version, &latest) =>
                {
                    format!(
                        " Your yt-dlp is outdated (installed {}, latest {}) — update it in Settings > Dependencies.",
                        version, latest
                    )
                }
                _ => String::new(),
            };
            return Err(format!("yt-dlp failed:{} {}", outdated_hint, stderr));
        }

        if !dest.exists() {
            return Err("yt-dlp produced no output file".to_string());
        }

        log::info!("yt-dlp download complete: {} ({} bytes)", dest.display(),
            std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0));

        Ok(dest_str)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Convert a local audio file to a different format using ffmpeg.
/// Returns the path to the converted file. If ffmpeg is unavailable, returns the original path.
#[tauri::command]
pub async fn ffmpeg_convert_audio(
    source_path: String,
    audio_format: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ext = match audio_format.as_str() {
            "aac" | "m4a" => "m4a",
            "mp3" => "mp3",
            "flac" => "flac",
            _ => return Ok(source_path),
        };

        let has_ffmpeg = {
            let mut cmd = command_with_path("ffmpeg");
            cmd.arg("-version");
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            cmd.output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };

        if !has_ffmpeg {
            return Ok(source_path);
        }

        let src = std::path::Path::new(&source_path);
        let dest = src.with_extension(ext);
        if dest == src {
            return Ok(source_path);
        }

        let dest_str = dest.to_string_lossy().to_string();
        log::info!("ffmpeg converting {} -> {}", source_path, dest_str);

        let codec = match audio_format.as_str() {
            "aac" | "m4a" => "aac",
            "mp3" => "libmp3lame",
            "flac" => "flac",
            _ => "copy",
        };

        let mut cmd = command_with_path("ffmpeg");
        cmd.args(["-i", &source_path, "-vn", "-c:a", codec, "-y", &dest_str]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = cmd.output()
            .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!("ffmpeg conversion failed, using original: {}", stderr);
            return Ok(source_path);
        }

        log::info!("ffmpeg conversion complete: {} ({} bytes)", dest_str,
            std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0));

        Ok(dest_str)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub fn get_video_frames(
    state: State<'_, AppState>,
    track_id: i64,
) -> Option<VideoFrameResult> {
    let app_dir = &state.app_dir;
    crate::video_frames::get_cached_frames(app_dir, track_id).map(|cached| VideoFrameResult {
        status: "ok".to_string(),
        paths: Some(cached.paths),
        timestamps: if cached.timestamps.is_empty() { None } else { Some(cached.timestamps) },
    })
}

#[tauri::command]
pub async fn extract_video_frames(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<VideoFrameResult, String> {
    let app_dir = state.app_dir.clone();
    let db = state.db.clone();

    tauri::async_runtime::spawn_blocking(move || {
        if !crate::video_frames::is_ffmpeg_available() {
            return Ok(VideoFrameResult { status: "unavailable".to_string(), paths: None, timestamps: None });
        }

        if let Some(cached) = crate::video_frames::get_cached_frames(&app_dir, track_id) {
            return Ok(VideoFrameResult {
                status: "ok".to_string(),
                paths: Some(cached.paths),
                timestamps: if cached.timestamps.is_empty() { None } else { Some(cached.timestamps) },
            });
        }

        let track = db.get_track_by_id(track_id)
            .map_err(|e| format!("DB error: {}", e))?;

        if track.is_remote() {
            return Err("Cannot extract frames from remote tracks".to_string());
        }

        let fs_path = track.filesystem_path()
            .ok_or_else(|| "Track has no local file path".to_string())?;

        let video_path = std::path::Path::new(fs_path);
        if !video_path.exists() {
            return Err(format!("Video file not found: {}", fs_path));
        }

        let is_video = video_path.extension()
            .and_then(|e| e.to_str())
            .map(|e| crate::scanner::VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);
        if !is_video {
            return Err(format!("Track is not a supported video file: {}", fs_path));
        }

        let (paths, timestamps) = crate::video_frames::extract_frames(&app_dir, track_id, video_path)?;

        Ok(VideoFrameResult {
            status: "ok".to_string(),
            paths: Some(paths),
            timestamps: Some(timestamps),
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub fn get_track_audio_properties(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<AudioProperties, String> {
    let track = state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())?;
    let bare_path = track.filesystem_path()
        .ok_or("Track has no local file path")?
        .to_string();

    use lofty::prelude::*;

    let tagged_file = lofty::probe::Probe::open(&bare_path)
        .and_then(|p| p.read())
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let props = tagged_file.properties();

    Ok(AudioProperties {
        sample_rate: props.sample_rate(),
        bit_depth: props.bit_depth(),
        channels: props.channels(),
        bitrate: props.overall_bitrate(),
    })
}

#[tauri::command]
pub fn get_audio_properties_by_path(
    path: String,
) -> Result<AudioProperties, String> {
    let bare_path = path.strip_prefix("file://").unwrap_or(&path);

    use lofty::prelude::*;

    let tagged_file = lofty::probe::Probe::open(bare_path)
        .and_then(|p| p.read())
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let props = tagged_file.properties();

    Ok(AudioProperties {
        sample_rate: props.sample_rate(),
        bit_depth: props.bit_depth(),
        channels: props.channels(),
        bitrate: props.overall_bitrate(),
    })
}

/// Cache-only storyboard lookup, keyed by the track's scheme-prefixed path. Never
/// generates, so the seek bar can ask on every track change for free.
#[tauri::command]
pub fn get_storyboard(
    state: State<'_, AppState>,
    path: String,
) -> Option<crate::storyboard::Storyboard> {
    crate::storyboard::get_cached(&state.app_dir, &path)
}

/// Generate the storyboard for a local video if it isn't cached yet. One ffmpeg pass;
/// see `storyboard.rs`. Returns a status rather than erroring for the two expected
/// "can't do this" cases, so the frontend can stay quiet about them.
#[tauri::command]
pub async fn extract_storyboard(
    state: State<'_, AppState>,
    path: String,
) -> Result<StoryboardResult, String> {
    let app_dir = state.app_dir.clone();

    tauri::async_runtime::spawn_blocking(move || {
        if let Some(cached) = crate::storyboard::get_cached(&app_dir, &path) {
            return Ok(StoryboardResult { status: "ok".to_string(), storyboard: Some(cached) });
        }
        // Local files only: ffmpeg needs a real file, and re-streaming a remote source
        // per video would cost bandwidth. Plugin sources supply their own storyboards.
        let Some(bare) = path.strip_prefix("file://") else {
            return Ok(StoryboardResult { status: "unsupported".to_string(), storyboard: None });
        };
        if !crate::video_frames::is_ffmpeg_available() {
            return Ok(StoryboardResult { status: "unavailable".to_string(), storyboard: None });
        }
        let video_path = std::path::Path::new(bare);
        let duration = crate::video_frames::get_video_duration(video_path)?;
        let board = crate::storyboard::generate(&app_dir, &path, video_path, duration)?;
        Ok(StoryboardResult { status: "ok".to_string(), storyboard: Some(board) })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Byte size of a local file. A plain `stat` — much cheaper than
/// `get_audio_properties_by_path`, which reads tags. `None` when the path isn't
/// a local file or can't be stat'd, so callers can treat "unknown" as distinct
/// from zero rather than inferring a size.
#[tauri::command]
pub fn get_file_size(path: String) -> Option<u64> {
    let bare_path = path.strip_prefix("file://").unwrap_or(&path);
    std::fs::metadata(bare_path).ok().map(|m| m.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(input: &[u8]) -> (Vec<String>, String) {
        let mut seen = Vec::new();
        let text = pump_lines(input, |l| seen.push(l));
        (seen, text)
    }

    // A progress-reporting CLI redraws one line with carriage returns, so a
    // `\n`-only reader emits nothing until the process exits — which is exactly
    // the output the caller wanted live.
    #[test]
    fn pump_lines_splits_on_carriage_returns_too() {
        let (seen, _) = lines_of(b"10%\r50%\r100%\ndone\n");
        assert_eq!(seen, vec!["10%", "50%", "100%", "done"]);
    }

    // The returned text is what a plugin parses as stdout, so it must match what
    // `Command::output()` would have produced byte for byte — blank lines and
    // all. Rebuilding it from the emitted lines would quietly drop them.
    #[test]
    fn pump_lines_returns_output_verbatim() {
        let raw = "first\n\nsecond\n";
        let (seen, text) = lines_of(raw.as_bytes());
        assert_eq!(text, raw, "blank line preserved in the returned text");
        assert_eq!(seen, vec!["first", "second"], "but not emitted as a line");
    }

    #[test]
    fn pump_lines_emits_a_trailing_unterminated_line() {
        let (seen, text) = lines_of(b"/tmp/dl.0.mp4");
        assert_eq!(seen, vec!["/tmp/dl.0.mp4"]);
        assert_eq!(text, "/tmp/dl.0.mp4");
    }

    // The cancel invoke can beat the exec invoke it is cancelling to the
    // backend — two separate IPC calls, no ordering guarantee. If `claim`
    // ignored a cancel that arrived first, that exec would spawn anyway and run
    // to completion with nobody left to receive it.
    #[test]
    fn cancel_before_claim_stops_the_exec_from_starting() {
        let reg = PluginExecRegistry::new();
        assert!(!reg.cancel("e1"), "no child to signal yet");
        assert!(!reg.claim("e1"), "claim refuses an already-cancelled id");
    }

    #[test]
    fn cancel_between_claim_and_spawn_is_not_lost() {
        let reg = PluginExecRegistry::new();
        assert!(reg.claim("e1"));
        assert!(!reg.cancel("e1"), "cancel lands before a pid is known");
        assert!(!reg.attach("e1", 424242), "caller is told to kill its child");
    }

    // The streaming path must drain stdout and stderr *concurrently*: a child
    // that fills the pipe nobody is reading blocks forever, and yt-dlp writes
    // to both (progress on stdout, postprocessor lines on stderr). Reading them
    // in sequence deadlocks as soon as the idle pipe passes ~64 KB, which a
    // long download comfortably does — so this drives a real child past that.
    #[cfg(unix)]
    #[test]
    fn both_pipes_drain_concurrently_past_the_buffer_size() {
        use std::process::Stdio;
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            // stderr first and larger than the pipe buffer: a sequential reader
            // starting on stdout would wedge here.
            // ~8000 × ~15 bytes ≈ 120 KB, comfortably past Linux's 64 KB pipe
            // buffer as well as macOS's smaller default.
            .arg("i=0; while [ $i -lt 8000 ]; do echo \"err line $i\" >&2; i=$((i+1)); done; \
                  printf 'progress\\rprogress2\\nfinal/path.mp4\\n'")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn /bin/sh");

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (out_lines, out_text, err_lines) = std::thread::scope(|scope| {
            let o = scope.spawn(|| {
                let mut lines = Vec::new();
                let text = stdout.map(|p| pump_lines(p, |l| lines.push(l))).unwrap_or_default();
                (lines, text)
            });
            let e = scope.spawn(|| {
                let mut n = 0usize;
                stderr.map(|p| pump_lines(p, |_| n += 1));
                n
            });
            let (ol, ot) = o.join().unwrap();
            (ol, ot, e.join().unwrap())
        });

        let status = child.wait().expect("child exits");
        assert!(status.success());
        assert_eq!(err_lines, 8000, "the whole stderr stream was read");
        assert_eq!(out_lines, vec!["progress", "progress2", "final/path.mp4"]);
        assert_eq!(out_text, "progress\rprogress2\nfinal/path.mp4\n", "stdout is verbatim");
    }

    #[test]
    fn a_clean_run_is_not_reported_as_cancelled() {
        let reg = PluginExecRegistry::new();
        assert!(reg.claim("e1"));
        assert!(reg.attach("e1", 424242));
        assert!(!reg.finish("e1"));
        // Finished ids are swept, so a late cancel can't kill a recycled pid.
        assert!(!reg.cancel("e1"));
    }
}
