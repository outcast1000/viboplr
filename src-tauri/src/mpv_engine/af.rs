//! EQ → ffmpeg filtergraph mapping for the mpv engine.
//!
//! Mirrors the Web Audio graph in `src/hooks/usePlayback.ts` /
//! `src/eqPresets.ts`: 10 peaking biquads (advanced mode) or two shelves
//! (simple mode), pre-gain, and a brick-wall limiter engaged only while a
//! simple-mode boost can clip. The constants below are the single Rust copy of
//! the eqPresets.ts values — the unit tests pin them so drift is caught.

use serde::Deserialize;

/// Band center frequencies (Hz) — mirrors `BANDS` in src/eqPresets.ts.
pub const BANDS: [u32; 10] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
/// Peaking-band Q — mirrors `BAND_Q`.
pub const BAND_Q: f64 = 1.41;
/// Simple-mode shelf corners — mirror `SHELF_BASS_FREQ` / `SHELF_TREBLE_FREQ`.
pub const SHELF_BASS_FREQ: u32 = 100;
pub const SHELF_TREBLE_FREQ: u32 = 10000;
/// Limiter ceiling (dBFS) for simple-mode boosts — mirrors `LIMITER_CEILING_DB`
/// in usePlayback.ts (DynamicsCompressor: ratio 20, attack 3 ms, release 250 ms).
pub const LIMITER_CEILING_DB: f64 = -1.0;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqParams {
    pub enabled: bool,
    /// "advanced" | "simple"
    pub mode: String,
    /// 10 per-band gains (dB), advanced mode.
    pub gains: Vec<f64>,
    /// Advanced-mode pre-gain (dB). Simple mode never attenuates (limiter instead).
    pub pre_gain_db: f64,
    pub bass_db: f64,
    pub treble_db: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayGainParams {
    /// "off" | "track" | "album"
    pub mode: String,
    pub preamp_db: f64,
    pub prevent_clip: bool,
}

impl Default for ReplayGainParams {
    fn default() -> Self {
        ReplayGainParams { mode: "off".into(), preamp_db: 0.0, prevent_clip: true }
    }
}

/// The ffmpeg filtergraph for these EQ settings, or an empty string when the
/// chain is a no-op. The caller wraps it as mpv's `af=lavfi=[<graph>]`.
pub fn build_af_graph(eq: &EqParams) -> String {
    if !eq.enabled {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    if eq.mode == "simple" {
        if eq.bass_db != 0.0 {
            parts.push(format!("bass=g={:.1}:f={}", eq.bass_db, SHELF_BASS_FREQ));
        }
        if eq.treble_db != 0.0 {
            parts.push(format!("treble=g={:.1}:f={}", eq.treble_db, SHELF_TREBLE_FREQ));
        }
        // Limiter only when a boost can push peaks past the ceiling — cuts and
        // flat can't clip, and the dry path stays clean (parity with
        // limiterThresholdDb in usePlayback.ts).
        if eq.bass_db.max(eq.treble_db) > 0.0 {
            let limit = 10f64.powf(LIMITER_CEILING_DB / 20.0);
            parts.push(format!("alimiter=limit={limit:.4}:attack=3:release=250:level=false"));
        }
    } else {
        for (i, g) in eq.gains.iter().take(BANDS.len()).enumerate() {
            if *g != 0.0 {
                parts.push(format!("equalizer=f={}:t=q:w={}:g={:.1}", BANDS[i], BAND_Q, g));
            }
        }
        if eq.pre_gain_db != 0.0 {
            parts.push(format!("volume={:.1}dB", eq.pre_gain_db));
        }
    }
    parts.join(",")
}

/// mpv `replaygain` option value for a frontend mode string.
pub fn replaygain_mode_value(mode: &str) -> &'static str {
    match mode {
        "track" => "track",
        "album" => "album",
        _ => "no",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eq(enabled: bool, mode: &str) -> EqParams {
        EqParams {
            enabled,
            mode: mode.into(),
            gains: vec![0.0; 10],
            pre_gain_db: 0.0,
            bass_db: 0.0,
            treble_db: 0.0,
        }
    }

    #[test]
    fn test_disabled_eq_is_empty_graph() {
        let mut p = eq(false, "advanced");
        p.gains[0] = 6.0;
        assert_eq!(build_af_graph(&p), "");
    }

    #[test]
    fn test_flat_advanced_is_empty_graph() {
        assert_eq!(build_af_graph(&eq(true, "advanced")), "");
    }

    #[test]
    fn test_advanced_bands_match_eqpresets_constants() {
        let mut p = eq(true, "advanced");
        p.gains = vec![6.0, 5.0, 4.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]; // "Bass Boost" preset
        assert_eq!(
            build_af_graph(&p),
            "equalizer=f=31:t=q:w=1.41:g=6.0,\
             equalizer=f=62:t=q:w=1.41:g=5.0,\
             equalizer=f=125:t=q:w=1.41:g=4.0,\
             equalizer=f=250:t=q:w=1.41:g=2.0"
                .replace(char::is_whitespace, "")
        );
    }

    #[test]
    fn test_advanced_pre_gain_appended() {
        let mut p = eq(true, "advanced");
        p.gains[9] = -3.0;
        p.pre_gain_db = -2.5;
        assert_eq!(build_af_graph(&p), "equalizer=f=16000:t=q:w=1.41:g=-3.0,volume=-2.5dB");
    }

    #[test]
    fn test_simple_shelves_and_limiter_on_boost() {
        let mut p = eq(true, "simple");
        p.bass_db = 5.0;
        p.treble_db = -2.0;
        // -1 dBFS ceiling → linear 0.8913
        assert_eq!(
            build_af_graph(&p),
            "bass=g=5.0:f=100,treble=g=-2.0:f=10000,alimiter=limit=0.8913:attack=3:release=250:level=false"
        );
    }

    #[test]
    fn test_simple_cuts_skip_limiter() {
        let mut p = eq(true, "simple");
        p.bass_db = -4.0;
        p.treble_db = -1.0;
        assert_eq!(build_af_graph(&p), "bass=g=-4.0:f=100,treble=g=-1.0:f=10000");
    }

    #[test]
    fn test_replaygain_mode_mapping() {
        assert_eq!(replaygain_mode_value("off"), "no");
        assert_eq!(replaygain_mode_value("track"), "track");
        assert_eq!(replaygain_mode_value("album"), "album");
        assert_eq!(replaygain_mode_value("bogus"), "no");
    }
}
