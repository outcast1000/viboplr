//! Seek-bar waveform captured while a track plays: per-second loudness (RMS)
//! of what each deck decodes, read from an ffmpeg `astats` filter through
//! mpv's `af-metadata/<label>` property. It is how a stream gets a waveform
//! without being downloaded a second time — the local-file providers
//! (`waveform.rs`, the Web Audio one) need the bytes; this reads the samples
//! mpv is already decoding for playback.
//!
//! **Cumulative, so nothing is missed between reads.** The filter runs with
//! `reset=0`: `Number_of_samples` (frames per channel) and `RMS_level` (over
//! every sample of every channel) describe everything since the filter
//! started, so `frames × 10^(dB/10)` is the running sum of squares and the
//! difference between two reads is the exact energy of the frames decoded in
//! between, whatever the read cadence. Only the split of one read's interval
//! across a second boundary is approximate (assumed uniform over ~90ms).
//!
//! **Placed by sample count, never by `time-pos`.** The filter runs at decode
//! time, ~0.5s ahead of the speaker (the AO buffer — `probe_wave_counters`
//! measured 24576 frames decoded at `time-pos` 0.025). The decode head is
//! `base + frames / rate`, where `base` is where the filter's count started:
//!
//! - **File start / seek:** mpv rebuilds the filter, so the count restarts at
//!   0. Readings between the `Seek` event and its `PlaybackRestart` are
//!   ignored, and `PlaybackRestart` sets `base` to `time-pos`, which is the
//!   seek target at that moment (nothing has played yet).
//! - **Filter rebuilt mid-play** (bit-perfect off/on, a chain whose capture
//!   entry changed): the count restarts *without* a restart event and without
//!   a flush — decoding continues from the old head — so `base` becomes the
//!   last head. An EQ change leaves a labelled filter with unchanged arguments
//!   alone, so the count simply continues.
//! - **Gapless:** the next file gets a fresh filter and its own capture.
//!
//! The rate is `audio-params/samplerate` — the decoder's output, i.e. the
//! filter's input. Gapless and `speed` resample *after* the user `af` chain.
//!
//! **What the number is.** Pre-EQ (first in the chain), pre-ReplayGain and
//! pre-volume (mpv applies those after the chain), and the mean square over
//! all channels — where `waveform.rs` takes the RMS of the `-ac 1` downmix.
//! The two agree on correlated material and differ on wide stereo; see
//! `probe_wave_capture_vs_ffmpeg` for a measured comparison.

/// The filter label, read back as `af-metadata/<label>`.
pub const WAVE_LABEL: &str = "vibowave";

/// Minimum time between two reads of the filter. mpv runs the chain in ~90ms
/// bursts and the property holds the last burst's numbers, so reading faster
/// only re-reads them.
pub const WAVE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(90);

/// Finished captures kept for the frontend to collect after their track
/// ended. A track's last second arrives as it ends, after the frontend has
/// moved on to the next track.
pub const FINISHED_CAPTURES_KEPT: usize = 6;

/// The `af` entry that carries the capture. Only the two overall numbers it
/// reads are measured, so astats computes as little as it can. Needs the same
/// FFmpeg 4.4 options the meter does (`meter::ffmpeg_supports_meter`).
pub fn wave_filter() -> String {
    format!(
        "@{WAVE_LABEL}:lavfi=[astats=metadata=1:reset=0:measure_perchannel=none:measure_overall=RMS_level+Number_of_samples]"
    )
}

/// One cumulative reading: frames per channel since the filter started, and
/// their sum of squares (mean over channels, full scale = 1).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct WaveReading {
    pub frames: f64,
    pub energy: f64,
}

