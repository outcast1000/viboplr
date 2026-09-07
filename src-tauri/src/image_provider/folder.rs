//! Folder ("sidecar") image discovery: the `cover.jpg` sitting next to the
//! tracks, which is how most of the world ships artwork.
//!
//! The model is Navidrome's: an **ordered list of case-insensitive globs**,
//! first match wins, with the list itself user-editable (Settings → Providers).
//! That ordering matters more than it looks — a folder often holds several
//! candidates (`cover.jpg` next to a `folder.jpg` left behind by Windows Media
//! Player), and which one is "the" cover is a judgement call the user owns.
//!
//! Two decisions worth knowing before changing anything here:
//!
//! **Walk-up is gated on disc-folder names.** A multi-disc release keeps its art
//! at the album level (`Physical Graffiti/cover.jpg`) while the tracks live in
//! `CD1/`, so the search has to climb. But climbing unconditionally is what
//! breaks a `Singles/` or collection-root dump: every album sharing that folder
//! would be assigned the same cover, confidently and wrongly. So the parent is
//! probed only when the track's own folder *names itself* a disc — see
//! `is_disc_dir` — and never above the collection root.
//!
//! **The artist folder is confirmed by name, not by position.** `Artist/Album/`
//! is a convention, not a guarantee: a flat folder, a `Compilations/` tree or a
//! label-first layout would all hand back a parent that has nothing to do with
//! the artist. `artist_search_dirs` therefore only accepts an ancestor whose
//! basename slug-matches the artist, which is also what stops a `Various
//! Artists` folder image from becoming every guest artist's portrait.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::db::Database;
use crate::entity_image::canonical_slug;

/// Filenames are only considered when they carry one of these extensions. This
/// is a pre-filter, not the format decision: it keeps the matcher from opening
/// `front.txt` for a `front.*` pattern, while the stored file's real extension
/// still comes from the bytes (`sniff_image_ext`).
pub const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];

/// Default album-art globs, in probe order. `folder.*` / `albumart*.*` are
/// Windows Media Player leftovers and sit below the explicit names on purpose.
pub const DEFAULT_ALBUM_PATTERNS: &[&str] =
    &["cover.*", "folder.*", "front.*", "album.*", "albumart*.*"];

/// Default artist-image globs. Deliberately short: an artist folder holding a
/// `cover.*` almost always means a single-album artist, and taking it would
/// make the artist and the album share one picture.
pub const DEFAULT_ARTIST_PATTERNS: &[&str] = &["artist.*", "folder.*", "fanart.*"];

/// `plugin_storage` keys (under the `__core__` pseudo-plugin) holding the
/// user's pattern lists. Storage rather than the frontend store because the
/// image worker reads these from Rust, off the main thread, with no webview
/// involved.
pub const ALBUM_PATTERNS_KEY: &str = "folder_image_patterns_album";
pub const ARTIST_PATTERNS_KEY: &str = "folder_image_patterns_artist";

pub fn default_patterns(entity: &str) -> Vec<String> {
    let src = if entity == "artist" { DEFAULT_ARTIST_PATTERNS } else { DEFAULT_ALBUM_PATTERNS };
    src.iter().map(|s| s.to_string()).collect()
}

/// Match a `*`-glob against a filename. Both sides are compared lowercase by
/// the caller; `?` and character classes are not supported (nobody writes
/// `co?er.jpg`, and supporting them would mean pulling in a glob crate for it).
pub fn glob_match(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == name;
    }
    if !name.starts_with(parts[0]) {
        return false;
    }
    let mut rest = &name[parts[0].len()..];
    let last = parts.len() - 1;
    for (i, part) in parts.iter().enumerate().skip(1) {
        if i == last {
            return rest.len() >= part.len() && rest.ends_with(part);
        }
        if part.is_empty() {
            continue;
        }
        match rest.find(part) {
            Some(p) => rest = &rest[p + part.len()..],
            None => return false,
        }
    }
    true
}

fn has_image_ext(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .is_some_and(|e| IMAGE_EXTS.contains(&e.as_str()))
}

