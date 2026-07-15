//! Native playback engine backed by libmpv.
//!
//! Compiled into every build; libmpv itself is loaded at runtime (`ffi.rs`) —
//! from the bundled Frameworks dir (Full build), the downloadable engine
//! component (`component.rs`), the dev vendor dir, or a system install. When
//! no library is available, `engine_capabilities` reports `mpv: false` and
//! the frontend stays on the browser engine.
//!
//! Audio-only (`vo=null`, `video=no`), built around **two decks** (libmpv
//! handles) in a ping-pong arrangement:
//!
//! - **Gapless** (crossfade off): the next track is appended to the *active*
//!   deck's playlist; mpv transitions sample-accurately and the following
//!   `StartFile` promotes the armed key.
//! - **Crossfade** (crossfade on): the next track is loaded *paused* on the
//!   standby deck; `start_crossfade` swaps roles and a ramp thread fades the
//!   deck volumes (linear, matching the browser engine's curve). If the active
//!   track reaches EOF before the fade was triggered, the armed deck is
//!   promoted with a hard cut as a safety net.
//!
//! EQ maps to one ffmpeg `lavfi` graph (see `af.rs`), ReplayGain to mpv's
//! native `replaygain*` options — both applied to both decks, and cached on
//! `EngineHandle` so settings set before the engine exists apply at creation.
//!
//! Event contract (all payloads carry `track_key` so the frontend can drop
//! stale events, mirroring the browser path's play-generation guard):
//! `engine-position` (~4 Hz while playing), `engine-duration`,
//! `engine-track-changed {reason}`, `engine-ended`, `engine-state`,
//! `engine-error {code}`.

mod af;
mod api;
pub mod component;
pub mod ffi;
#[cfg(target_os = "macos")]
mod video_layer;
#[cfg(windows)]
mod video_layer_win;

#[cfg(target_os = "macos")]
use video_layer::VideoLayer as PlatformVideoLayer;
#[cfg(windows)]
use video_layer_win::VideoLayer as PlatformVideoLayer;

pub use af::{EqParams, ReplayGainParams};
pub use api::libmpv_available;
pub use ffi::set_component_dir;

use af::{build_af_graph, replaygain_mode_value};
use api::{mpv_end_file_reason, Event, Format, Mpv};
use serde_json::json;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

const POSITION_EMIT_INTERVAL: Duration = Duration::from_millis(240);
const FADE_TICK: Duration = Duration::from_millis(30);

/// Where engine events go. Production wraps `AppHandle::emit`; tests collect.
pub type EventSink = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

#[derive(Clone, Default)]
struct DspSettings {
    eq: EqParams,
    rg: ReplayGainParams,
    /// Exclusive audio-device access (CoreAudio hog mode / WASAPI exclusive).
    exclusive: bool,
    /// Letterbox / uncovered-window fill for native video (mpv `background-color`),
    /// pushed from the frontend to match the active skin's `--bg-primary`. None =
    /// leave mpv's default (black).
    video_bg: Option<String>,
}

/// Live audio-stream facts read off the active deck — what's actually being
/// decoded, which works for remote streams where tag-based readers can't.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineAudioInfo {
    pub codec: Option<String>,
    pub sample_rate: Option<i64>,
    /// mpv sample format string (e.g. "s16", "s32", "floatp").
    pub format: Option<String>,
    /// Instantaneous bitrate in bits/s (VBR streams fluctuate).
    pub bitrate: Option<f64>,
}

#[derive(Default)]
pub struct EngineHandle {
    inner: Mutex<Option<Arc<Engine>>>,
    /// DSP settings survive here while the engine isn't running (e.g. set from
    /// Settings before the first native play) and are applied at creation.
    pending_dsp: Mutex<DspSettings>,
}

impl EngineHandle {
    /// Lazily create the engine on first use so sessions on the browser engine
    /// never open an audio device.
    pub fn ensure(&self, app: &tauri::AppHandle) -> Result<Arc<Engine>, String> {
        let mut guard = self.inner.lock().unwrap();
        if let Some(engine) = guard.as_ref() {
            return Ok(engine.clone());
        }
        let ca_bundle = ensure_ca_bundle(app);
        let app_for_engine = app.clone();
        let app = app.clone();
        let sink: EventSink = Arc::new(move |event, payload| {
            use tauri::Emitter;
            if let Err(e) = app.emit(event, payload) {
                log::error!("mpv-engine: failed to emit {event}: {e}");
            }
        });
        let engine = Engine::new(sink, None, Some(app_for_engine))?;
        let dsp = self.pending_dsp.lock().unwrap().clone();
        engine.apply_eq(&dsp.eq)?;
        engine.apply_replaygain(&dsp.rg)?;
        engine.apply_audio_exclusive(dsp.exclusive)?;
        if let Some(ref bg) = dsp.video_bg {
            engine.apply_video_background(bg);
        }
        // Give the static-OpenSSL TLS stack a CA store (see set_tls_ca_file).
        // On failure we log and leave verification ON — https sources then
        // fail closed and fall back to the browser engine per-track.
        match ca_bundle {
            Some(ca) => {
                if let Err(e) = engine.set_tls_ca_file(&ca) {
                    log::error!("mpv-engine: {e}");
                }
            }
            None => log::error!("mpv-engine: no CA bundle available; https sources will fail verification"),
        }
        *guard = Some(engine.clone());
        Ok(engine)
    }

    pub fn get(&self) -> Option<Arc<Engine>> {
        self.inner.lock().unwrap().clone()
    }

    pub fn set_eq(&self, eq: EqParams) -> Result<(), String> {
        self.pending_dsp.lock().unwrap().eq = eq.clone();
        match self.get() {
            Some(engine) => engine.apply_eq(&eq),
            None => Ok(()),
        }
    }

    pub fn set_replaygain(&self, rg: ReplayGainParams) -> Result<(), String> {
        self.pending_dsp.lock().unwrap().rg = rg.clone();
        match self.get() {
            Some(engine) => engine.apply_replaygain(&rg),
            None => Ok(()),
        }
    }

    pub fn set_audio_exclusive(&self, enabled: bool) -> Result<(), String> {
        self.pending_dsp.lock().unwrap().exclusive = enabled;
        match self.get() {
            Some(engine) => engine.apply_audio_exclusive(enabled),
            None => Ok(()),
        }
    }

    pub fn set_video_background(&self, color: String) -> Result<(), String> {
        self.pending_dsp.lock().unwrap().video_bg = Some(color.clone());
        if let Some(engine) = self.get() {
            engine.apply_video_background(&color);
        }
        Ok(())
    }
}

