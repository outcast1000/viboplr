// Manifest collections: an artist (or anyone) publishes an HTTP JSON manifest of
// tracks; the user subscribes to its URL and the app ingests the *metadata* as
// rows in a `manifest`-kind collection (bytes stream from each track's `url` on
// play, since http(s):// is a natively-playable scheme). Periodic refresh is the
// generic collection auto-update loop — see `commands::run_collection_resync`.
//
// Mirrors the upsert+prune shape of `sync.rs` (Subsonic), but the fetch is a
// single atomic JSON GET, so a successful parse is always a complete view and
// pruning removed tracks is safe.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::db::Database;

#[derive(Debug, Deserialize)]
pub struct Manifest {
    /// Display name for the source — applied as the collection name (e.g. "Artist — Album").
    #[serde(default)]
    pub name: Option<String>,
    /// Default artist for tracks that don't carry their own `artist`.
    #[serde(default)]
    pub artist: Option<String>,
    /// Artist avatar — parsed for the future discovery/home-shelf layer.
    #[serde(default)]
    #[allow(dead_code)]
    pub image: Option<String>,
    #[serde(default)]
    pub tracks: Vec<ManifestTrack>,
}

#[derive(Debug, Deserialize)]
pub struct ManifestTrack {
    pub title: String,
    /// Direct, playable URL (http/https). Stored as the track `path`.
    pub url: String,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default, alias = "duration")]
    pub duration_secs: Option<f64>,
    #[serde(default, alias = "track")]
    pub track_number: Option<i32>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// Per-track cover art — parsed for the future discovery/home-shelf layer.
    #[serde(default)]
    #[allow(dead_code)]
    pub cover: Option<String>,
}

/// Best-effort container format from a URL's file extension (e.g. `flac`, `mp3`).
/// Returns `None` for extension-less or implausible suffixes.
fn format_from_url(url: &str) -> Option<String> {
    let no_query = url.split(['?', '#']).next().unwrap_or(url);
    let file = no_query.rsplit('/').next().unwrap_or("");
    let (_, ext) = file.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_lowercase())
}

/// Fetch and parse a manifest from an HTTP(S) URL. Public so the add-collection
/// command can validate a URL up front (and fail) before creating anything.
pub fn fetch_manifest(url: &str) -> Result<Manifest, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Viboplr")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("Failed to fetch manifest: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Manifest fetch returned HTTP {}", resp.status()));
    }
    resp.json::<Manifest>()
        .map_err(|e| format!("Invalid manifest JSON: {}", e))
}

/// Ingest an already-parsed manifest into the given collection: upsert every
/// track (keyed by its URL) and prune any collection track no longer listed.
/// Returns the number of pruned tracks. Pure (no network) so it's unit-testable.
pub fn ingest_manifest(
    db: &Arc<Database>,
    manifest: &Manifest,
    collection_id: i64,
    progress_callback: impl Fn(u64, u64) + Send,
) -> Result<u64, String> {
    let start = std::time::Instant::now();

    // The manifest names the source — apply it as the collection's display name
    // (overrides the provisional name the caller created the collection with).
    if let Some(name) = manifest
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let _ = db.set_collection_name(collection_id, name);
    }

    let existing_paths: HashSet<String> = db
        .get_track_paths_for_collection(collection_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    let mut seen_paths: HashSet<String> = HashSet::new();

    let default_artist = manifest.artist.as_deref();
    let total = manifest.tracks.len() as u64;
    let mut done: u64 = 0;

    for track in &manifest.tracks {
        done += 1;
        // Skip malformed entries — a track needs at least a title and a URL.
        if track.title.trim().is_empty() || track.url.trim().is_empty() {
            if done % 20 == 0 || done == total {
                progress_callback(done, total);
            }
            continue;
        }

        let artist_id = track
            .artist
            .as_deref()
            .or(default_artist)
            .and_then(|name| db.get_or_create_artist(name).ok());

        let album_id = track
            .album
            .as_deref()
            .and_then(|title| db.get_or_create_album(title, artist_id, track.year).ok());

        let format = track.format.clone().or_else(|| format_from_url(&track.url));

        let path = track.url.clone();
        seen_paths.insert(path.clone());

        if let Ok(track_db_id) = db.upsert_track(
            &path,
            &track.title,
            artist_id,
            album_id,
            track.track_number,
            track.duration_secs,
            format.as_deref(),
            None,
            None,
            Some(collection_id),
            track.year,
        ) {
            if let Some(tags) = &track.tags {
                for tag in tags {
                    if tag.trim().is_empty() {
                        continue;
                    }
                    if let Ok(tag_id) = db.get_or_create_tag(tag) {
                        let _ = db.add_track_tag(track_db_id, tag_id);
                    }
                }
            }
        }

        if done % 20 == 0 || done == total {
            progress_callback(done, total);
        }
    }

    // Prune tracks no longer in the manifest. A successful JSON parse is a
    // complete snapshot of what's published, so the seen/not-seen diff is
    // trustworthy (unlike Subsonic's per-album fetch, which can partially fail).
    let removed: Vec<String> = existing_paths
        .into_iter()
        .filter(|p| !seen_paths.contains(p))
        .collect();
    let removed_count = removed.len() as u64;
    db.delete_tracks_by_paths_in_collection(collection_id, &removed)
        .map_err(|e| e.to_string())?;

    db.rebuild_fts().map_err(|e| e.to_string())?;
    db.recompute_counts().map_err(|e| e.to_string())?;
    // Seed tracks.liked for freshly-ingested rows liked before they existed.
    let _ = db.reconcile_track_likes_from_entity_likes();
    db.update_collection_synced(collection_id, start.elapsed().as_secs_f64())
        .map_err(|e| e.to_string())?;

    Ok(removed_count)
}