/// The value of `af-metadata/vibowave` (a JSON map, every value a string).
/// `None` before the first frame has gone through.
pub fn parse_wave(json: &str) -> Option<WaveReading> {
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(json).ok()?;
    let read = |stat: &str| -> Option<f64> {
        map.get(&format!("lavfi.astats.Overall.{stat}"))?.as_str()?.trim().parse::<f64>().ok()
    };
    let frames = read("Number_of_samples")?;
    if !frames.is_finite() || frames < 0.0 {
        return None;
    }
    // Digital silence prints `-inf`, which parses to -inf → energy 0.
    let db = read("RMS_level")?;
    let energy = if db.is_nan() || db == f64::INFINITY {
        return None;
    } else if db == f64::NEG_INFINITY {
        0.0
    } else {
        frames * 10f64.powf(db / 10.0)
    };
    Some(WaveReading { frames, energy })
}

/// What the frontend gets: one RMS per second (the last bucket the leftover
/// remainder, as `waveform.rs` lays it out), `None` where nothing was heard.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaveSnapshot {
    pub rms: Vec<Option<f32>>,
    /// Fraction of the track's length heard, 0..1. Re-listened spans count once.
    pub coverage: f64,
    pub duration_secs: Option<f64>,
}

/// One track's capture.
#[derive(Debug, Default, Clone)]
pub struct WaveCapture {
    /// Per one-second bucket: sum of squares, frames, and seconds covered.
    energy: Vec<f64>,
    frames: Vec<f64>,
    covered: Vec<f64>,
    duration: Option<f64>,
    /// Where the decode head is (seconds into the track).
    head: f64,
    /// The filter's last cumulative reading.
    prev: WaveReading,
    /// False between a file start / seek and its `PlaybackRestart`: the
    /// filter's count then belongs to a position not known yet.
    live: bool,
    /// The next restart is a file's start with no seek in between, so its
    /// count starts at 0 whatever `time-pos` says by then.
    from_file_start: bool,
}

impl WaveCapture {
    /// Whether readings are being taken (not between a load/seek and its restart).
    pub fn is_live(&self) -> bool {
        self.live
    }

    /// A file started for this capture. Readings wait for its restart.
    pub fn start_file(&mut self) {
        self.live = false;
        self.from_file_start = true;
    }

    /// A seek started. Readings are ignored until it lands.
    pub fn suspend(&mut self) {
        self.live = false;
        self.from_file_start = false;
    }

    /// Playback (re)started with `time-pos` at `position`: the filter was
    /// rebuilt, and its count — including the frames decoded ahead to restart
    /// — starts at the file's start, or for a seek at `position` (nothing has
    /// played since it landed). A file start ignores `position`: a gapless
    /// successor's restart can arrive after its first ~0.1s has played.
    pub fn restart(&mut self, position: f64) {
        self.head = if self.from_file_start || !position.is_finite() { 0.0 } else { position.max(0.0) };
        self.from_file_start = false;
        self.prev = WaveReading::default();
        self.live = true;
    }

    pub fn set_duration(&mut self, secs: f64) {
        if secs.is_finite() && secs > 0.0 {
            self.duration = Some(secs);
        }
    }

    /// Take one reading of the filter, decoded at `rate` frames per second.
    /// Returns whether it carried frames not seen before.
    pub fn feed(&mut self, reading: WaveReading, rate: f64) -> bool {
        if !self.live || !(rate > 0.0) {
            return false;
        }
        if reading.frames < self.prev.frames {
            // The filter was rebuilt mid-play: its count restarts from the next
            // decoded frame, which follows on from the head (no flush).
            self.prev = WaveReading::default();
        }
        let frames = reading.frames - self.prev.frames;
        if frames <= 0.0 {
            return false;
        }
        let energy = (reading.energy - self.prev.energy).max(0.0);
        self.prev = reading;
        let start = self.head;
        let end = start + frames / rate;
        self.head = end;
        self.spread(start, end, energy, frames);
        true
    }

