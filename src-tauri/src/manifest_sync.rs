// Manifest collections: an artist (or anyone) publishes an HTTP JSON manifest of
// tracks; the user subscribes to its URL and the app ingests the *metadata* as
// rows in a `manifest`-kind collection (bytes stream from each track's `url` on
// play, since http(s):// is a natively-playable scheme). Periodic refresh is the
// generic collection auto-update loop — see `commands::run_collection_resync`.
//
// Mirrors the upsert+prune shape of `sync.rs` (Subsonic), but the fetch is a
// single atomic JSON GET, so a successful parse is always a complete view and
// pruning removed tracks is safe.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::db::collections::ManifestIngestTrack;
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
    /// The track's audio reference: an absolute http(s) URL, or a path relative
    /// to the manifest URL (Option C). Aliases keep legacy (`url`) and
    /// mixtape-shaped (`file`) manifests parseable. Resolved to an absolute URL
    /// and stored as the track `path` (see `bundle_ref::resolve_subscribe_ref`).
    #[serde(alias = "src", alias = "file")]
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
pub enum FetchOutcome {
    /// Server returned a fresh manifest; carries the new validators to persist.
    Fetched {
        manifest: Manifest,
        etag: Option<String>,
        last_modified: Option<String>,
    },
    /// Server replied 304 Not Modified — skip ingest entirely.
    NotModified,
}

pub fn fetch_manifest(
    url: &str,
    prior_etag: Option<&str>,
    prior_last_modified: Option<&str>,
) -> Result<FetchOutcome, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Viboplr")
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    if let Some(etag) = prior_etag {
        req = req.header("If-None-Match", etag);
    }
    if let Some(lm) = prior_last_modified {
        req = req.header("If-Modified-Since", lm);
    }
    let resp = req.send().map_err(|e| format!("Failed to fetch manifest: {}", e))?;
    if resp.status().as_u16() == 304 {
        return Ok(FetchOutcome::NotModified);
    }
    if !resp.status().is_success() {
        return Err(format!("Manifest fetch returned HTTP {}", resp.status()));
    }
    let etag = resp.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_string);
    let last_modified = resp.headers().get("last-modified").and_then(|v| v.to_str().ok()).map(str::to_string);
    let manifest = resp.json::<Manifest>().map_err(|e| format!("Invalid manifest JSON: {}", e))?;
    Ok(FetchOutcome::Fetched { manifest, etag, last_modified })
}

/// Ingest an already-parsed manifest into the given collection: upsert every
/// track (keyed by its resolved URL) and prune any collection track no longer
/// listed. Returns the number of pruned tracks. Pure (no network) so it's
/// unit-testable.
///
/// `base_url` is the URL the manifest was fetched from — relative track refs are
/// resolved against it (Option C). A ref that can't be resolved to an http(s)
/// URL is dropped (and thus pruned if it was present before); this is the
/// reader-side guardrail, so a manifest can never point the app at `file://` or a
/// private scheme.
pub fn ingest_manifest(
    db: &Arc<Database>,
    manifest: &Manifest,
    collection_id: i64,
    base_url: &str,
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

    let default_artist = manifest.artist.as_deref();
    let items: Vec<ManifestIngestTrack> = manifest
        .tracks
        .iter()
        .filter_map(|t| {
            let resolved = match crate::bundle_ref::resolve_subscribe_ref(base_url, &t.url) {
                Some(u) => u,
                None => {
                    log::warn!("Skipping manifest track '{}' — unresolvable/disallowed ref: {}", t.title, t.url);
                    return None;
                }
            };
            Some(ManifestIngestTrack {
                title: t.title.clone(),
                artist: t.artist.clone().or_else(|| default_artist.map(str::to_string)),
                album: t.album.clone(),
                duration_secs: t.duration_secs,
                track_number: t.track_number,
                format: t.format.clone().or_else(|| format_from_url(&resolved)),
                year: t.year,
                url: resolved,
                tags: t.tags.clone().unwrap_or_default(),
            })
        })
        .collect();

    // One transaction: upsert + tag replace + incremental FTS + prune.
    // O(changed rows), not O(whole library) — no full FTS rebuild.
    let stats = db
        .manifest_ingest(collection_id, &items, &progress_callback)
        .map_err(|e| e.to_string())?;

    // Counts + like-state reconcile stay whole-library for correctness; the
    // conditional fetch in `sync_manifest` skips all of this when unchanged.
    db.recompute_counts().map_err(|e| e.to_string())?;
    let _ = db.reconcile_track_likes_from_entity_likes();
    db.update_collection_synced(collection_id, start.elapsed().as_secs_f64())
        .map_err(|e| e.to_string())?;

    Ok(stats.removed)
}

