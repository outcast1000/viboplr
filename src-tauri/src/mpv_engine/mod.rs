//! Native playback engine backed by libmpv.
//!
//! Compiled into every build; libmpv itself is loaded at runtime (`ffi.rs`) —
//! from the bundled Frameworks dir (Full build), the downloadable engine
//! component (`component.rs`), the dev vendor dir, or a system install. When
//! no library is available, `engine_capabilities` reports `mpv: false`; this
//! is the only playback path, so playback is unavailable and the frontend
//! shows the recovery path (install the engine component).
//!
//! Audio-only (`vo=null`, `video=no`), built around **two decks** (libmpv
//! handles) in a ping-pong arrangement:
//!
//! - **Gapless** (crossfade off): the next track is appended to the *active*
//!   deck's playlist; mpv transitions sample-accurately and the following
//!   `StartFile` promotes the armed key.
//! - **Crossfade** (crossfade on): the next track is loaded *paused* on the
//!   standby deck; `start_crossfade` swaps roles and a ramp thread fades the
//!   deck volumes (linear in gain). If the active
//!   track reaches EOF before the fade was triggered, the armed deck is
//!   promoted with a hard cut as a safety net.
//!
//! EQ maps to one ffmpeg `lavfi` graph (see `af.rs`), ReplayGain to mpv's
//! native `replaygain*` options — both applied to both decks, and cached on
//! `EngineHandle` so settings set before the engine exists apply at creation.
//!
//! Event contract (all payloads carry `track_key` so the frontend can drop
//! stale events from a superseded play, the frontend's play-generation guard):
//! `engine-position` (~4 Hz while playing), `engine-duration`,
//! `engine-track-changed {reason}`, `engine-ended`, `engine-state`,
//! `engine-error {code}`, `engine-buffer` (demuxer cache state — see
//! `BufferSnapshot`), `engine-level` (live per-channel peak/RMS, only while
//! the meter is on — see `meter.rs`).
//!
//! Every deck also captures a per-second waveform of what it decodes
//! (`wave_capture.rs`), read back on request with `wave_snapshot` — how a
//! stream gets a seek-bar waveform without a second download.

mod af;
mod api;
pub mod output;
pub mod component;
pub mod ffi;
mod http_headers;
mod meter;
mod wave_capture;
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
use meter::{af_chain, meter_fingerprint, parse_meter, round_db, MeterFingerprint};
use api::{mpv_end_file_reason, Event, Format, Mpv};
use wave_capture::{parse_wave, WaveCaptures};
pub use wave_capture::WaveSnapshot;
use http_headers::mpv_http_header_lines;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

const POSITION_EMIT_INTERVAL: Duration = Duration::from_millis(240);
/// How often the demuxer cache is sampled. Deliberately its own clock rather
/// than a ride-along on the position tick: mpv keeps filling the cache while
/// **paused**, but stops emitting `time-pos` altogether, so a position-driven
/// poll froze the buffered edge for the whole pause — exactly when the user is
/// sitting there watching it fill.
const BUFFER_POLL_INTERVAL: Duration = Duration::from_millis(240);
const FADE_TICK: Duration = Duration::from_millis(30);
/// How often a busy pinned device is retried (see `EngineState::device_busy`).
const BUSY_RETRY_INTERVAL: Duration = Duration::from_secs(2);
/// `MPV_ERROR_AO_INIT_FAILED` — the audio output couldn't be opened.
const MPV_ERROR_AO_INIT_FAILED: i32 = -14;

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
    /// Playback rate. `Option` rather than `f64` because this struct derives
    /// `Default` and `f64::default()` is 0.0 — a speed of zero is not "unset",
    /// it's a stopped deck. None = never set, leave mpv's own default of 1.0.
    speed: Option<f64>,
    /// Bit-perfect mode: pinned output device. While set, the engine overlays
    /// neutral values (no EQ/ReplayGain, speed 1, volume 100%, exclusive) on
    /// top of the settings above, which are kept so turning it off restores
    /// them exactly. See `output.rs`.
    bit_perfect: Option<output::DevicePin>,
    /// The level meter (`meter.rs`): on while some consumer is subscribed.
    meter: bool,
}

/// Live media-stream facts read off the active deck — what's actually being
/// decoded, which works for remote streams (and video) where tag-based readers
/// can't. The video fields are `None` for audio-only playback.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineMediaInfo {
    // Audio.
    pub codec: Option<String>,
    pub sample_rate: Option<i64>,
    /// mpv sample format string (e.g. "s16", "s32", "floatp").
    pub format: Option<String>,
    /// Instantaneous audio bitrate in bits/s (VBR streams fluctuate).
    pub bitrate: Option<f64>,
    // Video (None for audio-only playback).
    /// Short video codec name (mpv `video-format`, e.g. "h264", "vp9", "av1").
    pub video_codec: Option<String>,
    /// Decoded frame width / height in pixels.
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// Instantaneous video bitrate in bits/s.
    pub video_bitrate: Option<f64>,
    /// Nominal container frame rate.
    pub fps: Option<f64>,
}

/// What the active deck's demuxer cache is holding right now. Only really
/// moves for network sources — a local file's cache saturates and then reports
/// the same numbers forever, which the emit guard turns into silence.
#[derive(Clone, Copy, Debug, PartialEq)]
struct BufferSnapshot {
    /// mpv `paused-for-cache`: playback is halted waiting for data.
    paused_for_cache: bool,
    /// mpv `demuxer-cache-time`: absolute track position the cache reaches.
    cache_end_secs: Option<f64>,
    /// mpv `demuxer-cache-duration`: readahead beyond the play position.
    readahead_secs: Option<f64>,
}

/// Coarse identity of a snapshot — the emit guard's comparison key, quantized
/// per field to the granularity that field is actually *displayed* at. Without
/// this the position tick would emit a redundant event 4× a second for every
/// network track whose cache has settled.
type BufferFingerprint = (bool, Option<i64>, Option<i64>);

fn buffer_fingerprint(s: &BufferSnapshot) -> BufferFingerprint {
    (
        s.paused_for_cache,
        // Drives the seek bar's buffered edge: half a second is well under a
        // pixel of movement on any sane bar width.
        s.cache_end_secs.map(|v| (v * 2.0).round() as i64),
        // Readahead is only ever *shown* while stalled (it's the number in the
        // buffering chip), so let it drive emits only then. Outside a stall it
        // changes continuously and nobody can see it, so including it
        // unconditionally would re-emit on every tick of every network track.
        s.paused_for_cache
            .then(|| s.readahead_secs.map(|v| (v * 10.0).round() as i64))
            .flatten(),
    )
}

/// Read the cache properties off a deck, or `None` when the source isn't a
/// network stream.
///
/// The network gate is load-bearing, not a nicety. mpv keeps a *bounded*
/// demuxer readahead for local files too — a few tens of seconds, not the
/// whole file — so a five-minute FLAC on the user's own disk reports a cache
/// that ends barely past the playhead. Reporting that would dim most of its
/// seek bar as "not downloaded yet", which is the exact opposite of true.
///
/// Everything past the gate is optional: a source or an mpv build that doesn't
/// report a given property yields `None` (or, for the stall flag, "not
/// stalled"), never an error the caller has to handle.
///
/// **Split streams describe the video only.** These properties read the *main*
/// demuxer and never aggregate with an external `audio-file` track — measured,
/// not assumed: attaching a 3 KB/s starved stream as external audio reported
/// `demuxer-cache-time` as `None` throughout, while the identical stream as the
/// main file produced a full stall trace (`probe_split_stream_buffer_attribution`).
/// So for a YouTube ≥720p play (video-only + audio-only, see `play`'s
/// `audio_url`) the readout describes the **video** stream. That is coherent
/// with where it is rendered — the seek bar it decorates *is* the video
/// timeline — but an audio-side underrun with healthy video is a gap: the
/// number would stay reassuring, or the chip may not appear at all. It is a
/// missing signal rather than a wrong one, which is why the readout is kept
/// rather than suppressed for split sources.
fn read_buffer_snapshot(mpv: &Mpv) -> Option<BufferSnapshot> {
    if !mpv.get_property::<bool>("demuxer-via-network").unwrap_or(false) {
        return None;
    }
    let finite = |v: f64| v.is_finite().then_some(v);
    let paused_for_cache = mpv.get_property::<bool>("paused-for-cache").unwrap_or(false);
    Some(BufferSnapshot {
        paused_for_cache,
        cache_end_secs: mpv.get_property::<f64>("demuxer-cache-time").ok().and_then(finite),
        readahead_secs: mpv
            .get_property::<f64>("demuxer-cache-duration")
            .ok()
            .and_then(finite)
            .filter(|v| *v >= 0.0),
    })
}

#[derive(Default)]
pub struct EngineHandle {
    inner: Mutex<Option<Arc<Engine>>>,
    /// DSP settings survive here while the engine isn't running (e.g. set from
    /// Settings before the first native play) and are applied at creation.
    pending_dsp: Mutex<DspSettings>,
}

