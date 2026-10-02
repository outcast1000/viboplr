//! Snapshots behind the Home "Latest play" shelf.
//!
//! A play that can't be rebuilt by name — a radio station, a generated mix, a
//! saved or plugin playlist, a multi-track selection — is captured as a
//! **playlist-only mixtape** (the existing `.mixtape` zip: `manifest.json` plus
//! an optional `cover.jpg`, no audio), one file per session in
//! `{profile}/recent-plays/`, so replaying it plays exactly what was heard.
//! Albums, artists and tags are not snapshotted; they replay by name from the
//! current library.
//!
//! A zip rather than the live queue's unzipped folder because a snapshot is
//! written once and never mutated — the queue folder exists because the queue
//! changes on every reorder. The format is the mixtape's, so a snapshot is a
//! valid `.mixtape` file as it stands.
//!
//! Lifecycle (the frontend owns the session list, Rust owns the files):
//! - written before the session that names it is recorded, so a crash leaves at
//!   worst an orphaned file, never a session pointing at nothing it can't
//!   survive (replay falls back when the file is missing anyway);
//! - deleted as soon as its session leaves the 12-entry Latest play ring;
//! - swept at startup by `gc`, which removes every file no session names.

use crate::models::BundleManifest;
use std::io::Read;
use std::path::{Path, PathBuf};

const DIR: &str = "recent-plays";
const EXT: &str = "mixtape";

fn folder(profile_dir: &Path) -> PathBuf {
    profile_dir.join(DIR)
}

/// Session ids are minted by the frontend and become file names, so they are
/// held to a strict charset — no separators, no dots — which rules out any
/// path traversal through the id.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn snapshot_path(profile_dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("invalid recent-play id: {id:?}"));
    }
    Ok(folder(profile_dir).join(format!("{id}.{EXT}")))
}

/// Write one snapshot. `cover` is a local image file; anything else (a URL, a
/// data URI, a missing file) is simply left out — the shelf card keeps its own
/// cover reference, so the zip's cover only matters for a later export, and a
/// play must never wait on a network fetch or fail over decoration.
pub fn write(profile_dir: &Path, id: &str, manifest: BundleManifest, cover: Option<&str>) -> Result<(), String> {
    let dest = snapshot_path(profile_dir, id)?;
    std::fs::create_dir_all(folder(profile_dir)).map_err(|e| format!("create recent-plays dir: {e}"))?;
    let cover_path = cover
        .map(|c| c.strip_prefix("file://").unwrap_or(c))
        .map(Path::new)
        .filter(|p| p.is_absolute() && p.is_file());
    match crate::mixtape::build_playlist_mixtape(&dest, cover_path, manifest.clone(), &[], false) {
        Ok(_) => Ok(()),
        // A cover that won't decode costs the snapshot its cover, not the snapshot.
        Err(e) if cover_path.is_some() => {
            log::warn!("recent-play {id}: cover left out ({e})");
            crate::mixtape::build_playlist_mixtape(&dest, None, manifest, &[], false).map(|_| ())
        }
        Err(e) => Err(e),
    }
}

/// The manifest of one snapshot, read straight out of the zip — no cover or
/// thumbnail is extracted, since replay needs only the track list.
pub fn read(profile_dir: &Path, id: &str) -> Result<BundleManifest, String> {
    let path = snapshot_path(profile_dir, id)?;
    let file = std::fs::File::open(&path).map_err(|e| format!("open recent-play {id}: {e}"))?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| format!("read recent-play {id}: {e}"))?;
    let mut entry = zip.by_name("manifest.json").map_err(|e| format!("recent-play {id} has no manifest: {e}"))?;
    let mut json = String::new();
    entry.read_to_string(&mut json).map_err(|e| format!("read recent-play {id} manifest: {e}"))?;
    serde_json::from_str(&json).map_err(|e| format!("parse recent-play {id} manifest: {e}"))
}

/// Delete one snapshot. A file that is already gone is not an error.
pub fn delete(profile_dir: &Path, id: &str) -> Result<(), String> {
    let path = snapshot_path(profile_dir, id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete recent-play {id}: {e}")),
    }
}