/// Conditionally fetch a manifest from `url` (sending stored ETag/Last-Modified)
/// and ingest it into `collection_id`. A 304 Not Modified skips ingest entirely
/// and just refreshes the sync timestamp. Used by the auto-update/resync path.
pub fn sync_manifest(
    db: &Arc<Database>,
    url: &str,
    collection_id: i64,
    progress_callback: impl Fn(u64, u64) + Send,
) -> Result<u64, String> {
    let (prior_etag, prior_lm) = db.get_manifest_http_cache(collection_id).unwrap_or((None, None));
    match fetch_manifest(url, prior_etag.as_deref(), prior_lm.as_deref())? {
        FetchOutcome::NotModified => {
            // Unchanged — refresh last_synced_at so the cadence resets, skip ingest.
            let _ = db.update_collection_synced(collection_id, 0.0);
            Ok(0)
        }
        FetchOutcome::Fetched { manifest, etag, last_modified } => {
            let removed = ingest_manifest(db, &manifest, collection_id, url, progress_callback)?;
            let _ = db.set_manifest_http_cache(collection_id, etag.as_deref(), last_modified.as_deref());
            Ok(removed)
        }
    }
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
        ingest_manifest(&db, &m, cid, "https://example.com/manifest.json", |_, _| {}).unwrap();
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
        let removed = ingest_manifest(&db, &m, cid, "https://example.com/manifest.json", |_, _| {}).unwrap();
        assert_eq!(removed, 0);

        let mut paths = db.get_track_paths_for_collection(cid).unwrap();
        paths.sort();
        assert_eq!(paths, vec!["https://h/t1.flac".to_string(), "https://h/t2.mp3".to_string()]);
    }

    #[test]
    fn test_ingest_resolves_relative_refs_against_manifest_url() {
        // Option C: a portable manifest with relative `src` refs resolves each
        // against the URL it was fetched from. `file`/`url`/`src` all deserialize.
        let db = test_db();
        let cid = manifest_collection(&db);
        let m: Manifest = serde_json::from_str(
            r#"{ "artist": "Aurora", "tracks": [
                { "title": "T1", "src": "tracks/t1.flac" },
                { "title": "T2", "url": "https://cdn.other/t2.mp3" }
            ] }"#,
        )
        .unwrap();
        ingest_manifest(&db, &m, cid, "https://h/mixes/manifest.json", |_, _| {}).unwrap();
        let mut paths = db.get_track_paths_for_collection(cid).unwrap();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "https://cdn.other/t2.mp3".to_string(),        // absolute passes through
                "https://h/mixes/tracks/t1.flac".to_string(), // relative joined to manifest dir
            ]
        );
    }

    #[test]
    fn test_publish_then_subscribe_roundtrip() {
        // Full Option-C loop with the real production functions: publish a bundle
        // (which now emits relative `src`), then subscribe to its manifest exactly
        // as the HTTP client would and confirm every relative ref resolves back to
        // the hosting URL. This is the end-to-end proof the two halves agree.
        let tmp = tempfile::tempdir().unwrap();
        let src_audio = tmp.path().join("song.flac");
        std::fs::write(&src_audio, b"fake flac bytes").unwrap();

        let dest = tmp.path().join("bundle");
        let tracks = vec![crate::music_publish::PublishTrack {
            title: "Drift".into(),
            artist: Some("Aurora".into()),
            album: Some("Demos".into()),
            duration_secs: Some(210.0),
            track_number: Some(1),
            format: Some("flac".into()),
            src_path: src_audio.to_string_lossy().to_string(),
            tags: vec!["ambient".into()],
        }];
        let base = "https://aurora.example.com/mymusic";
        let res = crate::music_publish::export_music_source(
            dest.to_str().unwrap(), "My Music", base, &tracks,
        )
        .unwrap();
        assert_eq!(res.exported, 1);

        // Read the published manifest exactly as a subscriber's HTTP client would.
        let manifest_json = std::fs::read_to_string(dest.join("manifest.json")).unwrap();
        let manifest: Manifest = serde_json::from_str(&manifest_json).unwrap();

        // Subscribe: ingest against the manifest's own URL (its hosting base).
        let db = test_db();
        let cid = manifest_collection(&db);
        ingest_manifest(&db, &manifest, cid, &res.manifest_url, |_, _| {}).unwrap();

        // The relative `src` resolved back to the hosted absolute URL, and the
        // portable manifest carries no baked-in base.
        assert!(!manifest_json.contains(base), "manifest should not bake in the base URL");
        let paths = db.get_track_paths_for_collection(cid).unwrap();
        assert_eq!(paths, vec![format!("{}/tracks/aurora-drift.flac", base)]);
    }

    #[test]
    fn test_ingest_drops_disallowed_refs() {
        // A manifest naming a local/private ref must not be ingested (guardrail).
        let db = test_db();
        let cid = manifest_collection(&db);
        let m: Manifest = serde_json::from_str(
            r#"{ "tracks": [
                { "title": "Evil", "src": "file:///etc/passwd" },
                { "title": "Good", "src": "tracks/ok.mp3" }
            ] }"#,
        )
        .unwrap();
        ingest_manifest(&db, &m, cid, "https://h/manifest.json", |_, _| {}).unwrap();
        let paths = db.get_track_paths_for_collection(cid).unwrap();
        assert_eq!(paths, vec!["https://h/tracks/ok.mp3".to_string()]);
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
        ingest_manifest(&db, &m1, cid, "https://example.com/manifest.json", |_, _| {}).unwrap();

        // T2 dropped from the manifest → it should be pruned on re-ingest.
        let m2: Manifest = serde_json::from_str(
            r#"{ "artist": "Aurora", "tracks": [
                { "title": "T1", "url": "https://h/t1.flac" }
            ] }"#,
        )
        .unwrap();
        let removed = ingest_manifest(&db, &m2, cid, "https://example.com/manifest.json", |_, _| {}).unwrap();
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
        ingest_manifest(&db, &m, cid, "https://example.com/manifest.json", |_, _| {}).unwrap();
        assert_eq!(
            db.get_track_paths_for_collection(cid).unwrap(),
            vec!["https://h/good.flac".to_string()]
        );
    }

    #[test]
    fn test_ingest_populates_fts_search() {
        let db = test_db();
        let cid = manifest_collection(&db);
        let m: Manifest = serde_json::from_str(
            r#"{ "tracks": [
                { "title": "Zephyr Drift", "url": "https://h/z.flac", "artist": "Cloudline", "album": "Skies", "tags": ["ambient"] }
            ] }"#,
        )
        .unwrap();
        ingest_manifest(&db, &m, cid, "https://example.com/manifest.json", |_, _| {}).unwrap();

        // Incremental FTS maintenance: the row is findable by title, artist, and tag.
        assert!(db.search_all("Zephyr", 5, 5, 5).unwrap().tracks.iter().any(|t| t.title == "Zephyr Drift"));
        assert!(db.search_all("Cloudline", 5, 5, 5).unwrap().artists.iter().any(|a| a.name == "Cloudline"));
        assert!(db.search_all("ambient", 5, 5, 5).unwrap().tracks.iter().any(|t| t.title == "Zephyr Drift"));

        // And after re-ingesting without it, the pruned track leaves the index.
        let empty: Manifest = serde_json::from_str(r#"{ "tracks": [] }"#).unwrap();
        ingest_manifest(&db, &empty, cid, "https://example.com/manifest.json", |_, _| {}).unwrap();
        assert!(db.search_all("Zephyr", 5, 5, 5).unwrap().tracks.is_empty());
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
