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