    /// Distribute one interval's energy and frames over the seconds it spans,
    /// in proportion to the overlap. Past the known length (EOF padding) it
    /// lands in the last bucket.
    fn spread(&mut self, start: f64, end: f64, energy: f64, frames: f64) {
        let span = end - start;
        let last = self.duration.map(|d| d.ceil().max(1.0) as usize - 1);
        let mut t = start;
        while t < end {
            let second = t.floor();
            let next = (second + 1.0).min(end);
            let share = (next - t) / span;
            let mut i = second as usize;
            if let Some(last) = last {
                i = i.min(last);
            }
            if self.energy.len() <= i {
                self.energy.resize(i + 1, 0.0);
                self.frames.resize(i + 1, 0.0);
                self.covered.resize(i + 1, 0.0);
            }
            self.energy[i] += energy * share;
            self.frames[i] += frames * share;
            self.covered[i] += next - t;
            t = next;
        }
    }

    pub fn snapshot(&self) -> WaveSnapshot {
        let buckets = match self.duration {
            Some(d) => d.ceil().max(1.0) as usize,
            None => self.energy.len(),
        };
        let rms = (0..buckets)
            .map(|i| match self.frames.get(i) {
                Some(&f) if f > 0.0 => Some((self.energy[i] / f).sqrt() as f32),
                _ => None,
            })
            .collect();
        let coverage = match self.duration {
            Some(d) => {
                let heard: f64 = (0..buckets)
                    .map(|i| {
                        let len = (d - i as f64).min(1.0);
                        self.covered.get(i).copied().unwrap_or(0.0).min(len)
                    })
                    .sum();
                (heard / d).clamp(0.0, 1.0)
            }
            None => 0.0,
        };
        WaveSnapshot { rms, coverage, duration_secs: self.duration }
    }
}

/// Every deck's live capture plus the recently finished ones, by track key.
#[derive(Default)]
pub struct WaveCaptures {
    live: [Option<(String, WaveCapture)>; 2],
    finished: std::collections::VecDeque<(String, WaveCapture)>,
}

impl WaveCaptures {
    /// `deck` started a file for `key`. A capture already held for that key —
    /// a retry or a file swap that resumes the same track — is continued, so
    /// its coverage adds up across the attempts.
    pub fn begin(&mut self, deck: usize, key: &str) {
        self.finish(deck);
        let other = 1 - deck;
        let resumed = if self.live[other].as_ref().is_some_and(|(k, _)| k == key) {
            self.live[other].take().map(|(_, c)| c)
        } else {
            self.finished.iter().position(|(k, _)| k == key).and_then(|i| self.finished.remove(i)).map(|(_, c)| c)
        };
        let mut capture = resumed.unwrap_or_default();
        capture.start_file();
        self.live[deck] = Some((key.to_string(), capture));
    }

    /// Stop every live capture until its next restart. For bit-perfect mode:
    /// it removes the filter, so nothing is counted while it is on, and the
    /// filter that comes back with the mode off counts from wherever the
    /// decoder is by then — continuing from the old head would shift the rest
    /// of the waveform by however long the mode was on.
    pub fn suspend_all(&mut self) {
        for (_, capture) in self.live.iter_mut().flatten() {
            capture.suspend();
        }
    }

    /// `deck`'s file ended (or was replaced): keep its capture for collection.
    pub fn finish(&mut self, deck: usize) {
        if let Some(entry) = self.live[deck].take() {
            self.finished.retain(|(k, _)| *k != entry.0);
            self.finished.push_back(entry);
            while self.finished.len() > FINISHED_CAPTURES_KEPT {
                self.finished.pop_front();
            }
        }
    }

    pub fn live_mut(&mut self, deck: usize) -> Option<&mut WaveCapture> {
        self.live[deck].as_mut().map(|(_, c)| c)
    }

