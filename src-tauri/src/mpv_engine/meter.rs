//! Live level meter: per-channel peak and RMS of what the active deck is
//! decoding, read from an ffmpeg `astats` filter through mpv's
//! `af-metadata/<label>` property.
//!
//! What the reading is, and isn't. Each one is measured in mpv's own filter
//! chain, so:
//!
//! - **Post-EQ, pre-ReplayGain, pre-volume.** The meter sits after the EQ
//!   graph. mpv applies ReplayGain and `volume` together as one output gain
//!   after the filter chain, so neither the slider nor ReplayGain moves the
//!   meter (`test_meter_reads_before_replaygain`). That's intended: it's a
//!   program meter, so a loud master reads loud at any volume.
//! - **One decoded chunk, not every sample.** `reset=1` restarts the stats on
//!   every audio frame, and the property holds only the latest frame's
//!   numbers (~20–100ms depending on the codec), updated ~11 Hz. A transient
//!   in a frame nobody read is missed. That's fine for a visual meter with
//!   decay, but this isn't a true-peak or PPM reading.
//! - **Ahead of the speaker** by the audio output's buffer: the filter runs
//!   at decode time.
//! - **Frozen while paused.** mpv keeps the last frame's metadata, so the
//!   poller only reads while the deck is actually playing (`core-idle`), and
//!   the frontend clears its copy on pause.

use std::time::Duration;

/// How often the meter is read while it's on and the active deck is playing.
/// The reading itself changes only ~11 Hz — mpv runs the filter chain in ~90ms
/// bursts and keeps the last frame of each (`probe_meter_update_rate_real_ao`)
/// — so polling at ~15 Hz catches each update promptly, and the duplicate reads
/// in between are dropped by the change gate before anything is emitted.
pub const METER_POLL_INTERVAL: Duration = Duration::from_millis(66);

/// Readings are clamped here. Digital silence prints `-inf`, and
/// `serde_json` serializes a non-finite float as `null`, so the payload would
/// otherwise silently lose the value.
pub const METER_FLOOR_DB: f64 = -90.0;

/// Upper clamp. A float decoder can legitimately report overs (a lossy
/// master clipped in encoding), so 0 dBFS is not the ceiling, but nothing
/// sane is anywhere near this.
const METER_CEIL_DB: f64 = 24.0;

/// More than any real layout (7.1.4 is 12). Guards the parse loop against a
/// malformed property, not real files.
const MAX_CHANNELS: usize = 16;

/// The filter label, read back as `af-metadata/<label>`.
pub const METER_LABEL: &str = "vibometer";

/// The `af` entry that carries the meter. `measure_overall=none` skips the
/// combined stats, and the per-channel set is limited to the two numbers we
/// read, so astats computes as little as it can.
pub fn meter_filter() -> String {
    #[cfg(test)]
    if let Some(f) = FILTER_OVERRIDE.with(|o| o.borrow().clone()) {
        return f;
    }
    format!(
        "@{METER_LABEL}:lavfi=[astats=metadata=1:reset=1:measure_overall=none:measure_perchannel=Peak_level+RMS_level]"
    )
}

/// Whether an ffmpeg version string (mpv's `ffmpeg-version`) carries the
/// astats options [`meter_filter`] uses — `measure_perchannel` and
/// `measure_overall` arrived in FFmpeg 4.4. A development snapshot
/// (`N-125352-g…`, what the bundled libmpv reports) is current by
/// construction. Anything that doesn't parse is refused: an unbuildable meter
/// costs the next track its audio (see `Engine::apply_meter`), so guessing
/// wrong is not cheap.
pub fn ffmpeg_supports_meter(version: &str) -> bool {
    let v = version.trim();
    if v.starts_with("N-") {
        return true;
    }
    let v = v.trim_start_matches(|c: char| c == 'n' || c == 'v');
    let mut parts = v.split(|c: char| !c.is_ascii_digit());
    let major = parts.next().and_then(|p| p.parse::<u32>().ok());
    let minor = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
    match major {
        Some(major) => (major, minor) >= (4, 4),
        None => false,
    }
}

