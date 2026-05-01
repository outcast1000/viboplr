# Main Playlist Folder Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the live playlist (queue tracks, playback state, cover, thumbnails) out of `app-state.json` and into a dedicated folder `{profile_dir}/main-playlist/` whose shape matches an uncompressed mixtape, so remote images survive source deletion and mixtape export becomes a filesystem copy.

**Architecture:** A new Rust module `main_playlist.rs` exposes atomic Tauri commands to write/read/gc a folder containing `manifest.json` (mixtape-compatible), `state.json` (live playback state), `cover.jpg`, and `thumbs/{key}.jpg`. `useQueue.ts` replaces its four `tauri-plugin-store` effects with one debounced writer call, plus side-effect effects for cover and thumbs. Startup reads from the folder; if absent (post-upgrade), the queue starts empty (no migration).

**Tech Stack:** Rust (Tauri 2, `serde_json`, `reqwest::blocking`, `image` crate), TypeScript (React, Tauri `invoke`, `convertFileSrc`), Vitest for TS logic tests, `cargo test` with `tempfile` for Rust tests.

**Spec:** `docs/superpowers/specs/2026-05-01-main-playlist-folder-design.md`

---

## File Structure

**New files:**
- `src-tauri/src/main_playlist.rs` — folder I/O, atomic writes, cover/thumb copy & download, gc sweep
- `src-tauri/src/main_playlist/tests.rs` (inline `#[cfg(test)] mod tests`) — Rust unit tests (roundtrip, atomicity, gc, dedup)
- `src/mainPlaylist.ts` — pure helpers: `buildManifest`, `buildState`, `tracksFromManifest`, `contextFromManifest`, `diffThumbs`
- `src/__tests__/mainPlaylist.test.ts` — Vitest tests for the above pure helpers

**Modified files:**
- `src-tauri/src/lib.rs` — register new module + 6 new commands in both `get_invoke_handler()` variants
- `src-tauri/src/models.rs` — add `MainPlaylistState` struct + `MainPlaylistReadResult` struct + `ThumbSource` / `CoverSource` enums
- `src/hooks/useQueue.ts` — replace 4 store effects with 1 debounced writer + 2 side-effect effects; add `remote?: boolean` to `PlaylistContext`
- `src/App.tsx` — replace queue-related `store.get` restore block with `invoke("main_playlist_read")`; stop writing queue keys; wire `remote: true` into the `play-tracks` plugin action path

---

## Task 0: Anchor facts (no code changes)

Each of the following has already been verified against the repo and is recorded here so the implementer doesn't need to re-discover them:

- `MixtapeManifest` (src-tauri/src/models.rs) already derives `Serialize, Deserialize` — safe to deserialize in `read_json::<MixtapeManifest>`.
- `MixtapeTrack` has a `thumb: Option<String>` field — safe to read for gc.
- `image_provider::http_client()` exists and is `pub` (src-tauri/src/image_provider/mod.rs:16).
- `AppState.app_dir` is `std::path::PathBuf` (src-tauri/src/commands.rs:54) — cloneable.
- `useQueue` already exports `setQueueMode`, `setShuffleOrder`, `setShufflePosition`, `setPlaylistContext` (src/hooks/useQueue.ts:447–456).
- `App.tsx` already has `pendingRestoreTrackRef` and `pendingRestoreQueueRef` (src/App.tsx:104–105).
- `canonical_slug` behavior (src-tauri/src/entity_image.rs:18): lowercases, then **filters out** (deletes, does not replace) the characters `\ / : * ? " < > |` and control chars, then collapses whitespace, trims dots. Examples:
  - `"file:///Users/me/song.mp3"` → `"fileusersmesong.mp3"`
  - `"tidal://123456"` → `"tidal123456"`
  - Empty becomes `"_unknown"`.
- **Thumb keying:** thumbnails key off the track's **`file` URI** (the stable persistent identifier), not off `QueueEntry.key` (which is an in-memory counter that resets every restart — would break thumb reuse after restart). The spec's "per-track stable key" requirement is satisfied by the URI.
- TS `thumbFilenameForUri` must produce identical output to `canonical_slug`. Implementation in Task 7.

No file changes or commits in this task.

---

## Task 1: Create the Rust module skeleton and `MainPlaylistState` type

**Files:**
- Create: `src-tauri/src/main_playlist.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs:17` (add `mod main_playlist;`)

- [ ] **Step 1: Add `MainPlaylistState` to models.rs**

Add at end of `src-tauri/src/models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MainPlaylistState {
    pub queue_index: i32,
    pub queue_mode: String, // "normal" | "loop" | "shuffle"
    pub shuffle_order: Vec<usize>,
    pub shuffle_position: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainPlaylistReadResult {
    pub manifest: Option<MixtapeManifest>,
    pub state: Option<MainPlaylistState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSource {
    /// Local filesystem path to copy from.
    pub path: Option<String>,
    /// Remote URL to download from.
    pub url: Option<String>,
}
```

