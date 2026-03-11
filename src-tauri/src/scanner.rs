use lofty::prelude::*;
use lofty::probe::Probe;
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
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
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown");

    // Pattern 1: "03 - Artist - Title"
    let re1 = Regex::new(r"^(?P<track>\d+)[\s._-]+(?P<artist>.+?)\s*-\s*(?P<title>.+)$").unwrap();
    // Pattern 2: "Artist - Title"
    let re2 = Regex::new(r"^(?P<artist>.+?)\s*-\s*(?P<title>.+)$").unwrap();
    // Pattern 3: "03 - Title"
    let re3 = Regex::new(r"^(?P<track>\d+)[\s._-]+(?P<title>.+)$").unwrap();

    if let Some(caps) = re1.captures(stem) {
        return ParsedTags {
            title: caps["title"].trim().to_string(),
            artist: Some(caps["artist"].trim().to_string()),
            album: parent_folder_name(path),
            genre: None,
            year: None,
            track_number: caps["track"].parse().ok(),
            duration_secs,
        };
    }

    if let Some(caps) = re2.captures(stem) {
        return ParsedTags {
            title: caps["title"].trim().to_string(),
            artist: Some(caps["artist"].trim().to_string()),
            album: parent_folder_name(path),
            genre: None,
            year: None,
            track_number: None,
            duration_secs,
        };
    }

    if let Some(caps) = re3.captures(stem) {
        return ParsedTags {
            title: caps["title"].trim().to_string(),
            artist: grandparent_folder_name(path),
            album: parent_folder_name(path),
            genre: None,
            year: None,
            track_number: caps["track"].parse().ok(),
            duration_secs,
        };
    }

    // Ultimate fallback
    ParsedTags {
        title: stem.to_string(),
        artist: grandparent_folder_name(path),
        album: parent_folder_name(path),
        genre: None,
        year: None,
        track_number: None,
        duration_secs,
    }
}

fn parent_folder_name(path: &Path) -> Option<String> {
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
}

fn grandparent_folder_name(path: &Path) -> Option<String> {
    path.parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
}

pub fn scan_folder(
    db: &Arc<Database>,
    folder_path: &str,
    progress_callback: impl Fn(u64, u64) + Send,
) {
    let root = PathBuf::from(folder_path);

    // First pass: count files
    let total: u64 = WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_media_file(e.path()))
        .count() as u64;

    // Second pass: process files
    let mut scanned: u64 = 0;
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_media_file(e.path()))
    {
        let path = entry.path();
        process_media_file(db, path);
        scanned += 1;
        if scanned % 10 == 0 || scanned == total {
            progress_callback(scanned, total);
        }
    }
}

pub fn process_media_file(db: &Arc<Database>, path: &Path) {
    let path_str = path.to_string_lossy().to_string();
    let tags = read_tags(path);

    let format = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    let file_size = std::fs::metadata(path).ok().map(|m| m.len() as i64);

    let modified_at = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);

    let artist_id = tags
        .artist
        .as_ref()
        .and_then(|name| db.get_or_create_artist(name).ok());

    let album_id = tags
        .album
        .as_ref()
        .and_then(|title| db.get_or_create_album(title, artist_id, tags.year).ok());

    let genre_id = tags
        .genre
        .as_ref()
        .and_then(|name| db.get_or_create_genre(name).ok());

    if let Ok(track_id) = db.upsert_track(
        &path_str,
        &tags.title,
        artist_id,
        album_id,
        genre_id,
        tags.track_number,
        tags.duration_secs,
        format.as_deref(),
        file_size,
        modified_at,
    ) {
        let _ = track_id;
    }
}

pub fn remove_media_file(db: &Arc<Database>, path: &Path) {
    let path_str = path.to_string_lossy().to_string();
    let _ = db.remove_track_by_path(&path_str);
}
