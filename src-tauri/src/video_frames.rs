use std::path::{Path, PathBuf};

use crate::dependencies;

// ONE frame: the video's thumbnail, used wherever a large sharp still is needed —
// queue/shelf art, the detail-page hero art at rest, and hero background layers.
// Multi-frame surfaces (the filmstrip, and hover cycling) read tiles from the
// storyboard sprite instead, which is cheaper per moment and offers far more of them.
// See docs/seek-preview-spec.md "Reducing FRAME_COUNT to 1".
const FRAME_COUNT: usize = 1;
// Pulled off the very head so we dodge fade-ins and title cards; the thumbnail filter
// (below) does the fine selection within the window.
const FRAME_POSITIONS: [f64; FRAME_COUNT] = [0.10];
// Recipe stamp for what is on disk. **Bump it whenever the extraction changes** —
// positions, filters, encoder — and every cached frame cut by the old recipe is
// re-extracted on next use instead of living on. Without it a fix to the pixels can't
// reach anyone who already has a cache, which is the whole library.
// v2 = the display-aspect scaling below; v1 frames were cut with `scale=-2:720`, which
// stretched anamorphic sources.
const FRAME_RECIPE: u32 = 2;
// Around each position we decode a short window and let ffmpeg's `thumbnail`
// filter pick the most representative (non-black, non-blurry) frame in it.
const WINDOW_SECS: f64 = 2.0;
// `thumbnail=50` analyzes ~50 frames per window and emits the most
// representative one; the scale targets the short edge at ~720px so the
// 220px square hero crop stays sharp on retina (up to ~660 device px), at
// negligible disk cost vs. native resolution.
//
// The width comes from `dar` — the source's DISPLAY aspect — not from its stored
// width/height. An anamorphic source (a DVD rip, a DVB capture, some phone video)
// stores non-square pixels, so the plain `scale=-2:720` this replaced reproduced that
// squeeze faithfully and the frame came out stretched against the video the player
// showed. `trunc(.../2)*2` keeps the width even for yuvj420p; `setsar=1` stops the
// encoder recording a non-square ratio that nothing downstream reads.
const SCALE_FILTER: &str = "thumbnail=50,scale=trunc(720*dar/2)*2:720,setsar=1";

pub(crate) fn ffmpeg_command() -> std::process::Command {
    dependencies::command_with_path("ffmpeg")
}

pub fn is_ffmpeg_available() -> bool {
    let cache = dependencies::DepCache::new();
    dependencies::is_available("ffmpeg", &cache)
}

/// Whether the resolved ffmpeg build can encode WebP. Probed once per process;
/// builds without libwebp fall back to high-quality JPEG so extraction never
/// fails outright on a stripped-down ffmpeg.
fn webp_supported() -> bool {
    static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SUPPORTED.get_or_init(|| {
        let mut cmd = ffmpeg_command();
        cmd.args(["-hide_banner", "-loglevel", "error", "-encoders"]);
        match cmd.output() {
            Ok(out) => String::from_utf8_lossy(&out.stdout).contains("libwebp"),
            Err(_) => false,
        }
    })
}

fn frame_ext() -> &'static str {
    if webp_supported() { "webp" } else { "jpg" }
}

/// Locate frame `i` in `dir`, accepting either output format. A cache written
/// by an earlier session (or a different ffmpeg build) may use the other
/// extension; we honor whichever is on disk.
fn frame_file(dir: &Path, i: usize) -> Option<PathBuf> {
    for ext in ["webp", "jpg"] {
        let p = dir.join(format!("frame_{}.{}", i, ext));
        if p.exists() {
            return Some(p);
        }
    }
    None
}

pub fn parse_duration(stderr: &str) -> Option<f64> {
    for line in stderr.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Duration: ") {
            let time_str = rest.split(',').next()?;
            let parts: Vec<&str> = time_str.trim().split(':').collect();
            if parts.len() == 3 {
                let hours: f64 = parts[0].parse().ok()?;
                let minutes: f64 = parts[1].parse().ok()?;
                let seconds: f64 = parts[2].parse().ok()?;
                return Some(hours * 3600.0 + minutes * 60.0 + seconds);
            }
        }
    }
    None
}

pub fn get_video_duration(video_path: &Path) -> Result<f64, String> {
    let mut cmd = ffmpeg_command();
    cmd.args(["-i", &video_path.to_string_lossy()]);
    let output = cmd.output().map_err(|e| format!("Failed to run ffmpeg: {}", e))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_duration(&stderr).ok_or_else(|| "Could not parse video duration".to_string())
}

pub fn frames_dir(app_dir: &Path, track_id: i64) -> PathBuf {
    app_dir.join("video_frames").join(track_id.to_string())
}

pub struct CachedFrames {
    pub paths: Vec<String>,
    pub timestamps: Vec<f64>,
}

fn recipe_path(dir: &Path) -> PathBuf {
    dir.join("recipe.json")
}

/// Whether what's cached was cut by the recipe in force now. An unstamped dir is v1
/// (the marker postdates it), so it re-extracts once.
fn recipe_matches(dir: &Path) -> bool {
    std::fs::read_to_string(recipe_path(dir))
        .ok()
        .and_then(|d| d.trim().parse::<u32>().ok())
        == Some(FRAME_RECIPE)
}

pub fn get_cached_frames(app_dir: &Path, track_id: i64) -> Option<CachedFrames> {
    let dir = frames_dir(app_dir, track_id);
    if !recipe_matches(&dir) {
        return None;
    }
    let mut paths = Vec::with_capacity(FRAME_COUNT);
    for i in 0..FRAME_COUNT {
        let frame_path = frame_file(&dir, i)?;
        paths.push(frame_path.to_string_lossy().to_string());
    }
    let timestamps = read_timestamps(&dir).unwrap_or_default();
    Some(CachedFrames { paths, timestamps })
}

