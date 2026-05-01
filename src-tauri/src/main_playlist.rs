use crate::entity_image::canonical_slug;
use crate::image_provider;
use crate::models::{
    ImageSource, MainPlaylistReadResult, MainPlaylistState, MixtapeManifest,
};
use std::path::{Path, PathBuf};

const MANIFEST_FILE: &str = "manifest.json";
const STATE_FILE: &str = "state.json";
const COVER_FILE: &str = "cover.jpg";
const THUMBS_DIR: &str = "thumbs";

fn folder(profile_dir: &Path) -> PathBuf {
    profile_dir.join("main-playlist")
}

fn thumb_file(profile_dir: &Path, key: &str) -> PathBuf {
    folder(profile_dir).join(THUMBS_DIR).join(format!("{}.jpg", canonical_slug(key)))
}

fn thumb_sidecar(profile_dir: &Path, key: &str) -> PathBuf {
    folder(profile_dir).join(THUMBS_DIR).join(format!("{}.jpg.src", canonical_slug(key)))
}

fn cover_file(profile_dir: &Path) -> PathBuf {
    folder(profile_dir).join(COVER_FILE)
}

fn cover_sidecar(profile_dir: &Path) -> PathBuf {
    folder(profile_dir).join("cover.jpg.src")
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
    manifest: Option<&MixtapeManifest>,
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
    let manifest = read_json::<MixtapeManifest>(&f.join(MANIFEST_FILE));
    let state = read_json::<MainPlaylistState>(&f.join(STATE_FILE));
    Ok(MainPlaylistReadResult { manifest, state })
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
    let thumbs = f.join(THUMBS_DIR);
    if !thumbs.exists() {
        return Ok(());
    }
    let manifest = read_json::<MixtapeManifest>(&f.join(MANIFEST_FILE));
    let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(m) = manifest {
        for t in m.tracks {
            if let Some(thumb) = t.thumb {
                if let Some(name) = Path::new(&thumb).file_name().and_then(|n| n.to_str()) {
                    referenced.insert(name.to_string());
                    referenced.insert(format!("{}.src", name));
                }
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

fn source_fingerprint(src: &ImageSource) -> String {
    if let Some(u) = &src.url { return format!("url:{}", u); }
    if let Some(p) = &src.path { return format!("path:{}", p); }
    String::new()
}

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
    let sidecar_path = cover_sidecar(profile_dir);

    let Some(src) = src else {
        let _ = std::fs::remove_file(&cover_path);
        let _ = std::fs::remove_file(&sidecar_path);
        return Ok(());
    };

    let fingerprint = source_fingerprint(src);
    if cover_path.exists() {
        if let Ok(existing) = std::fs::read_to_string(&sidecar_path) {
            if existing == fingerprint { return Ok(()); }
        }
    }

    let bytes = if let Some(p) = &src.path {
        resize_path_to_jpeg(Path::new(p), COVER_MAX_DIM)?
    } else {
        resize_bytes_to_jpeg(&fetch_source_bytes(src)?, COVER_MAX_DIM)?
    };

    atomic_write(&cover_path, &bytes)?;
    atomic_write(&sidecar_path, fingerprint.as_bytes())?;
    Ok(())
}

pub fn set_thumb(profile_dir: &Path, key: &str, src: &ImageSource) -> Result<(), String> {
    ensure_dirs(profile_dir)?;
    let dest = thumb_file(profile_dir, key);
    let sidecar = thumb_sidecar(profile_dir, key);
    let fingerprint = source_fingerprint(src);
    if dest.exists() {
        if let Ok(existing) = std::fs::read_to_string(&sidecar) {
            if existing == fingerprint { return Ok(()); }
        }
    }
    let bytes = if let Some(p) = &src.path {
        resize_path_to_jpeg(Path::new(p), THUMB_MAX_DIM)?
    } else {
        resize_bytes_to_jpeg(&fetch_source_bytes(src)?, THUMB_MAX_DIM)?
    };
    atomic_write(&dest, &bytes)?;
    atomic_write(&sidecar, fingerprint.as_bytes())?;
    Ok(())
}

pub fn remove_thumb(profile_dir: &Path, key: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(thumb_file(profile_dir, key));
    let _ = std::fs::remove_file(thumb_sidecar(profile_dir, key));
    Ok(())
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

    fn sample_manifest() -> MixtapeManifest {
        MixtapeManifest {
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
            queue_mode: "shuffle".into(),
            shuffle_order: vec![2, 0, 1],
            shuffle_position: 0,
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
        assert_eq!(s.shuffle_order, vec![2, 0, 1]);
    }

    #[test]
    fn read_missing_folder_returns_nulls() {
        let t = tmp();
        let r = read(t.path()).unwrap();
        assert!(r.manifest.is_none());
        assert!(r.state.is_none());
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

    #[test]
    fn gc_removes_orphan_thumbs_not_referenced_by_manifest() {
        use crate::models::MixtapeTrack;
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join("keep.jpg"), b"x").unwrap();
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join("orphan.jpg"), b"x").unwrap();
        std::fs::write(folder(t.path()).join(THUMBS_DIR).join("keep.jpg.src"), b"url").unwrap();
        let mut m = sample_manifest();
        m.tracks.push(MixtapeTrack {
            title: "t".into(),
            artist: "a".into(),
            album: None,
            duration_secs: None,
            file: Some("file:///x".into()),
            thumb: Some("thumbs/keep.jpg".into()),
        });
        write(t.path(), Some(&m), None).unwrap();
        gc(t.path()).unwrap();
        assert!(folder(t.path()).join(THUMBS_DIR).join("keep.jpg").exists());
        assert!(folder(t.path()).join(THUMBS_DIR).join("keep.jpg.src").exists());
        assert!(!folder(t.path()).join(THUMBS_DIR).join("orphan.jpg").exists());
    }

    #[test]
    fn set_cover_copies_local_file() {
        let t = tmp();
        let src = t.path().join("src.jpg");
        // Generate a minimal valid JPEG (1x1 white).
        let img = image::ImageBuffer::from_pixel(1u32, 1u32, image::Rgb([255u8, 255u8, 255u8]));
        img.save(&src).unwrap();
        ensure_dirs(t.path()).unwrap();
        set_cover(t.path(), Some(&ImageSource { path: Some(src.to_string_lossy().into()), url: None })).unwrap();
        assert!(cover_file(t.path()).exists());
        let sidecar = std::fs::read_to_string(cover_sidecar(t.path())).unwrap();
        assert!(sidecar.contains("src.jpg"));
    }

    #[test]
    fn set_cover_skips_rewrite_when_source_unchanged() {
        let t = tmp();
        let src = t.path().join("src.jpg");
        let img = image::ImageBuffer::from_pixel(1u32, 1u32, image::Rgb([255u8, 255u8, 255u8]));
        img.save(&src).unwrap();
        ensure_dirs(t.path()).unwrap();
        let s = ImageSource { path: Some(src.to_string_lossy().into()), url: None };
        set_cover(t.path(), Some(&s)).unwrap();
        let m1 = std::fs::metadata(cover_file(t.path())).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        set_cover(t.path(), Some(&s)).unwrap();
        let m2 = std::fs::metadata(cover_file(t.path())).unwrap().modified().unwrap();
        assert_eq!(m1, m2, "cover should not be rewritten when source unchanged");
    }

    #[test]
    fn set_cover_none_removes_cover_and_sidecar() {
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        std::fs::write(cover_file(t.path()), b"x").unwrap();
        std::fs::write(cover_sidecar(t.path()), b"y").unwrap();
        set_cover(t.path(), None).unwrap();
        assert!(!cover_file(t.path()).exists());
        assert!(!cover_sidecar(t.path()).exists());
    }

    #[test]
    fn set_thumb_writes_keyed_file_and_sidecar() {
        let t = tmp();
        let src = t.path().join("t.jpg");
        image::ImageBuffer::from_pixel(1u32, 1u32, image::Rgb([0u8, 0u8, 0u8])).save(&src).unwrap();
        ensure_dirs(t.path()).unwrap();
        set_thumb(t.path(), "lib:42", &ImageSource { path: Some(src.to_string_lossy().into()), url: None }).unwrap();
        assert!(thumb_file(t.path(), "lib:42").exists());
        assert!(thumb_sidecar(t.path(), "lib:42").exists());
    }

    #[test]
    fn set_thumb_dedups_on_same_source() {
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
        assert_eq!(m1, m2);
    }

    #[test]
    fn remove_thumb_deletes_file_and_sidecar_silently_if_absent() {
        let t = tmp();
        ensure_dirs(t.path()).unwrap();
        remove_thumb(t.path(), "missing").unwrap(); // no error
        std::fs::write(thumb_file(t.path(), "lib:1"), b"x").unwrap();
        std::fs::write(thumb_sidecar(t.path(), "lib:1"), b"y").unwrap();
        remove_thumb(t.path(), "lib:1").unwrap();
        assert!(!thumb_file(t.path(), "lib:1").exists());
        assert!(!thumb_sidecar(t.path(), "lib:1").exists());
    }
}
