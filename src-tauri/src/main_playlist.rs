use crate::entity_image::canonical_slug;
use crate::image_provider;
use crate::models::{
    ImageSource, MainPlaylistReadResult, MainPlaylistState, BundleManifest,
};
use std::path::{Path, PathBuf};

const MANIFEST_FILE: &str = "manifest.json";
const STATE_FILE: &str = "state.json";
const COVER_FILE: &str = "cover.jpg";
const THUMBS_DIR: &str = "thumbs";

fn folder(profile_dir: &Path) -> PathBuf {
    profile_dir.join("main-playlist")
}

/// The on-disk thumbnail filename for a track key (its file URI). Rust is the
/// single source of this name: the frontend learns it from the
/// `main-playlist-thumb-ready` event, never recomputes it. See set_thumb.
fn thumb_filename(key: &str) -> String {
    format!("{}.jpg", canonical_slug(key))
}

fn thumb_file(profile_dir: &Path, key: &str) -> PathBuf {
    folder(profile_dir).join(THUMBS_DIR).join(thumb_filename(key))
}


fn cover_file(profile_dir: &Path) -> PathBuf {
    folder(profile_dir).join(COVER_FILE)
}


pub fn ensure_dirs(profile_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(folder(profile_dir).join(THUMBS_DIR))
        .map_err(|e| format!("create main-playlist dir: {}", e))
}

fn atomic_write(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    // Append ".tmp" to the full filename (so `manifest.json.tmp`, not `manifest.tmp`).
    // Path::with_extension replaces the extension, which is not what we want here.
    let mut tmp_os = dest.as_os_str().to_owned();
    tmp_os.push(".tmp");
    let tmp = PathBuf::from(tmp_os);
    std::fs::write(&tmp, bytes).map_err(|e| format!("write tmp: {}", e))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename tmp: {}", e)
    })
}

pub fn write(
    profile_dir: &Path,
    manifest: Option<&BundleManifest>,
    state: Option<&MainPlaylistState>,
) -> Result<(), String> {
    ensure_dirs(profile_dir)?;
    if let Some(m) = manifest {
        let json = serde_json::to_vec_pretty(m).map_err(|e| format!("serialize manifest: {}", e))?;
        atomic_write(&folder(profile_dir).join(MANIFEST_FILE), &json)?;
    }
    if let Some(s) = state {
        let json = serde_json::to_vec_pretty(s).map_err(|e| format!("serialize state: {}", e))?;
        atomic_write(&folder(profile_dir).join(STATE_FILE), &json)?;
    }
    Ok(())
}

pub fn read(profile_dir: &Path) -> Result<MainPlaylistReadResult, String> {
    let f = folder(profile_dir);
    let manifest = read_json::<BundleManifest>(&f.join(MANIFEST_FILE));
    let state = read_json::<MainPlaylistState>(&f.join(STATE_FILE));
    // Existence-check cached thumbs inline so the frontend can seed `thumbInfo`
    // synchronously with the restored queue (replaces the old post-restore
    // `touch_thumbs` round-trip). Keys are the track file URIs; Rust stays the
    // sole namer via `canonical_slug` inside `existing_thumbs`.
    let thumbs = manifest
        .as_ref()
        .map(|m| {
            let keys: Vec<String> = m.tracks.iter().filter_map(|t| t.file.clone()).collect();
            existing_thumbs(profile_dir, &keys)
        })
        .unwrap_or_default();
    Ok(MainPlaylistReadResult { manifest, state, thumbs })
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    match std::fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str::<T>(&s) {
            Ok(v) => Some(v),
            Err(e) => {
                log::warn!("main_playlist: failed to parse {}: {}", path.display(), e);
                None
            }
        },
        Err(_) => None,
    }
}

pub fn clear(profile_dir: &Path) -> Result<(), String> {
    let f = folder(profile_dir);
    if !f.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&f).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_dir() {
            std::fs::remove_dir_all(&p).map_err(|e| format!("remove {}: {}", p.display(), e))?;
        } else {
            std::fs::remove_file(&p).map_err(|e| format!("remove {}: {}", p.display(), e))?;
        }
    }
    ensure_dirs(profile_dir)?; // restore thumbs/ subdirectory
    Ok(())
}

