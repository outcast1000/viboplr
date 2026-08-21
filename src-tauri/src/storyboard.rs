// Seek-preview storyboards: one sprite sheet per video, holding many small
// thumbnails in a grid. The seek bar shows a single tile by offsetting the sheet
// (see `docs/seek-preview-spec.md`).
//
// Distinct from `video_frames.rs`, which produces a few LARGE, curated frames
// (queue art, hero background). This produces many small, literal frames — a seek
// preview must show the frame AT the hovered timestamp, so it deliberately does not
// use the `thumbnail` filter's "most representative frame" selection.
//
// One `ffmpeg` pass per video: `-skip_frame nokey` (decode keyframes only) keeps a
// 1080p 5-minute source at ~0.3 s / ~85 MB peak, versus ~3.2 s / ~161 MB for a full
// decode. The cost is granularity — grid slots that fall between keyframes repeat
// the previous frame, which is harmless to render.

use std::path::{Path, PathBuf};

use crate::dependencies;

/// Never generate tiles closer together than this, even for short videos.
pub const MIN_INTERVAL_SECS: f64 = 10.0;
/// Hard cap on tiles per video, so one sheet always suffices.
pub const MAX_TILES: usize = 100;
/// Sheet width budget. The single-sheet invariant means every tile must fit inside
/// one image, so this is the real constraint on tile size. 2000 keeps the worst case
/// (a 4:3 source at 10x10 => 2000x1500) comfortably inside desktop WebView texture
/// limits.
pub const MAX_SHEET_WIDTH: u32 = 2000;
/// Ceiling on tile width, so short videos don't produce needlessly large sheets.
/// 400 is set by the largest consumer: the detail-page hero art renders a tile
/// cover-cropped into a ~240 px square, i.e. ~480 device px on retina.
pub const MAX_TILE_WIDTH: u32 = 400;

/// Tile width for a grid of `cols` columns — as large as the sheet budget allows.
///
/// Deliberately adaptive rather than fixed: the budget is per *sheet*, so a short
/// video (5x5) affords 400 px tiles while only a long one (10x10) is squeezed to 200.
/// A fixed 200 would have softened hero art on every video to accommodate the rare
/// long one. Sheet pixel count — and so disk — stays roughly constant either way.
pub fn tile_width(cols: usize) -> u32 {
    (MAX_SHEET_WIDTH / cols.max(1) as u32).min(MAX_TILE_WIDTH)
}

/// Sheet geometry for a given duration. `count` is how many tiles actually carry a
/// frame — the grid may have more slots, and ffmpeg's `tile` filter pads the
/// remainder with black. Callers must not address slots at or beyond `count`.
#[derive(Debug, Clone, PartialEq)]
pub struct Geometry {
    pub interval_secs: f64,
    pub count: usize,
    pub cols: usize,
    pub rows: usize,
    pub tile_w: u32,
}

/// `interval = max(MIN_INTERVAL_SECS, duration / MAX_TILES)`, then the smallest
/// near-square grid that holds the resulting tile count.
pub fn geometry(duration_secs: f64) -> Geometry {
    let interval_secs = (duration_secs / MAX_TILES as f64).max(MIN_INTERVAL_SECS);
    // `fps=1/interval` emits a frame at 0, interval, 2*interval, … so the tile count
    // is the number of those positions that land inside the video.
    let count = ((duration_secs / interval_secs).ceil() as usize).clamp(1, MAX_TILES);
    let cols = (count as f64).sqrt().ceil() as usize;
    let rows = count.div_ceil(cols);
    Geometry { interval_secs, count, cols, rows, tile_w: tile_width(cols) }
}

/// What the frontend needs to render a tile. `sheets` is a Vec (not a single path)
/// so plugin-supplied storyboards, which are genuinely multi-sheet, share this type.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Storyboard {
    pub sheets: Vec<String>,
    pub cols: usize,
    pub rows: usize,
    pub count: usize,
    pub tile_w: u32,
    pub tile_h: u32,
    pub start_secs: f64,
    pub interval_secs: f64,
}

fn dir(app_dir: &Path) -> PathBuf {
    app_dir.join("storyboards")
}

