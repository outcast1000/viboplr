use log::info;
use lofty::prelude::*;
use lofty::probe::Probe;
use regex::Regex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use walkdir::WalkDir;

use crate::db::Database;

const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "aac", "m4a", "wav", "opus", "alac", "wma",
];

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "webm",
];

fn is_media_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_lowercase();
            AUDIO_EXTENSIONS.contains(&lower.as_str()) || VIDEO_EXTENSIONS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

struct ParsedTags {
    title: String,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    year: Option<i32>,
    track_number: Option<i32>,
    duration_secs: Option<f64>,
}

fn read_tags(path: &Path) -> ParsedTags {
    if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
        let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());

        let duration = tagged_file.properties().duration();
        let duration_secs = Some(duration.as_secs_f64()).filter(|&d| d > 0.0);

        if let Some(tag) = tag {
            let title = tag.title().map(|s| s.to_string());
            let artist = tag.artist().map(|s| s.to_string());
            let album = tag.album().map(|s| s.to_string());
            let genre = tag.genre().map(|s| s.to_string());
            let year = tag.year().map(|y| y as i32);
            let track_number = tag.track().map(|t| t as i32);

            if title.is_some() {
                return ParsedTags {
                    title: title.unwrap(),
                    artist,
                    album,
                    genre,
                    year,
                    track_number,
                    duration_secs,
                };
            }
        }
        // Tags exist but no title — fall through to filename parsing
        return fallback_from_filename(path, duration_secs);
    }
    fallback_from_filename(path, None)
}

fn fallback_from_filename(path: &Path, duration_secs: Option<f64>) -> ParsedTags {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Unknown");
    let parent = path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("");
    let grandparent = path.parent().and_then(|p| p.parent()).and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("");

    // Build "grandparent/parent/stem" for path-based regex matching
    let path_str = format!("{}/{}/{}", grandparent, parent, stem);

    // Each pattern matches against "grandparent/parent/filename_stem".
    // Patterns are tried most-specific first.
    let patterns: &[(&str, &str)] = &[
        // Artist - Album - 03 - Title  (all in filename)
        ("[^/]*/[^/]*/(?P<artist>.+?)\\s*-\\s*(?P<album>.+?)\\s*-\\s*(?P<track>\\d+)\\s*-\\s*(?P<title>.+)$",
         "filename has all four fields"),
        // Artist - Album/03 - Title  (artist-album in parent, track-title in filename)
        ("[^/]*/(?P<artist>[^/]+?)\\s*-\\s*(?P<album>[^/]+)/(?P<track>\\d+)[\\s._-]+(?P<title>.+)$",
         "artist-album folder, track-title filename"),
        // */Artist - Title  (artist-title in filename)
        ("[^/]*/[^/]*/(?P<artist>.+?)\\s*-\\s*(?P<title>.+)$",
         "artist-title filename"),
    ];

    for (pattern, _desc) in patterns {
        let re = Regex::new(&format!("^{}", pattern)).unwrap();
        if let Some(caps) = re.captures(&path_str) {
            return ParsedTags {
                title: caps.name("title").map(|m| m.as_str().trim().to_string())
                    .unwrap_or_else(|| stem.to_string()),
                artist: caps.name("artist").map(|m| m.as_str().trim().to_string()),
                album: caps.name("album").map(|m| m.as_str().trim().to_string()),
                genre: None,
                year: None,
                track_number: caps.name("track").and_then(|m| m.as_str().parse().ok()),
                duration_secs,
            };
        }
    }

    // Ultimate fallback (bare filename, no useful folder structure)
    ParsedTags {
        title: stem.to_string(),
        artist: None,
        album: None,
        genre: None,
        year: None,
        track_number: None,
        duration_secs,
    }
}

pub fn scan_folder(
    db: &Arc<Database>,
    folder_path: &str,
    collection_id: Option<i64>,
    progress_callback: impl Fn(u64, u64) + Send,
) {
    let root = PathBuf::from(folder_path);
    let start = Instant::now();

    // First pass: count files
    let total: u64 = WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_media_file(e.path()))
        .count() as u64;

    info!("Scan started: {} ({} media files found)", folder_path, total);

    // Second pass: process files and collect seen paths
    let mut scanned: u64 = 0;
    let mut seen_paths: HashSet<String> = HashSet::with_capacity(total as usize);
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_media_file(e.path()))
    {
        let path = entry.path();
        seen_paths.insert(path.to_string_lossy().to_string());
        process_media_file(db, path, collection_id);
        scanned += 1;
        if scanned % 10 == 0 || scanned == total {
            progress_callback(scanned, total);
        }
    }

    // Soft-delete tracks whose files no longer exist on disk
    if let Some(cid) = collection_id {
        if let Ok(db_paths) = db.get_local_track_paths_for_collection(cid) {
            let missing: Vec<String> = db_paths.into_iter().filter(|p| !seen_paths.contains(p)).collect();
            if !missing.is_empty() {
                info!("Soft-deleting {} tracks no longer on disk", missing.len());
                let _ = db.mark_tracks_deleted_by_paths(&missing);
            }
        }
    }

    let elapsed = start.elapsed();
    info!("Scan complete: {} files in {:.1}s", scanned, elapsed.as_secs_f64());
}