/// Remove every file in the folder except the snapshots of `keep` — orphans
/// from a crash between write and record, a reset store, and the writer's own
/// leftover `.tmp` files. Returns how many files were removed.
pub fn gc(profile_dir: &Path, keep: &[String]) -> Result<usize, String> {
    let dir = folder(profile_dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("read recent-plays dir: {e}")),
    };
    let keep: std::collections::HashSet<String> = keep
        .iter()
        .filter(|id| valid_id(id))
        .map(|id| format!("{id}.{EXT}"))
        .collect();
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if keep.contains(&name) || !entry.path().is_file() {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => removed += 1,
            Err(e) => log::warn!("recent-plays gc: couldn't remove {name}: {e}"),
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{BundleTrack, MixtapeType};
    use std::collections::HashMap;

    fn manifest(n: usize) -> BundleManifest {
        BundleManifest {
            version: 1,
            title: "Radio: Song".into(),
            mixtape_type: MixtapeType::Custom,
            metadata: HashMap::from([("source".to_string(), "radio".to_string())]),
            created_at: "2026-10-02T00:00:00Z".into(),
            created_by: None,
            cover: None,
            tracks: (0..n)
                .map(|i| BundleTrack {
                    title: format!("T{i}"),
                    artist: "A".into(),
                    album_artist: None,
                    album: None,
                    duration_secs: Some(180.0),
                    file: Some(format!("file:///m/{i}.flac")),
                    thumb: None,
                    format: Some("flac".into()),
                    image_url: None,
                    file_size: None,
                })
                .collect(),
        }
    }

    #[test]
    fn writes_a_readable_playlist_mixtape_and_reads_it_back() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "s1", manifest(3), None).unwrap();
        let path = tmp.path().join("recent-plays/s1.mixtape");
        assert!(path.is_file());
        // It is a real playlist-only mixtape: the mixtape reader opens it.
        let preview = crate::mixtape::read_mixtape(&path, tmp.path()).unwrap();
        assert_eq!(preview.manifest.tracks.len(), 3);
        let back = read(tmp.path(), "s1").unwrap();
        assert_eq!(back.title, "Radio: Song");
        assert_eq!(back.tracks.iter().map(|t| t.file.clone().unwrap()).collect::<Vec<_>>(),
                   vec!["file:///m/0.flac", "file:///m/1.flac", "file:///m/2.flac"]);
    }

    #[test]
    fn a_missing_or_undecodable_cover_never_fails_the_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "nocover", manifest(1), Some("https://example.com/c.jpg")).unwrap();
        let bad = tmp.path().join("bad.jpg");
        std::fs::write(&bad, b"not an image").unwrap();
        write(tmp.path(), "badcover", manifest(1), Some(bad.to_str().unwrap())).unwrap();
        assert_eq!(read(tmp.path(), "badcover").unwrap().cover, None);
    }

    #[test]
    fn rejects_ids_that_could_leave_the_folder() {
        let tmp = tempfile::tempdir().unwrap();
        for id in ["../x", "a/b", "a.b", "", "a\\b"] {
            assert!(write(tmp.path(), id, manifest(1), None).is_err(), "{id:?} accepted");
            assert!(read(tmp.path(), id).is_err());
            assert!(delete(tmp.path(), id).is_err());
        }
    }

    #[test]
    fn delete_is_idempotent_and_gc_keeps_only_named_snapshots() {
        let tmp = tempfile::tempdir().unwrap();
        for id in ["keep", "orphan", "gone"] {
            write(tmp.path(), id, manifest(1), None).unwrap();
        }
        std::fs::write(tmp.path().join("recent-plays/x.mixtape.tmp"), b"partial").unwrap();
        delete(tmp.path(), "gone").unwrap();
        delete(tmp.path(), "gone").unwrap();
        assert_eq!(gc(tmp.path(), &["keep".to_string()]).unwrap(), 2);
        let left: Vec<String> = std::fs::read_dir(tmp.path().join("recent-plays"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["keep.mixtape"]);
        // No folder yet is not an error.
        assert_eq!(gc(&tmp.path().join("nowhere"), &[]).unwrap(), 0);
    }
}