/// Cache entries are keyed by the track's scheme-prefixed path, hashed — NOT by
/// metadata. Two different videos can share a title+artist+duration (a studio cut and
/// a live take) and would then swap frames; `shelfVideoKey` in the frontend already
/// keys by path for exactly this reason.
fn key(track_path: &str) -> String {
    format!("{:x}", md5::compute(track_path))
}

fn sheet_path(app_dir: &Path, k: &str) -> PathBuf {
    dir(app_dir).join(format!("{}.jpg", k))
}

/// Scratch dir for the per-frame side output emitted while the sheet generates
/// (see `generate`). Removed when generation finishes either way; a leftover from
/// a crash is cleared at the start of the next generation for the same track.
fn frames_dir(app_dir: &Path, k: &str) -> PathBuf {
    dir(app_dir).join(format!("{}.frames", k))
}

fn meta_path(app_dir: &Path, k: &str) -> PathBuf {
    dir(app_dir).join(format!("{}.json", k))
}

/// Cache-only read; never generates. Returns None unless both the descriptor and its
/// sheet are on disk.
pub fn get_cached(app_dir: &Path, track_path: &str) -> Option<Storyboard> {
    let k = key(track_path);
    let data = std::fs::read_to_string(meta_path(app_dir, &k)).ok()?;
    let board: Storyboard = serde_json::from_str(&data).ok()?;
    if board.sheets.iter().any(|s| !Path::new(s).exists()) {
        return None;
    }
    Some(board)
}

pub fn delete_cached(app_dir: &Path, track_path: &str) {
    let k = key(track_path);
    let _ = std::fs::remove_file(sheet_path(app_dir, &k));
    let _ = std::fs::remove_file(meta_path(app_dir, &k));
}

fn ffmpeg_command() -> std::process::Command {
    dependencies::command_with_path("ffmpeg")
}

/// Track paths with a generation in flight, plus the condvar waiters sleep on.
/// Generation must be single-flight per track: two frontend surfaces (the
/// now-playing bar and the track detail page) both extract on a cache miss, and
/// two concurrent runs sabotage each other — the second's scratch-dir reset kills
/// the first's ffmpeg mid-write, whose failure cleanup then deletes the sheet the
/// winner just cached, leaving a descriptor with no sheet (= "caching stopped
/// working"). The loser now waits and serves the winner's cache instead.
fn inflight() -> &'static (std::sync::Mutex<std::collections::HashSet<String>>, std::sync::Condvar) {
    static INFLIGHT: std::sync::OnceLock<(
        std::sync::Mutex<std::collections::HashSet<String>>,
        std::sync::Condvar,
    )> = std::sync::OnceLock::new();
    INFLIGHT.get_or_init(|| (std::sync::Mutex::new(std::collections::HashSet::new()), std::sync::Condvar::new()))
}

/// Removes the in-flight entry and wakes waiters even if generation unwinds.
struct InflightGuard(String);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        let (lock, cv) = inflight();
        lock.lock().unwrap().remove(&self.0);
        cv.notify_all();
    }
}

/// Frames in `dir` that are safely complete. The image2 muxer writes files in
/// sequence and only opens frame N+1 after closing frame N, so while ffmpeg is
/// still running the highest-numbered file may be mid-write and is held back;
/// once it has exited (`finished`) everything on disk is complete.
fn completed_frames(dir: &Path, finished: bool) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            (p.extension().and_then(|x| x.to_str()) == Some("jpg"))
                .then(|| p.to_string_lossy().to_string())
        })
        .collect();
    // %03d names sort lexicographically in frame order.
    names.sort();
    if !finished {
        names.pop();
    }
    names
}

