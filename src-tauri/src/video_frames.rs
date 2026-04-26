use std::path::{Path, PathBuf};
use std::process::Command;

const FRAME_COUNT: usize = 4;
const FRAME_POSITIONS: [f64; 4] = [0.10, 0.30, 0.60, 0.90];

fn ffmpeg_command() -> Command {
    let mut cmd = Command::new("ffmpeg");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

pub fn is_ffmpeg_available() -> bool {
    let mut cmd = ffmpeg_command();
    cmd.arg("-version");
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
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

pub fn get_cached_frames(app_dir: &Path, track_id: i64) -> Option<CachedFrames> {
    let dir = frames_dir(app_dir, track_id);
    let mut paths = Vec::with_capacity(FRAME_COUNT);
    for i in 0..FRAME_COUNT {
        let frame_path = dir.join(format!("frame_{}.jpg", i));
        if !frame_path.exists() {
            return None;
        }
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
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create frames dir: {}", e))?;

    let mut paths = Vec::with_capacity(FRAME_COUNT);
    for (i, &position) in FRAME_POSITIONS.iter().enumerate() {
        let timestamp = duration * position;
        let output_path = dir.join(format!("frame_{}.jpg", i));
        let output_str = output_path.to_string_lossy().to_string();

        let mut cmd = ffmpeg_command();
        cmd.args([
            "-ss", &format!("{:.2}", timestamp),
            "-i", &video_path.to_string_lossy(),
            "-frames:v", "1",
            "-q:v", "3",
            "-vf", "scale=480:-1",
            "-y",
            &output_str,
        ]);
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
