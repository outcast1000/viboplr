//! IPC surface for the native mpv playback engine.
//!
//! The engine is compiled into every build; libmpv itself is resolved at
//! runtime (bundled / downloaded component / vendored / system — see
//! `mpv_engine::ffi`). `engine_capabilities` reports whether a library is
//! actually loadable plus the component install state, so the frontend gates
//! on capability, not build flavor.

use serde::Deserialize;
use tauri::Emitter;

/// Pre-`convertFileSrc` origin of a track — libmpv takes raw paths/URLs.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EngineSource {
    File { path: String },
    Http { url: String },
}

impl EngineSource {
    fn as_mpv_target(&self) -> &str {
        match self {
            EngineSource::File { path } => path,
            EngineSource::Http { url } => url,
        }
    }
}

#[tauri::command]
pub fn engine_capabilities() -> serde_json::Value {
    // Loads libmpv on first probe (load failures are not cached, so a
    // component installed mid-session flips this on the next probe).
    let mpv = crate::mpv_engine::libmpv_available();
    serde_json::json!({
        "mpv": mpv,
        // Native video: macOS (render-API layer, validated) and Windows (wid
        // layer, PoC — the WINVIDEO diagnostic logs stay until it's visually
        // confirmed on real hardware).
        "video": mpv && (cfg!(target_os = "macos") || cfg!(windows)),
        "component": crate::mpv_engine::component::status(),
    })
}

/// Install state of the downloadable libmpv component.
#[tauri::command]
pub fn engine_component_status() -> crate::mpv_engine::component::ComponentStatus {
    crate::mpv_engine::component::status()
}

/// Download + verify + install the pinned libmpv component. Progress streams
/// via `engine-component-progress` events; the engine becomes usable
/// immediately (no restart) because load failures are never cached.
#[tauri::command]
pub fn engine_component_install(
    app: tauri::AppHandle,
) -> Result<crate::mpv_engine::component::ComponentStatus, String> {
    crate::mpv_engine::component::install(|downloaded, total| {
        if let Err(e) = app.emit(
            "engine-component-progress",
            serde_json::json!({ "downloaded": downloaded, "total": total }),
        ) {
            log::error!("mpv-engine: failed to emit component progress: {e}");
        }
    })
}

/// Remove the downloaded component. A copy already loaded in this process
/// stays usable until restart.
#[tauri::command]
pub fn engine_component_uninstall() -> Result<crate::mpv_engine::component::ComponentStatus, String>
{
    crate::mpv_engine::component::uninstall()
}

#[tauri::command]
pub fn engine_play(
    app: tauri::AppHandle,
    state: tauri::State<'_, super::AppState>,
    source: EngineSource,
    track_key: String,
    seek_secs: Option<f64>,
    volume: f64,
    muted: bool,
    video: bool,
) -> Result<(), String> {
    let engine = state.mpv_engine.ensure(&app)?;
    engine.play(source.as_mpv_target(), &track_key, seek_secs, volume, muted, video)
}

#[tauri::command]
pub fn engine_set_audio_exclusive(
    state: tauri::State<'_, super::AppState>,
    enabled: bool,
) -> Result<(), String> {
    // Cached on the handle when the engine isn't running; applied at creation.
    state.mpv_engine.set_audio_exclusive(enabled)
}

/// Letterbox / uncovered-window fill for native video, so it matches the active
/// skin's `--bg-primary` instead of mpv's default black. `color` is an mpv color
/// string (e.g. `#RRGGBB`). Cached on the handle when the engine isn't running.
#[tauri::command]
pub fn engine_set_video_background(
    state: tauri::State<'_, super::AppState>,
    color: String,
) -> Result<(), String> {
    state.mpv_engine.set_video_background(color)
}

/// Live codec/samplerate/format/bitrate of whatever the engine is decoding,
/// or null when no native session is playing.
#[tauri::command]
pub fn engine_get_audio_info(
    state: tauri::State<'_, super::AppState>,
) -> Result<serde_json::Value, String> {
    let info = state.mpv_engine.get().and_then(|engine| engine.audio_info());
    serde_json::to_value(info).map_err(|e| format!("serialize audio info: {e}"))
}

/// Position the native video surface. Coordinates are top-left-origin points
/// within the window content view (frontend pre-multiplies its zoom factor).
#[tauri::command]
pub fn engine_set_video_bounds(
    state: tauri::State<'_, super::AppState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    match state.mpv_engine.get() {
        Some(engine) => engine.set_video_bounds(x, y, width, height),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn engine_preload(
    state: tauri::State<'_, super::AppState>,
    source: EngineSource,
    track_key: String,
    crossfade: bool,
) -> Result<(), String> {
    match state.mpv_engine.get() {
        Some(engine) => engine.preload(source.as_mpv_target(), &track_key, crossfade),
        None => Err("mpv engine is not running".into()),
    }
}

#[tauri::command]
pub fn engine_start_crossfade(
    state: tauri::State<'_, super::AppState>,
    secs: f64,
) -> Result<(), String> {
    match state.mpv_engine.get() {
        // Benign no-op when nothing is armed — the track ends normally.
        Some(engine) => engine.start_crossfade(secs),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn engine_set_eq(
    state: tauri::State<'_, super::AppState>,
    params: serde_json::Value,
) -> Result<(), String> {
    let eq: crate::mpv_engine::EqParams =
        serde_json::from_value(params).map_err(|e| format!("invalid EQ params: {e}"))?;
    // Cached on the handle when the engine isn't running; applied at creation.
    state.mpv_engine.set_eq(eq)
}

#[tauri::command]
pub fn engine_set_replaygain(
    state: tauri::State<'_, super::AppState>,
    params: serde_json::Value,
) -> Result<(), String> {
    let rg: crate::mpv_engine::ReplayGainParams =
        serde_json::from_value(params).map_err(|e| format!("invalid ReplayGain params: {e}"))?;
    state.mpv_engine.set_replaygain(rg)
}

#[tauri::command]
pub fn engine_clear_preload(state: tauri::State<'_, super::AppState>) -> Result<(), String> {
    match state.mpv_engine.get() {
        Some(engine) => engine.clear_preload(),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn engine_set_paused(
    state: tauri::State<'_, super::AppState>,
    paused: bool,
) -> Result<(), String> {
    match state.mpv_engine.get() {
        Some(engine) => engine.set_paused(paused),
        None => Err("mpv engine is not running".into()),
    }
}

#[tauri::command]
pub fn engine_stop(state: tauri::State<'_, super::AppState>) -> Result<(), String> {
    match state.mpv_engine.get() {
        Some(engine) => engine.stop(),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn engine_seek(state: tauri::State<'_, super::AppState>, secs: f64) -> Result<(), String> {
    match state.mpv_engine.get() {
        Some(engine) => engine.seek(secs),
        None => Err("mpv engine is not running".into()),
    }
}

#[tauri::command]
pub fn engine_set_volume(
    state: tauri::State<'_, super::AppState>,
    volume: f64,
    muted: bool,
) -> Result<(), String> {
    // Harmless when the engine isn't running yet — play() carries volume.
    match state.mpv_engine.get() {
        Some(engine) => engine.apply_volume(volume, muted),
        None => Ok(()),
    }
}