pub fn gc(profile_dir: &Path) -> Result<(), String> {
    let f = folder(profile_dir);
    // Remove legacy sidecar file from older versions
    let _ = std::fs::remove_file(f.join("cover.jpg.src"));
    let thumbs = f.join(THUMBS_DIR);
    if !thumbs.exists() {
        return Ok(());
    }

    // Distinguish "no manifest" from "manifest present but unreadable". A
    // missing manifest means the queue was cleared (clear() also removes the
    // manifest file) → any leftover thumbs are genuine orphans, safe to sweep.
    // A manifest that exists but fails to parse (schema drift, truncated write
    // after a crash, hand-edit) must NOT be treated as "zero referenced
    // thumbs": doing so would wipe the entire thumb cache on the next startup.
    // Bail in that case and leave every thumb in place.
    let manifest_path = f.join(MANIFEST_FILE);
    let manifest = match std::fs::read_to_string(&manifest_path) {
        Ok(contents) => match serde_json::from_str::<BundleManifest>(&contents) {
            Ok(m) => Some(m),
            Err(e) => {
                log::warn!(
                    "main_playlist::gc: manifest exists but failed to parse ({}); \
                     skipping thumb GC to avoid deleting live thumbnails",
                    e
                );
                return Ok(());
            }
        },
        // File absent: queue was cleared (clear() removes the manifest). Leave
        // `manifest` as None → empty referenced set → leftover thumbs collected.
        Err(_) => None,
    };

    // Build the referenced set from each track's `file` URI run through the
    // SAME Rust thumb_filename (canonical_slug) that set_thumb uses to name the
    // file on disk — never the manifest's `thumb` string. The frontend no
    // longer writes `thumb` (it is always null for the main playlist), so the
    // only reliable signal is the file URI itself: a thumb is an orphan iff no
    // current track's slug maps to it. Reference every track with a `file`;
    // tracks that never had a thumb simply won't have a matching file on disk
    // for their slug, so referencing them is harmless.
    let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(m) = &manifest {
        for t in &m.tracks {
            if let Some(file) = &t.file {
                referenced.insert(thumb_filename(file));
            }
        }
    }

    for entry in std::fs::read_dir(&thumbs).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if !referenced.contains(&name) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

const COVER_MAX_DIM: u32 = 800;
const THUMB_MAX_DIM: u32 = 150;


fn resize_path_to_jpeg(path: &Path, max_dim: u32) -> Result<Vec<u8>, String> {
    use image::{imageops::FilterType, GenericImageView};
    let img = image::open(path).map_err(|e| format!("open image: {}", e))?;
    let (w, h) = img.dimensions();
    let resized = if w > max_dim || h > max_dim {
        let scale = (max_dim as f32) / (w.max(h) as f32);
        img.resize((w as f32 * scale) as u32, (h as f32 * scale) as u32, FilterType::Lanczos3)
    } else { img };
    let rgb = resized.to_rgb8();
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
    enc.encode(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("encode jpeg: {}", e))?;
    Ok(out)
}

fn resize_bytes_to_jpeg(bytes: &[u8], max_dim: u32) -> Result<Vec<u8>, String> {
    use image::{imageops::FilterType, GenericImageView};
    let img = image::load_from_memory(bytes).map_err(|e| format!("decode image: {}", e))?;
    let (w, h) = img.dimensions();
    let resized = if w > max_dim || h > max_dim {
        let scale = (max_dim as f32) / (w.max(h) as f32);
        img.resize((w as f32 * scale) as u32, (h as f32 * scale) as u32, FilterType::Lanczos3)
    } else { img };
    let rgb = resized.to_rgb8();
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
    enc.encode(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("encode jpeg: {}", e))?;
    Ok(out)
}

fn fetch_source_bytes(src: &ImageSource) -> Result<Vec<u8>, String> {
    if let Some(url) = &src.url {
        let client = image_provider::http_client()?;
        let resp = client.get(url).send().map_err(|e| format!("http get {}: {}", url, e))?;
        if !resp.status().is_success() {
            return Err(format!("http {} from {}", resp.status(), url));
        }
        return resp.bytes().map_err(|e| e.to_string()).map(|b| b.to_vec());
    }
    Err("ImageSource has neither path nor url".into())
}

pub fn set_cover(profile_dir: &Path, src: Option<&ImageSource>) -> Result<(), String> {
    ensure_dirs(profile_dir)?;
    let cover_path = cover_file(profile_dir);

    let Some(src) = src else {
        let _ = std::fs::remove_file(&cover_path);
        return Ok(());
    };

    // Skip if source path is the cover file itself (restored context)
    if let Some(p) = &src.path {
        if Path::new(p) == cover_path {
            return Ok(());
        }
    }

    let bytes = if let Some(p) = &src.path {
        resize_path_to_jpeg(Path::new(p), COVER_MAX_DIM)?
    } else {
        resize_bytes_to_jpeg(&fetch_source_bytes(src)?, COVER_MAX_DIM)?
    };

    atomic_write(&cover_path, &bytes)?;
    Ok(())
}

/// Ensure a thumbnail exists for `key` and return its on-disk filename
/// (`canonical_slug(key).jpg`). Returns the name in BOTH the freshly-written
/// and already-exists branches so the caller can always relay it to the
/// frontend via `main-playlist-thumb-ready` — the frontend never computes this
/// name itself.
pub fn set_thumb(profile_dir: &Path, key: &str, src: &ImageSource) -> Result<String, String> {
    ensure_dirs(profile_dir)?;
    let filename = thumb_filename(key);
    let dest = thumb_file(profile_dir, key);
    if dest.exists() {
        return Ok(filename);
    }
    let bytes = if let Some(p) = &src.path {
        resize_path_to_jpeg(Path::new(p), THUMB_MAX_DIM)?
    } else {
        resize_bytes_to_jpeg(&fetch_source_bytes(src)?, THUMB_MAX_DIM)?
    };
    atomic_write(&dest, &bytes)?;
    Ok(filename)
}

pub fn remove_thumb(profile_dir: &Path, key: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(thumb_file(profile_dir, key));
    Ok(())
}

/// Restore reconciler: for each key (track file URI) whose thumbnail already
/// exists on disk, return `(key, filename)`. The caller emits
/// `main-playlist-thumb-ready` for each so the frontend can populate its
/// `thumbInfo` map after a restart without recomputing any filename. Keys with
/// no thumb on disk are omitted (they fall back to the live entity-image chain).
pub fn existing_thumbs(profile_dir: &Path, keys: &[String]) -> Vec<(String, String)> {
    keys.iter()
        .filter_map(|key| {
            let filename = thumb_filename(key);
            if thumb_file(profile_dir, key).exists() {
                Some((key.clone(), filename))
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MixtapeType;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn ensure_dirs_creates_folder_and_thumbs() {
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        assert!(folder(t.path()).is_dir());
        assert!(folder(t.path()).join(THUMBS_DIR).is_dir());
    }

    fn sample_manifest() -> BundleManifest {
        BundleManifest {
            version: 1,
            title: "Test".into(),
            mixtape_type: MixtapeType::Custom,
            metadata: Default::default(),
            created_at: "2026-05-01T00:00:00Z".into(),
            created_by: None,
            cover: None,
            tracks: vec![],
        }
    }

    fn sample_state() -> MainPlaylistState {
        MainPlaylistState {
            queue_index: 2,
            queue_mode: "repeat-all".into(),
        }
    }

    #[test]
    fn write_then_read_roundtrips_manifest_and_state() {
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        write(t.path(), Some(&sample_manifest()), Some(&sample_state())).unwrap();
        let r = read(t.path()).unwrap();
        assert_eq!(r.manifest.unwrap().title, "Test");
        let s = r.state.unwrap();
        assert_eq!(s.queue_index, 2);
        assert_eq!(s.queue_mode, "repeat-all");
    }

    #[test]
    fn read_missing_folder_returns_nulls() {
        let t = tmp();
        let r = read(t.path()).unwrap();
        assert!(r.manifest.is_none());
        assert!(r.state.is_none());
        assert!(r.thumbs.is_empty());
    }

    #[test]
    fn read_returns_existing_thumbs_for_queued_tracks_only() {
        // read() existence-checks each queued track's thumb and returns
        // (uri, canonical_slug(uri).jpg) only for those present on disk, so the
        // frontend can seed thumbInfo synchronously (no touch_thumbs round-trip).
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        let with_thumb = "spotify://has-thumb";
        let without_thumb = "spotify://no-thumb";
        // Write the on-disk thumb for only the first track, using the Rust name.
        let fname = format!("{}.jpg", canonical_slug(with_thumb));
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join(&fname), b"x").unwrap();
        let mut m = sample_manifest();
        m.tracks.push(referenced_track(with_thumb));
        m.tracks.push(referenced_track(without_thumb));
        write(t.path(), Some(&m), Some(&sample_state())).unwrap();

        let r = read(t.path()).unwrap();
        assert_eq!(r.thumbs, vec![(with_thumb.to_string(), fname)]);
    }

    #[test]
    fn read_corrupt_manifest_returns_null_manifest_but_keeps_state() {
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        std::fs::write(folder(t.path()).join(MANIFEST_FILE), "{not json").unwrap();
        write(t.path(), None, Some(&sample_state())).unwrap();
        let r = read(t.path()).unwrap();
        assert!(r.manifest.is_none());
        assert!(r.state.is_some());
    }

    #[test]
    fn write_is_atomic_no_tmp_left_behind() {
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        write(t.path(), Some(&sample_manifest()), Some(&sample_state())).unwrap();
        let tmp_manifest = folder(t.path()).join(format!("{}.tmp", MANIFEST_FILE));
        let tmp_state = folder(t.path()).join(format!("{}.tmp", STATE_FILE));
        assert!(!tmp_manifest.exists());
        assert!(!tmp_state.exists());
    }

    #[test]
    fn clear_removes_files_but_keeps_folder() {
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        write(t.path(), Some(&sample_manifest()), Some(&sample_state())).unwrap();
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join("a.jpg"), b"x").unwrap();
        clear(t.path()).unwrap();
        assert!(folder(t.path()).is_dir());
        assert!(!folder(t.path()).join(MANIFEST_FILE).exists());
        assert!(!folder(t.path()).join(STATE_FILE).exists());
        assert!(!folder(t.path()).join(THUMBS_DIR).join("a.jpg").exists());
    }

    /// A track whose `file` URI produces `canonical_slug(file).jpg` on disk and
    /// carries a non-null `thumb` so gc() treats it as referenced.
    fn referenced_track(file: &str) -> crate::models::BundleTrack {
        crate::models::BundleTrack {
            title: "t".into(),
            artist: "a".into(),
            album: None,
            duration_secs: None,
            file: Some(file.into()),
            // gc() keys off canonical_slug(file), not this string, but it must
            // be non-null for the track to count as referenced.
            thumb: Some(format!("thumbs/{}.jpg", canonical_slug(file))),
            format: None,
        }
    }

    #[test]
    fn gc_removes_orphan_thumbs_not_referenced_by_manifest() {
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        // The on-disk thumb name must match canonical_slug(file) — the same
        // name set_thumb writes — so gc keeps it.
        let keep = format!("{}.jpg", canonical_slug("spotify://keep"));
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join(&keep), b"x").unwrap();
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join("orphan.jpg"), b"x").unwrap();
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join("legacy.jpg.src"), b"url").unwrap();
        let mut m = sample_manifest();
        m.tracks.push(referenced_track("spotify://keep"));
        write(t.path(), Some(&m), None).unwrap();
        gc(t.path()).unwrap();
        assert!(folder(t.path()).join(THUMBS_DIR).join(&keep).exists());
        assert!(!folder(t.path()).join(THUMBS_DIR).join("orphan.jpg").exists());
        assert!(!folder(t.path()).join(THUMBS_DIR).join("legacy.jpg.src").exists());
    }

    #[test]
    fn gc_keys_referenced_thumbs_by_canonical_slug_of_file_not_manifest_thumb_string() {
        // Regression: gc must derive the kept filename from canonical_slug(file)
        // — the exact name set_thumb wrote — never from the manifest's `thumb`
        // string (a JS-side slug mirror that can diverge for non-ASCII / long
        // URIs). Here the manifest's thumb string is deliberately WRONG; the
        // real on-disk file follows the Rust slug. gc must keep the real file.
        use crate::models::BundleTrack;
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        let uri = "spotify://Björk-track";
        let real = format!("{}.jpg", canonical_slug(uri)); // what set_thumb actually writes
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join(&real), b"x").unwrap();
        let mut m = sample_manifest();
        m.tracks.push(BundleTrack {
            title: "t".into(),
            artist: "a".into(),
            album: None,
            duration_secs: None,
            file: Some(uri.into()),
            thumb: Some("thumbs/this-string-is-intentionally-wrong.jpg".into()),
            format: None,
        });
        write(t.path(), Some(&m), None).unwrap();
        gc(t.path()).unwrap();
        assert!(
            folder(t.path()).join(THUMBS_DIR).join(&real).exists(),
            "gc deleted a live thumb because it trusted the manifest thumb string instead of canonical_slug(file)"
        );
    }

    #[test]
    fn gc_references_thumbs_by_file_slug_ignoring_manifest_thumb_field() {
        // The frontend no longer writes the manifest `thumb` field (always null
        // for the main playlist). gc must reference a track's thumb purely by
        // canonical_slug(file), regardless of whether `thumb` is set. A thumb
        // whose slug matches a current track's file is kept even though that
        // track carries thumb: None.
        use crate::models::BundleTrack;
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        let keep = thumb_filename("spotify://keep");
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join(&keep), b"x").unwrap();
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join("orphan.jpg"), b"x").unwrap();
        let mut m = sample_manifest();
        m.tracks.push(BundleTrack {
            title: "t".into(),
            artist: "a".into(),
            album: None,
            duration_secs: None,
            file: Some("spotify://keep".into()),
            thumb: None, // gc must NOT consult this; slug(file) is the truth
            format: None,
        });
        write(t.path(), Some(&m), None).unwrap();
        gc(t.path()).unwrap();
        assert!(folder(t.path()).join(THUMBS_DIR).join(&keep).exists());
        assert!(!folder(t.path()).join(THUMBS_DIR).join("orphan.jpg").exists());
    }

    #[test]
    fn existing_thumbs_returns_only_present_files_with_rust_filename() {
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        // Write a thumb for one URI; leave the other absent.
        let present = "spotify://Björk-track";
        let fname = thumb_filename(present);
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join(&fname), b"x").unwrap();
        let keys = vec![present.to_string(), "tidal://missing".to_string()];
        let got = existing_thumbs(t.path(), &keys);
        assert_eq!(got, vec![(present.to_string(), fname)]);
    }

    #[test]
    fn gc_keeps_all_thumbs_when_manifest_is_corrupt() {
        // Regression: gc runs fire-and-forget at every startup. If the manifest
        // exists but fails to deserialize (schema drift, crash-truncated write,
        // hand-edit), gc must NOT treat that as "zero referenced thumbs" and
        // wipe the cache. It must bail and leave every thumb in place.
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join("a.jpg"), b"x").unwrap();
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join("b.jpg"), b"x").unwrap();
        // Corrupt manifest (valid file, invalid JSON for BundleManifest).
        std::fs::write(folder(t.path()).join(MANIFEST_FILE), "{not valid json").unwrap();
        gc(t.path()).unwrap();
        assert!(folder(t.path()).join(THUMBS_DIR).join("a.jpg").exists());
        assert!(folder(t.path()).join(THUMBS_DIR).join("b.jpg").exists());
    }

    #[test]
    fn gc_collects_all_thumbs_when_manifest_absent() {
        // No manifest file at all means the queue was cleared (clear() removes
        // the manifest). Any leftover thumbs are genuine orphans → collected.
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join("a.jpg"), b"x").unwrap();
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join("b.jpg"), b"x").unwrap();
        assert!(!folder(t.path()).join(MANIFEST_FILE).exists());
        gc(t.path()).unwrap();
        assert!(!folder(t.path()).join(THUMBS_DIR).join("a.jpg").exists());
        assert!(!folder(t.path()).join(THUMBS_DIR).join("b.jpg").exists());
    }

    #[test]
    fn set_cover_copies_local_file() {
        let t = tmp();
        let src = t.path().join("src.jpg");
        let img = image::ImageBuffer::from_pixel(1u32, 1u32, image::Rgb([255u8, 255u8, 255u8]));
        img.save(&src).unwrap();
        ensure_dirs(t.path()).unwrap();
        set_cover(t.path(), Some(&ImageSource { path: Some(src.to_string_lossy().into()), url: None })).unwrap();
        assert!(cover_file(t.path()).exists());
    }

    #[test]
    fn set_cover_skips_when_source_is_cover_file_itself() {
        let t = tmp();
        let src = t.path().join("src.jpg");
        let img = image::ImageBuffer::from_pixel(1u32, 1u32, image::Rgb([255u8, 255u8, 255u8]));
        img.save(&src).unwrap();
        ensure_dirs(t.path()).unwrap();
        set_cover(t.path(), Some(&ImageSource { path: Some(src.to_string_lossy().into()), url: None })).unwrap();
        let m1 = std::fs::metadata(cover_file(t.path())).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        // Calling with the cover file path itself should be a no-op
        let cover = cover_file(t.path());
        set_cover(t.path(), Some(&ImageSource { path: Some(cover.to_string_lossy().into()), url: None })).unwrap();
        let m2 = std::fs::metadata(cover_file(t.path())).unwrap().modified().unwrap();
        assert_eq!(m1, m2, "cover should not be rewritten when source is cover file itself");
    }

    #[test]
    fn set_cover_none_removes_cover() {
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        std::fs::write(cover_file(t.path()), b"x").unwrap();
        set_cover(t.path(), None).unwrap();
        assert!(!cover_file(t.path()).exists());
    }

    #[test]
    fn set_thumb_writes_keyed_file_and_sidecar() {
        let t = tmp();
        let src = t.path().join("t.jpg");
        image::ImageBuffer::from_pixel(1u32, 1u32, image::Rgb([0u8, 0u8, 0u8])).save(&src).unwrap();
        ensure_dirs(t.path()).unwrap();
        set_thumb(t.path(), "lib:42", &ImageSource { path: Some(src.to_string_lossy().into()), url: None }).unwrap();
        assert!(thumb_file(t.path(), "lib:42").exists());
    }

    #[test]
    fn set_thumb_skips_when_file_exists() {
        let t = tmp();
        let src = t.path().join("t.jpg");
        image::ImageBuffer::from_pixel(1u32, 1u32, image::Rgb([0u8, 0u8, 0u8])).save(&src).unwrap();
        ensure_dirs(t.path()).unwrap();
        let s = ImageSource { path: Some(src.to_string_lossy().into()), url: None };
        set_thumb(t.path(), "lib:42", &s).unwrap();
        let m1 = std::fs::metadata(thumb_file(t.path(), "lib:42")).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        set_thumb(t.path(), "lib:42", &s).unwrap();
        let m2 = std::fs::metadata(thumb_file(t.path(), "lib:42")).unwrap().modified().unwrap();
        assert_eq!(m1, m2, "thumb should not be rewritten when file already exists");
    }

    #[test]
    fn remove_thumb_deletes_file_silently_if_absent() {
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        remove_thumb(t.path(), "missing").unwrap(); // no error
        std::fs::write(thumb_file(t.path(), "lib:1"), b"x").unwrap();
        remove_thumb(t.path(), "lib:1").unwrap();
        assert!(!thumb_file(t.path(), "lib:1").exists());
    }
}
