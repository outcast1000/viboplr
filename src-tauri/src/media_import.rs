//! Putting a file that is already on this computer into a local collection —
//! the headless counterpart of the download modal's "Add to library", for
//! plugins that fetch files themselves (the Soulseek plugin's download jobs:
//! `api.library.planImport` / `api.library.importFile`).
//!
//! Three decisions live here so every caller makes them the same way:
//!
//! * **Is the song already there?** Unless the caller asks for a copy, a local
//!   library copy of the same song (the backend's accent-insensitive metadata
//!   match, length within [`SAME_RECORDING_TOLERANCE_SECS`]) stops the import
//!   and is returned instead, so the caller can offer Replace / Save as copy.
//!   A different length is a different recording (a live take), not a match.
//! * **Which collection?** The one already holding the album, else the one
//!   holding the artist, else the caller's default, else the only / first
//!   local collection ([`plan`]). Only enabled local folders can receive a file.
//! * **Where in it?** The download layout (`Artist/Album/NN Title`, or flat),
//!   and the first free `name (N)` when that name is taken — never overwritten.
//!
//! The source is **copied**, never moved: the plugin's file stays where it is
//! (slskd may be sharing it), and a failed ingest removes only the copy.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::downloader::{download_relative_path, free_path, write_tags, DownloadLayout};
use crate::models::{Collection, ImportPlacement, Track};

/// How far apart two lengths may be and still be the same recording.
pub const SAME_RECORDING_TOLERANCE_SECS: f64 = 5.0;

/// Serializes [`import_file`] (see the comment where it is taken).
static IMPORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The song a file is being imported as, plus where the caller wants it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTarget {
    pub title: String,
    pub artist_name: String,
    pub album_title: Option<String>,
    pub track_number: Option<u32>,
    /// Put it exactly here (must be an enabled local collection).
    pub collection_id: Option<i64>,
    /// Used when the album and artist aren't in any collection yet.
    pub default_collection_id: Option<i64>,
    /// Prefer the collection that already holds the album / artist. Default on.
    pub keep_with_existing: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub collection_id: i64,
    pub collection_name: String,
    pub placement: ImportPlacement,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// `"imported"` or `"exists"`.
    pub status: &'static str,
    pub track_id: i64,
    /// Absolute path of the imported file, or of the existing copy.
    pub path: String,
    pub collection_id: Option<i64>,
    pub collection_name: Option<String>,
    pub placement: Option<ImportPlacement>,
    /// `"exists"` only: how many local copies matched (the first is returned).
    pub copies: Option<usize>,
    #[serde(skip)]
    pub is_new: bool,
}

/// Enabled local folder collections — the only ones a file can be copied into.
pub fn local_collections(db: &Database) -> Result<Vec<Collection>, String> {
    Ok(db
        .get_collections()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|c| c.kind == "local" && c.enabled && c.path.as_deref().is_some_and(|p| !p.is_empty()))
        .collect())
}

/// Where a file for `target` would go. `Ok(None)` when there is no local
/// collection at all; `Err` when the caller named one that can't take files.
pub fn plan(db: &Database, target: &ImportTarget) -> Result<Option<ImportPlan>, String> {
    let locals = local_collections(db)?;
    if locals.is_empty() {
        return Ok(None);
    }
    let made = |c: &Collection, placement| ImportPlan {
        collection_id: c.id,
        collection_name: c.name.clone(),
        placement,
    };
    let find = |id: i64| locals.iter().find(|c| c.id == id);

    if let Some(id) = target.collection_id {
        return find(id)
            .map(|c| Some(made(c, ImportPlacement::Given)))
            .ok_or_else(|| "That collection can't receive files: it isn't a local folder that's switched on".to_string());
    }
    if target.keep_with_existing.unwrap_or(true) {
        if let Some((id, placement)) = db
            .local_collection_holding(&target.artist_name, target.album_title.as_deref())
            .map_err(|e| e.to_string())?
        {
            if let Some(c) = find(id) {
                return Ok(Some(made(c, placement)));
            }
        }
    }
    if locals.len() == 1 {
        return Ok(Some(made(&locals[0], ImportPlacement::Only)));
    }
    let chosen = target.default_collection_id.and_then(find).unwrap_or(&locals[0]);
    Ok(Some(made(chosen, ImportPlacement::Default)))
}