    pub fn snapshot(&self, key: &str) -> Option<WaveSnapshot> {
        self.live
            .iter()
            .flatten()
            .chain(self.finished.iter())
            .find(|(k, _)| k == key)
            .map(|(_, c)| c.snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 100.0;

    /// A cumulative reading after `frames` frames all at `level` (linear RMS).
    fn r(frames: f64, mean_square: f64) -> WaveReading {
        WaveReading { frames, energy: frames * mean_square }
    }

    fn rms_of(s: &WaveSnapshot) -> Vec<Option<f32>> {
        s.rms.iter().map(|v| v.map(|x| (x * 1000.0).round() / 1000.0)).collect()
    }

    #[test]
    fn test_parse_wave_reads_cumulative_frames_and_energy() {
        let json = r#"{"lavfi.astats.Overall.RMS_level":"-20.000000","lavfi.astats.Overall.Number_of_samples":"44100.000000"}"#;
        let w = parse_wave(json).unwrap();
        assert_eq!(w.frames, 44100.0);
        assert!((w.energy - 441.0).abs() < 1e-6, "{w:?}"); // -20 dB = 0.01 mean square
        let silent = r#"{"lavfi.astats.Overall.RMS_level":"-inf","lavfi.astats.Overall.Number_of_samples":"10.0"}"#;
        assert_eq!(parse_wave(silent).unwrap().energy, 0.0);
        assert_eq!(parse_wave(r#"{"lavfi.astats.Overall.RMS_level":"nan","lavfi.astats.Overall.Number_of_samples":"1"}"#), None);
        assert_eq!(parse_wave("{}"), None);
        assert_eq!(parse_wave("garbage"), None);
    }

    #[test]
    fn test_readings_before_playback_restarts_are_ignored() {
        let mut c = WaveCapture::default();
        c.set_duration(3.0);
        c.feed(r(50.0, 0.25), RATE);
        assert_eq!(c.snapshot().coverage, 0.0);
        c.restart(0.0);
        c.feed(r(100.0, 0.25), RATE);
        assert_eq!(rms_of(&c.snapshot()), vec![Some(0.5), None, None]);
    }

    #[test]
    fn test_differences_of_cumulative_readings_give_each_seconds_rms() {
        let mut c = WaveCapture::default();
        c.set_duration(3.0);
        c.restart(0.0);
        // Second 0 at 0.25 mean square, second 1 at 0.01, read in uneven steps.
        c.feed(r(40.0, 0.25), RATE);
        c.feed(r(100.0, 0.25), RATE);
        c.feed(WaveReading { frames: 170.0, energy: 25.0 + 0.7 }, RATE);
        c.feed(WaveReading { frames: 200.0, energy: 25.0 + 1.0 }, RATE);
        let s = c.snapshot();
        assert_eq!(rms_of(&s), vec![Some(0.5), Some(0.1), None]);
        assert!((s.coverage - 2.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn test_an_interval_straddling_a_second_is_split_by_overlap() {
        let mut c = WaveCapture::default();
        c.set_duration(2.0);
        c.restart(0.0);
        c.feed(r(150.0, 0.04), RATE); // 0..1.5s, uniform
        let s = c.snapshot();
        assert_eq!(rms_of(&s), vec![Some(0.2), Some(0.2)]);
        assert!((s.coverage - 0.75).abs() < 1e-9);
    }

    #[test]
    fn test_a_seek_places_the_new_count_at_its_target() {
        let mut c = WaveCapture::default();
        c.set_duration(4.0);
        c.restart(0.0);
        c.feed(r(100.0, 0.25), RATE);
        c.suspend();
        // Readings mid-seek belong to neither position.
        c.feed(r(20.0, 0.01), RATE);
        c.restart(3.0);
        c.feed(r(100.0, 0.01), RATE);
        assert_eq!(rms_of(&c.snapshot()), vec![Some(0.5), None, None, Some(0.1)]);
        assert!((c.snapshot().coverage - 0.5).abs() < 1e-9);
    }

    #[test]
    fn test_a_rebuilt_filter_continues_from_the_head() {
        let mut c = WaveCapture::default();
        c.set_duration(3.0);
        c.restart(0.0);
        c.feed(r(150.0, 0.25), RATE);
        // Count restarts with no restart event: frames follow on at 1.5s.
        c.feed(r(100.0, 0.01), RATE);
        c.feed(WaveReading { frames: 150.0, energy: 1.0 + 0.5 }, RATE);
        let s = c.snapshot();
        // 1.5..2.0 at 0.01 + 1.0..1.5 at 0.25 → second 1 mixes both halves.
        assert_eq!(rms_of(&s), vec![Some(0.5), Some(0.361), Some(0.1)]);
        assert!((s.coverage - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_a_file_start_counts_from_zero_even_when_its_restart_is_late() {
        let mut c = WaveCapture::default();
        c.set_duration(2.0);
        c.start_file();
        // A gapless successor's restart can land after it began playing.
        c.restart(0.08);
        c.feed(r(100.0, 0.25), RATE);
        assert_eq!(rms_of(&c.snapshot()), vec![Some(0.5), None]);
        assert!((c.snapshot().coverage - 0.5).abs() < 1e-9);
        // A seek before the first restart (a play that starts mid-track) uses the target.
        let mut c = WaveCapture::default();
        c.set_duration(3.0);
        c.start_file();
        c.suspend();
        c.restart(2.0);
        c.feed(r(100.0, 0.25), RATE);
        assert_eq!(rms_of(&c.snapshot()), vec![None, None, Some(0.5)]);
    }

    #[test]
    fn test_bit_perfect_suspends_until_the_next_restart() {
        let mut caps = WaveCaptures::default();
        caps.begin(0, "q:1");
        let c = caps.live_mut(0).unwrap();
        c.set_duration(3.0);
        c.restart(0.0);
        c.feed(r(100.0, 0.25), RATE);
        caps.suspend_all();
        // The filter comes back with the mode off and counts from scratch, at
        // a position nobody knows: nothing is placed.
        let c = caps.live_mut(0).unwrap();
        assert!(!c.is_live());
        assert!(!c.feed(r(50.0, 0.25), RATE));
        assert!((caps.snapshot("q:1").unwrap().coverage - 1.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn test_relistening_counts_coverage_once() {
        let mut c = WaveCapture::default();
        c.set_duration(2.0);
        c.restart(0.0);
        c.feed(r(100.0, 0.25), RATE);
        c.suspend();
        c.restart(0.0);
        c.feed(r(100.0, 0.25), RATE);
        let s = c.snapshot();
        assert!((s.coverage - 0.5).abs() < 1e-9, "{s:?}");
        assert_eq!(rms_of(&s), vec![Some(0.5), None]);
    }

    #[test]
    fn test_the_last_bucket_is_the_remainder_and_takes_eof_padding() {
        let mut c = WaveCapture::default();
        c.set_duration(2.5);
        c.restart(0.0);
        c.feed(r(253.0, 0.25), RATE); // 3 frames of padding past 2.5s
        let s = c.snapshot();
        assert_eq!(s.rms.len(), 3);
        assert_eq!(rms_of(&s), vec![Some(0.5), Some(0.5), Some(0.5)]);
        assert!((s.coverage - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_a_resumed_key_keeps_its_capture() {
        let mut caps = WaveCaptures::default();
        caps.begin(0, "q:1");
        let c = caps.live_mut(0).unwrap();
        c.set_duration(2.0);
        c.restart(0.0);
        c.feed(r(100.0, 0.25), RATE);
        caps.finish(0);
        // A retry replays the same key from 1s (a play with a seek).
        caps.begin(0, "q:1");
        let c = caps.live_mut(0).unwrap();
        c.suspend();
        c.restart(1.0);
        c.feed(r(100.0, 0.25), RATE);
        assert!((caps.snapshot("q:1").unwrap().coverage - 1.0).abs() < 1e-9);
        // Another key starts fresh, and the finished ring is bounded.
        for i in 0..10 {
            caps.begin(0, &format!("q:x{i}"));
        }
        caps.finish(0);
        assert!(caps.snapshot("q:1").is_none());
        assert!(caps.snapshot("q:x9").is_some());
    }
}