fn read_timestamps(dir: &Path) -> Option<Vec<f64>> {
    let meta_path = dir.join("meta.json");
    let data = std::fs::read_to_string(meta_path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_timestamps(dir: &Path, timestamps: &[f64]) {
    let meta_path = dir.join("meta.json");
    if let Ok(data) = serde_json::to_string(timestamps) {
        let _ = std::fs::write(meta_path, data);
    }
}

pub fn extract_frames(app_dir: &Path, track_id: i64, video_path: &Path) -> Result<(Vec<String>, Vec<f64>), String> {
    let duration = get_video_duration(video_path)?;
    if duration <= 0.0 {
        return Err("Video has zero duration".to_string());
    }

    let dir = frames_dir(app_dir, track_id);
    // Start from a clean dir so we never mix formats from an earlier run.
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create frames dir: {}", e))?;

    let ext = frame_ext();
    let mut paths = Vec::with_capacity(FRAME_COUNT);
    for (i, &position) in FRAME_POSITIONS.iter().enumerate() {
        let timestamp = duration * position;
        let output_path = dir.join(format!("frame_{}.{}", i, ext));
        let output_str = output_path.to_string_lossy().to_string();
        let timestamp_str = format!("{:.2}", timestamp);
        let window_str = format!("{:.2}", WINDOW_SECS);

        let mut cmd = ffmpeg_command();
        cmd.args([
            "-hide_banner",
            "-loglevel", "error",
            // Fast input seek to ~position, then decode only a short window so
            // long videos stay cheap (we never decode the whole file).
            "-ss", &timestamp_str,
            "-i", &video_path.to_string_lossy(),
            "-t", &window_str,
            "-an",
            "-vf", SCALE_FILTER,
            "-frames:v", "1",
        ]);
        if ext == "webp" {
            cmd.args(["-c:v", "libwebp", "-quality", "82"]);
        } else {
            // yuvj420p keeps full-range color so JPEGs don't look washed out.
            cmd.args(["-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj420p"]);
        }
        cmd.args(["-y", &output_str]);
        let output = cmd.output().map_err(|e| format!("Failed to run ffmpeg for frame {}: {}", i, e))?;

        if !output.status.success() || !output_path.exists() {
            let _ = std::fs::remove_dir_all(&dir);
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg frame extraction failed for frame {}: {}", i, stderr));
        }

        paths.push(output_str);
    }

    let timestamps: Vec<f64> = FRAME_POSITIONS.iter().map(|p| duration * p).collect();
    write_timestamps(&dir, &timestamps);
    // Last, so a run that died part-way isn't mistaken for a complete one.
    let _ = std::fs::write(recipe_path(&dir), FRAME_RECIPE.to_string());

    log::info!("Extracted {} video frames for track {} from {}", FRAME_COUNT, track_id, video_path.display());
    Ok((paths, timestamps))
}

pub fn delete_cached_frames(app_dir: &Path, track_id: i64) {
    let dir = frames_dir(app_dir, track_id);
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cache with no stamp is v1 — cut before the marker existed, and by the scale
    /// filter that stretched anamorphic sources — so it must not be served.
    #[test]
    fn test_frames_cut_by_an_older_recipe_are_not_served() {
        let dir = tempfile::tempdir().unwrap();
        let fdir = frames_dir(dir.path(), 7);
        std::fs::create_dir_all(&fdir).unwrap();
        std::fs::write(fdir.join("frame_0.jpg"), b"not really a jpeg").unwrap();
        assert!(
            get_cached_frames(dir.path(), 7).is_none(),
            "an unstamped cache is v1 and must be re-extracted"
        );

        std::fs::write(recipe_path(&fdir), FRAME_RECIPE.to_string()).unwrap();
        assert!(get_cached_frames(dir.path(), 7).is_some(), "a current cache must be served");

        std::fs::write(recipe_path(&fdir), (FRAME_RECIPE + 1).to_string()).unwrap();
        assert!(
            get_cached_frames(dir.path(), 7).is_none(),
            "a stamp from a recipe this build doesn't know is not ours to serve either"
        );
    }

    #[test]
    fn test_parse_duration_standard() {
        let stderr = "  Duration: 00:03:45.67, start: 0.000000, bitrate: 1234 kb/s\n";
        let result = parse_duration(stderr).unwrap();
        assert!((result - 225.67).abs() < 0.01, "Expected ~225.67, got {}", result);
    }

    #[test]
    fn test_parse_duration_hours() {
        let stderr = "  Duration: 01:30:00.00, start: 0.000000\n";
        assert_eq!(parse_duration(stderr), Some(5400.0));
    }

    #[test]
    fn test_parse_duration_short() {
        let stderr = "  Duration: 00:00:12.50, start: 0.000000\n";
        assert_eq!(parse_duration(stderr), Some(12.5));
    }

    #[test]
    fn test_parse_duration_missing() {
        let stderr = "Input #0, mov,mp4,m4a from 'video.mp4':\n";
        assert_eq!(parse_duration(stderr), None);
    }

    #[test]
    fn test_parse_duration_multiline() {
        let stderr = "Input #0, mov from 'video.mp4':\n  Metadata:\n    title: test\n  Duration: 00:01:23.45, start: 0.0\n  Stream #0: Video\n";
        assert_eq!(parse_duration(stderr), Some(83.45));
    }
}
