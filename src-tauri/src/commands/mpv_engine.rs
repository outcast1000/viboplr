//! IPC surface for the native mpv playback engine.
//!
//! All commands are registered in every build; without the `mpv-engine`
//! feature they return a clean error and `engine_capabilities` reports
//! `mpv: false`, so the frontend gates on capability instead of build flavor.

use serde::Deserialize;

#[cfg(not(feature = "mpv-engine"))]
const NOT_AVAILABLE: &str = "mpv engine is not available in this build";

/// Pre-`convertFileSrc` origin of a track — libmpv takes raw paths/URLs.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[cfg_attr(not(feature = "mpv-engine"), allow(dead_code))]
pub enum EngineSource {
    File { path: String },
    Http { url: String },
}

impl EngineSource {
    #[cfg(feature = "mpv-engine")]
    fn as_mpv_target(&self) -> &str {
        match self {
            EngineSource::File { path } => path,
            EngineSource::Http { url } => url,
        }
    }
}

#[tauri::command]
pub fn engine_capabilities() -> serde_json::Value {
    // Native video: macOS (render-API layer) is validated; the Windows wid
    // layer is implemented but ships DARK until validated on real hardware —
    // enable for a validation session with VIBOPLR_WIN_NATIVE_VIDEO=1.
    let win_video_override = cfg!(all(feature = "mpv-engine", windows))
        && std::env::var("VIBOPLR_WIN_NATIVE_VIDEO").is_ok_and(|v| v == "1");
    if win_video_override {
        log::info!("WINVIDEO: native video capability enabled via VIBOPLR_WIN_NATIVE_VIDEO=1");
    }
    serde_json::json!({
        "mpv": cfg!(feature = "mpv-engine"),
        "video": cfg!(all(feature = "mpv-engine", target_os = "macos")) || win_video_override,
    })
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
    #[cfg(feature = "mpv-engine")]
    {
        let engine = state.mpv_engine.ensure(&app)?;
        engine.play(source.as_mpv_target(), &track_key, seek_secs, volume, muted, video)
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = (app, state, source, track_key, seek_secs, volume, muted, video);
        Err(NOT_AVAILABLE.into())
    }
}

#[tauri::command]
pub fn engine_set_audio_exclusive(
    state: tauri::State<'_, super::AppState>,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(feature = "mpv-engine")]
    {
        // Cached on the handle when the engine isn't running; applied at creation.
        state.mpv_engine.set_audio_exclusive(enabled)
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = (state, enabled);
        Err(NOT_AVAILABLE.into())
    }
}

/// Live codec/samplerate/format/bitrate of whatever the engine is decoding,
/// or null when no native session is playing.
#[tauri::command]
pub fn engine_get_audio_info(
    state: tauri::State<'_, super::AppState>,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "mpv-engine")]
    {
        let info = state.mpv_engine.get().and_then(|engine| engine.audio_info());
        serde_json::to_value(info).map_err(|e| format!("serialize audio info: {e}"))
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = state;
        Ok(serde_json::Value::Null)
    }
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
    #[cfg(feature = "mpv-engine")]
    {
        match state.mpv_engine.get() {
            Some(engine) => engine.set_video_bounds(x, y, width, height),
            None => Ok(()),
        }
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = (state, x, y, width, height);
        Err(NOT_AVAILABLE.into())
    }
}

#[tauri::command]
pub fn engine_preload(
    state: tauri::State<'_, super::AppState>,
    source: EngineSource,
    track_key: String,
    crossfade: bool,
) -> Result<(), String> {
    #[cfg(feature = "mpv-engine")]
    {
        match state.mpv_engine.get() {
            Some(engine) => engine.preload(source.as_mpv_target(), &track_key, crossfade),
            None => Err("mpv engine is not running".into()),
        }
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = (state, source, track_key, crossfade);
        Err(NOT_AVAILABLE.into())
    }
}