/// Generate the sheet for `video_path` and cache it. `duration_secs` comes from the
/// caller (see `video_frames::get_video_duration`) so we don't probe twice.
///
/// Progress: `on_partial` is called with the cumulative list of individual frame
/// files extracted so far (time order, one per tile), so a consumer can show the
/// moments as they land instead of a blank strip. The frame files are scratch —
/// they are deleted once the sheet exists, by which point the caller has the real
/// storyboard to switch to. Pass `|_| {}` when progress isn't wanted.
pub fn generate_with_progress(
    app_dir: &Path,
    track_path: &str,
    video_path: &Path,
    duration_secs: f64,
    mut on_partial: impl FnMut(&[String]),
) -> Result<Storyboard, String> {
    if duration_secs <= 0.0 {
        return Err("Video has zero duration".to_string());
    }

    // Single-flight per track (see `inflight`). A waiter that wakes to a cache hit
    // is the loser of the race — the winner generated while it slept.
    let _guard = {
        let (lock, cv) = inflight();
        let mut running = lock.lock().unwrap();
        while running.contains(track_path) {
            running = cv.wait(running).unwrap();
        }
        if let Some(cached) = get_cached(app_dir, track_path) {
            return Ok(cached);
        }
        running.insert(track_path.to_string());
        InflightGuard(track_path.to_string())
    };

    let g = geometry(duration_secs);
    let d = dir(app_dir);
    std::fs::create_dir_all(&d).map_err(|e| format!("Failed to create storyboard dir: {}", e))?;

    let k = key(track_path);
    let out = sheet_path(app_dir, &k);
    let out_str = out.to_string_lossy().to_string();
    let fdir = frames_dir(app_dir, &k);
    // Clear a leftover from a crashed run so stale frames can't be reported as live.
    let _ = std::fs::remove_dir_all(&fdir);
    std::fs::create_dir_all(&fdir).map_err(|e| format!("Failed to create frames dir: {}", e))?;
    let frame_pattern = fdir.join("%03d.jpg").to_string_lossy().to_string();

    let mut cmd = ffmpeg_command();
    cmd.args([
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        // Keyframes only — this is what makes one pass cheap. Must precede -i.
        "-skip_frame", "nokey",
        "-i", &video_path.to_string_lossy(),
        "-an",
        // One decode pass, two outputs: the individual frames (progress, scratch)
        // and the tiled sheet (the cached artifact, identical to what the old
        // single-output `-vf` produced).
        "-filter_complex", &format!(
            "fps=1/{:.4},scale={}:-2,split=2[strip][grid];[grid]tile={}x{}[sheet]",
            g.interval_secs, g.tile_w, g.cols, g.rows
        ),
        // MJPEG unconditionally: `webp_supported()` is false on stock homebrew
        // ffmpeg, so the WebP path already falls back in practice. Sheets are small.
        "-map", "[strip]",
        "-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p",
        &frame_pattern,
        "-map", "[sheet]",
        "-frames:v", "1",
        "-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p",
        &out_str,
    ]);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());

    let cleanup = |ok: bool| {
        let _ = std::fs::remove_dir_all(&fdir);
        if !ok {
            let _ = std::fs::remove_file(&out);
        }
    };

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            cleanup(false);
            return Err(format!("Failed to run ffmpeg: {}", e));
        }
    };
    // Drained on a thread so a chatty stderr can't fill the pipe and block ffmpeg.
    let stderr_pipe = child.stderr.take();
    let stderr_handle = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut pipe) = stderr_pipe {
            use std::io::Read;
            let _ = pipe.read_to_string(&mut s);
        }
        s
    });

    let mut reported = 0usize;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                let done = completed_frames(&fdir, false);
                if done.len() > reported {
                    reported = done.len();
                    on_partial(&done);
                }
                // 80ms, not something lazier: a typical music video's keyframe pass
                // finishes in ~0.3-0.5s, so a slow poll would collapse the whole
                // progression into one late event.
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                cleanup(false);
                return Err(format!("Failed to wait for ffmpeg: {}", e));
            }
        }
    };
    let stderr_text = stderr_handle.join().unwrap_or_default();

    if !status.success() || !out.exists() {
        cleanup(false);
        return Err(format!("ffmpeg storyboard generation failed: {}", stderr_text));
    }
    cleanup(true);

    // Tile height follows the source aspect (`scale=W:-2`), so it is only knowable
    // from the result — a 4:3 source yields 200x150, not 200x112. Read it from the
    // sheet header rather than assuming 16:9.
    let (sheet_w, sheet_h) = image::image_dimensions(&out)
        .map_err(|e| format!("Failed to read storyboard dimensions: {}", e))?;
    let board = Storyboard {
        sheets: vec![out_str],
        cols: g.cols,
        rows: g.rows,
        count: g.count,
        tile_w: sheet_w / g.cols as u32,
        tile_h: sheet_h / g.rows as u32,
        start_secs: 0.0,
        interval_secs: g.interval_secs,
    };

    let json = serde_json::to_string(&board).map_err(|e| e.to_string())?;
    std::fs::write(meta_path(app_dir, &k), json)
        .map_err(|e| format!("Failed to write storyboard meta: {}", e))?;

    log::info!(
        "Storyboard for {}: {} tiles ({}x{} grid, {}x{} px, every {:.1}s)",
        video_path.display(), g.count, g.cols, g.rows, board.tile_w, board.tile_h, g.interval_secs
    );
    Ok(board)
}

