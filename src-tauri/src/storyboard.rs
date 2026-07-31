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

/// Generate the sheet for `video_path` and cache it. `duration_secs` comes from the
/// caller (see `video_frames::get_video_duration`) so we don't probe twice.
pub fn generate(
    app_dir: &Path,
    track_path: &str,
    video_path: &Path,
    duration_secs: f64,
) -> Result<Storyboard, String> {
    if duration_secs <= 0.0 {
        return Err("Video has zero duration".to_string());
    }
    let g = geometry(duration_secs);
    let d = dir(app_dir);
    std::fs::create_dir_all(&d).map_err(|e| format!("Failed to create storyboard dir: {}", e))?;

    let k = key(track_path);
    let out = sheet_path(app_dir, &k);
    let out_str = out.to_string_lossy().to_string();

    let mut cmd = ffmpeg_command();
    cmd.args([
        "-hide_banner",
        "-loglevel", "error",
        // Keyframes only — this is what makes one pass cheap. Must precede -i.
        "-skip_frame", "nokey",
        "-i", &video_path.to_string_lossy(),
        "-an",
        "-vf", &format!(
            "fps=1/{:.4},scale={}:-2,tile={}x{}",
            g.interval_secs, g.tile_w, g.cols, g.rows
        ),
        "-frames:v", "1",
        // MJPEG unconditionally: `webp_supported()` is false on stock homebrew
        // ffmpeg, so the WebP path already falls back in practice. Sheets are small.
        "-c:v", "mjpeg",
        "-q:v", "5",
        "-pix_fmt", "yuvj420p",
        "-y", &out_str,
    ]);
    let output = cmd.output().map_err(|e| format!("Failed to run ffmpeg: {}", e))?;
    if !output.status.success() || !out.exists() {
        let _ = std::fs::remove_file(&out);
        return Err(format!(
            "ffmpeg storyboard generation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

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
        let removed = gc(app, &[live.to_string()]).unwrap();
        assert_eq!(removed, 2, "both files of the dead entry should go");
        assert!(sheet_path(app, &key(live)).exists());
        assert!(meta_path(app, &key(live)).exists());
        assert!(!sheet_path(app, &key(dead)).exists());
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
            let b = generate(dir.path(), &track_path, &f, dur as f64).expect("generate");
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
