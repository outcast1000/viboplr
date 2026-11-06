use std::path::{Path, PathBuf};
use deunicode::deunicode;
use unicode_normalization::UnicodeNormalization;

/// Extensions a stored entity image can carry. This list is the *reader* side
/// of every write path, so it must cover everything a writer can produce or the
/// image silently disappears: `set_entity_image` names the file from the picked
/// source's extension and the pickers accept webp, while `sniff_image_ext`
/// names downloaded and folder-discovered files from their bytes and can return
/// gif. Keep it a superset of both.
static EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];

static RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn strip_diacritics(s: &str) -> String {
    s.nfd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect()
}

/// Convert a string into a canonical, filesystem-safe ASCII slug.
pub fn canonical_slug(s: &str) -> String {
    let s = strip_diacritics(s);
    let s = deunicode(&s);
    let s = s.to_lowercase();
    let s: String = s.chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let s: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = s.trim_matches('.').to_string();
    let upper = s.to_uppercase();
    let s = if RESERVED_NAMES.contains(&upper.as_str()) {
        format!("_{}", s)
    } else {
        s
    };
    // Truncate to 200 bytes on a char boundary
    let s = if s.len() > 200 {
        let mut end = 200;
        while !s.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        s[..end].trim_end().to_string()
    } else {
        s
    };
    if s.is_empty() { "_unknown".to_string() } else { s }
}

/// Compute the filename slug for an entity image.
/// - artist/tag: `canonical_slug(name)`
/// - album: `{canonical_slug(artist)} - {canonical_slug(title)}`
pub fn entity_image_slug(kind: &str, name: &str, artist_name: Option<&str>) -> String {
    match kind {
        "album" => {
            let artist_slug = canonical_slug(artist_name.unwrap_or(""));
            let album_slug = canonical_slug(name);
            if artist_slug == "_unknown" {
                album_slug
            } else {
                format!("{} - {}", artist_slug, album_slug)
            }
        }
        _ => canonical_slug(name),
    }
}

pub fn image_dir(app_dir: &Path, kind: &str) -> PathBuf {
    app_dir.join(format!("{}_images", kind))
}

pub fn get_image_path(app_dir: &Path, kind: &str, slug: &str) -> Option<PathBuf> {
    let dir = image_dir(app_dir, kind);
    for ext in EXTENSIONS {
        let path = dir.join(format!("{}.{}", slug, ext));
        if !path.exists() {
            continue;
        }
        if is_bogus_image_file(&path) {
            // Written before downloads were content-checked (`ensure_image_bytes`):
            // archive.org answered some Cover Art Archive requests with an HTML
            // page, cached as `<slug>.jpg`. Served, it drew a broken image and —
            // being a "hit" — kept the artist fallback and the provider chain
            // from ever being asked. Drop it so every caller sees a miss and the
            // image worker resolves the entity again.
            log::warn!("Removing cached {} image that is not an image: {}", kind, path.display());
            if let Err(e) = std::fs::remove_file(&path) {
                log::error!("Failed to remove bogus image {}: {}", path.display(), e);
            }
            continue;
        }
        return Some(path);
    }
    None
}

/// True for a cached image file that is clearly not an image: empty, or text
/// that opens with markup or JSON (an HTML error page, an API error body).
/// Deliberately narrow — anything else is left alone, so a real image in a
/// format `sniff_image_ext` doesn't know is never deleted.
fn is_bogus_image_file(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 64];
    let n = match std::fs::File::open(path).and_then(|mut f| f.read(&mut head)) {
        Ok(n) => n,
        Err(e) => {
            log::error!("Failed to read image {}: {}", path.display(), e);
            return false;
        }
    };
    is_bogus_image_bytes(&head[..n])
}

fn is_bogus_image_bytes(head: &[u8]) -> bool {
    match head.iter().position(|b| !b.is_ascii_whitespace()) {
        None => true,
        Some(i) => matches!(head[i], b'<' | b'{'),
    }
}

