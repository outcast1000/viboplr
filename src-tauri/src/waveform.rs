// Seek-bar waveform analysis via ffmpeg: one bucket of loudness (RMS) per second of
// audio. This is one of two waveform providers — the other decodes in the webview
// with Web Audio (`src/waveform/browserProvider.ts`). The frontend picks the order
// (`src/waveform/providers.ts`) and owns the shaping: both providers hand back RAW
// per-second RMS and `shapePeaks` turns it into bar heights, so the two can never
// disagree about what a waveform looks like.
//
// Why ffmpeg at all: the Web Audio path reads the whole file into memory and then
// decodes all of it to float PCM at 44.1 kHz (≈100 MB for five minutes of stereo),
// which is why it is capped at 15 MB. Here ffmpeg streams 8 kHz mono s16 through a
// pipe and the RMS is accumulated as the bytes arrive, so memory stays flat whatever
// the file size, and decoding happens outside the webview. 8 kHz is plenty for a
// one-value-per-second envelope; the downmix (`-ac 1`) also uses every channel
// instead of the Web Audio path's channel 0.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use crate::dependencies;

/// Rate ffmpeg resamples to. One bucket = this many samples.
pub const SAMPLE_RATE: u32 = 8000;

/// Returned when the pass was stopped because nobody wants it any more. Not a
/// failure — the command reports it as a status.
pub const CANCELLED: &str = "waveform analysis cancelled";

/// Per-request state. `child` is set once ffmpeg is running so a cancel (or a track
/// delete) can kill it directly instead of waiting for the next chunk to arrive.
struct Run {
    path: String,
    cancelled: bool,
    child: Option<Arc<Mutex<Child>>>,
}

struct Runs {
    active: HashMap<String, Run>,
    /// Requests cancelled before their `begin` landed: the cancel IPC can overtake the
    /// invoke it cancels (the invoke registers from a blocking thread). Consumed by
    /// the matching `begin`; bounded in `cancel`.
    stillborn: HashSet<String>,
}

fn runs() -> &'static Mutex<Runs> {
    static RUNS: OnceLock<Mutex<Runs>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(Runs { active: HashMap::new(), stillborn: HashSet::new() }))
}

/// Register a request. False when it was cancelled before it got here.
fn begin(path: &str, request_id: &str) -> bool {
    let mut r = runs().lock().unwrap();
    if r.stillborn.remove(request_id) {
        return false;
    }
    r.active.insert(
        request_id.to_string(),
        Run { path: path.to_string(), cancelled: false, child: None },
    );
    true
}

fn end(request_id: &str) {
    runs().lock().unwrap().active.remove(request_id);
}

fn is_cancelled(request_id: &str) -> bool {
    runs().lock().unwrap().active.get(request_id).is_none_or(|r| r.cancelled)
}

/// Attach the running child. False when the request was cancelled meanwhile, in which
/// case the caller kills it itself.
fn attach(request_id: &str, child: Arc<Mutex<Child>>) -> bool {
    let mut r = runs().lock().unwrap();
    match r.active.get_mut(request_id) {
        Some(run) if !run.cancelled => {
            run.child = Some(child);
            true
        }
        _ => false,
    }
}

fn kill(child: &Arc<Mutex<Child>>) {
    if let Ok(mut c) = child.lock() {
        // Already exited is fine: the point is only that it stops reading the file.
        let _ = c.kill();
    }
}

/// Stop a request. Idempotent, and safe to call before `analyze` has registered it.
pub fn cancel(request_id: &str) {
    let mut r = runs().lock().unwrap();
    if let Some(run) = r.active.get_mut(request_id) {
        run.cancelled = true;
        if let Some(child) = run.child.clone() {
            drop(r);
            kill(&child);
        }
        return;
    }
    if r.stillborn.len() >= 256 {
        r.stillborn.clear();
    }
    r.stillborn.insert(request_id.to_string());
}