/// Fetch a manifest from `url` and ingest it into `collection_id`.
pub fn sync_manifest(
    db: &Arc<Database>,
    url: &str,
    collection_id: i64,
    progress_callback: impl Fn(u64, u64) + Send,
) -> Result<u64, String> {
    let manifest = fetch_manifest(url)?;
    ingest_manifest(db, &manifest, collection_id, progress_callback)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Arc<Database> {
        Arc::new(Database::new_in_memory().unwrap())
    }

    fn manifest_collection(db: &Arc<Database>) -> i64 {
        db.add_collection(
            "manifest",
            "Test Source",
            None,
            Some("https://example.com/manifest.json"),
            None,
            None,
            None,
            None,
        )
        .unwrap()
        .id
    }

    #[test]
    fn test_parse_manifest_json() {
        let json = r#"{
            "artist": "Nightshade",
            "image": "https://cdn.example.com/avatar.jpg",
            "tracks": [
                { "title": "Drift", "url": "https://cdn.example.com/drift.flac",
                  "album": "Demos", "duration": 210, "track": 1, "tags": ["ambient"] }
            ]
        }"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.artist.as_deref(), Some("Nightshade"));
        assert_eq!(m.tracks.len(), 1);
        assert_eq!(m.tracks[0].title, "Drift");
        // `duration`/`track` aliases map onto duration_secs/track_number.
        assert_eq!(m.tracks[0].duration_secs, Some(210.0));
        assert_eq!(m.tracks[0].track_number, Some(1));
    }

    #[test]
    fn test_manifest_name_sets_collection_name() {
        let db = test_db();
        let cid = manifest_collection(&db); // created with provisional name "Test Source"
        let m: Manifest = serde_json::from_str(
            r#"{ "name": "Aurora — Demos", "artist": "Aurora",
                 "tracks": [ { "title": "T1", "url": "https://h/t1.flac" } ] }"#,
        )
        .unwrap();
        ingest_manifest(&db, &m, cid, |_, _| {}).unwrap();
        assert_eq!(db.get_collection_by_id(cid).unwrap().name, "Aurora — Demos");
    }

    #[test]
    fn test_ingest_upserts_with_metadata() {
        let db = test_db();
        let cid = manifest_collection(&db);
        let m: Manifest = serde_json::from_str(
            r#"{ "artist": "Aurora", "tracks": [
                { "title": "T1", "url": "https://h/t1.flac", "album": "Alb", "tags": ["ambient", "calm"] },
                { "title": "T2", "url": "https://h/t2.mp3" }
            ] }"#,
        )
        .unwrap();
        let removed = ingest_manifest(&db, &m, cid, |_, _| {}).unwrap();
        assert_eq!(removed, 0);

        let mut paths = db.get_track_paths_for_collection(cid).unwrap();
        paths.sort();
        assert_eq!(paths, vec!["https://h/t1.flac".to_string(), "https://h/t2.mp3".to_string()]);
    }

    #[test]
    fn test_reingest_prunes_removed_tracks() {
        let db = test_db();
        let cid = manifest_collection(&db);

        let m1: Manifest = serde_json::from_str(
            r#"{ "artist": "Aurora", "tracks": [
                { "title": "T1", "url": "https://h/t1.flac" },
                { "title": "T2", "url": "https://h/t2.mp3" }
            ] }"#,
        )
        .unwrap();
        ingest_manifest(&db, &m1, cid, |_, _| {}).unwrap();

        // T2 dropped from the manifest → it should be pruned on re-ingest.
        let m2: Manifest = serde_json::from_str(
            r#"{ "artist": "Aurora", "tracks": [
                { "title": "T1", "url": "https://h/t1.flac" }
            ] }"#,
        )
        .unwrap();
        let removed = ingest_manifest(&db, &m2, cid, |_, _| {}).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(
            db.get_track_paths_for_collection(cid).unwrap(),
            vec!["https://h/t1.flac".to_string()]
        );
    }

    #[test]
    fn test_skips_malformed_entries() {
        let db = test_db();
        let cid = manifest_collection(&db);
        let m: Manifest = serde_json::from_str(
            r#"{ "tracks": [
                { "title": "", "url": "https://h/no-title.flac" },
                { "title": "No URL", "url": "" },
                { "title": "Good", "url": "https://h/good.flac" }
            ] }"#,
        )
        .unwrap();
        ingest_manifest(&db, &m, cid, |_, _| {}).unwrap();
        assert_eq!(
            db.get_track_paths_for_collection(cid).unwrap(),
            vec!["https://h/good.flac".to_string()]
        );
    }

    // End-to-end against the live demo repo: fetches the real manifest over the
    // network through the production `sync_manifest`, ingests it, then exercises
    // the real FTS Library search. Ignored by default (network); run with:
    //   cargo test live_github_manifest_end_to_end -- --ignored --nocapture
    #[test]
    #[ignore = "network: fetches the live demo manifest from GitHub"]
    fn test_live_github_manifest_end_to_end() {
        const MANIFEST: &str =
            "https://raw.githubusercontent.com/outcast1000/viboplr-oss-music-demo/main/manifest.json";
        const AUDIO_BASE: &str =
            "https://raw.githubusercontent.com/outcast1000/viboplr-oss-music-demo/main/audio/";

        let db = test_db();
        let cid = db
            .add_collection("manifest", "Open Source Test", None, Some(MANIFEST), None, None, None, None)
            .unwrap()
            .id;

        let removed = sync_manifest(&db, MANIFEST, cid, |_, _| {}).unwrap();
        assert_eq!(removed, 0, "nothing to prune on first sync");

        // The manifest carries its own display name → becomes the collection name.
        assert_eq!(
            db.get_collection_by_id(cid).unwrap().name,
            "Open Source Test - Manifest Demo"
        );

        // All tracks ingested; each stored path IS the playable audio URL.
        let paths = db.get_track_paths_for_collection(cid).unwrap();
        assert_eq!(paths.len(), 5, "expected 5 tracks from the live manifest");
        assert!(paths.iter().all(|p| p.starts_with(AUDIO_BASE)), "paths = playable URLs: {:?}", paths);

        // The real Library FTS search finds a tone track, with its playable URL.
        let by_title = db.search_all("Aurora", 5, 5, 5).unwrap();
        assert!(
            by_title.tracks.iter().any(|t| t.title == "Aurora"
                && t.path == format!("{}aurora.mp3", AUDIO_BASE)),
            "FTS search 'Aurora' should return the track with its URL; got {:?}",
            by_title.tracks.iter().map(|t| (&t.title, &t.path)).collect::<Vec<_>>()
        );

        // The two real m4a tracks ingest and are searchable by title + artist.
        let by_real = db.search_all("Positive Tension", 5, 5, 5).unwrap();
        assert!(
            by_real.tracks.iter().any(|t| t.title == "Positive Tension"
                && t.path == format!("{}bloc-party-positive-tension.m4a", AUDIO_BASE)),
            "FTS search 'Positive Tension' should return the Bloc Party track with its URL"
        );
        assert!(db.search_all("Bloc Party", 5, 5, 5).unwrap().artists.iter().any(|a| a.name == "Bloc Party"));
        assert!(db.search_all("Papazoglou", 5, 5, 5).unwrap().tracks.iter().any(|t| t.title == "Paravasi"));

        // Artist + album of the tone tracks remain searchable too.
        let by_artist = db.search_all("Open Source Test", 5, 5, 5).unwrap();
        assert!(by_artist.artists.iter().any(|a| a.name == "Open Source Test"));
        let by_album = db.search_all("Manifest Demo", 5, 5, 5).unwrap();
        assert!(by_album.albums.iter().any(|al| al.title == "Manifest Demo"));
    }

    #[test]
    fn test_format_inference() {
        assert_eq!(format_from_url("https://h/song.flac"), Some("flac".to_string()));
        assert_eq!(format_from_url("https://h/song.MP3?token=abc"), Some("mp3".to_string()));
        assert_eq!(format_from_url("https://h/path/clip.m4a#frag"), Some("m4a".to_string()));
        assert_eq!(format_from_url("https://h/song"), None);
        assert_eq!(format_from_url("https://h/song.toolongext"), None);
    }
}