pub fn remove_image(app_dir: &Path, kind: &str, slug: &str) {
    let dir = image_dir(app_dir, kind);
    for ext in EXTENSIONS {
        let _ = std::fs::remove_file(dir.join(format!("{}.{}", slug, ext)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bogus_image_bytes_are_recognised() {
        assert!(is_bogus_image_bytes(b""));
        assert!(is_bogus_image_bytes(b"   \n"));
        assert!(is_bogus_image_bytes(b"<!doctype html>\n<html lang=\"en\">"));
        assert!(is_bogus_image_bytes(b"\n  <?xml version=\"1.0\"?>"));
        assert!(is_bogus_image_bytes(b"{\"error\":\"not found\"}"));
        assert!(!is_bogus_image_bytes(&[0xFF, 0xD8, 0xFF, 0xE0]));
        assert!(!is_bogus_image_bytes(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]));
        assert!(!is_bogus_image_bytes(b"GIF89a"));
        assert!(!is_bogus_image_bytes(b"RIFF\0\0\0\0WEBP"));
        // An image format the sniffer doesn't know is left alone.
        assert!(!is_bogus_image_bytes(b"\0\0\0\x1cftypavif"));
    }

    #[test]
    fn test_get_image_path_drops_a_cached_html_page() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = image_dir(tmp.path(), "album");
        std::fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("a - b.jpg");
        std::fs::write(&bad, b"<!doctype html>\n<html><title>archive.org</title>").unwrap();
        assert_eq!(get_image_path(tmp.path(), "album", "a - b"), None);
        assert!(!bad.exists(), "the HTML page should be removed from the cache");

        // A real image behind it (another extension) is still found.
        std::fs::write(&bad, b"<html>").unwrap();
        let good = dir.join("a - b.png");
        std::fs::write(&good, [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]).unwrap();
        assert_eq!(get_image_path(tmp.path(), "album", "a - b"), Some(good));
    }

    #[test]
    fn test_canonical_slug_basic() {
        assert_eq!(canonical_slug("Björk"), "bjork");
        assert_eq!(canonical_slug("Sigur Rós"), "sigur ros");
        assert_eq!(canonical_slug("café"), "cafe");
        assert_eq!(canonical_slug("hello"), "hello");
    }

    #[test]
    fn test_canonical_slug_greek_cyrillic() {
        // Greek must transliterate to ASCII
        assert_eq!(canonical_slug("Ελληνικά"), "ellenika");
        // Cyrillic must transliterate to ASCII
        assert_eq!(canonical_slug("Москва"), "moskva");
    }

    #[test]
    fn test_canonical_slug_non_latin_transliteration() {
        // Japanese
        assert_eq!(canonical_slug("東京"), "dong jing");
        // Korean
        assert_eq!(canonical_slug("서울"), "seoul");
        // Mixed: Latin + Greek
        assert_eq!(canonical_slug("The Ελληνικά Band"), "the ellenika band");
    }

    #[test]
    fn test_canonical_slug_unsafe_chars() {
        assert_eq!(canonical_slug("AC/DC"), "acdc");
        assert_eq!(canonical_slug("What?"), "what");
        assert_eq!(canonical_slug("file:name"), "filename");
        assert_eq!(canonical_slug("a * b"), "a b");
    }

    #[test]
    fn test_canonical_slug_whitespace() {
        assert_eq!(canonical_slug("  multiple   spaces  "), "multiple spaces");
        assert_eq!(canonical_slug("\ttabs\t"), "tabs");
    }

    #[test]
    fn test_canonical_slug_dots() {
        assert_eq!(canonical_slug("...hidden"), "hidden");
        assert_eq!(canonical_slug("file..."), "file");
        assert_eq!(canonical_slug("mid.dle"), "mid.dle");
    }

    #[test]
    fn test_canonical_slug_reserved() {
        assert_eq!(canonical_slug("CON"), "_con");
        assert_eq!(canonical_slug("NUL"), "_nul");
        assert_eq!(canonical_slug("com1"), "_com1");
    }

    #[test]
    fn test_canonical_slug_empty() {
        assert_eq!(canonical_slug(""), "_unknown");
        assert_eq!(canonical_slug("..."), "_unknown");
        assert_eq!(canonical_slug("///"), "_unknown");
    }

    #[test]
    fn test_canonical_slug_truncation() {
        let long = "a".repeat(300);
        let slug = canonical_slug(&long);
        assert!(slug.len() <= 200);
        assert_eq!(slug, "a".repeat(200));
    }

    #[test]
    fn test_canonical_slug_truncation_after_transliteration() {
        // After transliteration, "б" becomes "b" (1 byte each)
        let long = "б".repeat(300);
        let slug = canonical_slug(&long);
        assert!(slug.len() <= 200);
        assert_eq!(slug, "b".repeat(200));
    }

    #[test]
    fn test_entity_image_slug_artist() {
        assert_eq!(entity_image_slug("artist", "Björk", None), "bjork");
    }

    #[test]
    fn test_entity_image_slug_album() {
        assert_eq!(
            entity_image_slug("album", "Post", Some("Björk")),
            "bjork - post"
        );
    }

    #[test]
    fn test_entity_image_slug_album_no_artist() {
        assert_eq!(entity_image_slug("album", "Post", None), "post");
        assert_eq!(entity_image_slug("album", "Post", Some("")), "post");
    }

    #[test]
    fn test_entity_image_slug_tag() {
        assert_eq!(entity_image_slug("tag", "Electronic", None), "electronic");
    }
}