/// A PEM CA bundle for mpv's statically-linked OpenSSL, exported from the
/// macOS system trust store (`/usr/bin/security`) and cached in the app data
/// dir for 30 days. Returns None (and https stays fail-closed) on any error.
fn ensure_ca_bundle(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok()?;
    let path = dir.join("mpv-cacert.pem");
    let fresh = path
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|age| age < Duration::from_secs(30 * 24 * 3600))
        .unwrap_or(false);
    if fresh {
        return Some(path);
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/bin/security")
            .args([
                "find-certificate",
                "-a",
                "-p",
                "/System/Library/Keychains/SystemRootCertificates.keychain",
            ])
            .output()
            .ok()?;
        if !out.status.success() || out.stdout.is_empty() {
            log::error!("mpv-engine: exporting the system CA store failed");
            return None;
        }
        if let Err(e) = std::fs::write(&path, &out.stdout) {
            log::error!("mpv-engine: writing CA bundle failed: {e}");
            return None;
        }
        return Some(path);
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(windows)]
        {
            if path.exists() {
                return Some(path);
            }
            if let Some(parent) = path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    log::error!("mpv-engine: creating CA bundle directory failed: {e}");
                    return None;
                }
            }
            match export_windows_root_certs_pem(&path) {
                Ok(()) => return Some(path),
                Err(e) => {
                    log::error!("mpv-engine: exporting Windows root certificates failed: {e}");
                    return None;
                }
            }
        }

        #[cfg(not(windows))]
        {
            if path.exists() {
                return Some(path);
            }
            None
        }
    }
}

#[cfg(windows)]
fn export_windows_root_certs_pem(path: &std::path::Path) -> Result<(), String> {
    let dest = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "`\"");
    let script = format!(
        "$ErrorActionPreference='Stop'; \
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','LocalMachine'); \
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly); \
$sb = New-Object System.Text.StringBuilder; \
foreach ($cert in $store.Certificates) {{ \
  $b64 = [System.Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert), [System.Base64FormattingOptions]::InsertLineBreaks); \
  [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----'); \
  [void]$sb.AppendLine($b64); \
  [void]$sb.AppendLine('-----END CERTIFICATE-----'); \
}}; \
$store.Close(); \
[System.IO.File]::WriteAllText(\"{dest}\", $sb.ToString(), [System.Text.Encoding]::ASCII);"
    );

    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .output()
        .map_err(|e| format!("failed to spawn powershell: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(format!(
            "powershell exit {}: {}{}{}",
            out.status,
            stdout.trim(),
            if !stdout.trim().is_empty() && !stderr.trim().is_empty() {
                " | "
            } else {
                ""
            },
            stderr.trim()
        ));
    }

    Ok(())
}

#[derive(Default)]
struct EngineState {
    /// Index (0/1) of the deck driving playback.
    active: usize,
    /// Key of the track the frontend considers current.
    current_key: Option<String>,
    /// Gapless arm: next track appended to the active deck's playlist.
    gapless_key: Option<String>,
    /// Crossfade arm: next track loaded paused on the standby deck.
    xfade_key: Option<String>,
    /// Per-deck guard so an explicit `loadfile` isn't taken for a promotion.
    expecting_start: [bool; 2],
    /// Seek to apply once the active deck's file is loaded.
    pending_seek: Option<f64>,
    duration: Option<f64>,
    /// User volume (0..1) and mute — the ramp thread scales from these.
    volume: f64,
    muted: bool,
    /// Exclusive device access: a second deck can't open the device while the
    /// active one holds it, so preload arming is forced to same-deck gapless.
    exclusive: bool,
    fading: bool,
    /// Bumped when a fade starts or is snapped; a ramp whose generation is
    /// stale exits without touching the decks.
    fade_gen: u64,
}

struct Deck {
    mpv: Arc<Mpv>,
}

pub struct Engine {
    decks: Vec<Deck>,
    state: Arc<Mutex<EngineState>>,
    sink: EventSink,
    /// Present in production (used for main-thread AppKit work); None in tests.
    app: Option<tauri::AppHandle>,
    /// Native video surface (macOS render layer / Windows wid child window),
    /// created lazily on the first video play.
    #[cfg(any(target_os = "macos", windows))]
    video: Mutex<Option<PlatformVideoLayer>>,
}

impl Engine {
    /// `ao_override` lets tests run with `ao=null` (no audio device needed).
    /// `app` is required for video (main-thread AppKit work); None in tests.
    pub fn new(
        sink: EventSink,
        ao_override: Option<&str>,
        app: Option<tauri::AppHandle>,
    ) -> Result<Arc<Self>, String> {
        let mut decks = Vec::with_capacity(2);
        for i in 0..2 {
            log::info!("mpv-engine: creating deck {i}");
            let mpv = Mpv::with_initializer(|init| {
                init.set_property("vo", "null")?;
                init.set_property("video", "no")?;
                init.set_property("audio-display", "no")?;
                init.set_property("gapless-audio", "yes")?;
                init.set_property("idle", "yes")?;
                init.set_property("terminal", "no")?;
                init.set_property("audio-client-name", "Viboplr")?;
                // No magic yt-dlp fallback for unloadable URLs — the app's
                // stream-resolver chain owns that, and the hook would spawn a
                // yt-dlp subprocess on every failed load otherwise.
                init.set_property("ytdl", false)?;
                if let Some(ao) = ao_override {
                    init.set_property("ao", ao)?;
                }
                Ok(())
            })
            .map_err(|e| format!("failed to initialize libmpv (deck {i}): {e}"))?;
            // Diagnostic hook: VIBOPLR_MPV_LOG_FILE=C:\path\mpv writes full mpv
            // debug logs per deck (mpv.deck0.log / mpv.deck1.log).
            if let Ok(base) = std::env::var("VIBOPLR_MPV_LOG_FILE") {
                let path = format!("{base}.deck{i}.log");
                if let Err(e) = mpv.set_property("log-file", path.as_str()) {
                    log::error!("mpv-engine: log-file setup failed: {e}");
                } else {
                    log::info!("mpv-engine: deck {i} logging to {path}");
                }
            }
            // Diagnostic hook: VIBOPLR_MPV_OPTS="key=val;key=val" applies raw
            // mpv options to both decks at creation — lets validation sessions
            // try candidate fixes (e.g. d3d11-flip=no) via env vars instead of
            // one release build per hypothesis. Not for production use.
            if let Ok(opts) = std::env::var("VIBOPLR_MPV_OPTS") {
                for pair in opts.split(';').map(str::trim).filter(|s| !s.is_empty()) {
                    let Some((key, val)) = pair.split_once('=') else {
                        log::error!("mpv-engine: VIBOPLR_MPV_OPTS entry without '=': {pair}");
                        continue;
                    };
                    match mpv.set_property(key.trim(), val.trim()) {
                        Ok(()) => log::info!("mpv-engine: deck {i} option override {key}={val}"),
                        Err(e) => {
                            log::error!("mpv-engine: deck {i} option override {key}={val} failed: {e}")
                        }
                    }
                }
            }
            let mpv_version = mpv
                .get_property::<String>("mpv-version")
                .unwrap_or_else(|_| "unknown".into());
            log::info!("mpv-engine: deck {i} core initialized ({mpv_version})");
            decks.push(Deck { mpv: Arc::new(mpv) });
        }

        let state = Arc::new(Mutex::new(EngineState { volume: 1.0, ..Default::default() }));
        let engine = Arc::new(Engine {
            decks,
            state,
            sink,
            app,
            #[cfg(any(target_os = "macos", windows))]
            video: Mutex::new(None),
        });
        for i in 0..2 {
            engine.spawn_event_thread(i)?;
        }
        log::info!("mpv-engine: engine ready (event threads running)");
        Ok(engine)
    }