- [ ] **Step 2: Create skeleton `main_playlist.rs`**

Create `src-tauri/src/main_playlist.rs`:

```rust
use crate::entity_image::canonical_slug;
use crate::mixtape;
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
```

- [ ] **Step 3: Register module in `lib.rs`**

Edit `src-tauri/src/lib.rs` around line 17 (after `mod mixtape;`):

```rust
mod mixtape;
mod main_playlist;
```

- [ ] **Step 4: Run `cargo check` to confirm compiles**

Run: `cd src-tauri && cargo check`
Expected: clean (warnings about unused functions are OK).

- [ ] **Step 5: Run the skeleton test**

Run: `cd src-tauri && cargo test main_playlist::tests::ensure_dirs_creates_folder_and_thumbs -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/main_playlist.rs src-tauri/src/models.rs src-tauri/src/lib.rs
git commit -m "feat(main-playlist): add module skeleton and state types"
```

---

## Task 2: Implement atomic `write` and `read` for manifest + state

**Files:**
- Modify: `src-tauri/src/main_playlist.rs`

- [ ] **Step 1: Write failing tests for write/read roundtrip**

Append to the `mod tests` block:

```rust
use crate::models::MixtapeType;

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
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd src-tauri && cargo test main_playlist::tests -- --nocapture`
Expected: FAIL with `cannot find function 'write'` / `read`.

- [ ] **Step 3: Implement `write` and `read`**

Add to `main_playlist.rs` (above `#[cfg(test)]`):

```rust
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
```

- [ ] **Step 4: Add `tempfile` to dev-dependencies if missing**

Run: `cd src-tauri && grep "^tempfile" Cargo.toml || echo "missing"`
If missing, add under `[dev-dependencies]` in `src-tauri/Cargo.toml`:
```toml
tempfile = "3"
```
(Spec/testing docs already indicate `tempfile = "3"` is used.)

- [ ] **Step 5: Run tests to confirm pass**

Run: `cd src-tauri && cargo test main_playlist::tests -- --nocapture`
Expected: all 4 new tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/main_playlist.rs
git commit -m "feat(main-playlist): atomic write/read for manifest and state"
```

---

## Task 3: Implement `clear` and `gc` (orphan thumb sweep)

**Files:**
- Modify: `src-tauri/src/main_playlist.rs`

- [ ] **Step 1: Write failing tests**

Append to `mod tests`:

```rust
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
```

- [ ] **Step 2: Run tests to confirm fail**

Run: `cd src-tauri && cargo test main_playlist::tests::clear main_playlist::tests::gc -- --nocapture`
Expected: FAIL (`cannot find function 'clear'` / `gc`).

- [ ] **Step 3: Implement `clear` and `gc`**

Add to `main_playlist.rs`:

```rust
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
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test main_playlist::tests -- --nocapture`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main_playlist.rs
git commit -m "feat(main-playlist): clear and gc (orphan thumb sweep)"
```

---

## Task 4: Implement `set_cover` (local copy + remote download + dedup)

**Files:**
- Modify: `src-tauri/src/main_playlist.rs`

- [ ] **Step 1: Write failing tests (local copy path + dedup)**

Append to `mod tests`:

```rust
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
```

- [ ] **Step 2: Run tests to confirm fail**

Run: `cd src-tauri && cargo test main_playlist::tests::set_cover -- --nocapture`
Expected: FAIL (`cannot find function 'set_cover'`).

- [ ] **Step 3: Implement `set_cover`**

Add to `main_playlist.rs` (sibling resize helpers are added here rather than extending `mixtape.rs` to keep the change localized):

```rust
use crate::image_provider;

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
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test main_playlist::tests::set_cover -- --nocapture`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main_playlist.rs
git commit -m "feat(main-playlist): set_cover with local copy, remote download, dedup"
```

---

## Task 5: Implement `set_thumb` and `remove_thumb`

**Files:**
- Modify: `src-tauri/src/main_playlist.rs`

- [ ] **Step 1: Write failing tests**

Append:

```rust
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
```

- [ ] **Step 2: Run tests to confirm fail**

Run: `cd src-tauri && cargo test main_playlist::tests::set_thumb main_playlist::tests::remove_thumb -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `main_playlist.rs`:

```rust
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
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test main_playlist::tests -- --nocapture`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main_playlist.rs
git commit -m "feat(main-playlist): set_thumb and remove_thumb with dedup"
```

---

## Task 6: Expose Tauri commands and register them

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add command wrappers in `commands.rs`**

Find a good section (near the other mixtape commands around line 3600+). Append:

```rust
#[tauri::command]
pub async fn main_playlist_write(
    state: State<'_, AppState>,
    manifest: Option<crate::models::MixtapeManifest>,
    state_data: Option<crate::models::MainPlaylistState>,
) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tokio::task::spawn_blocking(move || {
        crate::main_playlist::write(&dir, manifest.as_ref(), state_data.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn main_playlist_read(
    state: State<'_, AppState>,
) -> Result<crate::models::MainPlaylistReadResult, String> {
    let dir = state.app_dir.clone();
    tokio::task::spawn_blocking(move || crate::main_playlist::read(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn main_playlist_clear(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tokio::task::spawn_blocking(move || crate::main_playlist::clear(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn main_playlist_gc(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tokio::task::spawn_blocking(move || crate::main_playlist::gc(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn main_playlist_set_cover(
    state: State<'_, AppState>,
    source: Option<crate::models::ImageSource>,
) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tokio::task::spawn_blocking(move || crate::main_playlist::set_cover(&dir, source.as_ref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn main_playlist_set_thumb(
    state: State<'_, AppState>,
    key: String,
    source: crate::models::ImageSource,
) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tokio::task::spawn_blocking(move || crate::main_playlist::set_thumb(&dir, &key, &source))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn main_playlist_remove_thumb(
    state: State<'_, AppState>,
    key: String,
) -> Result<(), String> {
    let dir = state.app_dir.clone();
    tokio::task::spawn_blocking(move || crate::main_playlist::remove_thumb(&dir, &key))
        .await
        .map_err(|e| e.to_string())?
}
```

Check the existing signature style: `grep -n "pub async fn" src-tauri/src/commands.rs | head -3`. Match it (most commands use `State<'_, AppState>`).

- [ ] **Step 2: Verify `AppState` has `app_dir`**

Run: `grep -n "pub app_dir" src-tauri/src/commands.rs | head -1`
Expected: match. If the field is named differently (e.g., `profile_dir`), adjust the wrappers above to use that name.

- [ ] **Step 3: Register commands in `lib.rs` — BOTH `get_invoke_handler` variants**

Edit `src-tauri/src/lib.rs`. Find the `#[cfg(debug_assertions)]` handler block starting at line 30, and the release block at line 219. Add to each `tauri::generate_handler![ ... ]` list:

```rust
commands::main_playlist_write,
commands::main_playlist_read,
commands::main_playlist_clear,
commands::main_playlist_gc,
commands::main_playlist_set_cover,
commands::main_playlist_set_thumb,
commands::main_playlist_remove_thumb,
```

- [ ] **Step 4: Compile-check debug and release**

Run: `cd src-tauri && cargo check`
Run: `cd src-tauri && cargo check --release`
Expected: both clean.

- [ ] **Step 5: Full test suite still green**

Run: `cd src-tauri && cargo test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(main-playlist): expose Tauri commands"
```

---

## Task 7: Pure TS helpers (`mainPlaylist.ts`) with tests

**Files:**
- Create: `src/mainPlaylist.ts`
- Create: `src/__tests__/mainPlaylist.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/mainPlaylist.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { Track } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";
import {
  buildManifest,
  buildState,
  tracksFromManifest,
  contextFromManifest,
  diffThumbs,
  thumbFilenameForUri,
} from "../mainPlaylist";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: null, key: "ext:1", path: "file:///x.mp3", title: "T",
    artist_id: null, artist_name: "A", album_id: null, album_title: "Al",
    year: null, track_number: null, duration_secs: 200, format: "mp3",
    file_size: null, collection_id: null, collection_name: null,
    liked: 0, youtube_url: null, added_at: null, modified_at: null,
    image_url: undefined, ...overrides,
  };
}

describe("buildManifest", () => {
  it("produces a version-1 custom mixtape manifest", () => {
    const t = makeTrack();
    const m = buildManifest([t], { name: "Hits" });
    expect(m.version).toBe(1);
    expect(m.type).toBe("custom");
    expect(m.title).toBe("Hits");
    expect(m.tracks).toHaveLength(1);
    expect(m.tracks[0].file).toBe("file:///x.mp3");
  });

  it("references thumbs/{slug}.jpg derived from the track URI when context is remote", () => {
    const t = makeTrack({ path: "tidal://12345" });
    const m = buildManifest([t], { name: "P", remote: true });
    expect(m.tracks[0].thumb).toBe("thumbs/tidal12345.jpg");
  });

  it("leaves thumb null when context is not remote", () => {
    const m = buildManifest([makeTrack()], { name: "P", remote: false });
    expect(m.tracks[0].thumb).toBeNull();
  });

  it("sets cover to 'cover.jpg' when context has an image", () => {
    const m = buildManifest([], { name: "P", imagePath: "/abs/x.jpg" });
    expect(m.cover).toBe("cover.jpg");
  });
});

describe("buildState", () => {
  it("round-trips queue playback state", () => {
    const s = buildState(3, "shuffle", [0, 2, 1], 1);
    expect(s).toEqual({ queueIndex: 3, queueMode: "shuffle", shuffleOrder: [0, 2, 1], shufflePosition: 1 });
  });
});

describe("diffThumbs", () => {
  it("returns added and removed by URI", () => {
    const a = [makeTrack({ path: "spotify://a" }), makeTrack({ path: "spotify://b" })];
    const b = [makeTrack({ path: "spotify://a" }), makeTrack({ path: "spotify://c" })];
    const d = diffThumbs(a, b);
    expect(d.added.map(t => t.path)).toEqual(["spotify://c"]);
    expect(d.removed).toEqual(["spotify://b"]);
  });

  it("returns empty on reorder", () => {
    const a = [makeTrack({ path: "spotify://a" }), makeTrack({ path: "spotify://b" })];
    const b = [makeTrack({ path: "spotify://b" }), makeTrack({ path: "spotify://a" })];
    const d = diffThumbs(a, b);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });
});

describe("contextFromManifest", () => {
  it("sets imagePath to cover.jpg when manifest has cover", () => {
    const m = buildManifest([], { name: "P", imagePath: "/x.jpg", source: "spotify" });
    const ctx = contextFromManifest(m);
    expect(ctx?.imagePath).toBe("cover.jpg");
    expect(ctx?.source).toBe("spotify");
  });

  it("infers remote=true when source is non-library", () => {
    const m = buildManifest([], { name: "P", source: "spotify" });
    const ctx = contextFromManifest(m);
    expect(ctx?.remote).toBe(true);
  });

  it("infers remote=false when source is 'library'", () => {
    const m = buildManifest([], { name: "P", source: "library" });
    expect(contextFromManifest(m)?.remote).toBe(false);
  });
});

describe("thumbFilenameForUri", () => {
  it("matches backend canonical_slug: colons and slashes are deleted", () => {
    expect(thumbFilenameForUri("tidal://12345")).toBe("tidal12345.jpg");
    expect(thumbFilenameForUri("spotify://abc")).toBe("spotifyabc.jpg");
  });

  it("falls back to _unknown for empty strings", () => {
    expect(thumbFilenameForUri("")).toBe("_unknown.jpg");
    expect(thumbFilenameForUri(null as unknown as string)).toBe("_unknown.jpg");
  });
});
```

- [ ] **Step 2: Run tests to confirm fail**

Run: `npm test -- mainPlaylist`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/mainPlaylist.ts`**

```typescript
import type { Track } from "./types";
import type { PlaylistContext } from "./hooks/useQueue";

export interface ManifestTrack {
  title: string;
  artist: string;
  album: string | null;
  duration_secs: number | null;
  file: string | null;
  thumb: string | null;
}

export interface Manifest {
  version: 1;
  title: string;
  type: "custom";
  metadata: Record<string, string>;
  created_at: string;
  created_by: string | null;
  cover: string | null;
  tracks: ManifestTrack[];
}

export interface MainPlaylistState {
  queueIndex: number;
  queueMode: "normal" | "loop" | "shuffle";
  shuffleOrder: number[];
  shufflePosition: number;
}

const LIBRARY_SOURCES = new Set(["library", "album", "artist", "tag", "playlist"]);

/**
 * Mirror of backend `canonical_slug` applied to a track's file URI.
 * Backend (src-tauri/src/entity_image.rs): lowercases, deletes `\ / : * ? " < > |` and
 * control chars, collapses whitespace, trims leading/trailing dots, returns "_unknown"
 * if empty.
 *
 * Rationale: URIs are stable across restarts (unlike the in-memory `QueueEntry.key`
 * which uses a resetting counter for external tracks). Keying thumbs by URI lets
 * cached thumbs survive app restarts.
 *
 * If you change `canonical_slug` in Rust, update this to match and re-run both test suites.
 */
const FORBIDDEN_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;
export function thumbFilenameForUri(uri: string | null | undefined): string {
  if (!uri) return "_unknown.jpg";
  const lowered = uri.toLowerCase();
  const filtered = lowered.replace(FORBIDDEN_CHARS, "");
  const collapsed = filtered.split(/\s+/).filter(Boolean).join(" ");
  const trimmed = collapsed.replace(/^\.+|\.+$/g, "");
  const slug = trimmed.length === 0 ? "_unknown" : trimmed;
  return `${slug}.jpg`;
}

export function isContextRemote(ctx: PlaylistContext | null | undefined): boolean {
  if (!ctx) return false;
  if (typeof ctx.remote === "boolean") return ctx.remote;
  if (!ctx.source) return false;
  return !LIBRARY_SOURCES.has(ctx.source);
}

export function buildManifest(queue: Track[], context: PlaylistContext | null | undefined): Manifest {
  const remote = isContextRemote(context);
  const metadata: Record<string, string> = {};
  if (context?.source) metadata.source = context.source;
  if (context?.metadata) for (const [k, v] of Object.entries(context.metadata)) metadata[k] = v;

  return {
    version: 1,
    title: context?.name ?? "Main Playlist",
    type: "custom",
    metadata,
    created_at: new Date().toISOString(),
    created_by: null,
    cover: context?.imagePath || context?.coverUrl ? "cover.jpg" : null,
    tracks: queue.map(t => ({
      title: t.title,
      artist: t.artist_name ?? "",
      album: t.album_title ?? null,
      duration_secs: t.duration_secs,
      file: t.path,
      thumb: remote && t.path ? `thumbs/${thumbFilenameForUri(t.path)}` : null,
    })),
  };
}

export function buildState(
  queueIndex: number,
  queueMode: "normal" | "loop" | "shuffle",
  shuffleOrder: number[],
  shufflePosition: number,
): MainPlaylistState {
  return { queueIndex, queueMode, shuffleOrder, shufflePosition };
}

export function tracksFromManifest(manifest: Manifest): Track[] {
  let extCounter = 1;
  return manifest.tracks.map((m): Track => ({
    id: null,
    // QueueEntry.key is an in-memory identity used for React rendering + multi-select.
    // It is not persisted. Generate fresh keys on restore. Thumbnail identity on disk
    // is keyed off the file URI (see thumbFilenameForUri), not this key, so thumbs
    // cached before restart are still found.
    key: `ext:${extCounter++}`,
    path: m.file,
    title: m.title,
    artist_id: null, artist_name: m.artist || null,
    album_id: null, album_title: m.album,
    year: null, track_number: null,
    duration_secs: m.duration_secs,
    format: null, file_size: null,
    collection_id: null, collection_name: null,
    liked: 0, youtube_url: null,
    added_at: null, modified_at: null,
    image_url: undefined,
  }));
}

export function contextFromManifest(manifest: Manifest): PlaylistContext | null {
  if (!manifest.title && !manifest.cover && Object.keys(manifest.metadata).length === 0) return null;
  const source = manifest.metadata.source ?? null;
  const { source: _s, ...restMeta } = manifest.metadata;
  const remote = source ? !LIBRARY_SOURCES.has(source) : false;
  return {
    name: manifest.title,
    imagePath: manifest.cover ? "cover.jpg" : null,
    coverUrl: null,
    source,
    metadata: Object.keys(restMeta).length > 0 ? restMeta : null,
    remote,
  };
}

/**
 * Diff queues by **file URI** (stable across restarts), not by `key` (in-memory only).
 * `added` are full track records (so callers can read image_url); `removed` is a list
 * of URIs to delete thumb files for.
 */
export function diffThumbs(
  prev: Track[],
  next: Track[],
): { added: Track[]; removed: string[] } {
  const prevUris = new Set(prev.map(t => t.path).filter((p): p is string => !!p));
  const nextUris = new Set(next.map(t => t.path).filter((p): p is string => !!p));
  const added = next.filter(t => t.path && !prevUris.has(t.path));
  const removed = prev
    .map(t => t.path)
    .filter((p): p is string => !!p && !nextUris.has(p));
  return { added, removed };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- mainPlaylist`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mainPlaylist.ts src/__tests__/mainPlaylist.test.ts
git commit -m "feat(main-playlist): pure TS helpers for manifest/state/thumb diff"
```

---

## Task 8: Add `remote` to `PlaylistContext` and switch `useQueue` to folder writes

**Files:**
- Modify: `src/hooks/useQueue.ts`

- [ ] **Step 1: Add `remote` to `PlaylistContext` interface**

Edit `src/hooks/useQueue.ts` around line 8:

```typescript
export interface PlaylistContext {
  name: string;
  imagePath?: string | null;
  coverUrl?: string | null;
  source?: string | null;
  metadata?: Record<string, string> | null;
  remote?: boolean;
}
```

- [ ] **Step 2: Replace the 4 `store.set` effects with a single debounced writer**

Remove lines 41–44 (the four `useEffect(() => { if (restoredRef.current) store.set(...) ... })` for `queueEntries`, `queueIndex`, `queueMode`, `playlistContext`).

Replace with:

```typescript
useEffect(() => {
  if (!restoredRef.current) return;
  const t = setTimeout(() => {
    invoke("main_playlist_write", {
      manifest: buildManifest(queueRef.current, playlistContext),
      stateData: buildState(queueIndex, queueMode, shuffleOrder, shufflePosition),
    }).catch(e => console.error("Failed to write main-playlist:", e));
  }, 500);
  return () => clearTimeout(t);
}, [queue, playlistContext, queueIndex, queueMode, shuffleOrder, shufflePosition]);
```

Add import at top of file:

```typescript
import { buildManifest, buildState } from "../mainPlaylist";
```

Note: Tauri command parameters are snake-cased in Rust but camelCased on the wire with `serde(rename_all = "camelCase")`, and the invoke call uses camelCase. The Rust command declares `state_data`, but with Tauri's auto-conversion the JS side passes `stateData`. Verify by checking another existing command with an underscored param.

- [ ] **Step 3: Compile-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Run existing useQueue-adjacent tests**

Run: `npm test -- hooks-logic queueEntry`
Expected: still pass (we haven't removed their dependencies).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useQueue.ts
git commit -m "feat(main-playlist): useQueue writes folder instead of tauri-store"
```

---

## Task 9: Wire cover + thumb side-effects in `useQueue`

**Files:**
- Modify: `src/hooks/useQueue.ts`

- [ ] **Step 1: Add cover side-effect**

Add inside the `useQueue` hook (after the main debounced write effect):

```typescript
// Cover: write whenever playlistContext changes
useEffect(() => {
  if (!restoredRef.current) return;
  const ctx = playlistContext;
  if (!ctx || (!ctx.imagePath && !ctx.coverUrl)) {
    invoke("main_playlist_set_cover", { source: null }).catch(console.error);
    return;
  }
  const source = ctx.coverUrl
    ? { url: ctx.coverUrl, path: null }
    : { path: ctx.imagePath, url: null };
  invoke("main_playlist_set_cover", { source }).catch(console.error);
}, [playlistContext]);
```

- [ ] **Step 2: Add thumb diff side-effect (remote-only)**

Add:

```typescript
const prevQueueRef = useRef<Track[]>([]);
useEffect(() => {
  if (!restoredRef.current) { prevQueueRef.current = queue; return; }
  const remote = isContextRemote(playlistContext);
  const { added, removed } = diffThumbs(prevQueueRef.current, queue);
  prevQueueRef.current = queue;

  // Always remove stale thumbs even when switching off remote.
  // Backend slugifies the `key` param via canonical_slug → same filename as thumbFilenameForUri.
  for (const uri of removed) {
    invoke("main_playlist_remove_thumb", { key: uri }).catch(console.error);
  }
  if (!remote) return;
  for (const t of added) {
    if (!t.path) continue;
    const source =
      t.image_url?.startsWith("http") ? { url: t.image_url, path: null } :
      t.image_url?.startsWith("file://") ? { path: t.image_url.slice(7), url: null } :
      t.image_url ? { path: t.image_url, url: null } :
      null;
    if (!source) continue;
    invoke("main_playlist_set_thumb", { key: t.path, source }).catch(console.error);
  }
}, [queue, playlistContext]);
```

Add `diffThumbs` and `isContextRemote` to the import from `../mainPlaylist`.

- [ ] **Step 3: Wire `clearQueue` to `main_playlist_clear`**

In `clearQueue` (line ~287), after the existing setters, append:

```typescript
invoke("main_playlist_clear").catch(console.error);
```

- [ ] **Step 4: Compile-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useQueue.ts
git commit -m "feat(main-playlist): cover/thumb side-effects and clear-on-clear"
```

---

## Task 10: Replace App.tsx startup restore — read folder, drop store reads, gc once

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Remove queue keys from `store.get` batch**

Find the `Promise.all([ ... ])` block starting around line 1263. Remove these lines:

```typescript
store.get<QueueEntry[]>("queueEntries"),
store.get<number>("queueIndex"),
store.get<string>("queueMode"),
...
store.get<PlaylistContext | null>("playlistContext"),
```

and adjust the destructured tuple (remove the matching positions) and any references to `qEntries`, `qIdx`, `qMode`, `savedPlaylistName`.

- [ ] **Step 2: Remove queue-restore logic block**

Use stable anchor strings (not line numbers) to locate the block:

1. Find the first line starting with `// Allow mutation for migration` — that is the top of the block.
2. Find the closing `}` of the `if (savedPlaylistName) { ... }` else-branch (`queueHook.setPlaylistContext(savedPlaylistName as PlaylistContext);` is the last statement inside it) — that is the bottom of the block.
3. Delete everything inclusive between those anchors: the `queueEntries` reassignment, the `queueTrackIds`/`location→url` migrations, the `restoredTracks` construction, the `savedTrackEntry` migration, the `pendingRestoreTrackRef`/`pendingRestoreQueueRef` assignments, the `qMode` branch, and the `savedPlaylistName` branch.
4. Verify with `grep` that `queueTrackIds`, `location`, `queueEntryToTrack`, and `savedPlaylistName` no longer appear inside the restore IIFE. (They may still appear in unrelated callers — only the restore block goes away.)

All of that logic is replaced by the folder read in Step 3.

- [ ] **Step 3: Add folder-based restore**

After the existing restore code where `restoredRef.current = true` is set (around line 1507), but **before** it, add:

```typescript
try {
  const { manifest, state } = await invoke<{ manifest: Manifest | null; state: MainPlaylistState | null }>("main_playlist_read");
  if (manifest) {
    const tracks = tracksFromManifest(manifest);
    const ctx = contextFromManifest(manifest);
    if (tracks.length > 0) {
      pendingRestoreQueueRef.current = {
        tracks,
        index: state?.queueIndex != null && state.queueIndex >= 0 && state.queueIndex < tracks.length ? state.queueIndex : -1,
      };
      if (state?.queueIndex != null && state.queueIndex >= 0 && state.queueIndex < tracks.length) {
        pendingRestoreTrackRef.current = tracks[state.queueIndex];
      }
    }
    if (ctx) queueHook.setPlaylistContext(ctx);
  }
  if (state) {
    if (state.queueMode && ["normal", "loop", "shuffle"].includes(state.queueMode)) {
      queueHook.setQueueMode(state.queueMode);
    }
    queueHook.setShuffleOrder(state.shuffleOrder ?? []);
    queueHook.setShufflePosition(state.shufflePosition ?? 0);
  }
  // Fire-and-forget gc; not awaited so it never blocks startup.
  invoke("main_playlist_gc").catch(e => console.error("main_playlist_gc failed:", e));
} catch (e) {
  console.error("Failed to restore main playlist:", e);
}
```

Add imports at top of `App.tsx`:

```typescript
import { tracksFromManifest, contextFromManifest, type Manifest, type MainPlaylistState } from "./mainPlaylist";
```

**Important ordering note:** this block must run **before** `restoredRef.current = true` at the end of the restore IIFE. The debounced writer in Task 8 and the cover/thumb side-effects in Task 9 are guarded by `restoredRef.current`, so calling `setPlaylistContext`, `setQueueMode`, `setShuffleOrder`, `setShufflePosition` here does not trigger spurious folder writes.

- [ ] **Step 4: Compile-check**

Run: `npx tsc --noEmit`
Expected: clean. If there are unused-variable errors from the destructured tuple, prune them.

- [ ] **Step 5: Run all TS tests**

Run: `npm test`
Expected: green.

- [ ] **Step 6: Manual smoke test**

Run: `npm run tauri dev`
- Load a library album -> Play All -> verify queue panel shows tracks.
- Close app, reopen -> verify queue restored from the folder.
- Open `{profile_dir}/main-playlist/` in Finder -> confirm `manifest.json` and `state.json` exist.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(main-playlist): replace store queue restore with folder read + gc"
```

---

## Task 11: Wire `remote: true` into the plugin `play-tracks` action path

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Find the plugin `play-tracks` handler**

Run: `grep -n '"play-tracks"\|play-tracks' src/App.tsx | head`. The handler constructs a `PlaylistContext` from `payload.playlistName`, `payload.coverUrl`, etc.

- [ ] **Step 2: Default `remote` to true for plugin-driven playback**

In that handler, when building the context passed to `queueHook.playTracks(...)`, include `remote: true`:

```typescript
const context: PlaylistContext = {
  name: payload.playlistName,
  coverUrl: payload.coverUrl ?? null,
  source: payload.source ?? "plugin",
  remote: true,
};
```

If the action already takes a `source` field, respect an explicit `source === "library"` by not forcing remote. Otherwise plugin callers are by definition remote.

- [ ] **Step 3: For the library-internal play actions, set `remote: false`**

Find where album / artist / tag / saved-playlist Play All code paths build the `PlaylistContext` (search for `playTracks(` call sites in `src/App.tsx` and hooks). Add `remote: false` (or set `source: "album"`/`"artist"`/`"tag"`/`"playlist"` and rely on inference). Explicit `remote` is clearer — prefer it.

- [ ] **Step 4: Manual smoke test**

Run: `npm run tauri dev`
- Play an album from the library -> confirm no thumbs are written to `main-playlist/thumbs/`.
- Play a Spotify or TIDAL plugin playlist (whichever is available) -> confirm thumbs appear in the folder.
- Delete the remote source (simulate by closing network) and restart the app -> thumbs still render.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(main-playlist): mark plugin-sourced playback as remote for thumb caching"
```

---

## Task 12: Add `main_playlist_dir` command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

The frontend needs the absolute path to the folder so it can render local files via `convertFileSrc`. Adding a dedicated command is cleaner than exposing the full profile directory.

- [ ] **Step 1: Add `main_playlist_dir` command**

Append next to the other `main_playlist_*` commands in `commands.rs`:

```rust
#[tauri::command]
pub async fn main_playlist_dir(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.app_dir.join("main-playlist").to_string_lossy().into_owned())
}
```

- [ ] **Step 2: Register in both invoke handlers (debug + release) in `lib.rs`**

Add `commands::main_playlist_dir,` to the `tauri::generate_handler![ ... ]` list in both `get_invoke_handler` variants (same places as Task 6).

- [ ] **Step 3: Compile-check debug and release**

Run: `cd src-tauri && cargo check && cargo check --release`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(main-playlist): expose main_playlist_dir command"
```

---

## Task 13: Render local thumbs and cover from the folder

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/QueuePanel.tsx`

- [ ] **Step 1: Fetch `mainPlaylistDir` on startup and pass it through**

In `App.tsx`, near the other one-time restore/init effects:

```typescript
const [mainPlaylistDir, setMainPlaylistDir] = useState<string | null>(null);
useEffect(() => {
  invoke<string>("main_playlist_dir").then(setMainPlaylistDir).catch(console.error);
}, []);
```

Pass `mainPlaylistDir` as a prop to `<QueuePanel>`:

```tsx
<QueuePanel ... mainPlaylistDir={mainPlaylistDir} />
```

- [ ] **Step 2: Add the prop to `QueuePanelProps`**

In `src/components/QueuePanel.tsx`, extend `QueuePanelProps`:

```typescript
mainPlaylistDir: string | null;
```

Thread it into the component signature.

- [ ] **Step 3: Use local thumb in the queue item `<img>`**

Import at top of QueuePanel:

```typescript
import { thumbFilenameForUri } from "../mainPlaylist";
```

Use Tauri's path join to keep Windows/macOS/Linux separators correct. Since string concatenation with `/` works for `convertFileSrc` on all platforms (Tauri normalizes), using `${dir}/thumbs/${filename}` is safe. Replace the `<img className="queue-item-thumb" …>` in the queue item (around line 493) with:

```tsx
const localThumb = mainPlaylistDir && t.path
  ? convertFileSrc(`${mainPlaylistDir}/thumbs/${thumbFilenameForUri(t.path)}`)
  : null;
const fallback = getTrackImage(t);
const initialSrc = localThumb ?? fallback ?? "";
return initialSrc ? (
  <img
    className="queue-item-thumb"
    src={initialSrc}
    data-has-fallback={localThumb && fallback ? "true" : "false"}
    onError={(e) => {
      const el = e.currentTarget as HTMLImageElement;
      if (el.dataset.fallbackApplied === "true") return;
      if (localThumb && fallback) {
        el.dataset.fallbackApplied = "true";
        el.src = fallback;
      }
    }}
    alt=""
  />
) : (
  <div className="queue-item-thumb queue-item-thumb-placeholder">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  </div>
);
```

The `onError → fallback` approach avoids statting files from JS: if the local thumb file doesn't exist, the `<img>` fires `onError` and we swap to the fallback source.

- [ ] **Step 4: Render `cover.jpg` as playlist context image**

In the context banner (around line 441), replace:

```tsx
{playlistContext.imagePath ? (
  <img src={convertFileSrc(playlistContext.imagePath)} alt="" />
) : (
```

with a computation that rewrites `"cover.jpg"` to an absolute path:

```tsx
const coverPath = playlistContext.imagePath === "cover.jpg" && mainPlaylistDir
  ? `${mainPlaylistDir}/cover.jpg`
  : playlistContext.imagePath;
...
{coverPath ? (
  <img src={convertFileSrc(coverPath)} alt="" />
) : (
```

- [ ] **Step 5: Compile-check and manual smoke**

Run: `npx tsc --noEmit`
Run: `npm run tauri dev`
- Play a plugin playlist — thumbs load from local files (no network for thumbs after first load).
- Restart app with network offline — thumbs and cover still render.
- Play from the library (album Play All) — thumbs fall back to `albumImages` chain as before, no files written to `main-playlist/thumbs/`.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/QueuePanel.tsx
git commit -m "feat(main-playlist): render local cover and thumbs with onError fallback"
```

---

## Task 14: Final pass — type check, cargo check (debug + release), full tests

**Files:** none

- [ ] **Step 1: `npx tsc --noEmit`**

Expected: clean.

- [ ] **Step 2: `cd src-tauri && cargo check && cargo check --release`**

Expected: clean.

- [ ] **Step 3: `npm run test:all`**

Expected: all pass.

- [ ] **Step 4: Manual QA checklist**

- Load library album -> queue restored after restart, no thumbs in folder, cover is the album image copied in.
- Load Spotify/TIDAL plugin playlist -> thumbs + cover appear in folder, survive restart + network off.
- Reorder queue -> only `manifest.json` mtime changes; thumbs unchanged.
- Remove track from queue -> corresponding thumb file deleted.
- Clear playlist -> folder is empty (except `thumbs/` subdirectory).
- Switch profile -> different `main-playlist/` folder used; no cross-profile leakage.

- [ ] **Step 5: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "chore(main-playlist): final cleanup" || true
```

---

## Notes for the implementer

- **Skill references:** Use @superpowers:test-driven-development for each task; the test-first pattern is baked into each step.
- **Rust module layout:** All Rust unit tests live in `#[cfg(test)] mod tests` inside `main_playlist.rs`. No separate test file.
- **Tauri param casing:** Rust fields are snake_case with `#[serde(rename_all = "camelCase")]` in models; invoke from TS using camelCase keys.
- **`canonical_slug` parity:** The TS `thumbFilenameForUri` must produce identical output to Rust's `canonical_slug`. Validate during Task 7 by running `"tidal://12345"` through both implementations. If parity breaks for non-ASCII inputs, the simplest fix is to key thumbs only on the `lib:<id>` / `ext:<n>` / URI-scheme prefix of well-formed URIs (which are ASCII-only in this codebase); do not try to emulate Rust's `deunicode` / `strip_diacritics` behavior in JS.
- **No migration:** Per the spec's Q7, users upgrading lose their current queue once. Don't add fallback reads from `app-state.json`.
- **`QueueEntry` preservation:** `queueEntry.ts` stays for M3U save/load. Only the four queue-related `store` keys go away.