/// Kill every pass reading `track_path`, for `delete_tracks`: on Windows an open read
/// handle makes the delete fail. Unlike a storyboard pass this one has no other
/// surface to protect, so it simply cancels them all.
pub fn abort_for_path(track_path: &str) {
    let children: Vec<Arc<Mutex<Child>>> = {
        let mut r = runs().lock().unwrap();
        r.active
            .values_mut()
            .filter(|run| run.path == track_path)
            .filter_map(|run| {
                run.cancelled = true;
                run.child.clone()
            })
            .collect()
    };
    for child in &children {
        kill(child);
        // Wait for the exit so the handle is really gone before the delete runs.
        if let Ok(mut c) = child.lock() {
            let _ = c.wait();
        }
    }
}

/// Mean-square accumulator over a stream of little-endian s16 samples, one bucket per
/// `samples_per_bucket`. Pure, so the bucketing is testable without ffmpeg.
pub struct RmsAccumulator {
    samples_per_bucket: u64,
    sum_sq: f64,
    count: u64,
    /// A sample split across two reads.
    carry: Option<u8>,
    out: Vec<f32>,
}

impl RmsAccumulator {
    pub fn new(samples_per_bucket: u32) -> Self {
        Self {
            samples_per_bucket: samples_per_bucket.max(1) as u64,
            sum_sq: 0.0,
            count: 0,
            carry: None,
            out: Vec::new(),
        }
    }

    fn push_sample(&mut self, s: i16) {
        let v = s as f64 / 32768.0;
        self.sum_sq += v * v;
        self.count += 1;
        if self.count == self.samples_per_bucket {
            self.out.push((self.sum_sq / self.count as f64).sqrt() as f32);
            self.sum_sq = 0.0;
            self.count = 0;
        }
    }

    pub fn feed(&mut self, mut bytes: &[u8]) {
        if let Some(lo) = self.carry.take() {
            let Some((&hi, rest)) = bytes.split_first() else {
                self.carry = Some(lo);
                return;
            };
            self.push_sample(i16::from_le_bytes([lo, hi]));
            bytes = rest;
        }
        let mut pairs = bytes.chunks_exact(2);
        for pair in &mut pairs {
            self.push_sample(i16::from_le_bytes([pair[0], pair[1]]));
        }
        if let [last] = pairs.remainder() {
            self.carry = Some(*last);
        }
    }

    /// The buckets, with the leftover remainder as a final (shorter) bucket — the
    /// same layout the Web Audio provider produces.
    pub fn finish(mut self) -> Vec<f32> {
        if self.count > 0 {
            self.out.push((self.sum_sq / self.count as f64).sqrt() as f32);
        }
        self.out
    }
}

/// Raw per-second RMS of a local audio file. `request_id` makes it cancellable via
/// `cancel`; returns `Err(CANCELLED)` when it was.
pub fn analyze(path: &str, request_id: &str) -> Result<Vec<f32>, String> {
    let bare = path.strip_prefix("file://").unwrap_or(path);
    if !begin(path, request_id) {
        return Err(CANCELLED.to_string());
    }
    let result = run_ffmpeg(bare, request_id);
    end(request_id);
    result
}

