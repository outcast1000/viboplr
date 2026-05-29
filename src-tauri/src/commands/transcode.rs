// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

#[tauri::command]
pub async fn start_transcode(
    state: State<'_, AppState>,
    path: String,
) -> Result<TranscodeInfo, String> {
    let cache = Arc::clone(&state.dep_cache);
    let available = tauri::async_runtime::spawn_blocking(move || {
        dependencies::is_available("ffmpeg", &cache)
    }).await.map_err(|e| e.to_string())?;
    if !available {
        return Err("ffmpeg is not installed. Install ffmpeg to play MKV/AVI/WMV files.".to_string());
    }

    let probe_path = std::path::PathBuf::from(&path);
    let duration_secs = tauri::async_runtime::spawn_blocking(move || {
        crate::video_frames::get_video_duration(&probe_path).ok()
    }).await.unwrap_or(None);

    let session_id = transcode_server::create_session(&state.transcode_sessions, path).await;
    let url = format!("http://127.0.0.1:{}/stream/{}?seek=0", state.transcode_port, session_id);

    Ok(TranscodeInfo { url, session_id, duration_secs })
}

#[tauri::command]
pub async fn stop_transcode(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    transcode_server::remove_session(&state.transcode_sessions, &session_id).await;
    Ok(())
}