    /// Windows: create the wid child window and hand it to deck 0 — mpv then
    /// renders into it itself (no render thread on our side).
    #[cfg(windows)]
    fn ensure_video_layer(self: &Arc<Self>) -> Result<(), String> {
        let mut guard = self.video.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
        let app = self
            .app
            .as_ref()
            .ok_or("video playback needs an app handle (not available in tests)")?;
        let layer = video_layer_win::VideoLayer::create(app)?;
        let deck = &self.decks[0].mpv;
        // Present model is mpv's DEFAULT (flip-model) — what composited in the
        // working direct-child config. A d3d11-flip entry in VIBOPLR_MPV_OPTS
        // still overrides (applied at deck creation).
        deck.set_property("wid", layer.wid())
            .and_then(|_| deck.set_property("vo", "gpu"))
            .and_then(|_| deck.set_property("hwdec", "auto"))
            .map_err(|e| format!("mpv wid/vo=gpu failed: {e}"))?;
        log::debug!("mpv-engine: deck 0 wired to video child (wid={:#x}, vo=gpu, hwdec=auto)", layer.wid());
        *guard = Some(layer);
        Ok(())
    }

    /// Create the native video surface + render thread once. The render
    /// thread owns the mpv `RenderContext` (it borrows deck 0's `Mpv`; the
    /// thread's `Arc<Engine>` keeps that borrow valid for its lifetime).
    #[cfg(target_os = "macos")]
    fn ensure_video_layer(self: &Arc<Self>) -> Result<(), String> {
        let mut guard = self.video.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
        let app = self
            .app
            .as_ref()
            .ok_or("video playback needs an app handle (not available in tests)")?;
        let layer = video_layer::VideoLayer::create(app)?;
        let render_state = layer.render_state();
        let glctx = layer.glctx();
        let cgl = layer.cgl_context();

        let engine = Arc::clone(self);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        std::thread::Builder::new()
            .name("mpv-video-render".into())
            .spawn(move || {
                video_layer::make_context_current(cgl);
                let gl = match video_layer::open_gl_library() {
                    Ok(gl) => gl,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                use api::render::{OpenGLInitParams, RenderParam, RenderParamApiType};
                let mut rctx = match engine.decks[0].mpv.create_render_context(vec![
                    RenderParam::ApiType(RenderParamApiType::OpenGl),
                    RenderParam::InitParams(OpenGLInitParams {
                        get_proc_address: video_layer::get_proc_address,
                        ctx: gl,
                    }),
                ]) {
                    Ok(rctx) => rctx,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("mpv render context failed: {e}")));
                        return;
                    }
                };
                let signal_state = render_state.clone();
                rctx.set_update_callback(move || {
                    video_layer::VideoLayer::signal_frame(&signal_state);
                });
                let _ = ready_tx.send(Ok(()));
                video_layer::run_render_loop(render_state, glctx, cgl, |width, height| {
                    rctx.render(0, width, height, true).map_err(|e| e.to_string())
                });
            })
            .map_err(|e| format!("failed to spawn video render thread: {e}"))?;
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "timed out initializing the video render context".to_string())??;

        // Route deck 0's video output through the render context.
        let deck = &self.decks[0].mpv;
        deck.set_property("vo", "libmpv")
            .and_then(|_| deck.set_property("hwdec", "auto"))
            .map_err(|e| format!("mpv vo=libmpv failed: {e}"))?;

        *guard = Some(layer);
        Ok(())
    }

    /// Position the video surface (top-left-origin points within the window's
    /// content view). No-op until a video session created the layer.
    pub fn set_video_bounds(&self, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
        #[cfg(any(target_os = "macos", windows))]
        {
            if let Some(layer) = self.video.lock().unwrap().as_ref() {
                layer.set_bounds(x, y, width, height);
            }
            Ok(())
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = (x, y, width, height);
            Err("native video is not supported on this platform".into())
        }
    }

    fn set_video_layer_visible(&self, visible: bool) {
        #[cfg(any(target_os = "macos", windows))]
        if let Some(layer) = self.video.lock().unwrap().as_ref() {
            layer.set_visible(visible);
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        let _ = visible;
    }

    fn spawn_event_thread(self: &Arc<Self>, deck: usize) -> Result<(), String> {
        let client = Arc::clone(&self.decks[deck].mpv);
        client
            .disable_deprecated_events()
            .map_err(|e| format!("failed to configure mpv events: {e}"))?;
        client
            .observe_property("time-pos", Format::Double, 1)
            .and_then(|_| client.observe_property("duration", Format::Double, 2))
            .and_then(|_| client.observe_property("pause", Format::Flag, 3))
            // ICY StreamTitle for radio streams surfaces as media-title.
            .and_then(|_| client.observe_property("media-title", Format::String, 4))
            .map_err(|e| format!("failed to observe mpv properties: {e}"))?;

        let state = self.state.clone();
        let sink = self.sink.clone();
        let weak = Arc::downgrade(self);
        std::thread::Builder::new()
            .name(format!("mpv-engine-events-{deck}"))
            .spawn(move || run_event_loop(client, deck, weak, state, sink))
            .map_err(|e| format!("failed to spawn mpv event thread: {e}"))?;
        Ok(())
    }

    fn out_volume(volume: f64, muted: bool) -> f64 {
        if muted { 0.0 } else { (volume.clamp(0.0, 1.0) * 100.0).round() }
    }

    pub fn play(
        self: &Arc<Self>,
        url: &str,
        track_key: &str,
        seek_secs: Option<f64>,
        volume: f64,
        muted: bool,
        video: bool,
    ) -> Result<(), String> {
        log::info!("mpv-engine: play key={track_key} video={video} url_scheme={}", url.split(':').next().unwrap_or("(path)"));
        if video {
            #[cfg(any(target_os = "macos", windows))]
            self.ensure_video_layer()?;
            #[cfg(not(any(target_os = "macos", windows)))]
            return Err("native video is not supported on this platform".into());
        }
        self.snap_finish_fade();
        let (active, drop_standby) = {
            let mut st = self.state.lock().unwrap();
            st.volume = volume;
            st.muted = muted;
            st.current_key = Some(track_key.to_string());
            st.gapless_key = None;
            let had_xfade = st.xfade_key.take().is_some();
            // Video renders through deck 0's render context only.
            if video {
                st.active = 0;
            }
            let active = st.active;
            st.expecting_start[active] = true;
            st.pending_seek = seek_secs.filter(|s| *s > 0.1);
            st.duration = None;
            (active, had_xfade || video)
        };
        let standby = 1 - active;
        if drop_standby {
            // Best-effort: a stale arm / displaced deck must not block the play.
            if let Err(e) = self.decks[standby].mpv.command("stop", &[]) {
                log::error!("mpv-engine: failed to stop standby deck: {e}");
            }
        }
        let deck = &self.decks[active].mpv;
        // Audio sessions keep video decode off; video sessions select the track.
        deck.set_property("video", if video { "auto" } else { "no" })
            .map_err(|e| format!("mpv video selection failed: {e}"))?;
        self.set_video_layer_visible(video);
        let out = Self::out_volume(volume, muted);
        deck.set_property("volume", out)
            .and_then(|_| deck.set_property("mute", muted))
            .and_then(|_| self.decks[standby].mpv.set_property("mute", muted))
            .map_err(|e| format!("mpv volume failed: {e}"))?;
        deck.set_property("pause", false)
            .map_err(|e| format!("mpv unpause failed: {e}"))?;
        deck.command("loadfile", &[url, "replace"])
            .map_err(|e| format!("mpv loadfile failed: {e}"))?;
        log::info!("mpv-engine: loadfile accepted on deck {active}");
        Ok(())
    }

    /// Arm the next track. `crossfade` picks the transition machinery: standby
    /// deck (fade / hard-cut safety net) vs. active-deck playlist (gapless).
    /// Exclusive mode forces gapless — the standby deck can't open the device.
    pub fn preload(&self, url: &str, track_key: &str, crossfade: bool) -> Result<(), String> {
        let crossfade = crossfade && !self.state.lock().unwrap().exclusive;
        self.clear_preload()?;
        if crossfade {
            let standby = {
                let mut st = self.state.lock().unwrap();
                let standby = 1 - st.active;
                st.expecting_start[standby] = true;
                st.xfade_key = Some(track_key.to_string());
                standby
            };
            let deck = &self.decks[standby].mpv;
            let armed = deck
                .set_property("pause", true)
                .and_then(|_| deck.set_property("volume", 0.0))
                .and_then(|_| deck.command("loadfile", &[url, "replace"]));
            if let Err(e) = armed {
                let mut st = self.state.lock().unwrap();
                st.xfade_key = None;
                st.expecting_start[standby] = false;
                return Err(format!("mpv crossfade preload failed: {e}"));
            }
        } else {
            let active = {
                let mut st = self.state.lock().unwrap();
                st.gapless_key = Some(track_key.to_string());
                st.active
            };
            if let Err(e) = self.decks[active].mpv.command("loadfile", &[url, "append"]) {
                self.state.lock().unwrap().gapless_key = None;
                return Err(format!("mpv preload failed: {e}"));
            }
        }
        Ok(())
    }

    /// Drop whichever arm exists (playlist entry or standby deck load).
    pub fn clear_preload(&self) -> Result<(), String> {
        let (active, had_gapless, standby, had_xfade) = {
            let mut st = self.state.lock().unwrap();
            let standby = 1 - st.active;
            let had_xfade = st.xfade_key.take().is_some();
            if had_xfade {
                st.expecting_start[standby] = false;
            }
            (st.active, st.gapless_key.take().is_some(), standby, had_xfade)
        };
        if had_gapless {
            self.decks[active]
                .mpv
                .command("playlist-clear", &[])
                .map_err(|e| format!("mpv playlist-clear failed: {e}"))?;
        }
        if had_xfade {
            self.decks[standby]
                .mpv
                .command("stop", &[])
                .map_err(|e| format!("mpv standby stop failed: {e}"))?;
        }
        Ok(())
    }

    /// Fade from the active deck into the crossfade-armed standby deck. A
    /// no-op (Ok) when nothing is armed — the track then ends normally.
    pub fn start_crossfade(self: &Arc<Self>, secs: f64) -> Result<(), String> {
        let (old, new, key, fade_gen_captured) = {
            let mut st = self.state.lock().unwrap();
            if st.fading {
                return Ok(());
            }
            let Some(key) = st.xfade_key.take() else {
                return Ok(());
            };
            let old = st.active;
            let new = 1 - old;
            st.active = new;
            st.current_key = Some(key.clone());
            st.duration = None;
            st.pending_seek = None;
            st.fading = true;
            st.fade_gen += 1;
            (old, new, key, st.fade_gen)
        };

        let incoming = &self.decks[new].mpv;
        incoming
            .set_property("volume", 0.0)
            .and_then(|_| incoming.set_property("pause", false))
            .map_err(|e| format!("mpv crossfade start failed: {e}"))?;

        // Track state swaps at fade START (parity with the browser engine).
        (self.sink)(
            "engine-track-changed",
            json!({ "trackKey": key, "reason": "crossfade" }),
        );
        self.emit_active_duration(new);

        let engine = Arc::clone(self);
        let fade_ms = (secs.max(0.05) * 1000.0) as u64;
        std::thread::Builder::new()
            .name("mpv-engine-fade".into())
            .spawn(move || {
                let start = Instant::now();
                loop {
                    std::thread::sleep(FADE_TICK);
                    let (out, stale) = {
                        let st = engine.state.lock().unwrap();
                        (
                            Self::out_volume(st.volume, st.muted),
                            !st.fading || st.fade_gen != fade_gen_captured,
                        )
                    };
                    if stale {
                        return; // snapped/superseded — cleanup already done
                    }
                    let t = (start.elapsed().as_millis() as f64 / fade_ms as f64).min(1.0);
                    let _ = engine.decks[new].mpv.set_property("volume", out * t);
                    let _ = engine.decks[old].mpv.set_property("volume", out * (1.0 - t));
                    if t >= 1.0 {
                        break;
                    }
                }
                {
                    let mut st = engine.state.lock().unwrap();
                    if st.fade_gen != fade_gen_captured {
                        return;
                    }
                    st.fading = false;
                }
                if let Err(e) = engine.decks[old].mpv.command("stop", &[]) {
                    log::error!("mpv-engine: failed to stop faded-out deck: {e}");
                }
                let out = {
                    let st = engine.state.lock().unwrap();
                    Self::out_volume(st.volume, st.muted)
                };
                let _ = engine.decks[old].mpv.set_property("volume", out);
            })
            .map_err(|e| format!("failed to spawn fade thread: {e}"))?;
        Ok(())
    }

    /// Hard-finish a running fade: incoming deck to full volume, outgoing deck
    /// stopped. Safe to call when no fade is running.
    fn snap_finish_fade(&self) {
        let (active, out) = {
            let mut st = self.state.lock().unwrap();
            if !st.fading {
                return;
            }
            st.fading = false;
            st.fade_gen += 1; // invalidate the ramp thread
            (st.active, Self::out_volume(st.volume, st.muted))
        };
        let old = 1 - active;
        if let Err(e) = self.decks[old].mpv.command("stop", &[]) {
            log::error!("mpv-engine: snap-finish stop failed: {e}");
        }
        let _ = self.decks[old].mpv.set_property("volume", out);
        let _ = self.decks[active].mpv.set_property("volume", out);
    }

    /// EOF-with-crossfade-armed safety net: promote the armed deck with a hard
    /// cut so playback continues even if the fade trigger never arrived.
    fn promote_xfade_cut(self: &Arc<Self>) {
        let (new, key, out) = {
            let mut st = self.state.lock().unwrap();
            let Some(key) = st.xfade_key.take() else {
                return;
            };
            let new = 1 - st.active;
            st.active = new;
            st.current_key = Some(key.clone());
            st.duration = None;
            st.pending_seek = None;
            (new, key, Self::out_volume(st.volume, st.muted))
        };
        let deck = &self.decks[new].mpv;
        let _ = deck.set_property("volume", out);
        if let Err(e) = deck.set_property("pause", false) {
            log::error!("mpv-engine: xfade cut promotion failed: {e}");
        }
        (self.sink)(
            "engine-track-changed",
            json!({ "trackKey": key, "reason": "gapless" }),
        );
        self.emit_active_duration(new);
    }

    /// The standby deck loaded (and possibly emitted `duration`) while it
    /// wasn't active, so that event was dropped — re-read and emit after a
    /// promotion.
    fn emit_active_duration(&self, deck: usize) {
        if let Ok(dur) = self.decks[deck].mpv.get_property::<f64>("duration") {
            let key = self.state.lock().unwrap().current_key.clone();
            if let Some(key) = key {
                {
                    let mut st = self.state.lock().unwrap();
                    st.duration = Some(dur);
                }
                (self.sink)(
                    "engine-duration",
                    json!({ "trackKey": key, "durationSecs": dur }),
                );
            }
        }
    }

    pub fn set_paused(&self, paused: bool) -> Result<(), String> {
        if paused {
            self.snap_finish_fade();
        }
        let active = self.state.lock().unwrap().active;
        self.decks[active]
            .mpv
            .set_property("pause", paused)
            .map_err(|e| format!("mpv pause failed: {e}"))
    }

    pub fn stop(&self) -> Result<(), String> {
        {
            let mut st = self.state.lock().unwrap();
            st.fading = false;
            st.fade_gen += 1;
            st.current_key = None;
            st.gapless_key = None;
            st.xfade_key = None;
            st.expecting_start = [false; 2];
            st.pending_seek = None;
            st.duration = None;
        }
        self.set_video_layer_visible(false);
        let mut result = Ok(());
        for deck in &self.decks {
            if let Err(e) = deck.mpv.command("stop", &[]) {
                result = Err(format!("mpv stop failed: {e}"));
            }
        }
        result
    }

    pub fn seek(&self, secs: f64) -> Result<(), String> {
        let active = self.state.lock().unwrap().active;
        self.decks[active]
            .mpv
            .command("seek", &[&format!("{secs:.3}"), "absolute"])
            .map_err(|e| format!("mpv seek failed: {e}"))
    }

    pub fn apply_volume(&self, volume: f64, muted: bool) -> Result<(), String> {
        let (active, fading) = {
            let mut st = self.state.lock().unwrap();
            st.volume = volume;
            st.muted = muted;
            (st.active, st.fading)
        };
        for deck in &self.decks {
            deck.mpv
                .set_property("mute", muted)
                .map_err(|e| format!("mpv mute failed: {e}"))?;
        }
        // During a fade the ramp thread owns both deck volumes; it reads the
        // updated user volume on its next tick.
        if !fading {
            self.decks[active]
                .mpv
                .set_property("volume", Self::out_volume(volume, muted))
                .map_err(|e| format!("mpv volume failed: {e}"))?;
        }
        Ok(())
    }

    pub fn apply_eq(&self, eq: &EqParams) -> Result<(), String> {
        let graph = build_af_graph(eq);
        let af = if graph.is_empty() { String::new() } else { format!("lavfi=[{graph}]") };
        for deck in &self.decks {
            deck.mpv
                .set_property("af", af.as_str())
                .map_err(|e| format!("mpv af (EQ) failed: {e}"))?;
        }
        Ok(())
    }

    /// Letterbox / uncovered-window fill for native video. mpv paints black
    /// there by default; this matches it to the app skin's `--bg-primary`.
    /// Non-fatal: a bad/unsupported color must never break playback, so errors
    /// are logged, not propagated. (On `vo=gpu` the border may still fall back
    /// to black — coloring it fully is a `vo=gpu-next` `--border-background`
    /// feature — but transparent-frame fill and any honoring VO pick this up.)
    pub fn apply_video_background(&self, color: &str) {
        for deck in &self.decks {
            // `background=color` is the default fill mode; set it defensively in
            // case a profile changed it, then the color itself.
            let _ = deck.mpv.set_property("background", "color");
            if let Err(e) = deck.mpv.set_property("background-color", color) {
                log::warn!("mpv-engine: background-color failed: {e}");
            }
        }
    }

    pub fn apply_replaygain(&self, rg: &ReplayGainParams) -> Result<(), String> {
        for deck in &self.decks {
            deck.mpv
                .set_property("replaygain", replaygain_mode_value(&rg.mode))
                .and_then(|_| deck.mpv.set_property("replaygain-preamp", rg.preamp_db))
                .and_then(|_| deck.mpv.set_property("replaygain-clip", rg.prevent_clip))
                .map_err(|e| format!("mpv replaygain failed: {e}"))?;
        }
        Ok(())
    }

    /// Point mpv's TLS stack at a CA bundle. The vendored libmpv links a
    /// static OpenSSL whose baked-in CA path doesn't exist on user machines,
    /// so without this every https source fails certificate verification.
    pub fn set_tls_ca_file(&self, path: &std::path::Path) -> Result<(), String> {
        let Some(path) = path.to_str() else {
            return Err("CA bundle path is not valid UTF-8".into());
        };
        for deck in &self.decks {
            deck.mpv
                .set_property("tls-ca-file", path)
                .map_err(|e| format!("mpv tls-ca-file failed: {e}"))?;
        }
        Ok(())
    }

    /// Exclusive device access. Takes effect when an audio output next opens
    /// (i.e. from the next track). While on, preload arming is forced to
    /// same-deck gapless — the standby deck can't open the held device.
    pub fn apply_audio_exclusive(&self, enabled: bool) -> Result<(), String> {
        self.state.lock().unwrap().exclusive = enabled;
        for deck in &self.decks {
            deck.mpv
                .set_property("audio-exclusive", enabled)
                .map_err(|e| format!("mpv audio-exclusive failed: {e}"))?;
        }
        Ok(())
    }

    /// What the active deck is actually decoding, or None when the engine
    /// isn't playing. Works for remote streams that tag readers can't inspect.
    pub fn audio_info(&self) -> Option<EngineAudioInfo> {
        let active = {
            let st = self.state.lock().unwrap();
            st.current_key.as_ref()?;
            st.active
        };
        let mpv = &self.decks[active].mpv;
        Some(EngineAudioInfo {
            codec: mpv.get_property::<String>("audio-codec-name").ok(),
            sample_rate: mpv.get_property::<i64>("audio-params/samplerate").ok(),
            format: mpv.get_property::<String>("audio-params/format").ok(),
            bitrate: mpv.get_property::<f64>("audio-bitrate").ok(),
        })
    }
}