impl EngineHandle {
    /// Lazily create the engine on first use so the app doesn't open an audio
    /// device until something actually plays.
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
        // A meter that can't be built must not cost the engine (apply_meter
        // reverts to the EQ-only chain on failure).
        if dsp.meter {
            if let Err(e) = engine.apply_meter(true, &dsp.eq) {
                log::error!("mpv-engine: level meter unavailable: {e}");
                self.pending_dsp.lock().unwrap().meter = false;
            }
        }
        engine.apply_replaygain(&dsp.rg)?;
        engine.apply_audio_exclusive(dsp.exclusive)?;
        if let Some(ref bg) = dsp.video_bg {
            engine.apply_video_background(bg);
        }
        if let Some(speed) = dsp.speed {
            engine.apply_speed(speed)?;
        }
        // Give the static-OpenSSL TLS stack a CA store (see set_tls_ca_file).
        // On failure we log and leave verification ON — https sources then
        // fail closed with an engine error.
        match ca_bundle {
            Some(ca) => {
                if let Err(e) = engine.set_tls_ca_file(&ca) {
                    log::error!("mpv-engine: {e}");
                }
            }
            None => log::error!("mpv-engine: no CA bundle available; https sources will fail verification"),
        }
        if let Some(ref pin) = dsp.bit_perfect {
            engine.apply_bit_perfect(Some(pin), &dsp)?;
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

    /// Level meter on/off. The frontend ref-counts its consumers and sends only
    /// the transitions; cached like EQ, since the af chain carries both.
    pub fn set_meter(&self, enabled: bool) -> Result<(), String> {
        let eq = {
            let mut dsp = self.pending_dsp.lock().unwrap();
            dsp.meter = enabled;
            dsp.eq.clone()
        };
        let result = match self.get() {
            Some(engine) => engine.apply_meter(enabled, &eq),
            None => Ok(()),
        };
        if result.is_err() {
            // Not wanted after all: a later engine creation mustn't retry it.
            self.pending_dsp.lock().unwrap().meter = false;
        }
        result
    }

    pub fn set_replaygain(&self, rg: ReplayGainParams) -> Result<(), String> {
        self.pending_dsp.lock().unwrap().rg = rg.clone();
        match self.get() {
            Some(engine) => engine.apply_replaygain(&rg),
            None => Ok(()),
        }
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        self.pending_dsp.lock().unwrap().speed = Some(speed);
        match self.get() {
            Some(engine) => engine.apply_speed(speed),
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

    /// Bit-perfect mode on (pinned to `pin`) or off. Cached like the other DSP
    /// settings; applied at creation when the engine isn't running yet.
    pub fn set_bit_perfect(&self, pin: Option<output::DevicePin>) -> Result<(), String> {
        let dsp = {
            let mut dsp = self.pending_dsp.lock().unwrap();
            dsp.bit_perfect = pin.clone();
            dsp.clone()
        };
        match self.get() {
            Some(engine) => engine.apply_bit_perfect(pin.as_ref(), &dsp),
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

/// A PEM CA bundle for mpv's statically-linked OpenSSL. Returns None (and
/// https stays fail-closed) on any error.
///
/// macOS: the OS trust store with its trust settings applied, shared with
/// yt-dlp and rebuilt each run (`trust_store`). It used to be Apple's roots
/// only (`SystemRootCertificates.keychain`), which leaves out the root a
/// network that inspects HTTPS signs with — its administrator installs that
/// into the admin trust settings — so every https stream failed there.
/// Windows: the LocalMachine Root store, exported once and cached 30 days.
fn ensure_ca_bundle(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok()?;
    #[cfg(target_os = "macos")]
    {
        return crate::trust_store::pem_path(&dir);
    }
    #[cfg(not(target_os = "macos"))]
    {
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
    /// Bit-perfect mode's pinned device (see `DspSettings::bit_perfect`).
    bit_perfect: Option<output::DevicePin>,
    /// Bumped on every bit-perfect toggle; a watchdog whose generation is stale exits.
    bit_perfect_gen: u64,
    /// The level meter is wanted (see `DspSettings::meter`). Bit-perfect mode
    /// suspends it without clearing this, like the EQ it rides beside.
    meter: bool,
    /// The waveform capture filter is in the `af` chain (`wave_capture.rs`).
    /// Set at creation when the loaded FFmpeg can build it; like the meter it
    /// is off in bit-perfect mode, so no capture there ever completes.
    wave_capture: bool,
    /// What the active deck was asked to load for the current track (URL +
    /// external audio track) — what a busy-device retry reloads.
    current_load: Option<(String, Option<String>)>,
    /// URL of the gapless arm, promoted into `current_load` at the transition.
    gapless_url: Option<String>,
    /// Last position reported for the current track (at the 4 Hz emit rate).
    last_pos: f64,
    /// Bit-perfect only: the pinned device refused to open because another
    /// process holds it exclusively (WASAPI fails the open outright, where
    /// CoreAudio stalls). Holds the time of the last attempt; the current
    /// track is kept and the output watchdog reloads it at `last_pos` every
    /// `BUSY_RETRY_INTERVAL` until the device opens.
    device_busy: Option<Instant>,
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
    /// Per-deck waveform captures, fed by each deck's event loop.
    waves: Arc<Mutex<WaveCaptures>>,
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
                init.set_property("audio-client-name", "Vibo")?;
                // Let `speed` shift pitch as well as tempo. mpv defaults this to
                // yes, which inserts scaletempo and holds the original pitch —
                // correct for an audiobook, wrong for a deck. A turntable
                // resamples: 45 on a 33 pressing plays faster AND higher, and
                // that IS the effect. Harmless at the default speed of 1.0.
                init.set_property("audio-pitch-correction", false)?;
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
            waves: Arc::new(Mutex::new(WaveCaptures::default())),
            sink,
            app,
            #[cfg(any(target_os = "macos", windows))]
            video: Mutex::new(None),
        });
        for i in 0..2 {
            engine.spawn_event_thread(i)?;
        }
        engine.enable_wave_capture();
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
                video_layer::run_render_loop(
                    render_state,
                    glctx,
                    cgl,
                    |width, height| rctx.render(0, width, height, true).map_err(|e| e.to_string()),
                    || rctx.report_swap(),
                );
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
        // Buffer state, observed best-effort: an mpv build that doesn't carry
        // one of these must lose the buffer readout, not the whole engine.
        // Both change rarely (only when the cache underruns), so observing them
        // costs nothing during healthy playback.
        //
        // `cache-buffering-state`'s *value* is deliberately unused — it reads a
        // near-constant 0 through a real stall, because mpv unpauses the moment
        // it has ~1s of data and so is only ever "buffering" while the cache is
        // near empty (confirmed against a throttled HTTP source). It's observed
        // purely as a **wake-up**, so a stall reaches the UI without waiting
        // out the poll interval.
        for (name, format, id) in [
            ("paused-for-cache", Format::Flag, 5u64),
            ("cache-buffering-state", Format::Int64, 6u64),
        ] {
            if let Err(e) = client.observe_property(name, format, id) {
                log::warn!("mpv-engine: cannot observe {name} (no buffer readout): {e}");
            }
        }
        // Whether a video output exists — gates the see-through hole (see the
        // PlaybackRestart handler). Best-effort: without it, a video output
        // that comes up only after playback restarted is never revealed.
        if let Err(e) = client.observe_property("vo-configured", Format::Flag, 7) {
            log::warn!("mpv-engine: cannot observe vo-configured: {e}");
        }

        let state = self.state.clone();
        let waves = self.waves.clone();
        let sink = self.sink.clone();
        let weak = Arc::downgrade(self);
        std::thread::Builder::new()
            .name(format!("mpv-engine-events-{deck}"))
            .spawn(move || run_event_loop(client, deck, weak, state, waves, sink))
            .map_err(|e| format!("failed to spawn mpv event thread: {e}"))?;
        Ok(())
    }

    /// The linear amplitude a deck should play at: the user's 0..1 volume, or
    /// silence while muted. This — not mpv's property value — is the quantity
    /// the crossfade ramps, so a fade is linear in amplitude
    /// (`gain = vol * progress`).
    fn out_gain(volume: f64, muted: bool) -> f64 {
        if muted { 0.0 } else { volume.clamp(0.0, 1.0) }
    }

    /// Linear gain (0..1) → mpv's `volume` property.
    ///
    /// mpv's `volume` is **not** a linear gain: it cubes it internally
    /// (`gain = (volume/100)³`, inherited from mplayer's softvol curve), while
    /// the app's volume slider is linear amplitude. Passing the slider straight
    /// through therefore put its 30% at 0.3³ = 2.7% gain (-31 dB) — audible as
    /// "everything below a third is silent". Sending the cube root makes mpv's
    /// cube hand back the gain that was asked for.
    fn mpv_volume(gain: f64) -> f64 {
        // One decimal: an integer step near the top of the cube root is ~3% of
        // gain, which is a coarse jump for a slider drag.
        (gain.clamp(0.0, 1.0).cbrt() * 1000.0).round() / 10.0
    }

    fn out_volume(volume: f64, muted: bool) -> f64 {
        Self::mpv_volume(Self::out_gain(volume, muted))
    }

    /// The user volume the decks actually play at: full scale in bit-perfect
    /// mode (mpv's volume is softvol — any attenuation rewrites the samples),
    /// the user's own otherwise. `st.volume` always keeps the user's value.
    fn effective_volume(st: &EngineState) -> f64 {
        if st.bit_perfect.is_some() { 1.0 } else { st.volume }
    }

    /// mpv `volume` for the current state (user volume, mute, bit-perfect).
    fn deck_volume(st: &EngineState) -> f64 {
        Self::out_volume(Self::effective_volume(st), st.muted)
    }

    #[cfg(test)]
    pub fn play(
        self: &Arc<Self>,
        url: &str,
        audio_url: Option<&str>,
        track_key: &str,
        seek_secs: Option<f64>,
        volume: f64,
        muted: bool,
        video: bool,
    ) -> Result<(), String> {
        self.play_with_headers(url, audio_url, None, track_key, seek_secs, volume, muted, video)
    }

    pub fn play_with_headers(
        self: &Arc<Self>,
        url: &str,
        audio_url: Option<&str>,
        headers: Option<&HashMap<String, String>>,
        track_key: &str,
        seek_secs: Option<f64>,
        volume: f64,
        muted: bool,
        video: bool,
    ) -> Result<(), String> {
        log::info!("mpv-engine: play key={track_key} video={video} audio_track={} url_scheme={}", audio_url.is_some(), url.split(':').next().unwrap_or("(path)"));
        if video {
            #[cfg(any(target_os = "macos", windows))]
            self.ensure_video_layer()?;
            #[cfg(not(any(target_os = "macos", windows)))]
            return Err("native video is not supported on this platform".into());
        }
        self.snap_finish_fade();
        let (active, drop_standby, out) = {
            let mut st = self.state.lock().unwrap();
            st.volume = volume;
            st.muted = muted;
            let out = Self::deck_volume(&st);
            st.current_key = Some(track_key.to_string());
            st.gapless_key = None;
            st.gapless_url = None;
            st.current_load = Some((url.to_string(), audio_url.map(str::to_string)));
            st.last_pos = seek_secs.unwrap_or(0.0);
            st.device_busy = None;
            let had_xfade = st.xfade_key.take().is_some();
            // Video renders through deck 0's render context only.
            if video {
                st.active = 0;
            }
            let active = st.active;
            st.expecting_start[active] = true;
            st.pending_seek = seek_secs.filter(|s| *s > 0.1);
            st.duration = None;
            (active, had_xfade || video, out)
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
        deck.set_property("volume", out)
            .and_then(|_| deck.set_property("mute", muted))
            .and_then(|_| self.decks[standby].mpv.set_property("mute", muted))
            .map_err(|e| format!("mpv volume failed: {e}"))?;
        deck.set_property("pause", false)
            .map_err(|e| format!("mpv unpause failed: {e}"))?;
        Self::apply_http_headers(deck, headers)
            .map_err(|e| format!("mpv request-header setup failed: {e}"))?;
        // Hi-res sources (e.g. YouTube ≥720p) only offer split video-only +
        // audio-only streams; attach the audio via mpv's per-file `audio-file`
        // option so mpv muxes them at playback. loadfile's options field is the
        // 4th positional arg (mpv ≥ 0.38 — present in the pinned build); the
        // index arg ("0") is ignored for the "replace" action. The URL is
        // length-escaped (`%<bytes>%<value>`) so commas / query chars in it
        // aren't misparsed as option separators.
        let load = match audio_url {
            Some(audio) => {
                let opt = format!("audio-file=%{}%{}", audio.len(), audio);
                deck.command("loadfile", &[url, "replace", "0", &opt])
            }
            None => deck.command("loadfile", &[url, "replace"]),
        };
        load.map_err(|e| format!("mpv loadfile failed: {e}"))?;
        log::info!("mpv-engine: loadfile accepted on deck {active}");
        Ok(())
    }

    /// Set a deck's request headers for the file it is about to open.
    ///
    /// One `change-list` op per header, never a delimited property write — see
    /// http_headers.rs for the malformed requests that produced. `clr` first
    /// because appends accumulate: without it the previous track's signed
    /// User-Agent would ride along on this one's request.
    fn apply_http_headers(
        deck: &api::Mpv,
        headers: Option<&HashMap<String, String>>,
    ) -> api::Result<()> {
        deck.command("change-list", &["http-header-fields", "clr", ""])?;
        for line in mpv_http_header_lines(headers) {
            deck.command("change-list", &["http-header-fields", "append", &line])?;
        }
        Ok(())
    }

    /// Arm the next track. `crossfade` picks the transition machinery: standby
    /// deck (fade / hard-cut safety net) vs. active-deck playlist (gapless).
    /// Exclusive mode forces gapless — the standby deck can't open the device.
    ///
    /// `headers` must be applied here for the same reason `play` applies them:
    /// a signed CDN URL is bound to the User-Agent that minted it, so arming one
    /// without its headers loads it under the *previous* track's headers and the
    /// host sees a 403 (see http_headers.rs). Preload used to drop them, which
    /// made every armed yt-dlp track refuse and fall back to a re-resolve.
    pub fn preload(
        &self,
        url: &str,
        headers: Option<&HashMap<String, String>>,
        track_key: &str,
        crossfade: bool,
    ) -> Result<(), String> {
        let crossfade = crossfade && !self.state.lock().unwrap().exclusive;
        self.clear_preload()?;
        if crossfade {
            // A fade may still own the standby deck: a track shorter than the
            // preload lead arms its successor moments after its own fade
            // started, and that fade's completion `stop`s the standby deck —
            // silently unloading the armed file, while `xfade_key` and the
            // frontend's arm both stay set. The eventual promotion then
            // unpauses an empty deck: track-changed and playing=true fire, but
            // nothing plays and nothing ever ends. Finish the fade before
            // arming, the same way `play_with_headers` does — an armed standby
            // deck must never also be owned by a fade thread. (A ramp tick
            // already past its staleness check can still write one stale
            // volume here; harmless — the deck is paused and start_crossfade
            // re-zeros the incoming volume before unpausing.)
            self.snap_finish_fade();
            let standby = {
                let mut st = self.state.lock().unwrap();
                let standby = 1 - st.active;
                st.expecting_start[standby] = true;
                st.xfade_key = Some(track_key.to_string());
                standby
            };
            let deck = &self.decks[standby].mpv;
            let armed = Self::apply_http_headers(deck, headers)
                .and_then(|_| deck.set_property("pause", true))
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
                st.gapless_url = Some(url.to_string());
                st.active
            };
            // Gapless appends to the deck that is already playing. Its current
            // file is open, so re-setting the header list here only affects the
            // entry being armed — which is the one that needs these headers.
            let deck = &self.decks[active].mpv;
            let armed = Self::apply_http_headers(deck, headers)
                .and_then(|_| deck.command("loadfile", &[url, "append"]));
            if let Err(e) = armed {
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

        // Track state swaps at fade START, so the UI shows the incoming track
        // as soon as it becomes audible.
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
                    let (gain, stale) = {
                        let st = engine.state.lock().unwrap();
                        (
                            Self::out_gain(Self::effective_volume(&st), st.muted),
                            !st.fading || st.fade_gen != fade_gen_captured,
                        )
                    };
                    if stale {
                        return; // snapped/superseded — cleanup already done
                    }
                    let t = (start.elapsed().as_millis() as f64 / fade_ms as f64).min(1.0);
                    // Ramp the *gain*, then convert. Scaling the property value
                    // instead would fade as t³ — the outgoing deck would drop
                    // to a tenth of its level a fifth of the way in.
                    let inc = Self::mpv_volume(gain * t);
                    let dec = Self::mpv_volume(gain * (1.0 - t));
                    let _ = engine.decks[new].mpv.set_property("volume", inc);
                    let _ = engine.decks[old].mpv.set_property("volume", dec);
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
                    Self::deck_volume(&st)
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
            (st.active, Self::deck_volume(&st))
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
            (new, key, Self::deck_volume(&st))
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
            st.current_load = None;
            st.device_busy = None;
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
        let (active, fading, out) = {
            let mut st = self.state.lock().unwrap();
            st.volume = volume;
            st.muted = muted;
            (st.active, st.fading, Self::deck_volume(&st))
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
                .set_property("volume", out)
                .map_err(|e| format!("mpv volume failed: {e}"))?;
        }
        Ok(())
    }

    /// The whole `af` chain: the waveform capture, the EQ graph, then the level
    /// meter when it's on. One writer for all three, so changing one can't drop
    /// another. Bit-perfect mode clears the chain entirely, so the meter and the
    /// capture are off there too (their flags are kept, and they come back with
    /// the mode off).
    pub fn apply_eq(&self, eq: &EqParams) -> Result<(), String> {
        let (bit_perfect, meter, capture) = {
            let st = self.state.lock().unwrap();
            (st.bit_perfect.is_some(), st.meter, st.wave_capture)
        };
        let af = if bit_perfect { String::new() } else { af_chain(&build_af_graph(eq), meter, capture) };
        for deck in &self.decks {
            deck.mpv
                .set_property("af", af.as_str())
                .map_err(|e| format!("mpv af (EQ / meter) failed: {e}"))?;
        }
        Ok(())
    }

    /// Level meter on/off: record the flag, then rebuild the af chain with the
    /// current EQ (which the engine doesn't keep, hence the parameter).
    ///
    /// Refused up front when the loaded libmpv's ffmpeg predates the astats
    /// options the filter uses (`meter::ffmpeg_supports_meter`). That check is
    /// load-bearing: mpv accepts an `af` whose lavfi graph it can't build and
    /// only fails when the chain is next initialized — the next track then
    /// plays no audio at all (measured: `engine-error` "no audio or video data
    /// played"), so a missing option would cost native playback, not just the
    /// meter. If mpv rejects the chain when it is set, the flag is dropped and
    /// the EQ-only chain restored before the error is returned; left set, every
    /// later EQ change would fail with it.
    pub fn apply_meter(&self, enabled: bool, eq: &EqParams) -> Result<(), String> {
        if enabled {
            let version = self.decks[0].mpv.get_property::<String>("ffmpeg-version").unwrap_or_default();
            if !meter::ffmpeg_supports_meter(&version) {
                return Err(format!("the level meter needs FFmpeg 4.4 or newer (this libmpv has {version:?})"));
            }
        }
        self.state.lock().unwrap().meter = enabled;
        let result = self.apply_eq(eq);
        if result.is_err() && enabled {
            self.state.lock().unwrap().meter = false;
            if let Err(e) = self.apply_eq(eq) {
                log::error!("mpv-engine: restoring the EQ after a failed meter: {e}");
            }
        }
        result
    }

    /// Put the waveform capture filter in the chain, once at creation. It is
    /// always on (not on request) because the frontend only learns it wants a
    /// capture after a cache miss and a lookup — seconds in, too late for one
    /// that must cover the whole track. Gated like the meter, whose astats
    /// options it shares: an `af` mpv can't build costs the next track its
    /// audio (see `apply_meter`). A refusal here leaves the chain empty.
    fn enable_wave_capture(&self) {
        let version = self.decks[0].mpv.get_property::<String>("ffmpeg-version").unwrap_or_default();
        if !meter::ffmpeg_supports_meter(&version) {
            log::warn!("mpv-engine: no waveform capture — it needs FFmpeg 4.4 or newer (this libmpv has {version:?})");
            return;
        }
        self.state.lock().unwrap().wave_capture = true;
        if let Err(e) = self.apply_eq(&EqParams::default()) {
            log::error!("mpv-engine: waveform capture unavailable: {e}");
            self.state.lock().unwrap().wave_capture = false;
            if let Err(e) = self.apply_eq(&EqParams::default()) {
                log::error!("mpv-engine: clearing the af chain after a failed capture: {e}");
            }
        }
    }

    /// What has been captured of `track_key`'s waveform so far — live on a
    /// deck, or recently finished.
    pub fn wave_snapshot(&self, track_key: &str) -> Option<WaveSnapshot> {
        self.waves.lock().unwrap().snapshot(track_key)
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

    /// Playback rate, applied to BOTH decks.
    ///
    /// Both, not just the active one: the idle deck is what gapless/crossfade
    /// preloads the next track into, and a deck left at 1.0 would snap back to
    /// normal speed the moment the track changed.
    ///
    /// Pitch rides along with tempo — see `audio-pitch-correction` at init. That
    /// is the whole point: a turntable resamples, so 45 on a 33 pressing is
    /// faster AND higher. mpv would otherwise time-stretch and hold the pitch,
    /// which is a useful thing but a different one.
    pub fn apply_speed(&self, speed: f64) -> Result<(), String> {
        // Speed resamples (pitch correction is off), so bit-perfect holds 1.0.
        let speed = if self.bit_perfect_on() { 1.0 } else { speed };
        for deck in &self.decks {
            deck.mpv
                .set_property("speed", speed)
                .map_err(|e| format!("mpv speed failed: {e}"))?;
        }
        Ok(())
    }

    pub fn apply_replaygain(&self, rg: &ReplayGainParams) -> Result<(), String> {
        let mode = if self.bit_perfect_on() { "no" } else { replaygain_mode_value(&rg.mode) };
        for deck in &self.decks {
            deck.mpv
                .set_property("replaygain", mode)
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
        let enabled = {
            let mut st = self.state.lock().unwrap();
            st.exclusive = enabled || st.bit_perfect.is_some();
            st.exclusive
        };
        for deck in &self.decks {
            deck.mpv
                .set_property("audio-exclusive", enabled)
                .map_err(|e| format!("mpv audio-exclusive failed: {e}"))?;
        }
        Ok(())
    }

    fn bit_perfect_on(&self) -> bool {
        self.state.lock().unwrap().bit_perfect.is_some()
    }

    /// For the output watchdog: the pin, current track key, active deck and
    /// whether the pinned device is busy — or None once the mode is off or
    /// `generation` has been superseded.
    fn bit_perfect_snapshot(&self, generation: u64) -> Option<output::Snapshot> {
        let st = self.state.lock().unwrap();
        if st.bit_perfect_gen != generation {
            return None;
        }
        st.bit_perfect.clone().map(|pin| output::Snapshot {
            pin,
            track_key: st.current_key.clone(),
            active: st.active,
            busy: st.device_busy.is_some(),
        })
    }

    /// Output watchdog: the pinned device opened, so it's no longer busy.
    fn clear_device_busy(&self) {
        self.state.lock().unwrap().device_busy = None;
    }

    /// Output watchdog: reload the current track at its last position when
    /// the pinned device was busy and `BUSY_RETRY_INTERVAL` has passed (or
    /// right away with `now`). A failure lands back in `is_busy_device_failure`.
    fn retry_busy_device(&self, now: bool) {
        let (active, url, audio_url) = {
            let mut st = self.state.lock().unwrap();
            let Some(last) = st.device_busy else { return };
            if !now && last.elapsed() < BUSY_RETRY_INTERVAL {
                return;
            }
            let (Some(_), Some((url, audio_url))) = (st.current_key.as_ref(), st.current_load.clone()) else {
                st.device_busy = None;
                return;
            };
            st.device_busy = Some(Instant::now());
            let active = st.active;
            st.expecting_start[active] = true;
            st.pending_seek = Some(st.last_pos).filter(|s| *s > 0.1);
            (active, url, audio_url)
        };
        let deck = &self.decks[active].mpv;
        let load = match audio_url {
            Some(audio) => {
                let opt = format!("audio-file=%{}%{}", audio.len(), audio);
                deck.command("loadfile", &[&url, "replace", "0", &opt])
            }
            None => deck.command("loadfile", &[&url, "replace"]),
        };
        if let Err(e) = load {
            log::error!("mpv-engine: busy-device retry loadfile failed: {e}");
        }
    }

    /// Turn bit-perfect mode on (pinned to `pin`) or off, and re-apply every
    /// DSP setting from `dsp` through the overlay (see `DspSettings::bit_perfect`).
    ///
    /// - `audio-device` is pinned by UID: under `auto`, macOS moves the default
    ///   away from a hogged device and the next AO open would follow it.
    /// - `gapless-audio=weak`: with `yes` mpv keeps the AO in the first track's
    ///   format and resamples every later track to it, exclusive or not. `weak`
    ///   stays gapless between same-format tracks and reopens on a change.
    /// - The AO is reloaded so the change applies to the playing track now,
    ///   without replaying it (a replay would re-arm scrobbling).
    fn apply_bit_perfect(
        self: &Arc<Self>,
        pin: Option<&output::DevicePin>,
        dsp: &DspSettings,
    ) -> Result<(), String> {
        let (generation, dropped_xfade) = {
            let mut st = self.state.lock().unwrap();
            st.bit_perfect = pin.cloned();
            st.bit_perfect_gen += 1;
            // A crossfade arm holds the standby deck's AO open; a second deck
            // can't share a device held in exclusive mode.
            let dropped = pin.is_some() && st.xfade_key.take().is_some();
            (st.bit_perfect_gen, dropped)
        };
        // The waveform capture can't know how long it went uncounted; a track
        // played across a toggle stays short of complete (wave_capture.rs).
        self.waves.lock().unwrap().suspend_all();
        let standby = 1 - self.state.lock().unwrap().active;
        if dropped_xfade {
            if let Err(e) = self.decks[standby].mpv.command("stop", &[]) {
                log::error!("mpv-engine: failed to drop crossfade arm for bit-perfect: {e}");
            }
        }
        // Exclusive before the device: changing `audio-device` reloads the AO
        // by itself, and it should reopen with the right exclusivity.
        self.apply_audio_exclusive(dsp.exclusive)?;
        let device = pin.map(|p| p.mpv_device()).unwrap_or_else(|| "auto".to_string());
        let gapless = if pin.is_some() { "weak" } else { "yes" };
        for deck in &self.decks {
            deck.mpv
                .set_property("gapless-audio", gapless)
                .and_then(|_| deck.mpv.set_property("audio-device", device.as_str()))
                .map_err(|e| format!("mpv bit-perfect output setup failed: {e}"))?;
        }
        self.apply_eq(&dsp.eq)?;
        self.apply_replaygain(&dsp.rg)?;
        self.apply_speed(dsp.speed.unwrap_or(1.0))?;
        let (active, fading, out, playing) = {
            let st = self.state.lock().unwrap();
            (st.active, st.fading, Self::deck_volume(&st), st.current_key.is_some())
        };
        if !fading {
            self.decks[active]
                .mpv
                .set_property("volume", out)
                .map_err(|e| format!("mpv volume failed: {e}"))?;
        }
        let busy = self.state.lock().unwrap().device_busy.is_some();
        if busy && pin.is_none() {
            // Waiting on a busy device and the user gave up on the mode: the
            // deck is idle, so there's no AO to reload — load the track again
            // under the normal output. If that fails too it's an ordinary
            // engine error from here (the mode is off).
            self.retry_busy_device(true);
            self.clear_device_busy();
        } else if playing && !busy {
            if let Err(e) = self.decks[active].mpv.command("ao-reload", &[]) {
                log::error!("mpv-engine: ao-reload for bit-perfect failed: {e}");
            }
        }
        log::info!(
            "mpv-engine: bit-perfect {} (device={device}, gapless={gapless})",
            if pin.is_some() { "on" } else { "off" }
        );
        if pin.is_some() {
            output::spawn_watchdog(Arc::downgrade(self), generation);
        }
        Ok(())
    }

    /// What the active deck is actually decoding, or None when the engine
    /// isn't playing. Works for remote streams (and video) that tag readers
    /// can't inspect. Zero/empty values are normalized to `None` so the
    /// frontend can treat "known" as "present".
    pub fn media_info(&self) -> Option<EngineMediaInfo> {
        let active = {
            let st = self.state.lock().unwrap();
            st.current_key.as_ref()?;
            st.active
        };
        let mpv = &self.decks[active].mpv;
        let non_empty = |s: String| (!s.is_empty()).then_some(s);
        Some(EngineMediaInfo {
            codec: mpv.get_property::<String>("audio-codec-name").ok().and_then(non_empty),
            sample_rate: mpv.get_property::<i64>("audio-params/samplerate").ok().filter(|&v| v > 0),
            format: mpv.get_property::<String>("audio-params/format").ok().and_then(non_empty),
            bitrate: mpv.get_property::<f64>("audio-bitrate").ok().filter(|&v| v > 0.0),
            video_codec: mpv.get_property::<String>("video-format").ok().and_then(non_empty),
            width: mpv.get_property::<i64>("width").ok().filter(|&v| v > 0),
            height: mpv.get_property::<i64>("height").ok().filter(|&v| v > 0),
            video_bitrate: mpv.get_property::<f64>("video-bitrate").ok().filter(|&v| v > 0.0),
            fps: mpv.get_property::<f64>("container-fps").ok().filter(|&v| v > 0.0),
        })
    }
}

/// Emit the active deck's buffer state, unless nothing has moved since the
/// last emit. Must be called with no lock on `state` held — it takes one.
/// Whether an end-file error is Bit-perfect mode's pinned device being held by
/// another process, and if so mark it busy (see `EngineState::device_busy`).
///
/// Measured on Windows (WASAPI, 2026-10-01): while one client holds an
/// endpoint exclusively, a second client's open fails with
/// `AUDCLNT_E_DEVICE_IN_USE`, surfacing as `MPV_ERROR_AO_INIT_FAILED` on
/// end-file — exclusive *or* shared. (Shared-mode holders don't cause this:
/// an exclusive open evicts them, and mpv's own retry lands ~1s later.)
fn is_busy_device_failure(e: &api::Error, deck: usize, state: &Mutex<EngineState>) -> bool {
    if *e != api::Error::Raw(MPV_ERROR_AO_INIT_FAILED) {
        return false;
    }
    let mut st = state.lock().unwrap();
    if deck != st.active || st.bit_perfect.is_none() || st.current_key.is_none() || st.current_load.is_none() {
        return false;
    }
    st.gapless_key = None;
    st.gapless_url = None;
    // Keep the first failure's time: a retry that fails again mustn't push
    // the next one out, and the retry itself stamps its own attempt.
    st.device_busy.get_or_insert_with(Instant::now);
    true
}

/// Emit the active deck's level reading, unless it rounds to the last one.
/// Must be called with no lock on `state` held — it takes one.
///
/// Reads only while the deck is actually producing audio (`core-idle` false):
/// paused, stalled or idle, mpv keeps reporting the last frame's numbers, which
/// would hold a lit meter over silence. The readout is ended then (see
/// `end_level_readout`), so the first reading after a resume always goes out.
///
/// Returns whether the deck is producing audio, so the caller can stop waking
/// up at the poll rate while it isn't.
fn emit_level_if_changed(
    client: &Mpv,
    deck: usize,
    state: &Mutex<EngineState>,
    sink: &EventSink,
    last: &mut Option<(String, MeterFingerprint)>,
) -> bool {
    let key = {
        let st = state.lock().unwrap();
        if deck != st.active { None } else { st.current_key.clone() }
    };
    let Some(key) = key else {
        end_level_readout(sink, last);
        return false;
    };
    if client.get_property::<bool>("core-idle").unwrap_or(true) {
        end_level_readout(sink, last);
        return false;
    }
    if last.as_ref().is_some_and(|(k, _)| *k != key) {
        // A gapless transition: the previous track's readout is over.
        end_level_readout(sink, last);
    }
    let Some(reading) = client
        .get_property::<String>(&format!("af-metadata/{}", meter::METER_LABEL))
        .ok()
        .and_then(|json| parse_meter(&json))
    else {
        return true;
    };
    let fingerprint = meter_fingerprint(&reading);
    if last.as_ref().is_some_and(|(_, f)| *f == fingerprint) {
        return true;
    }
    *last = Some((key.clone(), fingerprint));
    let round = |v: &[f64]| v.iter().copied().map(round_db).collect::<Vec<_>>();
    sink(
        "engine-level",
        json!({
            "trackKey": key,
            "peakDb": round(&reading.peak_db),
            "rmsDb": round(&reading.rms_db),
        }),
    );
    true
}

/// The meter has stopped describing the track it last reported for (paused,
/// meter off, bit-perfect on, deck no longer active, track changed): say so
/// once, with null readings, so a consumer drops a level that is no longer
/// true rather than holding it. Keyed by the track the readings were for, so
/// the frontend's session guard drops it when that track is already gone.
fn end_level_readout(sink: &EventSink, last: &mut Option<(String, MeterFingerprint)>) {
    if let Some((key, _)) = last.take() {
        sink("engine-level", json!({ "trackKey": key, "peakDb": null, "rmsDb": null }));
    }
}

fn emit_buffer_if_changed(
    client: &Mpv,
    deck: usize,
    state: &Mutex<EngineState>,
    sink: &EventSink,
    last: &mut Option<BufferFingerprint>,
) {
    let key = {
        let st = state.lock().unwrap();
        if deck != st.active {
            return;
        }
        match st.current_key.clone() {
            Some(key) => key,
            None => return,
        }
    };
    // Non-network source: stay silent rather than emitting a snapshot the UI
    // would have to know to ignore.
    let Some(snap) = read_buffer_snapshot(client) else {
        return;
    };
    let fingerprint = buffer_fingerprint(&snap);
    if *last == Some(fingerprint) {
        return;
    }
    *last = Some(fingerprint);
    sink(
        "engine-buffer",
        json!({
            "trackKey": key,
            "pausedForCache": snap.paused_for_cache,
            "readaheadSecs": snap.readahead_secs,
            "cacheEndSecs": snap.cache_end_secs,
        }),
    );
}

/// Feed `deck`'s live waveform capture one reading of its filter. Reads
/// nothing while there is no capture to feed (idle, mid-seek, bit-perfect).
/// Returns whether the reading carried new frames. Must be called with no
/// lock on `state` or `waves` held.
fn feed_wave_capture(client: &Mpv, deck: usize, state: &Mutex<EngineState>, waves: &Mutex<WaveCaptures>) -> bool {
    {
        let st = state.lock().unwrap();
        if !st.wave_capture || st.bit_perfect.is_some() {
            return false;
        }
    }
    if !waves.lock().unwrap().live_mut(deck).is_some_and(|c| c.is_live()) {
        return false;
    }
    let Some(reading) = client
        .get_property::<String>(&format!("af-metadata/{}", wave_capture::WAVE_LABEL))
        .ok()
        .and_then(|json| parse_wave(&json))
    else {
        return false;
    };
    // The decoder's rate is the filter's input rate (resampling for the
    // output happens after the user chain).
    let Ok(rate) = client.get_property::<i64>("audio-params/samplerate") else {
        return false;
    };
    waves.lock().unwrap().live_mut(deck).is_some_and(|capture| capture.feed(reading, rate as f64))
}

fn run_event_loop(
    client: Arc<Mpv>,
    deck: usize,
    engine: Weak<Engine>,
    state: Arc<Mutex<EngineState>>,
    waves: Arc<Mutex<WaveCaptures>>,
    sink: EventSink,
) {
    let mut last_wave_poll = Instant::now() - wave_capture::WAVE_POLL_INTERVAL;
    // The last capture read found new frames: the deck is decoding.
    let mut wave_advancing = false;
    let mut last_position_emit = Instant::now() - POSITION_EMIT_INTERVAL;
    let mut last_buffer_poll = Instant::now() - BUFFER_POLL_INTERVAL;
    let mut last_buffer: Option<BufferFingerprint> = None;
    let mut last_meter_poll = Instant::now() - meter::METER_POLL_INTERVAL;
    let mut last_level: Option<(String, MeterFingerprint)> = None;
    // Whether the last meter poll found the deck producing audio. While it
    // isn't (paused, stalled), polling every 66ms would wake the loop for
    // nothing; the `pause` / `paused-for-cache` events wake it on resume.
    let mut meter_live = true;
    // Playback has (re)started on the current file — a `vo-configured` that
    // flips true after this is a late video output still to be revealed.
    let mut restarted = false;
    loop {
        // Only the active deck's loop reads the meter, and it wakes when the
        // next read is due: between events the loop would otherwise sleep up
        // to half a second, capping the meter at whatever wakes it.
        let metering = {
            let st = state.lock().unwrap();
            st.meter && st.bit_perfect.is_none() && deck == st.active
        };
        let timeout = if metering && meter_live {
            meter::METER_POLL_INTERVAL
                .saturating_sub(last_meter_poll.elapsed())
                .as_secs_f64()
                .max(0.005)
        } else if wave_advancing {
            // `time-pos` stops changing once the decoder reaches the end and
            // the output drains, so the last frames would wait for EndFile —
            // by which time the chain is gone. Keep reading while they move.
            wave_capture::WAVE_POLL_INTERVAL
                .saturating_sub(last_wave_poll.elapsed())
                .as_secs_f64()
                .max(0.005)
        } else {
            0.5
        };
        let event = client.wait_event(timeout);
        if !metering {
            end_level_readout(&sink, &mut last_level);
        } else if last_meter_poll.elapsed() >= meter::METER_POLL_INTERVAL {
            last_meter_poll = Instant::now();
            meter_live = emit_level_if_changed(&client, deck, &state, &sink, &mut last_level);
        }
        // Sample the cache on every pass, whatever woke us (including the 0.5s
        // timeout, which is *all* we get while paused). The fingerprint guard
        // keeps a settled cache silent, so this costs three property reads per
        // interval and emits nothing unless the buffered edge actually moved.
        if last_buffer_poll.elapsed() >= BUFFER_POLL_INTERVAL {
            last_buffer_poll = Instant::now();
            emit_buffer_if_changed(&client, deck, &state, &sink, &mut last_buffer);
        }
        // The counts are cumulative, so the cadence only sets how finely an
        // interval is placed — no frame is lost between two polls. While
        // playing, `time-pos` changes wake the loop often enough.
        if last_wave_poll.elapsed() >= wave_capture::WAVE_POLL_INTERVAL {
            last_wave_poll = Instant::now();
            wave_advancing = feed_wave_capture(&client, deck, &state, &waves);
        }
        let Some(event) = event else {
            continue;
        };
        #[cfg(test)]
        if !matches!(event, Ok(Event::PropertyChange { .. })) {
            eprintln!("[deck {deck}] raw event: {event:?}");
        }
        match event {
            Ok(Event::Shutdown) => break,
            Ok(Event::StartFile) => {
                // A new file owns a new cache — drop the guard's memory so the
                // first snapshot of this track always reaches the frontend,
                // even when it happens to match the last one of the previous.
                last_buffer = None;
                restarted = false;
                // This file's waveform capture key: the active deck plays the
                // current track, the standby deck only ever holds a crossfade arm.
                let capture_key;
                {
                    let mut st = state.lock().unwrap();
                    let mut gapless = None;
                    if st.expecting_start[deck] {
                        // Our own explicit loadfile (play or crossfade arm).
                        st.expecting_start[deck] = false;
                    } else if deck == st.active {
                        if let Some(next_key) = st.gapless_key.take() {
                            // Gapless transition into the playlist-armed track.
                            st.current_key = Some(next_key.clone());
                            st.duration = None;
                            st.pending_seek = None;
                            st.last_pos = 0.0;
                            if let Some(url) = st.gapless_url.take() {
                                st.current_load = Some((url, None));
                            }
                            gapless = Some(next_key);
                        }
                    }
                    capture_key = if deck == st.active { st.current_key.clone() } else { st.xfade_key.clone() };
                    drop(st);
                    if let Some(next_key) = gapless {
                        sink(
                            "engine-track-changed",
                            json!({ "trackKey": next_key, "reason": "gapless" }),
                        );
                    }
                }
                let mut waves = waves.lock().unwrap();
                match capture_key {
                    Some(key) => waves.begin(deck, &key),
                    None => waves.finish(deck),
                }
            }
            Ok(Event::Seek) => {
                if let Some(capture) = waves.lock().unwrap().live_mut(deck) {
                    capture.suspend();
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
                //
                // `hasVideo` says whether there is a picture to reveal. A video
                // whose picture can't be decoded still restarts — mpv carries on
                // audio-only — and revealing then opens the hole over an empty
                // native surface: the desktop shows through the transparent
                // window for the whole track.
                restarted = true;
                // Nothing has played since the restart, so `time-pos` is where
                // the rebuilt filter's count starts.
                let position = client.get_property::<f64>("time-pos").unwrap_or(0.0);
                if let Some(capture) = waves.lock().unwrap().live_mut(deck) {
                    capture.restart(position);
                }
                let key = {
                    let st = state.lock().unwrap();
                    if deck != st.active { None } else { st.current_key.clone() }
                };
                if let Some(key) = key {
                    let has_video = client.get_property::<bool>("vo-configured").unwrap_or(false);
                    sink(
                        "engine-playback-restart",
                        json!({ "trackKey": key, "hasVideo": has_video }),
                    );
                }
            }
            Ok(Event::EndFile(reason)) => {
                // Take the last frames before the capture is put away. Best-effort:
                // mpv may already have torn the chain down.
                feed_wave_capture(&client, deck, &state, &waves);
                waves.lock().unwrap().finish(deck);
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
                            let owner = {
                                let mut st = state.lock().unwrap();
                                if deck == st.active {
                                    st.last_pos = pos;
                                    st.current_key.clone().map(|key| (key, st.duration))
                                } else {
                                    None
                                }
                            };
                            if let Some((key, duration)) = owner {
                                last_position_emit = Instant::now();
                                sink(
                                    "engine-position",
                                    json!({
                                        "trackKey": key,
                                        "positionSecs": pos,
                                        "durationSecs": duration,
                                    }),
                                );
                            }
                        }
                    }
                    ("duration", PropertyData::Double(dur)) => {
                        if let Some(capture) = waves.lock().unwrap().live_mut(deck) {
                            capture.set_duration(dur);
                        }
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
                    // The stall signals, sampled ahead of the poll clock so a
                    // stall shows up immediately rather than up to
                    // BUFFER_POLL_INTERVAL later.
                    ("paused-for-cache", PropertyData::Flag(_))
                    | ("cache-buffering-state", PropertyData::Int64(_)) => {
                        emit_buffer_if_changed(&client, deck, &state, &sink, &mut last_buffer);
                    }
                    ("vo-configured", PropertyData::Flag(true)) if restarted => {
                        // The video output came up after playback had already
                        // restarted without one — reveal it now.
                        let key = {
                            let st = state.lock().unwrap();
                            if deck != st.active { None } else { st.current_key.clone() }
                        };
                        if let Some(key) = key {
                            sink(
                                "engine-playback-restart",
                                json!({ "trackKey": key, "hasVideo": true }),
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
            Err(e) if is_busy_device_failure(&e, deck, &state) => {
                // The pinned device is held by another process. Not a decode
                // failure, and no other output path exists (a shared-mode open
                // fails too while it's held), so keep the track and let the
                // output watchdog retry. mpv would otherwise
                // move on to a gapless arm, which can't open the device either.
                if let Err(e) = client.command("playlist-clear", &[]) {
                    log::error!("mpv-engine: playlist-clear after busy device failed: {e}");
                }
                log::warn!("mpv-engine: pinned output device is busy ({e}) — waiting for it");
            }
            Err(e) => {
                // Decode/load failures surface here (EndFile with an error
                // reason is mapped to Err by api::Mpv::wait_event).
                let (kind, key, load_pending) = {
                    let mut st = state.lock().unwrap();
                    let load_pending = st.expecting_start[deck];
                    if deck == st.active {
                        st.gapless_key = None;
                        ("active", st.current_key.take(), load_pending)
                    } else {
                        // Standby arming failure — report the armed key so the
                        // frontend can blocklist and disarm it.
                        st.expecting_start[deck] = false;
                        ("standby", st.xfade_key.take(), false)
                    }
                };
                // Whatever mpv would play next on this deck belongs to nobody:
                // the frontend decides what follows a failure (retry, fallback,
                // skip). It is not always empty — a source mpv can't demux but
                // can read as a playlist is expanded into the deck's playlist
                // (a refused YouTube HLS stream queues every segment), and each
                // entry then failed on its own, about twice a second. Not while
                // one of our own loads is on its way: that is a newer play,
                // and this error belongs to what it replaced.
                if !load_pending {
                    if let Err(e) = client.command("stop", &[]) {
                        log::error!("mpv-engine: stop after a failed load failed: {e}");
                    }
                }
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

    fn buffer_snap(paused: bool, cache_end: Option<f64>, readahead: Option<f64>) -> BufferSnapshot {
        BufferSnapshot { paused_for_cache: paused, cache_end_secs: cache_end, readahead_secs: readahead }
    }

    /// What mpv actually plays at, given the property value we send it.
    fn mpv_applied_gain(property: f64) -> f64 {
        (property / 100.0).powi(3)
    }

    #[test]
    fn test_the_volume_slider_maps_to_linear_gain() {
        // mpv cubes its `volume` property. The slider must therefore arrive as
        // a cube root, or half volume plays at 12.5% gain (-18 dB) and 30% at
        // 2.7% (-31 dB) — the "anything under a third is inaudible" report.
        for pct in [0.0, 0.1, 0.3, 0.5, 0.75, 1.0] {
            let applied = mpv_applied_gain(Engine::out_volume(pct, false));
            assert!(
                (applied - pct).abs() < 0.005,
                "slider {pct} played at gain {applied}, expected {pct}",
            );
        }
    }

    #[test]
    fn test_volume_endpoints_and_mute_are_exact() {
        assert_eq!(Engine::out_volume(1.0, false), 100.0);
        assert_eq!(Engine::out_volume(0.0, false), 0.0);
        assert_eq!(Engine::out_volume(1.0, true), 0.0);
        // Out-of-range input can't amplify past unity.
        assert_eq!(Engine::out_volume(4.0, false), 100.0);
    }

    #[test]
    fn test_crossfade_ramps_gain_not_the_property() {
        // The ramp scales the gain and converts; scaling the property value
        // would fade as t³, so the outgoing deck would already be down to a
        // tenth of its level a fifth of the way through the fade.
        let gain = Engine::out_gain(1.0, false);
        for t in [0.25, 0.5, 0.75] {
            let applied = mpv_applied_gain(Engine::mpv_volume(gain * t));
            assert!(
                (applied - t).abs() < 0.005,
                "at t={t} the incoming deck played at {applied}",
            );
        }
        // The two decks always sum to the full gain, so a fade holds its level.
        for t in [0.0, 0.3, 0.6, 1.0] {
            let sum = mpv_applied_gain(Engine::mpv_volume(gain * t))
                + mpv_applied_gain(Engine::mpv_volume(gain * (1.0 - t)));
            assert!((sum - 1.0).abs() < 0.01, "decks summed to {sum} at t={t}");
        }
    }

    #[test]
    fn test_buffer_fingerprint_ignores_sub_half_second_cache_drift() {
        // A settled cache reports a value that jitters in the noise. If that
        // counted as a change, every network track would emit a redundant
        // engine-buffer 4× a second for its whole duration.
        let a = buffer_snap(false, Some(180.02), Some(12.0));
        let b = buffer_snap(false, Some(180.21), Some(12.0));
        assert_eq!(buffer_fingerprint(&a), buffer_fingerprint(&b));
    }

    #[test]
    fn test_buffer_fingerprint_tracks_a_filling_cache() {
        let a = buffer_snap(false, Some(30.0), Some(6.0));
        let b = buffer_snap(false, Some(34.5), Some(10.5));
        assert_ne!(buffer_fingerprint(&a), buffer_fingerprint(&b));
    }

    #[test]
    fn test_buffer_fingerprint_tracks_stall_and_refill() {
        // The two states the chip renders. A refill behind a *frozen* playhead
        // moves only the readahead — the cache end can be unchanged at 0.5s
        // resolution — so readahead alone has to trigger an emit. This is the
        // whole reason the chip's number can climb during a stall.
        let playing = buffer_snap(false, Some(50.0), Some(20.0));
        let stalled = buffer_snap(true, Some(50.0), Some(0.0));
        let refilling = buffer_snap(true, Some(50.0), Some(0.4));
        assert_ne!(buffer_fingerprint(&playing), buffer_fingerprint(&stalled));
        assert_ne!(buffer_fingerprint(&stalled), buffer_fingerprint(&refilling));
    }

    #[test]
    fn test_buffer_fingerprint_ignores_readahead_while_playing() {
        // Readahead is only displayed while stalled. Outside a stall it drifts
        // continuously and invisibly, so it must not wake an emit — otherwise
        // every healthy network track pays for a number nobody can see.
        let a = buffer_snap(false, Some(90.0), Some(11.2));
        let b = buffer_snap(false, Some(90.0), Some(18.9));
        assert_eq!(buffer_fingerprint(&a), buffer_fingerprint(&b));
    }

    #[test]
    fn test_buffer_fingerprint_distinguishes_unknown_from_zero() {
        // "mpv didn't report a cache" and "the cache is empty" render
        // differently (no number vs. a real zero), so they can't share a key.
        let unknown = buffer_snap(true, None, None);
        let empty = buffer_snap(true, Some(0.0), Some(0.0));
        assert_ne!(buffer_fingerprint(&unknown), buffer_fingerprint(&empty));
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
    ///
    /// A libmpv that IS present but fails to load is a hard failure, not a skip:
    /// treating it as "not available" is how a whole suite of real-mpv tests went
    /// quietly unrun (a stale `@rpath/libluajit` install name made every dlopen
    /// fail, and each test just printed SKIPPED and passed).
    fn try_test_engine(sink: EventSink) -> Option<Arc<Engine>> {
        if let Err(e) = super::ffi::libmpv() {
            let present: Vec<_> = super::ffi::candidate_paths()
                .into_iter()
                .filter(|(p, _)| p.exists())
                .collect();
            if !present.is_empty() {
                let found = present
                    .iter()
                    .map(|(p, o)| format!("{} ({o})", p.display()))
                    .collect::<Vec<_>>()
                    .join(", ");
                panic!(
                    "libmpv exists but could not be loaded: {e}\n  \
                     found: {found}\n  \
                     try `node scripts/fetch-libmpv.mjs` — it repairs stale install names in place"
                );
            }
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
            .play(wav_a.to_str().unwrap(), None, "trk:a", None, 1.0, false, false)
            .expect("play");
        engine
            .preload(wav_b.to_str().unwrap(), None, "trk:b", false)
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
    fn test_mixtape_tracks_play_in_place_through_slice() {
        // A `.mixtape` track is played straight out of the archive via mpv's
        // `slice://`. The path deliberately carries what could trip the URL:
        // non-ASCII, spaces, `-` and `@` (the slice range ends at the first
        // `@`, everything after it is the inner path).
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Γκούλαγκ @ θέαμα");
        std::fs::create_dir_all(&folder).unwrap();
        let wav_a = folder.join("a.wav");
        let wav_b = folder.join("b.wav");
        write_wav(&wav_a, 0.6);
        write_wav(&wav_b, 0.4);
        let source = |title: &str, path: &std::path::Path| crate::mixtape::MixtapeTrackSource {
            title: title.into(),
            artist: "Γκούλαγκ".into(),
            album: None,
            duration_secs: None,
            audio_path: path.to_string_lossy().to_string(),
            thumb_path: None,
        };
        let mixtape = folder.join("Γκούλαγκ -Στην αυλή των θεαμάτων.mixtape");
        let manifest = crate::mixtape::build_manifest(
            "Στην αυλή".into(),
            crate::models::MixtapeType::Custom,
            Default::default(),
            None,
            vec![],
        );
        crate::mixtape::build_mixtape(
            &mixtape,
            None,
            &[source("Α", &wav_a), source("Β", &wav_b)],
            manifest,
            false,
            &std::sync::atomic::AtomicBool::new(false),
            |_, _, _, _| {},
        )
        .unwrap();
        let opened = crate::mixtape::open_for_play(&mixtape, &dir.path().join("art")).unwrap();
        let target = |i: usize| {
            let uri = opened.tracks[i].path.as_deref().unwrap();
            let (offset, length, path) = crate::mixtape::parse_entry_uri(uri).unwrap();
            crate::commands::slice_target(path, offset, length)
        };

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.play(&target(0), None, "trk:a", None, 1.0, false, false).expect("play");
        engine.preload(&target(1), None, "trk:b", false).expect("preload");

        let mut duration_a = None;
        let mut promoted = false;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("timed out waiting for engine-ended");
            let (name, payload) = rx.recv_timeout(remaining).expect("timed out waiting for engine-ended");
            assert_ne!(name, "engine-error", "a mixtape slice failed to play: {payload}");
            match name.as_str() {
                "engine-duration" if payload["trackKey"] == "trk:a" => {
                    duration_a = payload["durationSecs"].as_f64();
                }
                "engine-track-changed" => {
                    assert_eq!(payload["trackKey"], "trk:b");
                    assert_eq!(payload["reason"], "gapless");
                    promoted = true;
                }
                "engine-ended" => {
                    assert_eq!(payload["trackKey"], "trk:b");
                    break;
                }
                _ => {}
            }
        }
        assert!(promoted, "the second slice must follow gaplessly");
        let duration_a = duration_a.expect("a duration for the first slice");
        assert!((duration_a - 0.6).abs() < 0.05, "first slice read as {duration_a}s");
    }

    /// Real-file check of in-place mixtape playback (decode + seek), against a
    /// `.mixtape` of your own:
    /// `VIBOPLR_MIXTAPE=<path> cargo test --lib probe_mixtape_slice -- --ignored --nocapture`
    /// Plays the first track silently (`ao=null`), seeks to 30s and checks the
    /// position lands there.
    #[test]
    #[ignore]
    fn probe_mixtape_slice() {
        let Ok(path) = std::env::var("VIBOPLR_MIXTAPE") else {
            eprintln!("[engine-test] SKIPPED — set VIBOPLR_MIXTAPE");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let opened = crate::mixtape::open_for_play(std::path::Path::new(&path), dir.path()).unwrap();
        let uri = opened.tracks[0].path.as_deref().unwrap();
        let (offset, length, inner) = crate::mixtape::parse_entry_uri(uri).expect("played in place");
        let target = crate::commands::slice_target(inner, offset, length);

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.play(&target, None, "trk:mix", None, 1.0, false, false).expect("play");
        let duration = wait_for(&rx, "engine-duration", Duration::from_secs(10));
        eprintln!("[probe] {} → duration {}", opened.manifest.tracks[0].title, duration["durationSecs"]);
        engine.seek(30.0).expect("seek");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let (name, payload) = rx
                .recv_timeout(deadline.checked_duration_since(Instant::now()).expect("no position after the seek"))
                .expect("no position after the seek");
            assert_ne!(name, "engine-error", "{payload}");
            if name == "engine-position" {
                let pos = payload["positionSecs"].as_f64().unwrap_or(0.0);
                if (30.0..32.0).contains(&pos) {
                    eprintln!("[probe] seeked to {pos}");
                    break;
                }
            }
        }
    }

    #[test]
    fn test_arm_during_a_running_fade_survives_that_fades_cleanup() {
        // A track shorter than the preload lead arms its successor moments
        // after its own crossfade started. The fade thread's completion used to
        // `stop` the standby deck unconditionally — unloading the just-armed
        // file while `xfade_key` stayed set — so the eventual promotion
        // unpaused an empty deck: `engine-track-changed` fired, then no
        // time-pos, no EOF, no error, ever. `preload` now snap-finishes a
        // running fade before arming.
        let dir = tempfile::tempdir().unwrap();
        let wav_a = dir.path().join("a.wav");
        let wav_b = dir.path().join("b.wav");
        let wav_c = dir.path().join("c.wav");
        write_wav(&wav_a, 0.4);
        write_wav(&wav_b, 3.0);
        write_wav(&wav_c, 0.4);

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };

        engine
            .play(wav_a.to_str().unwrap(), None, "trk:a", None, 1.0, false, false)
            .expect("play");
        engine
            .preload(wav_b.to_str().unwrap(), None, "trk:b", true)
            .expect("arm b");
        engine.start_crossfade(1.0).expect("fade into b");
        let changed = wait_for(&rx, "engine-track-changed", Duration::from_secs(10));
        assert_eq!(changed["trackKey"], "trk:b");
        assert_eq!(changed["reason"], "crossfade");

        // Arm the next track while that 1s fade is still ramping — the race.
        engine
            .preload(wav_c.to_str().unwrap(), None, "trk:c", true)
            .expect("arm c mid-fade");
        // Let the original fade window pass: this is when the old cleanup
        // stopped the deck now holding C's arm.
        std::thread::sleep(Duration::from_millis(1500));

        engine.start_crossfade(0.1).expect("fade into c");
        let changed = wait_for(&rx, "engine-track-changed", Duration::from_secs(10));
        assert_eq!(changed["trackKey"], "trk:c");

        // The promoted deck must actually be playing: C reaches EOF and ends.
        // With the race, the deck is empty and this times out.
        let ended = wait_for(&rx, "engine-ended", Duration::from_secs(10));
        assert_eq!(ended["trackKey"], "trk:c");
    }

    /// Which demuxer does the buffer readout describe? Two shapes, back to
    /// back against the same starved audio stream:
    ///
    /// - **A:** that stream as the *main* file. The readout must track it.
    /// - **B:** a fast video file as main with that same starved stream
    ///   attached as an external `audio-file` — the shape every YouTube ≥720p
    ///   play takes (see `play`'s `audio_url`).
    ///
    /// **Measured result** (see `read_buffer_snapshot`'s note): A produced 16
    /// buffer events tracking the stall precisely (readahead climbing
    /// 0.0 → 0.28 → 0.74 → 1.02 and draining again); B produced **one**, with
    /// `cacheEnd: null`, while the playhead advanced off that same starved
    /// stream. The cache properties describe the **main demuxer only** — they
    /// never fall back to, or aggregate with, an external track.
    ///
    /// Harness: serve two endpoints on :8720, video fast and audio at ~3 KB/s.
    ///   ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30:duration=60 \
    ///          -f lavfi -i sine=frequency=440:duration=60 \
    ///          -map 0:v -c:v libx264 -preset ultrafast -pix_fmt yuv420p -an video.mp4 \
    ///          -map 1:a -c:a aac -vn audio.m4a
    /// plus any throttling static server that honours Range. `#[ignore]`d
    /// because of that dependency — run by hand when changing
    /// `read_buffer_snapshot`.
    #[test]
    #[ignore]
    fn probe_split_stream_buffer_attribution() {
        fn watch(label: &str, rx: &mpsc::Receiver<(String, serde_json::Value)>, secs: u64) {
            let deadline = Instant::now() + Duration::from_secs(secs);
            let mut pos = 0.0;
            let mut seen = 0;
            while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                match rx.recv_timeout(remaining) {
                    Ok((n, p)) if n == "engine-position" => {
                        pos = p["positionSecs"].as_f64().unwrap_or(0.0)
                    }
                    Ok((n, p)) if n == "engine-buffer" => {
                        seen += 1;
                        eprintln!(
                            "[{label}] pos={pos:6.2}  stalled={}  readahead={}  cacheEnd={}",
                            p["pausedForCache"], p["readaheadSecs"], p["cacheEndSecs"],
                        );
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            eprintln!("[{label}] {seen} buffer event(s), final pos={pos:.2}");
        }

        let dir = tempfile::tempdir().unwrap();
        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.set_tls_ca_file(&test_ca_bundle(dir.path())).expect("tls ca");

        // A — the starved stream is the main file.
        engine
            .play("http://127.0.0.1:8720/audio.m4a", None, "trk:solo", None, 0.5, false, false)
            .expect("play audio alone");
        watch("solo", &rx, 20);

        // B — same starved stream, now attached to a fast main file.
        engine
            .play(
                "http://127.0.0.1:8720/video.mp4",
                Some("http://127.0.0.1:8720/audio.m4a"),
                "trk:split",
                None,
                0.5,
                false,
                false,
            )
            .expect("play split pair");
        watch("split", &rx, 20);
    }

    /// What `media_info()` actually reports for a hi-res file — specifically
    /// whether `audio-params/format` can stand in for the file's bit depth.
    /// It cannot: ffmpeg's FLAC decoder outputs **s32 for a 24-bit file**
    /// (`ffmpeg -i` says so in as many words: `flac, 96000 Hz, s32 (24 bit)`),
    /// so anything deriving "32-bit" from it is describing the decoder, not the
    /// recording. Ignored because it needs a file and ffmpeg to make one:
    ///
    ///   ffmpeg -f lavfi -i sine=frequency=440:duration=2:sample_rate=96000 \
    ///     -sample_fmt s32 -c:a flac t24.flac
    ///   VIBOPLR_PROBE_FILE=/path/t24.flac cargo test --lib \
    ///     probe_engine_audio_params -- --ignored --nocapture
    #[test]
    #[ignore]
    fn probe_engine_audio_params() {
        let file = std::env::var("VIBOPLR_PROBE_FILE").expect("set VIBOPLR_PROBE_FILE");
        let (sink, _rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine
            .play(&file, None, "trk:probe", None, 1.0, false, false)
            .expect("play");
        std::thread::sleep(Duration::from_millis(1200));
        let info = engine.media_info().expect("media info");
        eprintln!(
            "[probe] codec={:?} samplerate={:?} format={:?} bitrate={:?}",
            info.codec, info.sample_rate, info.format, info.bitrate
        );
    }

    #[test]
    fn test_local_file_emits_no_buffer_events() {
        // The network gate, against real mpv. mpv keeps a bounded demuxer
        // readahead for local files too, so without the gate a file on disk
        // would report a cache ending just past the playhead — and the seek
        // bar would dim the rest of a track that is entirely local.
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("local.wav");
        write_wav(&wav, 1.0);

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine
            .play(wav.to_str().unwrap(), None, "trk:local", None, 1.0, false, false)
            .expect("play");

        // Drain the whole session; any engine-buffer in it is a failure.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("timed out waiting for engine-ended");
            let (name, payload) = rx
                .recv_timeout(remaining)
                .expect("timed out waiting for engine-ended");
            assert_ne!(name, "engine-buffer", "local file reported a buffer: {payload}");
            if name == "engine-ended" {
                break;
            }
        }
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
            .play(wav_a.to_str().unwrap(), None, "trk:a", None, 1.0, false, false)
            .expect("play");
        engine
            .preload(wav_b.to_str().unwrap(), None, "trk:b", true)
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
            .play(wav_a.to_str().unwrap(), None, "trk:a", None, 1.0, false, false)
            .expect("play");
        engine
            .preload(wav_b.to_str().unwrap(), None, "trk:b", true)
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
                clip_protection: String::new(),
            })
            .expect("advanced EQ af graph");
        engine
            .apply_replaygain(&ReplayGainParams { mode: "track".into(), preamp_db: 3.0, prevent_clip: true })
            .expect("replaygain options");
        engine
            .play(wav.to_str().unwrap(), None, "trk:eq", None, 0.8, false, false)
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
                clip_protection: String::new(),
            })
            .expect("simple EQ af graph");
    }

    #[test]
    fn test_bit_perfect_overlays_neutral_dsp_and_restores_it() {
        let (sink, _rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        let dsp = DspSettings {
            eq: EqParams {
                enabled: true,
                mode: "advanced".into(),
                gains: vec![6.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -3.0],
                ..Default::default()
            },
            rg: ReplayGainParams { mode: "track".into(), ..Default::default() },
            exclusive: false,
            speed: Some(1.5),
            ..Default::default()
        };
        engine.apply_eq(&dsp.eq).unwrap();
        engine.apply_replaygain(&dsp.rg).unwrap();
        engine.apply_speed(1.5).unwrap();
        engine.apply_volume(0.4, false).unwrap();
        engine.apply_meter(true, &dsp.eq).unwrap();
        let deck = |i: usize| engine.decks[i].mpv.clone();
        let s = |i: usize, p: &str| deck(i).get_property::<String>(p).unwrap_or_default();
        assert!(!s(0, "af").is_empty(), "EQ graph applied before the mode");
        assert!(s(0, "af").contains(meter::METER_LABEL), "meter applied before the mode");

        let pin = output::DevicePin { uid: "TestDevice".into(), name: "Test".into(), has_volume: false };
        engine.apply_bit_perfect(Some(&pin), &dsp).expect("bit-perfect on");
        for i in 0..2 {
            assert_eq!(s(i, "gapless-audio"), "weak", "deck {i}");
            assert_eq!(s(i, "audio-device"), pin.mpv_device(), "deck {i}");
            assert_eq!(s(i, "af"), "", "deck {i}: EQ suspended");
            assert_eq!(s(i, "replaygain"), "no", "deck {i}: ReplayGain suspended");
            assert_eq!(deck(i).get_property::<f64>("speed").unwrap(), 1.0, "deck {i}: speed held");
            assert!(deck(i).get_property::<bool>("audio-exclusive").unwrap(), "deck {i}: exclusive");
        }
        let active = engine.state.lock().unwrap().active;
        assert_eq!(deck(active).get_property::<f64>("volume").unwrap(), 100.0, "full digital volume");
        {
            let st = engine.state.lock().unwrap();
            assert_eq!(st.volume, 0.4, "the user's volume is kept, not overwritten");
            assert!(st.exclusive, "arming treats bit-perfect as exclusive");
        }
        // Volume changes while on keep the user's value but never leave full scale.
        engine.apply_volume(0.2, false).unwrap();
        assert_eq!(deck(active).get_property::<f64>("volume").unwrap(), 100.0);

        engine.apply_bit_perfect(None, &dsp).expect("bit-perfect off");
        for i in 0..2 {
            assert_eq!(s(i, "gapless-audio"), "yes", "deck {i}");
            assert_eq!(s(i, "audio-device"), "auto", "deck {i}");
            assert!(!s(i, "af").is_empty(), "deck {i}: EQ restored");
            assert!(s(i, "af").contains(meter::METER_LABEL), "deck {i}: meter restored");
            assert!(s(i, "af").contains(wave_capture::WAVE_LABEL), "deck {i}: waveform capture restored");
            assert_eq!(s(i, "replaygain"), "track", "deck {i}: ReplayGain restored");
            assert_eq!(deck(i).get_property::<f64>("speed").unwrap(), 1.5, "deck {i}: speed restored");
            assert!(!deck(i).get_property::<bool>("audio-exclusive").unwrap(), "deck {i}: exclusive restored");
        }
        assert_eq!(
            deck(active).get_property::<f64>("volume").unwrap(),
            Engine::out_volume(0.2, false),
            "the latest user volume comes back"
        );
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
            .play(wav_a.to_str().unwrap(), None, "trk:a", None, 1.0, false, false)
            .expect("play");
        // Crossfade requested, but exclusive mode must arm same-deck gapless
        // (the standby deck can't open an exclusively-held device).
        engine
            .preload(wav_b.to_str().unwrap(), None, "trk:b", true)
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
    /// `cargo test test_https_file -- --ignored --nocapture`
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
                None,
                "trk:https",
                None,
                0.5,
                false,
                false,
            )
            .expect("play https file");
        let pos = wait_for(&rx, "engine-position", Duration::from_secs(30));
        assert_eq!(pos["trackKey"], "trk:https");
        let info = engine.media_info().expect("media info");
        eprintln!("[https-test] info: {info:?}");
        assert!(info.codec.is_some());
        // The buffer readout is network-gated, so this is the only shape of
        // test that can prove the properties are actually wired to real mpv.
        let buffer = wait_for(&rx, "engine-buffer", Duration::from_secs(30));
        eprintln!("[https-test] buffer: {buffer}");
        assert_eq!(buffer["trackKey"], "trk:https");
        assert!(buffer["cacheEndSecs"].is_f64(), "http source must report a cache end");
        let ended = wait_for(&rx, "engine-ended", Duration::from_secs(30));
        assert_eq!(ended["trackKey"], "trk:https");
    }

    /// Where does `demuxer-cache-time` end up once an HTTP source is fully
    /// cached? **Measured: a hair short of the duration, never at it** — the
    /// property is the last cached packet's timestamp, so a fully-downloaded
    /// 60.0s file reports a final cacheEnd of ~59.98 (mp3 and flac alike, with
    /// and without Content-Length). The frontend's `bufferedFraction` snaps
    /// that shortfall to 1 (`FULL_SLACK_SECS`); without the snap the seek
    /// bar's final block — which counts a block straddling the buffered edge
    /// as unbuffered — stayed dim forever on every remote track.
    ///
    /// Harness: serve an audio file from any Range-honoring static server
    /// (throttle it to watch the edge climb) and run
    ///   VIBOPLR_PROBE_URL=http://127.0.0.1:8731/probe.mp3 \
    ///     cargo test --lib probe_buffered_edge_vs_duration -- --ignored --nocapture
    /// `#[ignore]`d because of the server dependency.
    #[test]
    #[ignore]
    fn probe_buffered_edge_vs_duration() {
        let url = std::env::var("VIBOPLR_PROBE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8731/probe.mp3".into());
        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine
            .play(&url, None, "trk:edge", None, 0.2, false, false)
            .expect("play throttled http");
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut duration = 0.0f64;
        let mut pos = 0.0f64;
        let mut last_cache: Option<f64> = None;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(remaining) {
                Ok((n, p)) if n == "engine-duration" => {
                    duration = p["durationSecs"].as_f64().unwrap_or(0.0);
                    eprintln!("[edge] duration={duration:.3}");
                }
                Ok((n, p)) if n == "engine-position" => {
                    pos = p["positionSecs"].as_f64().unwrap_or(0.0);
                }
                Ok((n, p)) if n == "engine-buffer" => {
                    last_cache = p["cacheEndSecs"].as_f64();
                    eprintln!(
                        "[edge] pos={pos:6.2} stalled={} readahead={} cacheEnd={}",
                        p["pausedForCache"], p["readaheadSecs"], p["cacheEndSecs"],
                    );
                }
                Ok((n, _)) if n == "engine-ended" => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        eprintln!("[edge] FINAL duration={duration:.3} lastCacheEnd={last_cache:?} pos={pos:.2}");
    }

    /// **The buffered edge must keep moving while paused.** mpv goes on filling
    /// the demuxer cache when playback is paused, but stops emitting `time-pos`
    /// entirely — so while the buffer poll rode the position tick, pausing a
    /// remote track (subsonic, any http source) froze the seek bar's buffered
    /// edge for the whole pause, which is precisely when a user watches it fill.
    /// The poll now runs on its own clock (`BUFFER_POLL_INTERVAL`), fed by the
    /// event loop's own 0.5s `wait_event` timeout when nothing else wakes it.
    ///
    /// Harness: same as `probe_buffered_edge_vs_duration` — a Range-honoring
    /// static server, ideally throttled so the cache is still filling at the
    /// moment of the pause. `#[ignore]`d because of the server dependency.
    ///   VIBOPLR_PROBE_URL=http://127.0.0.1:8731/probe.mp3 \
    ///     cargo test --lib test_paused_stream_keeps_reporting_buffer -- --ignored --nocapture
    #[test]
    #[ignore]
    fn test_paused_stream_keeps_reporting_buffer() {
        let url = std::env::var("VIBOPLR_PROBE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8731/probe.mp3".into());
        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine
            .play(&url, None, "trk:paused-buffer", None, 0.2, false, false)
            .expect("play throttled http");

        // Let the session get going, then pause and forget everything the
        // playing phase reported.
        wait_for(&rx, "engine-buffer", Duration::from_secs(30));
        engine.set_paused(true).expect("pause");
        std::thread::sleep(Duration::from_millis(500));
        while rx.try_recv().is_ok() {}

        // Everything from here on was emitted with playback paused.
        let mut edges: Vec<f64> = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(remaining) {
                Ok((n, p)) if n == "engine-buffer" => {
                    if let Some(edge) = p["cacheEndSecs"].as_f64() {
                        eprintln!("[paused] cacheEnd={edge:.2}");
                        edges.push(edge);
                    }
                    if edges.len() >= 2 && edges[edges.len() - 1] > edges[0] {
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        engine.set_paused(false).ok();
        assert!(
            edges.len() >= 2 && edges[edges.len() - 1] > edges[0],
            "buffered edge did not advance while paused: {edges:?}"
        );
    }

    /// The headers a resolver supplies must reach the server **verbatim** — one
    /// line per header, values intact. Asserted against a real socket rather than
    /// by reading the property back, because mpv echoes whatever string it was
    /// given and so cannot report that it mangled the request; the only place the
    /// truth is visible is the wire. This is the regression that made signed
    /// YouTube URLs answer 400 (malformed lines) and 403 (our User-Agent never
    /// arriving) — see http_headers.rs.
    #[test]
    fn test_resolver_headers_reach_the_server_verbatim() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();

        let seen = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut lines = Vec::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 { break; }
                let line = line.trim_end_matches(['\r', '\n']).to_string();
                if line.is_empty() { break; }
                lines.push(line);
            }
            let mut s = stream;
            let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            lines
        });

        let (sink, _rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        let mut headers = HashMap::new();
        // Both values carry commas — the exact shape that used to be split into
        // colon-less lines. yt-dlp reports precisely these on every format.
        headers.insert("User-Agent".to_string(), "UA/1.0 (KHTML, like Gecko)".to_string());
        headers.insert("Accept".to_string(), "text/html,application/xml;q=0.9".to_string());
        engine
            .play_with_headers(&format!("http://127.0.0.1:{port}/probe.m4a"), None, Some(&headers), "trk:hdr", None, 0.0, true, false)
            .expect("play accepted");

        let lines = seen.join().expect("server thread");
        eprintln!("[header-test] request lines: {lines:#?}");
        assert!(lines.contains(&"User-Agent: UA/1.0 (KHTML, like Gecko)".to_string()),
            "the resolver's User-Agent must replace mpv's own — got {lines:#?}");
        assert!(lines.contains(&"Accept: text/html,application/xml;q=0.9".to_string()),
            "a comma-bearing value must arrive as ONE header — got {lines:#?}");
        for line in &lines[1..] {
            assert!(line.contains(':'), "every header line needs a colon; {line:?} is malformed");
            assert!(!line.starts_with('%'), "length-prefix escaping leaked onto the wire: {line:?}");
        }
    }

    /// The same guarantee for the **preload** path. It had none: `engine_preload`
    /// received the resolver's headers and passed only the URL, so an armed
    /// track was fetched under whatever headers the deck still held from the
    /// previous one — a signed CDN URL bound to a different User-Agent, i.e. a
    /// 403 that surfaced as "the arm was refused" and cost a full re-resolve on
    /// every gapless hand-off.
    #[test]
    fn test_preload_headers_reach_the_server_verbatim() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();

        let seen = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut lines = Vec::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 { break; }
                let line = line.trim_end_matches(['\r', '\n']).to_string();
                if line.is_empty() { break; }
                lines.push(line);
            }
            let mut s = stream;
            let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            lines
        });

        let (sink, _rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        let mut headers = HashMap::new();
        headers.insert("User-Agent".to_string(), "UA/1.0 (KHTML, like Gecko)".to_string());
        headers.insert("Accept".to_string(), "text/html,application/xml;q=0.9".to_string());
        // Crossfade arming loads on the standby deck straight away, so the
        // request goes out without needing a play in front of it.
        engine
            .preload(&format!("http://127.0.0.1:{port}/armed.m4a"), Some(&headers), "trk:arm", true)
            .expect("preload accepted");

        let lines = seen.join().expect("server thread");
        eprintln!("[preload-header-test] request lines: {lines:#?}");
        assert!(lines.contains(&"User-Agent: UA/1.0 (KHTML, like Gecko)".to_string()),
            "an armed track must carry its own resolver's User-Agent — got {lines:#?}");
        assert!(lines.contains(&"Accept: text/html,application/xml;q=0.9".to_string()),
            "a comma-bearing value must arrive as ONE header — got {lines:#?}");
    }

    /// Diagnostic probe for the yt-dlp / YouTube split-stream playback failure:
    /// feeds real, freshly-resolved googlevideo URLs through the exact call the
    /// app makes (`play_with_headers` + the per-file `audio-file` option), so the
    /// mpv-side failure can be observed without driving the GUI. Plays as an
    /// AUDIO session deliberately — a video session needs a window layer the test
    /// engine has no AppHandle for, and the failure under investigation is the
    /// stream open, which happens either way. Run:
    ///   VIBOPLR_PROBE_URL=… VIBOPLR_PROBE_AUDIO=… VIBOPLR_PROBE_HEADERS='{…}' \
    ///   cargo test probe_youtube_split_play -- --ignored --nocapture
    #[test]
    #[ignore]
    fn probe_youtube_split_play() {
        let Ok(url) = std::env::var("VIBOPLR_PROBE_URL") else {
            eprintln!("[probe] set VIBOPLR_PROBE_URL (optionally VIBOPLR_PROBE_AUDIO / _HEADERS / _CA)");
            return;
        };
        let audio = std::env::var("VIBOPLR_PROBE_AUDIO").ok();
        let headers: Option<HashMap<String, String>> = std::env::var("VIBOPLR_PROBE_HEADERS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        eprintln!("[probe] audio_track={} headers={:?}", audio.is_some(), headers);

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        if let Ok(ca) = std::env::var("VIBOPLR_PROBE_CA") {
            engine.set_tls_ca_file(std::path::Path::new(&ca)).expect("tls ca");
        }
        engine
            .play_with_headers(&url, audio.as_deref(), headers.as_ref(), "trk:probe", None, 0.5, false, false)
            .expect("play accepted");

        let deadline = Instant::now() + Duration::from_secs(30);
        let mut positions = 0;
        let mut verdict = "NO EVENTS (timed out)".to_string();
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(remaining) {
                Ok((n, p)) if n == "engine-position" => {
                    positions += 1;
                    if positions >= 4 {
                        verdict = format!("PLAYING (pos={})", p["positionSecs"]);
                        break;
                    }
                }
                Ok((n, p)) if n == "engine-error" => {
                    verdict = format!("ENGINE ERROR {p}");
                    break;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        eprintln!("[probe] VERDICT: {verdict}");
        eprintln!("[probe] media_info: {:?}", engine.media_info());
    }

    /// A source mpv can't demux as media but can read as a playlist is expanded
    /// into the deck's playlist — what happens to a YouTube HLS stream whose
    /// first segment is refused: ffmpeg's HLS demuxer gives up, mpv's generic
    /// playlist demuxer reads the `.m3u8` and queues every segment. Each entry
    /// then failed on its own, one engine error after another, ~2/s until
    /// something else was loaded (35 in one real log, all "no owning track").
    /// The failure of the track the frontend asked for must end the deck's
    /// playlist there.
    #[test]
    fn test_a_failed_track_does_not_play_on_through_an_expanded_playlist() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                let _ = reader.read_line(&mut first);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() { break; }
                }
                let path = first.split_whitespace().nth(1).unwrap_or("").to_string();
                seen.lock().unwrap().push(path.clone());
                let mut s = stream;
                if path == "/list.m3u" {
                    let body: String = (0..5).map(|i| format!("http://127.0.0.1:{port}/entry{i}.m4a\n")).collect();
                    let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: audio/x-mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                } else {
                    let _ = s.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
            }
        });

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine
            .play(&format!("http://127.0.0.1:{port}/list.m3u"), None, "trk:list", None, 0.5, false, false)
            .expect("play accepted");
        let err = wait_for(&rx, "engine-error", Duration::from_secs(10));
        assert_eq!(err["trackKey"], "trk:list");
        // Long enough for the next entries to have been tried, were they queued.
        std::thread::sleep(Duration::from_secs(3));
        let entries: Vec<String> = requests.lock().unwrap().iter().filter(|p| p.starts_with("/entry")).cloned().collect();
        assert_eq!(entries, vec!["/entry0.m4a".to_string()],
            "only the entry that failed may be requested — got {entries:?}");
        assert_eq!(rx.try_iter().filter(|(n, _)| n == "engine-error").count(), 0, "one failure, one error");
    }

    /// Network-dependent — run explicitly:
    /// `cargo test test_live_radio -- --ignored --nocapture`
    /// Plays a public Icecast stream and asserts ICY titles + live audio info.
    #[test]
    #[ignore]
    fn test_live_radio_stream_icy_and_audio_info() {
        let dir = tempfile::tempdir().unwrap();
        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.set_tls_ca_file(&test_ca_bundle(dir.path())).expect("tls ca");
        engine
            .play("https://ice1.somafm.com/groovesalad-128-mp3", None, "trk:radio", None, 0.5, false, false)
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
        let info = engine.media_info().expect("media info");
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
            .play(bogus.to_str().unwrap(), None, "trk:bad", None, 1.0, false, false)
            .expect("play command itself should be accepted");

        let err = wait_for(&rx, "engine-error", Duration::from_secs(10));
        assert_eq!(err["trackKey"], "trk:bad");
    }

    /// A stereo 440 Hz sine, 44.1 kHz 16-bit, the left channel at `amp(t)`
    /// (0..1 of full scale) and the right at half of it (6 dB lower).
    fn write_sine_wav(path: &std::path::Path, secs: f64, amp: impl Fn(f64) -> f64) {
        let sample_rate = 44100u32;
        let samples = (secs * sample_rate as f64) as u32;
        let data_len = samples * 4;
        let mut f = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + data_len).to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap(); // PCM
        f.write_all(&2u16.to_le_bytes()).unwrap(); // stereo
        f.write_all(&sample_rate.to_le_bytes()).unwrap();
        f.write_all(&(sample_rate * 4).to_le_bytes()).unwrap();
        f.write_all(&4u16.to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_len.to_le_bytes()).unwrap();
        for i in 0..samples {
            let t = i as f64 / sample_rate as f64;
            let s = (2.0 * std::f64::consts::PI * 440.0 * t).sin() * amp(t) * 32767.0;
            f.write_all(&(s as i16).to_le_bytes()).unwrap();
            f.write_all(&((s * 0.5) as i16).to_le_bytes()).unwrap();
        }
    }

    /// The next `engine-level` with readings (not a readout end).
    fn wait_for_level(rx: &mpsc::Receiver<(String, serde_json::Value)>) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let ev = wait_for(rx, "engine-level", deadline.saturating_duration_since(Instant::now()));
            if !ev["peakDb"].is_null() {
                return ev;
            }
        }
    }

    fn db_values(v: &serde_json::Value) -> Vec<f64> {
        v.as_array().expect("array of dB").iter().map(|x| x.as_f64().unwrap()).collect()
    }

    fn af_of(engine: &Engine, deck: usize) -> String {
        engine.decks[deck].mpv.get_property::<String>("af").unwrap_or_default()
    }

    #[test]
    fn test_meter_reports_per_channel_levels() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("sine.wav");
        write_sine_wav(&wav, 3.0, |_| 0.5); // L -6.02 dBFS, R -12.04 dBFS

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.apply_meter(true, &EqParams::default()).expect("meter on");
        engine
            .play(wav.to_str().unwrap(), None, "trk:sine", None, 1.0, false, false)
            .expect("play");

        let level = wait_for_level(&rx);
        assert_eq!(level["trackKey"], "trk:sine");
        let peak = db_values(&level["peakDb"]);
        let rms = db_values(&level["rmsDb"]);
        assert_eq!(peak.len(), 2, "one value per channel");
        assert!((peak[0] + 6.02).abs() < 0.15, "left peak {peak:?}");
        assert!((peak[1] + 12.04).abs() < 0.15, "right peak {peak:?}");
        // A sine's RMS sits 3.01 dB under its peak.
        assert!((rms[0] + 9.03).abs() < 0.15, "left rms {rms:?}");
        assert!((rms[1] + 15.05).abs() < 0.15, "right rms {rms:?}");
        // Pre-fader: the user's volume doesn't move the meter.
        engine.apply_volume(0.1, false).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let after: Vec<_> = rx.try_iter().filter(|(n, p)| n == "engine-level" && !p["peakDb"].is_null()).collect();
        assert!(after.is_empty(), "a steady tone at any volume sends nothing new: {after:?}");
        engine.stop().expect("stop");
    }

    /// The meter is pre-ReplayGain: mpv applies ReplayGain together with the
    /// volume, as one output gain after the `af` chain.
    #[test]
    fn test_meter_reads_before_replaygain() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("sine.wav");
        write_sine_wav(&wav, 3.0, |_| 0.5); // L -6.02 dBFS

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine
            .apply_replaygain(&ReplayGainParams { mode: "track".into(), preamp_db: 0.0, prevent_clip: false })
            .unwrap();
        // The file has no ReplayGain tags, so the fallback gain is what applies.
        for deck in &engine.decks {
            deck.mpv.set_property("replaygain-fallback", -20.0).unwrap();
        }
        engine.apply_meter(true, &EqParams::default()).expect("meter on");
        engine
            .play(wav.to_str().unwrap(), None, "trk:rg", None, 1.0, false, false)
            .expect("play");
        let level = wait_for_level(&rx);
        let peak = db_values(&level["peakDb"]);
        assert!((peak[0] + 6.02).abs() < 0.15, "-20 dB of ReplayGain must not reach the meter: {peak:?}");
        engine.stop().expect("stop");
    }

    #[test]
    fn test_meter_follows_a_moving_level_at_its_poll_rate() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("sweep.wav");
        // -40 dB to 0 dB over 3s (~13 dB/s): every poll crosses the 0.5 dB gate,
        // so the event count measures the achieved cadence.
        write_sine_wav(&wav, 3.0, |t| 10f64.powf((-40.0 + t / 3.0 * 40.0) / 20.0));

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.apply_meter(true, &EqParams::default()).expect("meter on");
        engine
            .play(wav.to_str().unwrap(), None, "trk:sweep", None, 1.0, false, false)
            .expect("play");
        let first = wait_for_level(&rx);
        let start = Instant::now();
        let mut readings = vec![db_values(&first["peakDb"])[0]];
        while start.elapsed() < Duration::from_millis(1500) {
            if let Ok((name, p)) = rx.recv_timeout(Duration::from_millis(50)) {
                if name == "engine-level" && !p["peakDb"].is_null() {
                    readings.push(db_values(&p["peakDb"])[0]);
                }
            }
        }
        eprintln!("[meter-test] {} readings in 1.5s: {readings:?}", readings.len());
        // ~11 Hz measured (mpv's filter bursts, see the probe below); well above
        // the 2 Hz the loop's 0.5s wait would give. The floor is 4 Hz, not the
        // measured rate: a contended CI runner (macos-latest) delivered 8.
        assert!(readings.len() >= 6, "only {} readings in 1.5s", readings.len());
        assert!(readings.last() > readings.first(), "the sweep rises: {readings:?}");
        engine.stop().expect("stop");
    }

    #[test]
    fn test_meter_readout_ends_on_pause_and_stays_quiet() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("sine.wav");
        write_sine_wav(&wav, 4.0, |_| 0.5);

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.apply_meter(true, &EqParams::default()).expect("meter on");
        engine
            .play(wav.to_str().unwrap(), None, "trk:pause", None, 1.0, false, false)
            .expect("play");
        wait_for_level(&rx);

        engine.decks[engine.state.lock().unwrap().active].mpv.set_property("pause", true).unwrap();
        let ended = wait_for(&rx, "engine-level", Duration::from_secs(2));
        assert_eq!(ended["trackKey"], "trk:pause");
        assert!(ended["peakDb"].is_null() && ended["rmsDb"].is_null(), "readout ended: {ended}");
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            rx.try_iter().all(|(n, _)| n != "engine-level"),
            "mpv's frozen last frame must not be reported while paused"
        );

        // Resuming into the same level re-lights it (the gate forgot it).
        engine.decks[engine.state.lock().unwrap().active].mpv.set_property("pause", false).unwrap();
        let back = wait_for_level(&rx);
        assert!((db_values(&back["peakDb"])[0] + 6.02).abs() < 0.15);
        engine.stop().expect("stop");
    }

    #[test]
    fn test_meter_off_measures_and_emits_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("sine.wav");
        write_sine_wav(&wav, 0.8, |_| 0.5);

        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        // Only the always-on waveform capture: no meter until someone asks.
        let af = af_of(&engine, 0);
        assert!(af.contains(wave_capture::WAVE_LABEL) && !af.contains(meter::METER_LABEL), "no meter until someone asks: {af}");
        engine
            .play(wav.to_str().unwrap(), None, "trk:off", None, 1.0, false, false)
            .expect("play");
        let mut saw_level = false;
        let deadline = Instant::now() + Duration::from_secs(10);
        while let Ok((name, _)) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            saw_level |= name == "engine-level";
            if name == "engine-ended" {
                break;
            }
        }
        assert!(!saw_level, "engine-level while the meter is off");
    }

    /// How often the meter's source actually updates, under the real audio
    /// output (silent: started at volume 0, which is after the meter, so the
    /// readings are unaffected). `#[ignore]`d because it opens the machine's
    /// default device. Run with:
    /// `cargo test --lib probe_meter_update_rate_real_ao -- --ignored --nocapture`
    ///
    /// Measured 2026-10-14 (macOS, CoreAudio, a WAV sweep): ~17 changes in 1.5s,
    /// i.e. ~11 Hz, the same as under `ao=null`. mpv runs the filter chain in
    /// ~90ms bursts and `af-metadata` holds the last frame of each, so that is
    /// the ceiling; polling faster only reads duplicates the gate drops.
    #[test]
    #[ignore]
    fn probe_meter_update_rate_real_ao() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("sweep.wav");
        write_sine_wav(&wav, 3.0, |t| 10f64.powf((-40.0 + t / 3.0 * 40.0) / 20.0));
        if super::ffi::libmpv().is_err() {
            eprintln!("[probe] SKIPPED — libmpv not available");
            return;
        }
        let (sink, rx) = collect_events();
        let engine = Engine::new(sink, None, None).expect("engine");
        engine.apply_meter(true, &EqParams::default()).unwrap();
        engine.play(wav.to_str().unwrap(), None, "k", None, 0.0, false, false).unwrap();
        wait_for_level(&rx);
        let m = engine.decks[0].mpv.clone();
        let label = format!("af-metadata/{}", meter::METER_LABEL);
        let (mut last, mut changes, t0) = (String::new(), 0, Instant::now());
        while t0.elapsed() < Duration::from_millis(1500) {
            let v = m.get_property::<String>(&label).unwrap_or_default();
            if v != last {
                changes += 1;
                last = v;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        eprintln!(
            "[probe] af-metadata changes in 1.5s: {changes} (ao={:?})",
            m.get_property::<String>("current-ao")
        );
        engine.stop().unwrap();
    }

    #[test]
    fn test_a_rejected_meter_keeps_the_eq_working() {
        let (sink, _rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        let eq = EqParams {
            enabled: true,
            mode: "advanced".into(),
            gains: vec![3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            ..Default::default()
        };
        // An unknown filter *name* is rejected when set. (An unknown lavfi
        // option is not — that case is what `ffmpeg_supports_meter` guards.)
        meter::FILTER_OVERRIDE.with(|o| *o.borrow_mut() = Some("@vibometer:no_such_filter".into()));
        let result = engine.apply_meter(true, &eq);
        meter::FILTER_OVERRIDE.with(|o| *o.borrow_mut() = None);
        assert!(result.is_err(), "mpv must reject the bogus filter");
        assert!(!engine.state.lock().unwrap().meter, "the flag is dropped");
        assert!(af_of(&engine, 0).contains("equalizer"), "the EQ is restored: {}", af_of(&engine, 0));
        // And later EQ changes still apply.
        engine.apply_eq(&EqParams::default()).expect("EQ still works after a failed meter");
    }

    #[test]
    fn test_meter_and_eq_share_the_af_chain() {
        let (sink, _rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        let eq = EqParams {
            enabled: true,
            mode: "advanced".into(),
            gains: vec![3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            ..Default::default()
        };
        engine.apply_eq(&eq).unwrap();
        engine.apply_meter(true, &eq).unwrap();
        for i in 0..2 {
            let af = af_of(&engine, i);
            assert!(af.contains("equalizer") && af.contains(meter::METER_LABEL), "deck {i}: {af}");
        }
        // An EQ change keeps the meter, and turning the meter off keeps the EQ.
        engine.apply_eq(&EqParams::default()).unwrap();
        assert!(af_of(&engine, 0).contains(meter::METER_LABEL));
        assert!(!af_of(&engine, 0).contains("equalizer"));
        engine.apply_meter(false, &eq).unwrap();
        let af = af_of(&engine, 0);
        assert!(af.contains("equalizer") && !af.contains(meter::METER_LABEL), "{af}");
    }

    /// Per-second level of the capture test files: second `i` at `LEVELS[i]`.
    /// Steps of ~6 dB: the capture is placed per read (one or two mpv decode
    /// bursts — a 4096-frame chunk of a WAV is ~93ms), so the read straddling
    /// a boundary is split evenly and a loud second bleeds a little into a
    /// quiet one. A 20 dB step makes that bleed dominate the quiet second; a
    /// capture placed by `time-pos` instead would be ~0.5s off and miss every
    /// step by ~50%.
    const LEVELS: [f64; 4] = [0.5, 0.25, 0.35, 0.5];

    fn stepped_amp(t: f64) -> f64 {
        LEVELS[(t as usize).min(LEVELS.len() - 1)]
    }

    /// RMS the capture should report for a second of `write_sine_wav` at
    /// `amp`: left at amp, right at half, averaged in the power domain.
    fn expected_rms(amp: f64) -> f32 {
        ((amp * amp / 2.0 + amp * amp / 8.0) / 2.0).sqrt() as f32
    }

    fn assert_levels(s: &WaveSnapshot, seconds: &[usize]) {
        for &i in seconds {
            let got = s.rms[i].unwrap_or_else(|| panic!("second {i} not heard: {:?}", s.rms));
            let want = expected_rms(LEVELS[i]);
            // Up to ~15% for the read a neighbouring second shares with this
            // one: a read that caught two bursts straddling the boundary is
            // split evenly, which moves a loud second's energy into a quiet
            // one. Misplacement would be ~50% (the AO lead is ~0.5s).
            assert!((got - want).abs() / want < 0.15, "second {i}: {got} vs {want} ({:?})", s.rms);
        }
    }

    #[test]
    fn test_wave_capture_records_a_whole_play_second_by_second() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("steps.wav");
        write_sine_wav(&wav, LEVELS.len() as f64, stepped_amp);
        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        assert!(af_of(&engine, 0).contains(wave_capture::WAVE_LABEL), "the capture is on from creation");
        engine.play(wav.to_str().unwrap(), None, "trk:steps", None, 1.0, false, false).unwrap();
        wait_for(&rx, "engine-ended", Duration::from_secs(10));
        let s = engine.wave_snapshot("trk:steps").expect("kept after the track ended");
        assert_eq!(s.rms.len(), LEVELS.len());
        // A full listen covers the track, short of at most the last decode
        // burst or two (~93ms each): mpv drops the filter soon after EOF, and a
        // busy machine can read too late for the final one. On a real track
        // that is well inside the frontend's 1% allowance.
        let heard = s.coverage * LEVELS.len() as f64;
        assert!(heard >= LEVELS.len() as f64 - 0.2, "a full listen covers the track: {s:?}");
        // Placed by decode position: a capture aligned to `time-pos` would be
        // ~0.5s late and smear every step into the next second.
        assert_levels(&s, &[0, 1, 2, 3]);
    }

    /// The track the queue advances to is captured too, by either arm: a
    /// gapless successor (same deck) and a crossfade arm (the standby deck,
    /// loaded paused).
    fn assert_successor_captured(crossfade: bool) {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.wav");
        let b = dir.path().join("b.wav");
        write_sine_wav(&a, 2.0, |_| 0.5);
        write_sine_wav(&b, LEVELS.len() as f64, stepped_amp);
        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.play(a.to_str().unwrap(), None, "trk:a", None, 1.0, false, false).unwrap();
        wait_for(&rx, "engine-playback-restart", Duration::from_secs(5));
        engine.preload(b.to_str().unwrap(), None, "trk:b", crossfade).unwrap();
        wait_for(&rx, "engine-ended", Duration::from_secs(15));
        let s = engine.wave_snapshot("trk:b").expect("the successor has a capture");
        let heard = s.coverage * LEVELS.len() as f64;
        // Half a second of slack: a contended CI runner (macos-latest) captured
        // 3.72s of 4. A successor that isn't captured scores ~0, and
        // `assert_levels` still checks every second's level.
        assert!(heard >= LEVELS.len() as f64 - 0.5, "crossfade={crossfade}: {s:?}");
        assert_levels(&s, &[0, 1, 2, 3]);
    }

    #[test]
    fn test_wave_capture_follows_a_gapless_successor() {
        assert_successor_captured(false);
    }

    #[test]
    fn test_wave_capture_follows_a_crossfade_arm() {
        assert_successor_captured(true);
    }

    #[test]
    fn test_wave_capture_places_a_seek_at_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("steps.wav");
        write_sine_wav(&wav, LEVELS.len() as f64, stepped_amp);
        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.play(wav.to_str().unwrap(), None, "trk:seek", None, 1.0, false, false).unwrap();
        wait_for(&rx, "engine-playback-restart", Duration::from_secs(5));
        engine.seek(2.0).unwrap();
        wait_for(&rx, "engine-ended", Duration::from_secs(10));
        let s = engine.wave_snapshot("trk:seek").unwrap();
        assert_levels(&s, &[2, 3]);
        assert!(s.coverage < 0.99, "the skipped span stays unheard: {s:?}");
        assert!(s.rms[1].is_none(), "second 1 was skipped: {:?}", s.rms);
    }

    /// Compare the captured waveform of a real track with the ffmpeg
    /// provider's (`waveform.rs`) for the same file. Plays the whole track at
    /// real time (`ao=null`): no `speed` or untimed output, which would change
    /// mpv's burst size and so how the capture places frames.
    ///
    /// `VIBOPLR_WAVE_COMPARE=/path/to/song.flac cargo test --lib probe_wave_capture_vs_ffmpeg -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn probe_wave_capture_vs_ffmpeg() {
        let Ok(path) = std::env::var("VIBOPLR_WAVE_COMPARE") else {
            eprintln!("[compare] set VIBOPLR_WAVE_COMPARE to a music file");
            return;
        };
        let reference = crate::waveform::analyze(&path, "probe-compare").expect("ffmpeg analysis");
        let (sink, rx) = collect_events();
        let Some(engine) = try_test_engine(sink) else { return };
        engine.play(&path, None, "trk:compare", None, 1.0, false, false).unwrap();
        let ended = Instant::now() + Duration::from_secs(reference.len() as u64 + 30);
        wait_for(&rx, "engine-ended", ended.saturating_duration_since(Instant::now()));
        let s = engine.wave_snapshot("trk:compare").unwrap();
        let captured: Vec<f64> = s.rms.iter().map(|v| v.unwrap_or(0.0) as f64).collect();
        let reference: Vec<f64> = reference.iter().map(|&v| v as f64).collect();
        eprintln!(
            "[compare] {} buckets captured vs {} from ffmpeg, coverage {:.4}, unheard {}",
            captured.len(),
            reference.len(),
            s.coverage,
            s.rms.iter().filter(|v| v.is_none()).count()
        );
        let n = captured.len().min(reference.len());
        let pearson = |a: &[f64], b: &[f64]| {
            let (ma, mb) = (a.iter().sum::<f64>() / a.len() as f64, b.iter().sum::<f64>() / b.len() as f64);
            let cov: f64 = a.iter().zip(b).map(|(x, y)| (x - ma) * (y - mb)).sum();
            let va: f64 = a.iter().map(|x| (x - ma).powi(2)).sum();
            let vb: f64 = b.iter().map(|y| (y - mb).powi(2)).sum();
            cov / (va * vb).sqrt()
        };
        for lag in [-1i64, 0, 1] {
            let (a, b): (Vec<f64>, Vec<f64>) = (0..n as i64)
                .filter_map(|i| {
                    let j = i + lag;
                    (j >= 0 && (j as usize) < n).then(|| (captured[i as usize], reference[j as usize]))
                })
                .unzip();
            eprintln!("[compare] pearson r at lag {lag:+}: {:.4}", pearson(&a, &b));
        }
        // What the user sees: the frontend's shapePeaks (normalize to the
        // loudest second, then the 1.8 display curve, floor 0.03).
        let shape = |v: &[f64]| {
            let max = v.iter().cloned().fold(0.0, f64::max).max(f64::MIN_POSITIVE);
            v.iter().map(|x| 0.03 + 0.97 * (x / max).clamp(0.0, 1.0).powf(1.8)).collect::<Vec<_>>()
        };
        let (sa, sb) = (shape(&captured[..n]), shape(&reference[..n]));
        let diffs: Vec<f64> = sa.iter().zip(&sb).map(|(x, y)| (x - y).abs()).collect();
        let mean = diffs.iter().sum::<f64>() / n as f64;
        let max = diffs.iter().cloned().fold(0.0, f64::max);
        let worst = diffs.iter().position(|d| *d == max).unwrap_or(0);
        eprintln!("[compare] bar height diff: mean {mean:.4}, max {max:.4} at {worst}s (capture {:.3}, ffmpeg {:.3})", sa[worst], sb[worst]);
        // Raw level ratio, which shows a systematic offset (downmix vs mean square).
        let ratios: Vec<f64> = (0..n).filter(|&i| reference[i] > 1e-4).map(|i| captured[i] / reference[i]).collect();
        let mut sorted = ratios.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if !sorted.is_empty() {
            eprintln!(
                "[compare] capture/ffmpeg RMS ratio: median {:.3}, p5 {:.3}, p95 {:.3}",
                sorted[sorted.len() / 2],
                sorted[sorted.len() * 5 / 100],
                sorted[(sorted.len() * 95 / 100).min(sorted.len() - 1)]
            );
        }
        eprintln!("[compare] second  capture  ffmpeg  (shaped)");
        for i in 0..n {
            eprintln!("[compare] {i:>5}  {:.3}    {:.3}", sa[i], sb[i]);
        }
    }
}
