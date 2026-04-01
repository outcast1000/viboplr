use encoding_rs::{WINDOWS_1251, WINDOWS_1252, WINDOWS_1253, WINDOWS_1254, WINDOWS_1255, WINDOWS_1256};
use log::info;
use lofty::prelude::*;
use lofty::probe::Probe;
use regex::Regex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
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

fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
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

/// Fix misencoded tag strings from ID3v1 or Latin-1-declared ID3v2 frames.
///
/// Lofty reads non-Unicode tag strings as Latin-1 (ISO 8859-1). If the actual
/// encoding was a different codepage (e.g. Windows-1253 for Greek, Windows-1251
/// for Cyrillic), the resulting string will contain garbled Latin characters.
///
/// This function detects that case by checking if all characters are ≤ U+00FF
/// with high-byte characters present, then tries UTF-8 and common Windows
/// codepages. It picks the decoding that produces the most Unicode letters.
fn fix_encoding(s: &str) -> String {
    // If the string is pure ASCII, or already contains characters > U+00FF
    // (i.e. real Unicode from a properly encoded tag), return as-is.
    let has_high = s.chars().any(|c| c as u32 > 0x7F);
    if !has_high {
        return s.to_string();
    }
    let all_latin1 = s.chars().all(|c| (c as u32) <= 0x00FF);
    if !all_latin1 {
        return s.to_string();
    }

    // Extract the raw bytes (Latin-1: each char maps 1:1 to a byte)
    let bytes: Vec<u8> = s.chars().map(|c| c as u8).collect();

    // Try UTF-8 first — many modern taggers write UTF-8 into legacy fields
    if let Ok(decoded) = std::str::from_utf8(&bytes) {
        if decoded.chars().any(|c| c as u32 > 0x7F) {
            return decoded.to_string();
        }
    }

    // Try common Windows codepages and pick the best result.
    // Score = number of chars above U+00FF. The garbled Latin-1 text always
    // scores 0 (all chars ≤ 0xFF). A correct decoding into Greek, Cyrillic,
    // etc. scores > 0 because those scripts live above U+00FF.
    let codepages = [
        WINDOWS_1253, // Greek
        WINDOWS_1251, // Cyrillic
        WINDOWS_1256, // Arabic
        WINDOWS_1255, // Hebrew
        WINDOWS_1254, // Turkish
        WINDOWS_1252, // Western European
    ];

    let mut best = s.to_string();
    let mut best_score: usize = 0; // original garbled text always scores 0

    for encoding in &codepages {
        let (decoded, _, had_errors) = encoding.decode(&bytes);
        if had_errors {
            continue;
        }
        let score = decoded.chars().filter(|&c| c as u32 > 0xFF).count();
        if score > best_score {
            best_score = score;
            best = decoded.into_owned();
        }
    }

    best
}

fn read_tags(path: &Path) -> ParsedTags {
    if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
        let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());

        let duration = tagged_file.properties().duration();
        let duration_secs = Some(duration.as_secs_f64()).filter(|&d| d > 0.0);

        if let Some(tag) = tag {
            let title = tag.title().map(|s| fix_encoding(&s));
            let artist = tag.artist().map(|s| fix_encoding(&s));
            let album = tag.album().map(|s| fix_encoding(&s));
            let genre = tag.genre().map(|s| fix_encoding(&s));
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

static FALLBACK_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        // Artist - Album - 03 - Title  (all in filename)
        Regex::new(r"^[^/]*/[^/]*/(?P<artist>.+?)\s*-\s*(?P<album>.+?)\s*-\s*(?P<track>\d+)\s*-\s*(?P<title>.+)$").unwrap(),
        // Artist - Album/03 - Title  (artist-album in parent, track-title in filename)
        Regex::new(r"^[^/]*/(?P<artist>[^/]+?)\s*-\s*(?P<album>[^/]+)/(?P<track>\d+)[\s._-]+(?P<title>.+)$").unwrap(),
        // */03 - Title  (track number + title in filename, no artist)
        Regex::new(r"^[^/]*/[^/]*/(?P<track>\d+)\s*-\s*(?P<title>.+)$").unwrap(),
        // */Artist - Title  (artist-title in filename)
        Regex::new(r"^[^/]*/[^/]*/(?P<artist>.+?)\s*-\s*(?P<title>.+)$").unwrap(),
    ]
});