/// Does this folder name declare itself a disc of a larger release?
/// Accepts `CD1`, `cd 1`, `Disc 2`, `disk_03`, `Disc 1 - Bonus`.
pub fn is_disc_dir(name: &str) -> bool {
    let lowered = name.trim().to_lowercase();
    for kw in ["disc", "disk", "cd"] {
        if let Some(rest) = lowered.strip_prefix(kw) {
            let rest = rest.trim_start_matches([' ', '_', '-', '.']);
            if rest.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                return true;
            }
        }
    }
    false
}

/// Pick the best image in one directory: the first pattern that matches
/// anything wins, and ties inside a pattern break alphabetically so the answer
/// doesn't depend on `read_dir` order.
pub fn pick_in_dir(dir: &Path, patterns: &[String]) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if has_image_ext(&name) {
            names.push(name);
        }
    }
    names.sort_by_key(|n| n.to_lowercase());

    for pattern in patterns {
        let pattern = pattern.trim().to_lowercase();
        if pattern.is_empty() {
            continue;
        }
        for name in &names {
            if glob_match(&pattern, &name.to_lowercase()) {
                return Some(dir.join(name));
            }
        }
    }
    None
}

/// Directories to probe for an album's art, nearest first: the folder the
/// track lives in, plus its parent when that folder names itself a disc.
pub fn album_search_dirs(track_path: &Path, collection_root: &Path) -> Vec<PathBuf> {
    let Some(dir) = track_path.parent() else { return Vec::new() };
    let mut dirs = vec![dir.to_path_buf()];
    let is_disc = dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_disc_dir);
    if is_disc {
        if let Some(parent) = dir.parent() {
            // `starts_with` includes equality, which is intended: probing the
            // collection root is fine when the root *is* the album folder. What
            // it forbids is climbing above it into a shared parent.
            if parent.starts_with(collection_root) {
                dirs.push(parent.to_path_buf());
            }
        }
    }
    dirs
}

/// Ancestors of a track that actually look like this artist's folder, nearest
/// first. An ancestor qualifies only when its basename slug-matches the artist
/// name, so a `Compilations/` or label-first layout yields nothing rather than
/// something wrong.
pub fn artist_search_dirs(
    track_path: &Path,
    collection_root: &Path,
    artist_name: &str,
) -> Vec<PathBuf> {
    let wanted = canonical_slug(artist_name);
    if wanted == "_unknown" {
        return Vec::new();
    }
    let mut dirs = Vec::new();
    let mut cursor = track_path.parent();
    // Four levels covers Artist/Album/CD1 and a disc-in-album-in-artist tree
    // with room to spare; deeper than that and the "parent means artist"
    // assumption has stopped being true anyway.
    for _ in 0..4 {
        let Some(dir) = cursor else { break };
        if !dir.starts_with(collection_root) {
            break;
        }
        if dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| canonical_slug(n) == wanted)
        {
            dirs.push(dir.to_path_buf());
        }
        if dir == collection_root {
            break;
        }
        cursor = dir.parent();
    }
    dirs
}

/// Copy a discovered image to `dest_base`, named from its **bytes**. Sidecar
/// files are misnamed often enough (a PNG saved as `cover.jpg` by a tagger)
/// that trusting the extension would store a file the webview can't decode
/// under a name that says it should.
pub fn store_discovered(src: &Path, dest_base: &Path) -> Result<PathBuf, String> {
    let mut head = [0u8; 16];
    let read = std::fs::File::open(src)
        .and_then(|mut f| f.read(&mut head))
        .map_err(|e| format!("Failed to read {}: {}", src.display(), e))?;
    let ext = crate::commands::sniff_image_ext(&head[..read])
        .ok_or_else(|| format!("{} is not a recognized image", src.display()))?;
    let dest = dest_base.with_extension(ext);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(src, &dest).map_err(|e| format!("Failed to copy image: {}", e))?;
    Ok(dest)
}

pub struct FolderImageProvider {
    db: Arc<Database>,
}

