// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

#[tauri::command]
pub async fn plugin_exec(
    state: State<'_, AppState>,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<ExecResult, String> {
    let allowed = dependencies::allowed_names();
    if !allowed.contains(&program.as_str()) {
        return Err(format!("Program not allowed: {}. Allowed: {:?}", program, allowed));
    }

    let app_dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = command_with_path(&program);
        cmd.args(&args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        } else {
            cmd.current_dir(&app_dir);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = cmd.output()
            .map_err(|e| format!("Failed to run {}: {}", program, e))?;
        Ok(ExecResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// --- yt-dlp commands ---

#[tauri::command]
pub async fn yt_dlp_check(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let cache = Arc::clone(&state.dep_cache);
    Ok(tauri::async_runtime::spawn_blocking(move || {
        match dependencies::check_single("yt-dlp", &cache) {
            dependencies::DepStatus::Installed { version } => Some(version),
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
            dependencies::DepStatus::Installed { version } => Some(version),
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
                    })
                    .collect();

                dependencies::DependencyInfo {
                    name: def.name.to_string(),
                    description: def.description.to_string(),
                    status,
                    internal_consumers: def.internal_consumers.iter().map(|(n, r)| {
                        dependencies::ConsumerInfo { name: n.to_string(), reason: r.to_string() }
                    }).collect(),
                    plugin_consumers,
                    install: def.install.clone(),
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
            return Err(format!("yt-dlp failed: {}", stderr));
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

        let video_exts = ["mp4", "m4v", "mov", "webm"];
        let is_video = video_path.extension()
            .and_then(|e| e.to_str())
            .map(|e| video_exts.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);
        if !is_video {
            return Err("Track is not a video file".to_string());
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