fn run_event_loop(
    client: Arc<Mpv>,
    deck: usize,
    engine: Weak<Engine>,
    state: Arc<Mutex<EngineState>>,
    sink: EventSink,
) {
    let mut last_position_emit = Instant::now() - POSITION_EMIT_INTERVAL;
    loop {
        let Some(event) = client.wait_event(0.5) else {
            continue;
        };
        #[cfg(test)]
        if !matches!(event, Ok(Event::PropertyChange { .. })) {
            eprintln!("[deck {deck}] raw event: {event:?}");
        }
        match event {
            Ok(Event::Shutdown) => break,
            Ok(Event::StartFile) => {
                let mut st = state.lock().unwrap();
                if st.expecting_start[deck] {
                    // Our own explicit loadfile (play or crossfade arm).
                    st.expecting_start[deck] = false;
                } else if deck == st.active {
                    if let Some(next_key) = st.gapless_key.take() {
                        // Gapless transition into the playlist-armed track.
                        st.current_key = Some(next_key.clone());
                        st.duration = None;
                        st.pending_seek = None;
                        drop(st);
                        sink(
                            "engine-track-changed",
                            json!({ "trackKey": next_key, "reason": "gapless" }),
                        );
                    }
                }
            }
            Ok(Event::FileLoaded) => {
                let pending = {
                    let mut st = state.lock().unwrap();
                    if deck == st.active { st.pending_seek.take() } else { None }
                };
                if let Some(secs) = pending {
                    if let Err(e) = client.command("seek", &[&format!("{secs:.3}"), "absolute"]) {
                        log::error!("mpv-engine: pending seek failed: {e}");
                    }
                }
            }
            Ok(Event::PlaybackRestart) => {
                // mpv is now displaying the first frame after load/seek. This is
                // the accurate "frame is on screen" signal (StartFile / time-pos
                // / video-reconfig all fire earlier, before the VO has actually
                // painted), so the frontend reveals the native video hole on it.
                let key = {
                    let st = state.lock().unwrap();
                    if deck != st.active { None } else { st.current_key.clone() }
                };
                if let Some(key) = key {
                    sink("engine-playback-restart", json!({ "trackKey": key }));
                }
            }
            Ok(Event::EndFile(reason)) => {
                let action = {
                    let st = state.lock().unwrap();
                    if deck != st.active || reason != mpv_end_file_reason::Eof {
                        None // outgoing/standby deck, or our own stop
                    } else if st.gapless_key.is_some() {
                        None // mpv auto-advances; the StartFile promotes
                    } else if st.xfade_key.is_some() && !st.fading {
                        Some("promote")
                    } else if st.fading {
                        // The INCOMING deck itself hit EOF mid-fade (track
                        // shorter than the fade): the session is over — snap
                        // the fade bookkeeping, then end.
                        Some("ended-mid-fade")
                    } else {
                        Some("ended")
                    }
                };
                match action {
                    Some("promote") => {
                        // Fade trigger never arrived — hard-cut into the arm.
                        if let Some(engine) = engine.upgrade() {
                            engine.promote_xfade_cut();
                        }
                    }
                    Some(ended @ ("ended" | "ended-mid-fade")) => {
                        if let Some(engine) = engine.upgrade() {
                            if ended == "ended-mid-fade" {
                                engine.snap_finish_fade();
                            }
                            // Don't leave a stale last frame in the hole.
                            engine.set_video_layer_visible(false);
                        }
                        let key = state.lock().unwrap().current_key.take();
                        if let Some(key) = key {
                            sink("engine-ended", json!({ "trackKey": key }));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::PropertyChange { name, change, .. }) => {
                use api::PropertyData;
                match (name.as_str(), change) {
                    ("time-pos", PropertyData::Double(pos)) => {
                        if last_position_emit.elapsed() >= POSITION_EMIT_INTERVAL {
                            let st = state.lock().unwrap();
                            if deck == st.active {
                                if let Some(key) = st.current_key.as_ref() {
                                    last_position_emit = Instant::now();
                                    sink(
                                        "engine-position",
                                        json!({
                                            "trackKey": key,
                                            "positionSecs": pos,
                                            "durationSecs": st.duration,
                                        }),
                                    );
                                }
                            }
                        }
                    }
                    ("duration", PropertyData::Double(dur)) => {
                        let key = {
                            let mut st = state.lock().unwrap();
                            if deck != st.active {
                                None
                            } else {
                                st.duration = Some(dur);
                                st.current_key.clone()
                            }
                        };
                        if let Some(key) = key {
                            sink(
                                "engine-duration",
                                json!({ "trackKey": key, "durationSecs": dur }),
                            );
                        }
                    }
                    ("pause", PropertyData::Flag(paused)) => {
                        let key = {
                            let st = state.lock().unwrap();
                            if deck != st.active { None } else { st.current_key.clone() }
                        };
                        if key.is_some() {
                            sink(
                                "engine-state",
                                json!({ "playing": !paused, "trackKey": key }),
                            );
                        }
                    }
                    ("media-title", PropertyData::Str(title)) => {
                        // ICY StreamTitle updates for live radio streams. Local
                        // files also emit this once (their tag title) — the
                        // frontend drops titles equal to the track's own.
                        let key = {
                            let st = state.lock().unwrap();
                            if deck != st.active { None } else { st.current_key.clone() }
                        };
                        if let Some(key) = key {
                            sink(
                                "engine-icy-title",
                                json!({ "trackKey": key, "title": title }),
                            );
                        }
                    }
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(e) => {
                // Decode/load failures surface here (EndFile with an error
                // reason is mapped to Err by api::Mpv::wait_event).
                let (kind, key) = {
                    let mut st = state.lock().unwrap();
                    if deck == st.active {
                        st.gapless_key = None;
                        ("active", st.current_key.take())
                    } else {
                        // Standby arming failure — report the armed key so the
                        // frontend can blocklist and disarm it.
                        st.expecting_start[deck] = false;
                        ("standby", st.xfade_key.take())
                    }
                };
                if let Some(key) = key {
                    sink(
                        "engine-error",
                        json!({
                            "trackKey": key,
                            "code": "decode",
                            "message": e.to_string(),
                        }),
                    );
                } else {
                    log::error!("mpv-engine: {kind} deck event error with no owning track: {e}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::mpsc;

    /// Write a WAV of `secs` seconds of silence (44.1 kHz, mono, 16-bit).
    fn write_wav(path: &std::path::Path, secs: f64) {
        let sample_rate = 44100u32;
        let samples = (secs * sample_rate as f64) as u32;
        let data_len = samples * 2;
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + data_len).to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap(); // PCM
        f.write_all(&1u16.to_le_bytes()).unwrap(); // mono
        f.write_all(&sample_rate.to_le_bytes()).unwrap();
        f.write_all(&(sample_rate * 2).to_le_bytes()).unwrap();
        f.write_all(&2u16.to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_len.to_le_bytes()).unwrap();
        f.write_all(&vec![0u8; data_len as usize]).unwrap();
    }

    fn collect_events() -> (EventSink, mpsc::Receiver<(String, serde_json::Value)>) {
        let (tx, rx) = mpsc::channel();
        let sink: EventSink = Arc::new(move |event, payload| {
            eprintln!("[engine-test] {event}: {payload}");
            let _ = tx.send((event.to_string(), payload));
        });
        (sink, rx)
    }

    /// None (test skipped) when no libmpv is resolvable — plain `cargo test`
    /// must stay green on machines without vendored/downloaded artifacts.
    fn try_test_engine(sink: EventSink) -> Option<Arc<Engine>> {
        if !api::libmpv_available() {
            eprintln!(
                "[engine-test] SKIPPED — libmpv not available (run `node scripts/fetch-libmpv.mjs`)"
            );
            return None;
        }
        Some(Engine::new(sink, Some("null"), None).expect("engine init"))
    }

    fn wait_for(
        rx: &mpsc::Receiver<(String, serde_json::Value)>,
        event: &str,
        timeout: Duration,
    ) -> serde_json::Value {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| panic!("timed out waiting for {event}"));
            let (name, payload) = rx
                .recv_timeout(remaining)
                .unwrap_or_else(|_| panic!("timed out waiting for {event}"));
            if name == event {
                return payload;
            }
        }
    }

    #[test]
    fn test_play_gapless_promote_and_ended() {
        let dir = tempfile::tempdir().unwrap();
        let wav_a = dir.path().join("a.wav");
        let wav_b = dir.path().join("b.wav");
        write_wav(&wav_a, 0.4);
        write_wav(&wav_b, 0.4);

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };

        engine
            .play(wav_a.to_str().unwrap(), "trk:a", None, 1.0, false, false)
            .expect("play");
        engine
            .preload(wav_b.to_str().unwrap(), "trk:b", false)
            .expect("preload");

        // Track A finishes -> gapless promotion of B (no `engine-ended`).
        let changed = wait_for(&rx, "engine-track-changed", Duration::from_secs(10));
        assert_eq!(changed["trackKey"], "trk:b");
        assert_eq!(changed["reason"], "gapless");

        // Track B finishes with nothing armed -> ended.
        let ended = wait_for(&rx, "engine-ended", Duration::from_secs(10));
        assert_eq!(ended["trackKey"], "trk:b");
    }

    #[test]
    fn test_crossfade_transition() {
        let dir = tempfile::tempdir().unwrap();
        let wav_a = dir.path().join("a.wav");
        let wav_b = dir.path().join("b.wav");
        write_wav(&wav_a, 1.5);
        write_wav(&wav_b, 0.5);

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };

        engine
            .play(wav_a.to_str().unwrap(), "trk:a", None, 1.0, false, false)
            .expect("play");
        engine
            .preload(wav_b.to_str().unwrap(), "trk:b", true)
            .expect("crossfade preload");
        // The arm must leave the standby deck paused at the start of B.
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(engine.decks[1].mpv.get_property::<bool>("pause"), Ok(true), "standby deck must arm paused");
        engine.start_crossfade(0.2).expect("start crossfade");

        let changed = wait_for(&rx, "engine-track-changed", Duration::from_secs(10));
        assert_eq!(changed["trackKey"], "trk:b");
        assert_eq!(changed["reason"], "crossfade");

        // B plays out and ends (nothing armed after it).
        let ended = wait_for(&rx, "engine-ended", Duration::from_secs(10));
        assert_eq!(ended["trackKey"], "trk:b");
    }

    #[test]
    fn test_eof_with_crossfade_arm_promotes_hard_cut() {
        let dir = tempfile::tempdir().unwrap();
        let wav_a = dir.path().join("a.wav");
        let wav_b = dir.path().join("b.wav");
        write_wav(&wav_a, 0.4);
        write_wav(&wav_b, 0.4);

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };

        engine
            .play(wav_a.to_str().unwrap(), "trk:a", None, 1.0, false, false)
            .expect("play");
        engine
            .preload(wav_b.to_str().unwrap(), "trk:b", true)
            .expect("crossfade preload");
        // Never trigger the fade — A reaches EOF and the safety net cuts to B.
        let changed = wait_for(&rx, "engine-track-changed", Duration::from_secs(10));
        assert_eq!(changed["trackKey"], "trk:b");
        assert_eq!(changed["reason"], "gapless");

        let ended = wait_for(&rx, "engine-ended", Duration::from_secs(10));
        assert_eq!(ended["trackKey"], "trk:b");
    }

    #[test]
    fn test_eq_graph_is_accepted_by_real_mpv() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("a.wav");
        write_wav(&wav, 0.4);

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };

        // Full advanced chain + pre-gain: the af property rejects invalid
        // graphs, and playback to EOF proves the graph actually runs.
        engine
            .apply_eq(&EqParams {
                enabled: true,
                mode: "advanced".into(),
                gains: vec![4.0, 3.0, 2.0, 0.0, -2.0, -1.0, 1.0, 3.0, 4.0, 5.0],
                pre_gain_db: -2.0,
                bass_db: 0.0,
                treble_db: 0.0,
            })
            .expect("advanced EQ af graph");
        engine
            .apply_replaygain(&ReplayGainParams { mode: "track".into(), preamp_db: 3.0, prevent_clip: true })
            .expect("replaygain options");
        engine
            .play(wav.to_str().unwrap(), "trk:eq", None, 0.8, false, false)
            .expect("play with EQ");
        let ended = wait_for(&rx, "engine-ended", Duration::from_secs(10));
        assert_eq!(ended["trackKey"], "trk:eq");

        // Simple mode with boost engages the limiter — must also be valid.
        engine
            .apply_eq(&EqParams {
                enabled: true,
                mode: "simple".into(),
                gains: vec![0.0; 10],
                pre_gain_db: 0.0,
                bass_db: 5.0,
                treble_db: -2.0,
            })
            .expect("simple EQ af graph");
    }

    #[test]
    fn test_exclusive_mode_forces_gapless_arming() {
        let dir = tempfile::tempdir().unwrap();
        let wav_a = dir.path().join("a.wav");
        let wav_b = dir.path().join("b.wav");
        write_wav(&wav_a, 0.6);
        write_wav(&wav_b, 0.4);

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.apply_audio_exclusive(true).expect("exclusive");

        engine
            .play(wav_a.to_str().unwrap(), "trk:a", None, 1.0, false, false)
            .expect("play");
        // Crossfade requested, but exclusive mode must arm same-deck gapless
        // (the standby deck can't open an exclusively-held device).
        engine
            .preload(wav_b.to_str().unwrap(), "trk:b", true)
            .expect("preload");
        {
            let st = engine.state.lock().unwrap();
            assert_eq!(st.gapless_key.as_deref(), Some("trk:b"), "expected gapless arm");
            assert!(st.xfade_key.is_none(), "standby deck must not be armed in exclusive mode");
        }

        let changed = wait_for(&rx, "engine-track-changed", Duration::from_secs(10));
        assert_eq!(changed["reason"], "gapless");
        let ended = wait_for(&rx, "engine-ended", Duration::from_secs(10));
        assert_eq!(ended["trackKey"], "trk:b");
    }

    /// Export the macOS system trust store as PEM (mirrors ensure_ca_bundle,
    /// which needs an AppHandle the tests don't have).
    fn test_ca_bundle(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("cacert.pem");
        let out = std::process::Command::new("/usr/bin/security")
            .args([
                "find-certificate",
                "-a",
                "-p",
                "/System/Library/Keychains/SystemRootCertificates.keychain",
            ])
            .output()
            .expect("export system CA store");
        std::fs::write(&path, &out.stdout).unwrap();
        path
    }

    /// Network-dependent — run explicitly:
    /// `cargo test --features mpv-engine test_https_file -- --ignored --nocapture`
    /// Proves mpv's https/TLS stack works by playing a remote file to EOF.
    #[test]
    #[ignore]
    fn test_https_file_playback_and_audio_info() {
        let dir = tempfile::tempdir().unwrap();
        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.set_tls_ca_file(&test_ca_bundle(dir.path())).expect("tls ca");
        engine
            .play(
                "https://github.com/anars/blank-audio/raw/master/2-seconds-of-silence.mp3",
                "trk:https",
                None,
                0.5,
                false,
                false,
            )
            .expect("play https file");
        let pos = wait_for(&rx, "engine-position", Duration::from_secs(30));
        assert_eq!(pos["trackKey"], "trk:https");
        let info = engine.audio_info().expect("audio info");
        eprintln!("[https-test] info: {info:?}");
        assert!(info.codec.is_some());
        let ended = wait_for(&rx, "engine-ended", Duration::from_secs(30));
        assert_eq!(ended["trackKey"], "trk:https");
    }

    /// Network-dependent — run explicitly:
    /// `cargo test --features mpv-engine test_live_radio -- --ignored --nocapture`
    /// Plays a public Icecast stream and asserts ICY titles + live audio info.
    #[test]
    #[ignore]
    fn test_live_radio_stream_icy_and_audio_info() {
        let dir = tempfile::tempdir().unwrap();
        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.set_tls_ca_file(&test_ca_bundle(dir.path())).expect("tls ca");
        engine
            .play("https://ice1.somafm.com/groovesalad-128-mp3", "trk:radio", None, 0.5, false, false)
            .expect("play stream");

        // Position events prove the stream is decoding.
        let pos = wait_for(&rx, "engine-position", Duration::from_secs(30));
        assert_eq!(pos["trackKey"], "trk:radio");

        // ICY StreamTitle surfaces via media-title.
        let icy = wait_for(&rx, "engine-icy-title", Duration::from_secs(30));
        assert_eq!(icy["trackKey"], "trk:radio");
        let title = icy["title"].as_str().unwrap_or_default();
        eprintln!("[radio-test] ICY title: {title}");
        assert!(!title.is_empty());

        // Live decode facts for a stream no tag reader could inspect.
        let info = engine.audio_info().expect("audio info");
        eprintln!("[radio-test] info: {info:?}");
        assert_eq!(info.codec.as_deref(), Some("mp3"));
        assert!(info.sample_rate.unwrap_or(0) > 0);

        engine.stop().expect("stop");
    }

    #[test]
    fn test_bad_file_emits_engine_error() {
        let dir = tempfile::tempdir().unwrap();
        let bogus = dir.path().join("not-audio.wav");
        std::fs::write(&bogus, b"this is not audio data at all").unwrap();

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine
            .play(bogus.to_str().unwrap(), "trk:bad", None, 1.0, false, false)
            .expect("play command itself should be accepted");

        let err = wait_for(&rx, "engine-error", Duration::from_secs(10));
        assert_eq!(err["trackKey"], "trk:bad");
    }
}