fn fallback_from_filename(path: &Path, duration_secs: Option<f64>) -> ParsedTags {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Unknown");
    let parent = path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("");
    let grandparent = path.parent().and_then(|p| p.parent()).and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("");

    // Build "grandparent/parent/stem" for path-based regex matching
    let path_str = format!("{}/{}/{}", grandparent, parent, stem);

    for regex in FALLBACK_PATTERNS.iter() {
        if let Some(caps) = regex.captures(&path_str) {
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
        .filter(|e| e.file_type().is_file() && is_media_file(e.path()) && e.metadata().map(|m| m.len() > 0).unwrap_or(false))
        .count() as u64;

    info!("Scan started: {} ({} media files found)", folder_path, total);

    // Second pass: process files and collect seen paths
    let mut scanned: u64 = 0;
    let mut seen_paths: HashSet<String> = HashSet::with_capacity(total as usize);
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_media_file(e.path()) && e.metadata().map(|m| m.len() > 0).unwrap_or(false))
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
                info!("Deleting {} tracks no longer on disk", missing.len());
                let _ = db.delete_tracks_by_paths(&missing);
            }
        }
    }

    let elapsed = start.elapsed();
    info!("Scan complete: {} files in {:.1}s", scanned, elapsed.as_secs_f64());
}

pub fn process_media_file(db: &Arc<Database>, path: &Path, collection_id: Option<i64>) {
    let path_str = path.to_string_lossy().to_string();

    let metadata = std::fs::metadata(path).ok();

    // Skip 0-byte files
    if metadata.as_ref().map(|m| m.len() == 0).unwrap_or(false) {
        return;
    }
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

    let format = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    let file_size = metadata.map(|m| m.len() as i64);

    // For video files, use filename as title but try to read duration from file properties
    if is_video_file(path) {
        let title = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Unknown").to_string();
        let duration_secs = Probe::open(path)
            .and_then(|p| p.read())
            .ok()
            .map(|f| f.properties().duration().as_secs_f64())
            .filter(|&d| d > 0.0);
        let _ = db.upsert_track(
            &path_str,
            &title,
            None,
            None,
            None,
            duration_secs,
            format.as_deref(),
            file_size,
            modified_at,
            collection_id,
            None,
            None,
        );
        return;
    }

    let tags = read_tags(path);

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
        tags.year,
    ) {
        if let Some(genre) = &tags.genre {
            if let Ok(tag_id) = db.get_or_create_tag(genre) {
                let _ = db.add_track_tag(track_id, tag_id);
            }
        }
    }
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

    #[test]
    fn test_fallback_trackno_title_not_artist() {
        // "01 - MYSTERY.mp3" in a flat folder should NOT be parsed as Artist: 01, Title: MYSTERY
        // This simulates a file at the root of a scanned folder with no meaningful parent structure
        let path = Path::new("/root/01 - MYSTERY.mp3");
        let tags = fallback_from_filename(path, None);
        assert_eq!(tags.title, "MYSTERY");
        assert!(tags.artist.is_none(), "numeric prefix should not be treated as artist, got: {:?}", tags.artist);
        assert_eq!(tags.track_number, Some(1));
    }

    #[test]
    fn test_fallback_trackno_title_two_digits() {
        // Same pattern with 2-digit track number
        let path = Path::new("/root/12 - Song Name.mp3");
        let tags = fallback_from_filename(path, None);
        assert_eq!(tags.title, "Song Name");
        assert!(tags.artist.is_none(), "numeric prefix should not be treated as artist, got: {:?}", tags.artist);
        assert_eq!(tags.track_number, Some(12));
    }

    #[test]
    fn test_fix_encoding_ascii_unchanged() {
        assert_eq!(fix_encoding("Hello World"), "Hello World");
    }

    #[test]
    fn test_fix_encoding_real_unicode_unchanged() {
        // Already proper Unicode (e.g. from a UTF-16 ID3v2 tag) — leave as-is
        assert_eq!(fix_encoding("Θεοί Του Φόβου"), "Θεοί Του Φόβου");
    }

    #[test]
    fn test_fix_encoding_greek_cp1253() {
        // Simulate: "Θεοί" in Windows-1253 is bytes [0xC8, 0xE5, 0xEF, 0xDF]
        // Lofty reads them as Latin-1: "Èåïß"
        let (encoded, _, _) = WINDOWS_1253.encode("Θεοί");
        let garbled: String = encoded.iter().map(|&b| b as char).collect();
        assert_eq!(fix_encoding(&garbled), "Θεοί");
    }

    #[test]
    fn test_fix_encoding_cyrillic_cp1251() {
        // Simulate: "Тест" in Windows-1251 (Т=0xD2 is undefined in CP1253, so Greek is skipped)
        let (encoded, _, _) = WINDOWS_1251.encode("Тест");
        let garbled: String = encoded.iter().map(|&b| b as char).collect();
        assert_eq!(fix_encoding(&garbled), "Тест");
    }

    #[test]
    fn test_fix_encoding_utf8_in_latin1() {
        // Simulate: UTF-8 bytes for "café" read as Latin-1
        let utf8_bytes = "café".as_bytes();
        let garbled: String = utf8_bytes.iter().map(|&b| b as char).collect();
        assert_eq!(fix_encoding(&garbled), "café");
    }
}