fn run_ffmpeg(bare: &str, request_id: &str) -> Result<Vec<f32>, String> {
    let mut cmd = dependencies::command_with_path("ffmpeg");
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(bare)
        .args(["-vn", "-sn", "-dn", "-ac", "1", "-ar"])
        .arg(SAMPLE_RATE.to_string())
        .args(["-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
    let mut stdout = child.stdout.take().ok_or("ffmpeg stdout unavailable")?;
    let mut stderr = child.stderr.take().ok_or("ffmpeg stderr unavailable")?;
    let child = Arc::new(Mutex::new(child));
    if !attach(request_id, Arc::clone(&child)) {
        kill(&child);
        return Err(CANCELLED.to_string());
    }

    // Drain stderr on its own thread: a child that fills the pipe nobody reads blocks.
    let stderr_thread = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });

    let mut acc = RmsAccumulator::new(SAMPLE_RATE);
    let mut buf = vec![0u8; 64 * 1024];
    let read_result = loop {
        if is_cancelled(request_id) {
            kill(&child);
            break Err(CANCELLED.to_string());
        }
        match stdout.read(&mut buf) {
            Ok(0) => break Ok(()),
            Ok(n) => acc.feed(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => break Err(format!("Failed to read ffmpeg output: {}", e)),
        }
    };

    let status = child.lock().map_err(|_| "ffmpeg handle poisoned")?.wait();
    let stderr_text = stderr_thread.join().unwrap_or_default();
    read_result?;
    // A kill landing after the last read still means the caller walked away.
    if is_cancelled(request_id) {
        return Err(CANCELLED.to_string());
    }
    let status = status.map_err(|e| format!("Failed to wait for ffmpeg: {}", e))?;
    if !status.success() {
        let detail = stderr_text.trim();
        return Err(if detail.is_empty() {
            format!("ffmpeg exited with {}", status)
        } else {
            format!("ffmpeg failed: {}", detail.lines().last().unwrap_or(detail))
        });
    }
    let rms = acc.finish();
    if rms.is_empty() {
        return Err("ffmpeg produced no audio".to_string());
    }
    Ok(rms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes_of(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn test_one_bucket_per_full_second_plus_remainder() {
        let mut acc = RmsAccumulator::new(4);
        acc.feed(&bytes_of(&[16384, -16384, 16384, -16384, 32767, 32767]));
        let out = acc.finish();
        assert_eq!(out.len(), 2);
        assert!((out[0] - 0.5).abs() < 1e-6);
        assert!((out[1] - 32767.0 / 32768.0).abs() < 1e-4);
    }

    #[test]
    fn test_a_sample_split_across_reads_is_reassembled() {
        let whole = bytes_of(&[16384, 16384, 16384, 16384]);
        let mut acc = RmsAccumulator::new(4);
        acc.feed(&whole[..3]);
        acc.feed(&whole[3..5]);
        acc.feed(&whole[5..]);
        let out = acc.finish();
        assert_eq!(out.len(), 1);
        assert!((out[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn test_silence_and_empty_input() {
        let mut acc = RmsAccumulator::new(2);
        acc.feed(&bytes_of(&[0, 0]));
        assert_eq!(acc.finish(), vec![0.0]);
        assert!(RmsAccumulator::new(2).finish().is_empty());
    }

    #[test]
    fn test_cancel_before_begin_stops_the_request() {
        cancel("wf-test-stillborn");
        assert!(!begin("file:///x.mp3", "wf-test-stillborn"));
        // Consumed: a later request with the same id is not affected.
        assert!(begin("file:///x.mp3", "wf-test-stillborn"));
        end("wf-test-stillborn");
    }

    #[test]
    fn test_cancel_after_begin_marks_the_run() {
        assert!(begin("file:///y.mp3", "wf-test-live"));
        assert!(!is_cancelled("wf-test-live"));
        cancel("wf-test-live");
        assert!(is_cancelled("wf-test-live"));
        end("wf-test-live");
    }

    /// End to end against the real ffmpeg: 2.5 s of a tone that gets louder each
    /// second. Self-skips where ffmpeg isn't installed (CI).
    #[test]
    fn test_analyze_real_file_with_ffmpeg() {
        if !crate::video_frames::is_ffmpeg_available() {
            eprintln!("ffmpeg not installed; skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("ramp.wav");
        let status = dependencies::command_with_path("ffmpeg")
            .args(["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i"])
            .arg("sine=frequency=440:duration=2.5,volume='0.2+0.3*floor(t)':eval=frame")
            .arg(&wav)
            .status()
            .unwrap();
        assert!(status.success());
        let rms = analyze(&format!("file://{}", wav.display()), "wf-test-real").unwrap();
        assert_eq!(rms.len(), 3, "two full seconds plus the half-second remainder");
        assert!(rms[0] < rms[1] && rms[1] < rms[2], "loudness should rise: {:?}", rms);
    }

    #[test]
    fn test_abort_for_path_cancels_matching_runs_only() {
        assert!(begin("file:///a.mp3", "wf-test-a"));
        assert!(begin("file:///b.mp3", "wf-test-b"));
        abort_for_path("file:///a.mp3");
        assert!(is_cancelled("wf-test-a"));
        assert!(!is_cancelled("wf-test-b"));
        end("wf-test-a");
        end("wf-test-b");
    }
}