/// Local library copies of the song, nearest in length first. With a known
/// `duration_secs`, copies whose own length is known and further off than the
/// tolerance are a different recording and left out.
pub fn local_copies(
    db: &Database,
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration_secs: Option<f64>,
) -> Result<Vec<Track>, String> {
    let mut copies: Vec<Track> = db
        .find_tracks_by_metadata(title, Some(artist), album)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|t| t.path.starts_with("file://"))
        .filter(|t| match (duration_secs, t.duration_secs) {
            (Some(want), Some(have)) => (want - have).abs() <= SAME_RECORDING_TOLERANCE_SECS,
            _ => true,
        })
        .collect();
    if let Some(want) = duration_secs {
        copies.sort_by(|a, b| {
            let da = a.duration_secs.map(|d| (d - want).abs()).unwrap_or(f64::MAX);
            let db_ = b.duration_secs.map(|d| (d - want).abs()).unwrap_or(f64::MAX);
            da.partial_cmp(&db_).unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    Ok(copies)
}

/// The file's playing length, when its tags can be read.
fn file_duration(path: &Path) -> Option<f64> {
    use lofty::prelude::*;
    let tagged = crate::tag_writer::read_tagged_file(path).ok()?;
    Some(tagged.properties().duration().as_secs_f64()).filter(|d| *d > 0.0)
}

fn bare(path: &str) -> PathBuf {
    PathBuf::from(path.strip_prefix("file://").unwrap_or(path))
}

/// Copy `source` into the library as `target` (see the module doc).
pub fn import_file(
    db: &Arc<Database>,
    source: &str,
    target: &ImportTarget,
    layout: DownloadLayout,
    as_copy: bool,
) -> Result<ImportResult, String> {
    let title = target.title.trim();
    let artist = target.artist_name.trim();
    if title.is_empty() || artist.is_empty() {
        return Err("importFile needs the song's title and artist".to_string());
    }
    let source = bare(source);
    if !source.is_file() {
        return Err(format!("There's no file at {}", source.display()));
    }
    if !crate::scanner::is_media_file(&source) {
        return Err("That isn't a music or video file Vibo can play".to_string());
    }
    let album = target.album_title.as_deref().map(str::trim).filter(|a| !a.is_empty());

    // One import at a time, from the library check to the ingest. Both the
    // "already there?" answer and the free name are check-then-act: two jobs
    // landing the same song at once would otherwise both import it, or both
    // pick `02 Jóga.wav` and rename onto it — a rename replaces silently.
    let _guard = IMPORT_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    if !as_copy {
        let copies = local_copies(db, title, artist, album, file_duration(&source))?;
        if let Some(first) = copies.first() {
            return Ok(ImportResult {
                status: "exists",
                track_id: first.id,
                path: bare(&first.path).to_string_lossy().to_string(),
                collection_id: first.collection_id,
                collection_name: first.collection_name.clone(),
                placement: None,
                copies: Some(copies.len()),
                is_new: false,
            });
        }
    }

    let plan = plan(db, target)?
        .ok_or_else(|| "There's no music folder to save into. Add a local folder in Collections first.".to_string())?;
    let collection = db.get_collection_by_id(plan.collection_id).map_err(|e| e.to_string())?;
    let root = collection.path.clone().ok_or("That collection has no folder")?;

    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or("The file has no extension")?;
    let is_video = crate::scanner::VIDEO_EXTENSIONS.contains(&ext.as_str());
    let rel = download_relative_path(layout, artist, title, album, target.track_number, is_video, &ext);
    let dest = free_path(&Path::new(&root).join(rel))?;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create the folder: {}", e))?;
    }
    // The copy in progress carries no media extension, so a scan running
    // meanwhile — or one after a crash mid-copy — never indexes it as a track.
    let temp = dest.with_extension(format!("{}.viboplr-import", ext));
    if let Err(e) = std::fs::copy(&source, &temp) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Couldn't copy the file: {}", e));
    }
    if dest.exists() {
        // Something outside Vibo took the name since `free_path` looked.
        let _ = std::fs::remove_file(&temp);
        return Err(format!("{} appeared while importing; nothing was written over it", dest.display()));
    }
    if let Err(e) = std::fs::rename(&temp, &dest) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Couldn't move the file into place: {}", e));
    }
    // Tags go in once the file has its real name: lofty picks the format from
    // the extension, which the temp name deliberately doesn't have.
    if !is_video {
        if let Err(e) = write_tags(&dest, title, artist, album, target.track_number, None, None, None) {
            // The song is still worth having; it'll show under its old tags.
            log::warn!("Import: couldn't write tags into {}: {}", dest.display(), e);
        }
    }

    match crate::scanner::ingest_media_file(db, &dest, Some(collection.id), Some(&root)) {
        Some((track_id, is_new)) => {
            if let Err(e) = db.refresh_track_after_ingest(track_id) {
                log::error!("Import: failed to refresh track {} after ingest: {}", track_id, e);
            }
            Ok(ImportResult {
                status: "imported",
                track_id,
                path: dest.to_string_lossy().to_string(),
                collection_id: Some(collection.id),
                collection_name: Some(collection.name.clone()),
                placement: Some(plan.placement),
                copies: None,
                is_new,
            })
        }
        None => {
            // Only the copy is ours to remove; the source stays.
            let _ = std::fs::remove_file(&dest);
            Err("The library couldn't read the file".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Database {
        Database::new_in_memory().unwrap()
    }

    /// A silent mono 16-bit PCM WAV of `secs` seconds.
    fn write_wav(path: &Path, secs: f64) {
        use std::io::Write;
        let rate = 44100u32;
        let data_len = (secs * rate as f64) as u32 * 2;
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + data_len).to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&rate.to_le_bytes()).unwrap();
        f.write_all(&(rate * 2).to_le_bytes()).unwrap();
        f.write_all(&2u16.to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_len.to_le_bytes()).unwrap();
        f.write_all(&vec![0u8; data_len as usize]).unwrap();
    }

    fn local(db: &Database, name: &str, path: &str) -> i64 {
        db.add_collection("local", name, Some(path), None, None, None, None, None).unwrap().id
    }

    fn track(db: &Database, coll: i64, path: &str, title: &str, artist: &str, album: Option<&str>, secs: f64) -> i64 {
        let artist_id = db.get_or_create_artist(artist).unwrap();
        let album_id = album.map(|a| db.get_or_create_album(a, Some(artist_id), None).unwrap());
        db.upsert_track(path, title, Some(artist_id), album_id, None, Some(secs), Some("mp3"), Some(1), None, Some(coll), None)
            .unwrap()
    }

    fn target(title: &str, artist: &str, album: Option<&str>) -> ImportTarget {
        ImportTarget {
            title: title.into(),
            artist_name: artist.into(),
            album_title: album.map(Into::into),
            ..Default::default()
        }
    }

    #[test]
    fn no_local_collection_plans_nowhere() {
        let db = db();
        db.add_collection("subsonic", "Navidrome", None, Some("http://x"), None, None, None, None).unwrap();
        assert_eq!(plan(&db, &target("Angel", "Massive Attack", None)).unwrap(), None);
    }

    #[test]
    fn a_song_goes_next_to_its_album_then_its_artist() {
        let db = db();
        let music = local(&db, "Music", "/music");
        let old = local(&db, "Old drive", "/old");
        track(&db, old, "ma/mezz/01.mp3", "Teardrop", "Massive Attack", Some("Mezzanine"), 330.0);
        track(&db, music, "ma/blue/01.mp3", "Safe from Harm", "Massive Attack", Some("Blue Lines"), 330.0);
        track(&db, music, "ma/blue/02.mp3", "Daydreaming", "Massive Attack", Some("Blue Lines"), 330.0);

        let p = plan(&db, &target("Angel", "Massive Attack", Some("Mezzanine"))).unwrap().unwrap();
        assert_eq!((p.collection_id, p.placement), (old, ImportPlacement::Album));

        // An album nobody has: the collection with most of the artist.
        let p = plan(&db, &target("Hymn of the Big Wheel", "massive attack", Some("Blue Lines (Remaster)"))).unwrap().unwrap();
        assert_eq!((p.collection_id, p.placement), (music, ImportPlacement::Artist));
    }

    #[test]
    fn an_unknown_artist_takes_the_default_and_a_named_collection_wins() {
        let db = db();
        let music = local(&db, "Music", "/music");
        let other = local(&db, "Other", "/other");
        let mut t = target("Windowlicker", "Aphex Twin", None);
        t.default_collection_id = Some(other);
        assert_eq!(plan(&db, &t).unwrap().unwrap().collection_id, other);
        assert_eq!(plan(&db, &t).unwrap().unwrap().placement, ImportPlacement::Default);

        t.collection_id = Some(music);
        let p = plan(&db, &t).unwrap().unwrap();
        assert_eq!((p.collection_id, p.placement), (music, ImportPlacement::Given));
    }

    #[test]
    fn a_disabled_or_remote_collection_is_refused_when_named() {
        let db = db();
        local(&db, "Music", "/music");
        let nav = db.add_collection("subsonic", "Navidrome", None, Some("http://x"), None, None, None, None).unwrap().id;
        let mut t = target("Angel", "Massive Attack", None);
        t.collection_id = Some(nav);
        assert!(plan(&db, &t).is_err());
    }

    #[test]
    fn the_only_collection_is_labelled_so() {
        let db = db();
        let music = local(&db, "Music", "/music");
        let p = plan(&db, &target("Windowlicker", "Aphex Twin", None)).unwrap().unwrap();
        assert_eq!((p.collection_id, p.placement), (music, ImportPlacement::Only));
    }

    #[test]
    fn local_copies_ignore_a_different_recording_and_sort_by_length() {
        let db = db();
        let music = local(&db, "Music", "/music");
        let a = track(&db, music, "b/post/04.mp3", "Hyperballad", "Björk", Some("Post"), 321.0);
        let b = track(&db, music, "b/gh/04.mp3", "Hyperballad", "Björk", Some("Greatest Hits"), 318.0);
        track(&db, music, "b/live/04.mp3", "Hyperballad", "Björk", Some("Live"), 372.0);

        let ids: Vec<i64> = local_copies(&db, "Hyperballad", "Bjork", None, Some(320.5)).unwrap().iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![a, b]);
    }

    #[test]
    fn import_copies_tags_and_ingests_then_reports_the_existing_copy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Music");
        std::fs::create_dir_all(&root).unwrap();
        let db = Arc::new(db());
        local(&db, "Music", root.to_str().unwrap());

        let src_dir = dir.path().join("slskd");
        std::fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("02 - joga.wav");
        write_wav(&src, 2.0);

        let t = ImportTarget { track_number: Some(2), ..target("Jóga", "Björk", Some("Homogenic")) };
        let r = import_file(&db, src.to_str().unwrap(), &t, DownloadLayout::ArtistAlbum, false).unwrap();
        assert_eq!(r.status, "imported");
        assert!(r.is_new);
        assert!(src.exists(), "the source is copied, never moved");
        let dest = PathBuf::from(&r.path);
        assert!(dest.starts_with(&root));
        assert!(dest.ends_with(Path::new("Björk").join("Homogenic").join("02 Jóga.wav")));
        assert_eq!(db.get_track_by_id(r.track_id).unwrap().title, "Jóga");

        // Again: the song is in the library now, so it isn't copied twice.
        let again = import_file(&db, src.to_str().unwrap(), &t, DownloadLayout::ArtistAlbum, false).unwrap();
        assert_eq!((again.status, again.track_id, again.copies), ("exists", r.track_id, Some(1)));

        // As a copy: a second file beside the first, never over it.
        let copy = import_file(&db, src.to_str().unwrap(), &t, DownloadLayout::ArtistAlbum, true).unwrap();
        assert_eq!(copy.status, "imported");
        assert_ne!(copy.track_id, r.track_id);
        assert!(copy.path.ends_with("02 Jóga (2).wav"), "{}", copy.path);
    }

    #[test]
    fn concurrent_imports_of_one_song_never_share_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(db());
        let root = dir.path().join("Music");
        std::fs::create_dir_all(&root).unwrap();
        local(&db, "Music", root.to_str().unwrap());
        let src = dir.path().join("in.wav");
        write_wav(&src, 1.0);

        let t = target("Jóga", "Björk", Some("Homogenic"));
        let results: Vec<ImportResult> = std::thread::scope(|s| {
            let jobs: Vec<_> = (0..4)
                .map(|_| s.spawn(|| import_file(&db, src.to_str().unwrap(), &t, DownloadLayout::ArtistAlbum, true).unwrap()))
                .collect();
            jobs.into_iter().map(|j| j.join().unwrap()).collect()
        });
        let mut paths: Vec<_> = results.iter().map(|r| r.path.clone()).collect();
        paths.sort();
        paths.dedup();
        assert_eq!(paths.len(), 4, "every copy got its own file: {:?}", paths);
        let mut ids: Vec<_> = results.iter().map(|r| r.track_id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn concurrent_imports_without_as_copy_import_the_song_once() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(db());
        let root = dir.path().join("Music");
        std::fs::create_dir_all(&root).unwrap();
        local(&db, "Music", root.to_str().unwrap());
        let src = dir.path().join("in.wav");
        write_wav(&src, 1.0);

        let t = target("Jóga", "Björk", Some("Homogenic"));
        let statuses: Vec<&str> = std::thread::scope(|s| {
            let jobs: Vec<_> = (0..4)
                .map(|_| s.spawn(|| import_file(&db, src.to_str().unwrap(), &t, DownloadLayout::ArtistAlbum, false).unwrap().status))
                .collect();
            jobs.into_iter().map(|j| j.join().unwrap()).collect()
        });
        assert_eq!(statuses.iter().filter(|s| **s == "imported").count(), 1, "{:?}", statuses);
        assert_eq!(statuses.iter().filter(|s| **s == "exists").count(), 3, "{:?}", statuses);
    }

    #[test]
    fn an_import_leaves_no_temp_file_and_none_a_scan_would_take_for_media() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(db());
        let root = dir.path().join("Music");
        std::fs::create_dir_all(&root).unwrap();
        local(&db, "Music", root.to_str().unwrap());
        let src = dir.path().join("in.wav");
        write_wav(&src, 1.0);

        let r = import_file(&db, src.to_str().unwrap(), &target("Jóga", "Björk", None), DownloadLayout::Flat, false).unwrap();
        let dest = PathBuf::from(&r.path);
        let files: Vec<_> = std::fs::read_dir(dest.parent().unwrap()).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(files, vec![dest.clone()], "only the imported file is left");
        // The tags were still written, after the rename.
        assert_eq!(db.get_track_by_id(r.track_id).unwrap().title, "Jóga");
        // And the in-progress name is not something the scanner indexes.
        assert!(!crate::scanner::is_media_file(&dest.with_extension("wav.viboplr-import")));
    }

    #[test]
    fn import_refuses_a_file_that_isnt_media() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(db());
        local(&db, "Music", dir.path().to_str().unwrap());
        let src = dir.path().join("notes.txt");
        std::fs::write(&src, "hi").unwrap();
        assert!(import_file(&db, src.to_str().unwrap(), &target("A", "B", None), DownloadLayout::Flat, false).is_err());
    }
}