#[cfg(test)]
thread_local! {
    /// Test-only: a filter mpv rejects, to exercise the failure path.
    pub static FILTER_OVERRIDE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// mpv's `af` value for an EQ graph plus, optionally, the waveform capture
/// and the meter. The capture goes first so a waveform doesn't depend on the
/// listener's EQ; the meter goes last so it measures what the EQ produced.
pub fn af_chain(eq_graph: &str, meter: bool, capture: bool) -> String {
    let mut parts = Vec::new();
    if capture {
        parts.push(super::wave_capture::wave_filter());
    }
    if !eq_graph.is_empty() {
        parts.push(format!("lavfi=[{eq_graph}]"));
    }
    if meter {
        parts.push(meter_filter());
    }
    parts.join(",")
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeterReading {
    /// Per channel, in dBFS, clamped to [`METER_FLOOR_DB`, +24].
    pub peak_db: Vec<f64>,
    pub rms_db: Vec<f64>,
}

/// The value of `af-metadata/<label>` (mpv formats the node map as JSON with
/// every value a string), parsed into a reading. `None` when there's no
/// channel to report, e.g. before the first frame has gone through.
pub fn parse_meter(json: &str) -> Option<MeterReading> {
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(json).ok()?;
    let read = |ch: usize, stat: &str| -> Option<f64> {
        let raw = map.get(&format!("lavfi.astats.{ch}.{stat}"))?.as_str()?;
        Some(clamp_db(raw.trim().parse::<f64>().ok()?))
    };
    let mut peak_db = Vec::new();
    let mut rms_db = Vec::new();
    for ch in 1..=MAX_CHANNELS {
        match (read(ch, "Peak_level"), read(ch, "RMS_level")) {
            (Some(p), Some(r)) => {
                peak_db.push(p);
                rms_db.push(r);
            }
            _ => break,
        }
    }
    (!peak_db.is_empty()).then_some(MeterReading { peak_db, rms_db })
}

fn clamp_db(v: f64) -> f64 {
    if v.is_nan() {
        METER_FLOOR_DB
    } else {
        // -inf / +inf clamp like any other out-of-range value.
        v.clamp(METER_FLOOR_DB, METER_CEIL_DB)
    }
}

/// The emit gate's comparison key: every value to the nearest 0.5 dB. A
/// steady tone (or silence) then sends nothing after its first reading,
/// while any movement a meter could show still goes out.
pub type MeterFingerprint = Vec<i32>;

pub fn meter_fingerprint(r: &MeterReading) -> MeterFingerprint {
    r.peak_db.iter().chain(&r.rms_db).map(|v| (v * 2.0).round() as i32).collect()
}

/// A value for the wire: 0.1 dB is finer than any meter draws.
pub fn round_db(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim from real libmpv, a stereo sine at -6 / -12 dBFS.
    const STEREO: &str = r#"{"lavfi.astats.1.Peak_level":"-6.020865","lavfi.astats.1.RMS_level":"-9.032227","lavfi.astats.2.Peak_level":"-12.041995","lavfi.astats.2.RMS_level":"-15.053153"}"#;

    #[test]
    fn test_parses_per_channel_peak_and_rms() {
        let r = parse_meter(STEREO).unwrap();
        assert_eq!(r.peak_db, vec![-6.020865, -12.041995]);
        assert_eq!(r.rms_db, vec![-9.032227, -15.053153]);
    }

    #[test]
    fn test_ignores_overall_stats_and_unknown_keys() {
        let json = r#"{"lavfi.astats.Overall.Peak_level":"-1.0","lavfi.astats.1.Peak_level":"-3.0","lavfi.astats.1.RMS_level":"-6.0","lavfi.astats.1.DC_offset":"0.0"}"#;
        let r = parse_meter(json).unwrap();
        assert_eq!(r.peak_db, vec![-3.0]);
        assert_eq!(r.rms_db, vec![-6.0]);
    }

    #[test]
    fn test_silence_clamps_to_the_floor() {
        let json = r#"{"lavfi.astats.1.Peak_level":"-inf","lavfi.astats.1.RMS_level":"-inf"}"#;
        let r = parse_meter(json).unwrap();
        assert_eq!(r.peak_db, vec![METER_FLOOR_DB]);
        assert_eq!(r.rms_db, vec![METER_FLOOR_DB]);
        // Clamped values must survive serialization (a raw -inf becomes null).
        assert_eq!(serde_json::json!(r.peak_db[0]), serde_json::json!(-90.0));
    }

    #[test]
    fn test_nan_and_overs_are_clamped() {
        let json = r#"{"lavfi.astats.1.Peak_level":"nan","lavfi.astats.1.RMS_level":"inf","lavfi.astats.2.Peak_level":"1.5","lavfi.astats.2.RMS_level":"-2.0"}"#;
        let r = parse_meter(json).unwrap();
        assert_eq!(r.peak_db, vec![METER_FLOOR_DB, 1.5]);
        assert_eq!(r.rms_db, vec![24.0, -2.0]);
    }

    #[test]
    fn test_no_channels_is_none() {
        assert_eq!(parse_meter("{}"), None);
        assert_eq!(parse_meter(""), None);
        assert_eq!(parse_meter("not json"), None);
        // A channel with only one of the two stats isn't a reading.
        assert_eq!(parse_meter(r#"{"lavfi.astats.1.Peak_level":"-3.0"}"#), None);
        assert_eq!(parse_meter(r#"{"lavfi.astats.1.Peak_level":"garbage","lavfi.astats.1.RMS_level":"-3"}"#), None);
    }

    #[test]
    fn test_channels_stop_at_the_first_gap() {
        let json = r#"{"lavfi.astats.1.Peak_level":"-1","lavfi.astats.1.RMS_level":"-2","lavfi.astats.3.Peak_level":"-1","lavfi.astats.3.RMS_level":"-2"}"#;
        assert_eq!(parse_meter(json).unwrap().peak_db.len(), 1);
    }

    #[test]
    fn test_fingerprint_ignores_sub_half_db_jitter() {
        let a = parse_meter(STEREO).unwrap();
        let mut b = a.clone();
        b.rms_db[0] += 0.05;
        assert_eq!(meter_fingerprint(&a), meter_fingerprint(&b));
        b.rms_db[0] += 1.0;
        assert_ne!(meter_fingerprint(&a), meter_fingerprint(&b));
    }

    #[test]
    fn test_ffmpeg_version_gate() {
        // What the bundled libmpv reports.
        assert!(ffmpeg_supports_meter("N-125352-g613d65d508"));
        assert!(ffmpeg_supports_meter("7.1"));
        assert!(ffmpeg_supports_meter("n6.1.1"));
        assert!(ffmpeg_supports_meter("4.4.2-0ubuntu0.22.04.1"));
        assert!(ffmpeg_supports_meter("4.4"));
        assert!(!ffmpeg_supports_meter("4.3.6"));
        assert!(!ffmpeg_supports_meter("n4.2"));
        assert!(!ffmpeg_supports_meter("3.4.11"));
        assert!(!ffmpeg_supports_meter(""));
        assert!(!ffmpeg_supports_meter("unknown"));
    }

    #[test]
    fn test_af_chain_composition() {
        assert_eq!(af_chain("", false, false), "");
        assert_eq!(af_chain("volume=-2.0dB", false, false), "lavfi=[volume=-2.0dB]");
        assert_eq!(af_chain("", true, false), meter_filter());
        assert_eq!(
            af_chain("volume=-2.0dB", true, false),
            format!("lavfi=[volume=-2.0dB],{}", meter_filter())
        );
        // The capture goes first, so the waveform is the same at any EQ.
        assert_eq!(
            af_chain("volume=-2.0dB", true, true),
            format!("{},lavfi=[volume=-2.0dB],{}", super::super::wave_capture::wave_filter(), meter_filter())
        );
    }
}