pub fn process_media_file(db: &Arc<Database>, path: &Path, collection_id: Option<i64>) {
    let path_str = path.to_string_lossy().to_string();

    let metadata = std::fs::metadata(path).ok();
    let modified_at = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);

    // Skip if file hasn't changed since last scan
    let stored_modified = db.get_track_modified_at_by_path(&path_str);
    if let (Some(stored), Some(current)) = (stored_modified, modified_at) {
        if stored >= current {
            return; // File unchanged, skip
        }
        info!("Updated file: {}", path_str);
    } else if stored_modified.is_some() {
        info!("Updated file: {}", path_str);
    } else {
        info!("New file: {}", path_str);
    }

    let tags = read_tags(path);

    let format = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    let file_size = metadata.map(|m| m.len() as i64);

    let artist_id = tags
        .artist
        .as_ref()
        .and_then(|name| db.get_or_create_artist(name).ok());

    let album_id = tags
        .album
        .as_ref()
        .and_then(|title| db.get_or_create_album(title, artist_id, tags.year).ok());

    if let Ok(track_id) = db.upsert_track(
        &path_str,
        &tags.title,
        artist_id,
        album_id,
        tags.track_number,
        tags.duration_secs,
        format.as_deref(),
        file_size,
        modified_at,
        collection_id,
        None,
    ) {
        if let Some(genre) = &tags.genre {
            if let Ok(tag_id) = db.get_or_create_tag(genre) {
                let _ = db.add_track_tag(track_id, tag_id);
            }
        }
    }
}

pub fn remove_media_file(db: &Arc<Database>, path: &Path) {
    let path_str = path.to_string_lossy().to_string();
    info!("Removed file: {}", path_str);
    let _ = db.remove_track_by_path(&path_str);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_media_file_audio() {
        for ext in &["mp3", "flac", "aac", "m4a", "wav", "opus", "alac", "wma"] {
            let path = PathBuf::from(format!("song.{}", ext));
            assert!(is_media_file(&path), "expected {} to be media", ext);
        }
    }

    #[test]
    fn test_is_media_file_video() {
        for ext in &["mp4", "m4v", "mov", "webm"] {
            let path = PathBuf::from(format!("video.{}", ext));
            assert!(is_media_file(&path), "expected {} to be media", ext);
        }
    }

    #[test]
    fn test_is_media_file_case_insensitive() {
        assert!(is_media_file(Path::new("song.MP3")));
        assert!(is_media_file(Path::new("song.Flac")));
    }

    #[test]
    fn test_is_media_file_rejects_non_media() {
        for ext in &["txt", "jpg", "png", "pdf", "doc", "exe", "rs"] {
            let path = PathBuf::from(format!("file.{}", ext));
            assert!(!is_media_file(&path), "expected {} to NOT be media", ext);
        }
    }

    #[test]
    fn test_is_media_file_no_extension() {
        assert!(!is_media_file(Path::new("README")));
    }

    #[test]
    fn test_fallback_artist_album_track_title() {
        // "Artist - Album - 03 - Title" pattern (all in filename)
        let path = Path::new("/Music/Unknown/Pink Floyd - Dark Side - 03 - Time.mp3");
        let tags = fallback_from_filename(path, Some(300.0));
        assert_eq!(tags.title, "Time");
        assert_eq!(tags.artist.as_deref(), Some("Pink Floyd"));
        assert_eq!(tags.album.as_deref(), Some("Dark Side"));
        assert_eq!(tags.track_number, Some(3));
        assert_eq!(tags.duration_secs, Some(300.0));
    }

    #[test]
    fn test_fallback_artist_title() {
        // "Artist - Title" pattern in filename
        let path = Path::new("/Music/Unknown/Radiohead - Creep.mp3");
        let tags = fallback_from_filename(path, None);
        assert_eq!(tags.title, "Creep");
        assert_eq!(tags.artist.as_deref(), Some("Radiohead"));
        assert!(tags.album.is_none());
    }

    #[test]
    fn test_fallback_folder_structure() {
        // "Artist - Album/03 - Title" pattern
        let path = Path::new("/Music/Pink Floyd - Dark Side/03 - Time.mp3");
        let tags = fallback_from_filename(path, None);
        assert_eq!(tags.title, "Time");
        assert_eq!(tags.artist.as_deref(), Some("Pink Floyd"));
        assert_eq!(tags.album.as_deref(), Some("Dark Side"));
        assert_eq!(tags.track_number, Some(3));
    }

    #[test]
    fn test_fallback_bare_filename() {
        // No parseable structure — just returns filename as title
        let path = Path::new("/somefile.mp3");
        let tags = fallback_from_filename(path, None);
        assert_eq!(tags.title, "somefile");
        assert!(tags.artist.is_none());
        assert!(tags.album.is_none());
        assert!(tags.track_number.is_none());
    }
}