impl FolderImageProvider {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// The pattern list the user has configured for `entity`, falling back to
    /// the defaults when unset or unparseable.
    pub fn patterns(&self, entity: &str) -> Vec<String> {
        let key = if entity == "artist" { ARTIST_PATTERNS_KEY } else { ALBUM_PATTERNS_KEY };
        let stored = self
            .db
            .plugin_storage_get("__core__", key)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok());
        match stored {
            Some(list) if !list.is_empty() => list,
            _ => default_patterns(entity),
        }
    }

    /// Locate an album's folder image without copying it anywhere.
    pub fn find_album_image(
        &self,
        album_title: &str,
        artist_name: Option<&str>,
    ) -> Result<PathBuf, String> {
        let locations = self
            .db
            .get_album_track_locations(album_title, artist_name)
            .map_err(|e| format!("DB lookup failed: {}", e))?;
        if locations.is_empty() {
            return Err("No local track found for album".into());
        }
        let patterns = self.patterns("album");
        let mut probed: Vec<PathBuf> = Vec::new();
        for (root, track) in &locations {
            for dir in album_search_dirs(Path::new(track), Path::new(root)) {
                if probed.contains(&dir) {
                    continue;
                }
                probed.push(dir.clone());
                if let Some(found) = pick_in_dir(&dir, &patterns) {
                    return Ok(found);
                }
            }
        }
        Err("No folder image found".into())
    }

    /// Locate an artist's folder image without copying it anywhere.
    pub fn find_artist_image(&self, artist_name: &str) -> Result<PathBuf, String> {
        let locations = self
            .db
            .get_artist_track_locations(artist_name)
            .map_err(|e| format!("DB lookup failed: {}", e))?;
        if locations.is_empty() {
            return Err("No local track found for artist".into());
        }
        let patterns = self.patterns("artist");
        let mut probed: Vec<PathBuf> = Vec::new();
        for (root, track) in &locations {
            for dir in artist_search_dirs(Path::new(track), Path::new(root), artist_name) {
                if probed.contains(&dir) {
                    continue;
                }
                probed.push(dir.clone());
                if let Some(found) = pick_in_dir(&dir, &patterns) {
                    return Ok(found);
                }
            }
        }
        Err("No folder image found".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_extension_wildcard() {
        assert!(glob_match("cover.*", "cover.jpg"));
        assert!(glob_match("cover.*", "cover.png"));
        assert!(!glob_match("cover.*", "mycover.jpg"));
        assert!(!glob_match("cover.*", "cover2.jpg"));
    }

    #[test]
    fn glob_matches_interior_wildcard() {
        assert!(glob_match("albumart*.*", "albumart.jpg"));
        assert!(glob_match("albumart*.*", "albumart_large.jpg"));
        assert!(glob_match("albumart*.*", "albumart_{guid}_large.jpg"));
        assert!(!glob_match("albumart*.*", "art.jpg"));
    }

    #[test]
    fn glob_exact_when_no_wildcard() {
        assert!(glob_match("cover.jpg", "cover.jpg"));
        assert!(!glob_match("cover.jpg", "cover.png"));
    }

    #[test]
    fn disc_dir_recognizes_common_spellings() {
        for name in ["CD1", "cd 1", "cd_01", "Disc 2", "disk-3", "DISC1", "Disc 1 - Bonus"] {
            assert!(is_disc_dir(name), "{} should be a disc dir", name);
        }
    }

    #[test]
    fn disc_dir_rejects_album_names() {
        // "Discovery" starts with "disc" but has no number after it — the digit
        // check is the whole reason this doesn't eat Daft Punk's album.
        for name in ["Discovery", "Disintegration", "CDs", "Physical Graffiti", "Bonus"] {
            assert!(!is_disc_dir(name), "{} should not be a disc dir", name);
        }
    }

    #[test]
    fn album_dirs_include_parent_only_for_disc_folders() {
        let root = Path::new("/music");
        let disc = Path::new("/music/Zeppelin/Physical Graffiti/CD1/01.flac");
        assert_eq!(
            album_search_dirs(disc, root),
            vec![
                PathBuf::from("/music/Zeppelin/Physical Graffiti/CD1"),
                PathBuf::from("/music/Zeppelin/Physical Graffiti"),
            ]
        );

        let flat = Path::new("/music/Singles/track.mp3");
        assert_eq!(album_search_dirs(flat, root), vec![PathBuf::from("/music/Singles")]);
    }

    #[test]
    fn album_dirs_never_climb_above_the_collection_root() {
        // The root itself IS the disc folder — climbing would leave the
        // collection entirely and pick up whatever sits beside it on disk.
        let root = Path::new("/music/CD1");
        let track = Path::new("/music/CD1/01.flac");
        assert_eq!(album_search_dirs(track, root), vec![PathBuf::from("/music/CD1")]);
    }

    #[test]
    fn artist_dirs_require_a_name_match() {
        let root = Path::new("/music");
        let track = Path::new("/music/Björk/Post/01.flac");
        // Diacritics fold through canonical_slug, so a "Bjork" folder matches too.
        assert_eq!(
            artist_search_dirs(track, root, "Björk"),
            vec![PathBuf::from("/music/Björk")]
        );
        assert!(artist_search_dirs(track, root, "Sigur Rós").is_empty());
    }

    #[test]
    fn artist_dirs_reach_past_a_disc_folder() {
        let root = Path::new("/music");
        let track = Path::new("/music/Zeppelin/Physical Graffiti/CD1/01.flac");
        assert_eq!(
            artist_search_dirs(track, root, "Zeppelin"),
            vec![PathBuf::from("/music/Zeppelin")]
        );
    }

    #[test]
    fn artist_dirs_ignore_unknown_names() {
        let root = Path::new("/music");
        let track = Path::new("/music/_unknown/x/01.flac");
        assert!(artist_search_dirs(track, root, "").is_empty());
    }

    #[test]
    fn pick_in_dir_follows_pattern_order_not_disk_order() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("folder.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("cover.jpg"), b"x").unwrap();
        let patterns = default_patterns("album");
        assert_eq!(
            pick_in_dir(dir.path(), &patterns).unwrap(),
            dir.path().join("cover.jpg")
        );
    }

    #[test]
    fn pick_in_dir_skips_non_images_and_misses_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("front.txt"), b"x").unwrap();
        std::fs::write(dir.path().join("notes.md"), b"x").unwrap();
        assert!(pick_in_dir(dir.path(), &default_patterns("album")).is_none());
    }

    #[test]
    fn store_discovered_names_the_file_from_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        // A PNG misnamed .jpg — exactly what a sloppy tagger leaves behind.
        let src = dir.path().join("cover.jpg");
        std::fs::write(&src, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4]).unwrap();
        let saved = store_discovered(&src, &dir.path().join("out.jpg")).unwrap();
        assert_eq!(saved, dir.path().join("out.png"));
        assert!(saved.exists());
    }

    #[test]
    fn store_discovered_rejects_a_file_that_is_not_an_image() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("cover.jpg");
        std::fs::write(&src, b"this is not an image at all").unwrap();
        assert!(store_discovered(&src, &dir.path().join("out.jpg")).is_err());
    }

    // ── End-to-end, against a real library ──────────────────────
    //
    // The helpers above are pure; these exercise the two SQL queries that feed
    // them (`get_album_track_locations` / `get_artist_track_locations`), which
    // is where the collection root and the multi-directory album come from.

    const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];

    /// `Björk/Post/` (art in the album folder) and
    /// `Zeppelin/Physical Graffiti/CD{1,2}/` (art one level up, at the album).
    fn library_with_sidecar_art() -> (tempfile::TempDir, Arc<Database>) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        let post = root.join("Björk").join("Post");
        let graffiti = root.join("Zeppelin").join("Physical Graffiti");
        std::fs::create_dir_all(&post).unwrap();
        std::fs::create_dir_all(graffiti.join("CD1")).unwrap();
        std::fs::create_dir_all(graffiti.join("CD2")).unwrap();

        std::fs::write(post.join("01.flac"), b"x").unwrap();
        std::fs::write(post.join("cover.jpg"), PNG).unwrap();
        std::fs::write(post.join("folder.jpg"), PNG).unwrap();
        std::fs::write(root.join("Björk").join("artist.jpg"), PNG).unwrap();

        std::fs::write(graffiti.join("CD1").join("01.flac"), b"x").unwrap();
        std::fs::write(graffiti.join("CD2").join("01.flac"), b"x").unwrap();
        std::fs::write(graffiti.join("front.png"), PNG).unwrap();

        let db = Arc::new(Database::new_in_memory().unwrap());
        let collection = db
            .add_collection("local", "music", Some(root.to_str().unwrap()), None, None, None, None, None)
            .unwrap();

        let file = |rel: &str, title: &str, artist: &str, album: &str| crate::db::ScannedFileMeta {
            relative_path: rel.to_string(),
            title: title.to_string(),
            artist: Some(artist.to_string()),
            album: Some(album.to_string()),
            year: None,
            track_number: None,
            duration_secs: None,
            format: Some("flac".to_string()),
            file_size: None,
            modified_at: None,
            tag_names: Vec::new(),
            extra_tags: None,
            write_extra_tags: false,
        };
        db.ingest_scanned_files(
            &[
                file("Björk/Post/01.flac", "Army of Me", "Björk", "Post"),
                file("Zeppelin/Physical Graffiti/CD1/01.flac", "Custard Pie", "Zeppelin", "Physical Graffiti"),
                file("Zeppelin/Physical Graffiti/CD2/01.flac", "In the Light", "Zeppelin", "Physical Graffiti"),
            ],
            Some(collection.id),
        )
        .unwrap();

        (tmp, db)
    }

    #[test]
    fn finds_album_art_in_the_track_folder_by_pattern_order() {
        let (tmp, db) = library_with_sidecar_art();
        let provider = FolderImageProvider::new(db);
        // Both cover.jpg and folder.jpg are present; cover.* is earlier.
        assert_eq!(
            provider.find_album_image("Post", Some("Björk")).unwrap(),
            tmp.path().join("Björk").join("Post").join("cover.jpg")
        );
    }

    #[test]
    fn finds_multi_disc_album_art_one_level_up() {
        // The tracks live in CD1/ and CD2/, neither of which holds an image —
        // this is the case the disc-gated walk-up exists for.
        let (tmp, db) = library_with_sidecar_art();
        let provider = FolderImageProvider::new(db);
        assert_eq!(
            provider
                .find_album_image("Physical Graffiti", Some("Zeppelin"))
                .unwrap(),
            tmp.path().join("Zeppelin").join("Physical Graffiti").join("front.png")
        );
    }

    #[test]
    fn finds_artist_art_in_the_artist_folder() {
        let (tmp, db) = library_with_sidecar_art();
        let provider = FolderImageProvider::new(db);
        assert_eq!(
            provider.find_artist_image("Björk").unwrap(),
            tmp.path().join("Björk").join("artist.jpg")
        );
    }

    #[test]
    fn reports_a_miss_rather_than_reaching_for_something_else() {
        let (_tmp, db) = library_with_sidecar_art();
        let provider = FolderImageProvider::new(db);
        // Zeppelin's own folder has no artist image, and the album art one
        // level down must NOT be promoted to stand in for it.
        assert!(provider.find_artist_image("Zeppelin").is_err());
        // An album with no local track at all (a streaming-only row).
        assert!(provider.find_album_image("Kid A", Some("Radiohead")).is_err());
    }

    #[test]
    fn honours_a_user_edited_pattern_list() {
        let (tmp, db) = library_with_sidecar_art();
        // Demote cover.* below folder.*, which is exactly why this list is
        // editable: which of two candidates is "the" cover is the user's call.
        db.plugin_storage_set(
            "__core__",
            ALBUM_PATTERNS_KEY,
            r#"["folder.*","cover.*"]"#,
        )
        .unwrap();
        let provider = FolderImageProvider::new(db);
        assert_eq!(
            provider.find_album_image("Post", Some("Björk")).unwrap(),
            tmp.path().join("Björk").join("Post").join("folder.jpg")
        );
    }
}