/// Sweep entries whose track is no longer live. Neither the waveform nor the
/// video-frame cache does this, and sheets are ~200 KB each, so an unbounded
/// storyboard cache would be the largest on disk. `live_paths` is every track path
/// still in the library.
pub fn gc(app_dir: &Path, live_paths: &[String]) -> Result<usize, String> {
    let d = dir(app_dir);
    if !d.exists() {
        return Ok(0);
    }
    let live: std::collections::HashSet<String> = live_paths.iter().map(|p| key(p)).collect();
    let mut removed = 0;
    for entry in std::fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        // A `.frames` scratch dir at gc time is a leftover from a generation the app
        // didn't live to finish (gc runs at startup, before anything can be playing —
        // an in-flight generation cannot exist yet). Liveness doesn't apply: the dir
        // is garbage even when its track is still in the library, and `remove_file`
        // below can't take a directory.
        if path.is_dir() {
            if path.extension().and_then(|x| x.to_str()) == Some("frames")
                && std::fs::remove_dir_all(&path).is_ok()
            {
                removed += 1;
            }
            continue;
        }
        // Both `<hash>.jpg` and `<hash>.json` share the stem.
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if !live.contains(stem) {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    if removed > 0 {
        log::info!("Storyboard gc: removed {} orphaned file(s)", removed);
    }
    Ok(removed)
}

/// Hard ceiling for the storyboard cache. Sheets are ~200 KB, so this holds roughly
/// 1300 videos before anything is evicted.
pub const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;

/// Evict least-recently-modified entries until the cache fits `max_bytes`. Runs after
/// `gc`, as the backstop for the case liveness can't catch: a library larger than the
/// budget. Sheet and descriptor are evicted together so `get_cached` never sees a
/// descriptor whose sheet is gone (it also guards against that independently).
pub fn enforce_cap(app_dir: &Path, max_bytes: u64) -> Result<u64, String> {
    let d = dir(app_dir);
    if !d.exists() {
        return Ok(0);
    }
    // stem -> (total bytes, newest mtime)
    let mut groups: std::collections::HashMap<String, (u64, std::time::SystemTime)> =
        std::collections::HashMap::new();
    let mut total: u64 = 0;
    for entry in std::fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        total += meta.len();
        let slot = groups.entry(stem).or_insert((0, std::time::UNIX_EPOCH));
        slot.0 += meta.len();
        if mtime > slot.1 {
            slot.1 = mtime;
        }
    }
    if total <= max_bytes {
        return Ok(0);
    }
    let mut ordered: Vec<_> = groups.into_iter().collect();
    ordered.sort_by_key(|(_, (_, mtime))| *mtime); // oldest first
    let mut freed = 0u64;
    for (stem, (bytes, _)) in ordered {
        if total - freed <= max_bytes {
            break;
        }
        let _ = std::fs::remove_file(d.join(format!("{}.jpg", stem)));
        let _ = std::fs::remove_file(d.join(format!("{}.json", stem)));
        freed += bytes;
    }
    if freed > 0 {
        log::info!("Storyboard cache: evicted {} KB to fit cap", freed / 1024);
    }
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_geometry_short_video_hits_min_interval() {
        // 213s / 100 = 2.13s, below the 10s floor, so the floor wins.
        let g = geometry(213.0);
        assert_eq!(g.interval_secs, 10.0);
        assert_eq!(g.count, 22); // ceil(21.3)
        assert_eq!(g.cols, 5);
        assert_eq!(g.rows, 5); // 25 slots, 22 carry frames
    }

    #[test]
    fn test_geometry_long_video_hits_tile_cap() {
        // 3.1 hours: the cap binds and the interval stretches instead.
        let g = geometry(11138.0);
        assert_eq!(g.count, MAX_TILES);
        assert_eq!(g.cols, 10);
        assert_eq!(g.rows, 10);
        assert!((g.interval_secs - 111.38).abs() < 0.01);
    }

    #[test]
    fn test_geometry_crossover_is_exactly_max_tiles_seconds() {
        // Both constraints meet where duration = MIN_INTERVAL * MAX_TILES = 1000s.
        let g = geometry(1000.0);
        assert_eq!(g.interval_secs, MIN_INTERVAL_SECS);
        assert_eq!(g.count, MAX_TILES);
    }

    #[test]
    fn test_geometry_never_exceeds_tile_cap() {
        for secs in [1.0, 10.0, 213.0, 999.0, 1000.0, 1001.0, 5021.0, 86400.0] {
            let g = geometry(secs);
            assert!(g.count >= 1, "{secs}s produced zero tiles");
            assert!(g.count <= MAX_TILES, "{secs}s produced {} tiles", g.count);
            assert!(
                g.cols * g.rows >= g.count,
                "{secs}s grid {}x{} cannot hold {} tiles",
                g.cols, g.rows, g.count
            );
            assert!(g.interval_secs >= MIN_INTERVAL_SECS);
        }
    }

    #[test]
    fn test_geometry_very_short_video_yields_one_tile() {
        let g = geometry(5.0);
        assert_eq!(g.count, 1);
        assert_eq!(g.cols, 1);
        assert_eq!(g.rows, 1);
    }

    #[test]
    fn test_geometry_last_tile_lands_inside_the_video() {
        for secs in [30.0, 213.0, 1000.0, 5021.0, 11138.0] {
            let g = geometry(secs);
            let last = (g.count - 1) as f64 * g.interval_secs;
            assert!(last < secs, "{secs}s: last tile at {last}s is past the end");
        }
    }

    #[test]
    fn test_cache_key_is_path_based_not_metadata_based() {
        // Two videos that would collide under a title+duration key must not share.
        assert_ne!(key("file:///a/Song.mp4"), key("file:///b/Song.mp4"));
        assert_eq!(key("file:///a/Song.mp4"), key("file:///a/Song.mp4"));
    }

    #[test]
    fn test_completed_frames_holds_back_the_file_still_being_written() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        for n in ["001.jpg", "002.jpg", "003.jpg"] {
            std::fs::write(d.join(n), b"x").unwrap();
        }
        std::fs::write(d.join("notes.txt"), b"x").unwrap(); // non-jpg is ignored
        // While ffmpeg runs, the highest-numbered frame may be mid-write.
        let running = completed_frames(d, false);
        assert_eq!(running.len(), 2);
        assert!(running[0].ends_with("001.jpg"));
        assert!(running[1].ends_with("002.jpg"));
        // Once it exited, everything on disk is complete.
        assert_eq!(completed_frames(d, true).len(), 3);
    }

    #[test]
    fn test_completed_frames_empty_and_missing_dirs_are_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(completed_frames(dir.path(), false).is_empty());
        assert!(completed_frames(&dir.path().join("nope"), true).is_empty());
    }

    #[test]
    fn test_get_cached_is_none_without_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(get_cached(dir.path(), "file:///nope.mp4").is_none());
    }

    #[test]
    fn test_get_cached_rejects_meta_with_missing_sheet() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path();
        std::fs::create_dir_all(super::dir(app)).unwrap();
        let k = key("file:///x.mp4");
        let board = Storyboard {
            sheets: vec![app.join("gone.jpg").to_string_lossy().to_string()],
            cols: 5, rows: 5, count: 22, tile_w: 400, tile_h: 224,
            start_secs: 0.0, interval_secs: 10.0,
        };
        std::fs::write(meta_path(app, &k), serde_json::to_string(&board).unwrap()).unwrap();
        // Descriptor present but the sheet was swept — must not be served.
        assert!(get_cached(app, "file:///x.mp4").is_none());
    }

    #[test]
    fn test_delete_cached_removes_both_files() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path();
        std::fs::create_dir_all(super::dir(app)).unwrap();
        let k = key("file:///x.mp4");
        std::fs::write(sheet_path(app, &k), b"jpeg").unwrap();
        std::fs::write(meta_path(app, &k), b"{}").unwrap();
        delete_cached(app, "file:///x.mp4");
        assert!(!sheet_path(app, &k).exists());
        assert!(!meta_path(app, &k).exists());
    }

    #[test]
    fn test_gc_keeps_live_and_sweeps_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path();
        std::fs::create_dir_all(super::dir(app)).unwrap();
        let live = "file:///keep.mp4";
        let dead = "file:///gone.mp4";
        for p in [live, dead] {
            let k = key(p);
            std::fs::write(sheet_path(app, &k), b"jpeg").unwrap();
            std::fs::write(meta_path(app, &k), b"{}").unwrap();
        }
        // A scratch dir left by an interrupted generation — garbage even though its
        // track is live (the app died mid-run; nothing will ever finish it).
        let stale_frames = frames_dir(app, &key(live));
        std::fs::create_dir_all(&stale_frames).unwrap();
        std::fs::write(stale_frames.join("001.jpg"), b"jpeg").unwrap();

        let removed = gc(app, &[live.to_string()]).unwrap();
        assert_eq!(removed, 3, "both files of the dead entry + the scratch dir should go");
        assert!(sheet_path(app, &key(live)).exists());
        assert!(meta_path(app, &key(live)).exists());
        assert!(!sheet_path(app, &key(dead)).exists());
        assert!(!stale_frames.exists());
    }

    #[test]
    fn test_gc_on_missing_dir_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(gc(dir.path(), &[]).unwrap(), 0);
    }

    /// End-to-end generation against real ffmpeg. `#[ignore]`d because it encodes two
    /// test clips (~4 s); self-skips when ffmpeg is absent so it stays green anywhere.
    /// The 4:3 case is the point: `scale=160:-2` yields 160x120, not 160x90, which is
    /// why `tile_h` is read from the produced sheet instead of assumed.
    #[test]
    #[ignore]
    fn test_generate_against_real_ffmpeg() {
        if !crate::video_frames::is_ffmpeg_available() {
            eprintln!("[storyboard-test] SKIPPED — ffmpeg not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        // Aspect is asserted as a ratio, not a magic number: `scale=W:-2` rounds the
        // derived height to the nearest EVEN value (1280x720 at width 400 gives 226,
        // not 225), which is precisely why tile_h is read from the produced sheet.
        for (name, size, dur, src_w, src_h) in [
            ("v169.mp4", "1280x720", 213u32, 1280.0f64, 720.0f64),
            ("v43.mp4", "640x480", 213, 640.0, 480.0),
        ] {
            let f = dir.path().join(name);
            let ok = std::process::Command::new("ffmpeg")
                .args([
                    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                    &format!("testsrc2=size={}:rate=30:duration={}", size, dur),
                    "-c:v", "libx264", "-preset", "ultrafast", "-g", "250",
                    "-pix_fmt", "yuv420p", "-y",
                ])
                .arg(&f)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "failed to encode test clip {name}");

            let track_path = format!("file://{}", f.to_string_lossy());
            // Through the progress path, so partial reporting is exercised too. The
            // clip decodes fast, so zero callbacks is legal — but any that fire must
            // report cumulative, in-bounds frame lists.
            let mut partial_lens: Vec<usize> = Vec::new();
            let started = std::time::Instant::now();
            let b = generate_with_progress(dir.path(), &track_path, &f, dur as f64, |frames| {
                assert!(frames.len() <= 22, "partial reported more frames than tiles");
                assert!(
                    partial_lens.last().map_or(true, |&prev| frames.len() >= prev),
                    "partial frame count went backwards"
                );
                eprintln!(
                    "[storyboard-test] {name}: partial {} frames at {:?}",
                    frames.len(),
                    started.elapsed()
                );
                partial_lens.push(frames.len());
            })
            .expect("generate");
            eprintln!(
                "[storyboard-test] {name}: done in {:?}, {} partial callback(s)",
                started.elapsed(),
                partial_lens.len()
            );
            assert!(
                !frames_dir(dir.path(), &key(&track_path)).exists(),
                "scratch frames dir must be cleaned up after generation"
            );
            assert_eq!(b.count, 22, "213s at a 10s floor is 22 tiles");
            assert_eq!((b.cols, b.rows), (5, 5));
            assert_eq!(b.interval_secs, MIN_INTERVAL_SECS);
            assert_eq!(b.tile_w, tile_width(5), "22 tiles => 5 cols => 400px tiles");
            let expected_h = b.tile_w as f64 * (src_h / src_w);
            assert!(
                (b.tile_h as f64 - expected_h).abs() <= 2.0,
                "{size}: tile height {} should follow the source aspect (~{expected_h:.0})",
                b.tile_h
            );
            assert_eq!(b.sheets.len(), 1, "local tier is always single-sheet");
            assert!(std::fs::metadata(&b.sheets[0]).unwrap().len() > 0);

            let cached = get_cached(dir.path(), &track_path).expect("round-trips via cache");
            assert_eq!(cached.count, b.count);
            assert_eq!(cached.tile_h, b.tile_h);
            assert_eq!(cached.interval_secs, b.interval_secs);
        }
    }

    /// Two surfaces (now-playing bar + detail page) both extract on a cache miss.
    /// Without single-flight the loser's scratch reset killed the winner's ffmpeg,
    /// whose failure cleanup then deleted the cached sheet — one thread errored and
    /// `get_cached` stayed None forever after. Both must succeed and the cache must
    /// survive. `#[ignore]`d: encodes a clip; self-skips without ffmpeg.
    #[test]
    #[ignore]
    fn test_concurrent_generation_is_single_flight_and_keeps_the_cache() {
        if !crate::video_frames::is_ffmpeg_available() {
            eprintln!("[storyboard-test] SKIPPED — ffmpeg not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("race.mp4");
        let ok = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                "testsrc2=size=1280x720:rate=30:duration=213",
                "-c:v", "libx264", "-preset", "ultrafast", "-g", "250",
                "-pix_fmt", "yuv420p", "-y",
            ])
            .arg(&f)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "failed to encode test clip");

        let track_path = format!("file://{}", f.to_string_lossy());
        let results: Vec<Result<Storyboard, String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    scope.spawn(|| {
                        generate_with_progress(dir.path(), &track_path, &f, 213.0, |_| {})
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        for r in &results {
            let b = r.as_ref().expect("both concurrent generations must succeed");
            assert_eq!(b.count, 22);
        }
        let cached = get_cached(dir.path(), &track_path)
            .expect("the cache must survive concurrent generation");
        assert!(std::fs::metadata(&cached.sheets[0]).unwrap().len() > 0);
        assert!(!frames_dir(dir.path(), &key(&track_path)).exists());
    }

    #[test]
    fn test_tile_width_fills_the_sheet_budget() {
        // Short video (5x5) gets large tiles; only a long one (10x10) is squeezed.
        assert_eq!(tile_width(5), 400);
        assert_eq!(tile_width(10), 200);
        // Capped so a 1- or 2-tile video doesn't produce an oversized sheet.
        assert_eq!(tile_width(1), MAX_TILE_WIDTH);
        assert_eq!(tile_width(2), MAX_TILE_WIDTH);
        assert_eq!(tile_width(0), MAX_TILE_WIDTH); // guard against div-by-zero
    }

    #[test]
    fn test_sheet_never_exceeds_the_width_budget() {
        for secs in [1.0, 30.0, 213.0, 999.0, 1000.0, 5021.0, 11138.0, 86400.0] {
            let g = geometry(secs);
            let sheet_w = g.cols as u32 * g.tile_w;
            assert!(
                sheet_w <= MAX_SHEET_WIDTH,
                "{secs}s: {} cols x {}px = {}px exceeds the {}px budget",
                g.cols, g.tile_w, sheet_w, MAX_SHEET_WIDTH
            );
        }
    }
}
