// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

#[tauri::command]
pub fn get_cached_waveform(state: State<'_, AppState>, key: String) -> Option<serde_json::Value> {
    let hash = format!("{:x}", md5::compute(&key));
    let cache_path = state.app_dir.join("waveforms").join(format!("{}.json", hash));
    log::info!("Waveform lookup: key={} hash={}", key, hash);
    let data = std::fs::read_to_string(&cache_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&data).ok()?;
    let name = value.get("name").and_then(|v| v.as_str()).unwrap_or("?");
    let duration = value.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
    log::info!("Waveform hit: \"{}\" ({}s)", name, duration);
    Some(value)
}

#[tauri::command]
pub fn cache_waveform(state: State<'_, AppState>, key: String, waveform: serde_json::Value) -> Result<(), String> {
    let dir = state.app_dir.join("waveforms");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", md5::compute(&key));
    let cache_path = dir.join(format!("{}.json", hash));
    let json = serde_json::to_string(&waveform).map_err(|e| e.to_string())?;
    std::fs::write(&cache_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Outcome of an ffmpeg waveform pass. `status` is `ok` (with `rms`), or one of the
/// expected "can't do this" answers the frontend falls back on quietly:
/// `unavailable` (no ffmpeg), `unsupported` (not a local file), `cancelled`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformAnalysis {
    pub status: String,
    /// Raw RMS, one value per second of audio (last = the remainder). Unshaped: the
    /// frontend's `shapePeaks` normalizes it, same as for the Web Audio provider.
    pub rms: Option<Vec<f32>>,
}

/// Analyze a local file's waveform with ffmpeg (see `waveform.rs`). `request_id` is
/// the caller's token for `cancel_waveform_analysis`. Async + `spawn_blocking`: the
/// pass runs for seconds and a sync command would run on the main thread.
#[tauri::command]
pub async fn analyze_waveform_ffmpeg(
    state: State<'_, AppState>,
    path: String,
    request_id: String,
) -> Result<WaveformAnalysis, String> {
    let dep_cache = std::sync::Arc::clone(&state.dep_cache);
    tauri::async_runtime::spawn_blocking(move || {
        let status = |s: &str| WaveformAnalysis { status: s.to_string(), rms: None };
        if !path.starts_with("file://") {
            return Ok(status("unsupported"));
        }
        if !crate::dependencies::is_available("ffmpeg", &dep_cache) {
            return Ok(status("unavailable"));
        }
        match crate::waveform::analyze(&path, &request_id) {
            Ok(rms) => Ok(WaveformAnalysis { status: "ok".to_string(), rms: Some(rms) }),
            Err(e) if e == crate::waveform::CANCELLED => Ok(status("cancelled")),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Stop a pass started by `analyze_waveform_ffmpeg`. Idempotent, and safe to call
/// before that invoke has landed.
#[tauri::command]
pub fn cancel_waveform_analysis(request_id: String) {
    crate::waveform::cancel(&request_id);
}