#[tauri::command]
pub fn engine_start_crossfade(
    state: tauri::State<'_, super::AppState>,
    secs: f64,
) -> Result<(), String> {
    #[cfg(feature = "mpv-engine")]
    {
        match state.mpv_engine.get() {
            // Benign no-op when nothing is armed — the track ends normally.
            Some(engine) => engine.start_crossfade(secs),
            None => Ok(()),
        }
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = (state, secs);
        Err(NOT_AVAILABLE.into())
    }
}

// EQ/RG params arrive as JSON and deserialize inside the feature gate — the
// concrete types live in the cfg-gated mpv_engine module.
#[tauri::command]
pub fn engine_set_eq(
    state: tauri::State<'_, super::AppState>,
    params: serde_json::Value,
) -> Result<(), String> {
    #[cfg(feature = "mpv-engine")]
    {
        let eq: crate::mpv_engine::EqParams =
            serde_json::from_value(params).map_err(|e| format!("invalid EQ params: {e}"))?;
        // Cached on the handle when the engine isn't running; applied at creation.
        state.mpv_engine.set_eq(eq)
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = (state, params);
        Err(NOT_AVAILABLE.into())
    }
}

#[tauri::command]
pub fn engine_set_replaygain(
    state: tauri::State<'_, super::AppState>,
    params: serde_json::Value,
) -> Result<(), String> {
    #[cfg(feature = "mpv-engine")]
    {
        let rg: crate::mpv_engine::ReplayGainParams =
            serde_json::from_value(params).map_err(|e| format!("invalid ReplayGain params: {e}"))?;
        state.mpv_engine.set_replaygain(rg)
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = (state, params);
        Err(NOT_AVAILABLE.into())
    }
}

#[tauri::command]
pub fn engine_clear_preload(state: tauri::State<'_, super::AppState>) -> Result<(), String> {
    #[cfg(feature = "mpv-engine")]
    {
        match state.mpv_engine.get() {
            Some(engine) => engine.clear_preload(),
            None => Ok(()),
        }
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = state;
        Err(NOT_AVAILABLE.into())
    }
}

#[tauri::command]
pub fn engine_set_paused(
    state: tauri::State<'_, super::AppState>,
    paused: bool,
) -> Result<(), String> {
    #[cfg(feature = "mpv-engine")]
    {
        match state.mpv_engine.get() {
            Some(engine) => engine.set_paused(paused),
            None => Err("mpv engine is not running".into()),
        }
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = (state, paused);
        Err(NOT_AVAILABLE.into())
    }
}

#[tauri::command]
pub fn engine_stop(state: tauri::State<'_, super::AppState>) -> Result<(), String> {
    #[cfg(feature = "mpv-engine")]
    {
        match state.mpv_engine.get() {
            Some(engine) => engine.stop(),
            None => Ok(()),
        }
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = state;
        Err(NOT_AVAILABLE.into())
    }
}

#[tauri::command]
pub fn engine_seek(state: tauri::State<'_, super::AppState>, secs: f64) -> Result<(), String> {
    #[cfg(feature = "mpv-engine")]
    {
        match state.mpv_engine.get() {
            Some(engine) => engine.seek(secs),
            None => Err("mpv engine is not running".into()),
        }
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = (state, secs);
        Err(NOT_AVAILABLE.into())
    }
}

#[tauri::command]
pub fn engine_set_volume(
    state: tauri::State<'_, super::AppState>,
    volume: f64,
    muted: bool,
) -> Result<(), String> {
    #[cfg(feature = "mpv-engine")]
    {
        // Harmless when the engine isn't running yet — play() carries volume.
        match state.mpv_engine.get() {
            Some(engine) => engine.apply_volume(volume, muted),
            None => Ok(()),
        }
    }
    #[cfg(not(feature = "mpv-engine"))]
    {
        let _ = (state, volume, muted);
        Err(NOT_AVAILABLE.into())
    }
}
