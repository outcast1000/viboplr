pub mod embedded;
pub mod folder;

use std::path::Path;

/// Sidecar image in the media folder (`cover.jpg` and friends).
pub const CORE_FOLDER: &str = "core:folder";
/// Artwork embedded in the audio file's tags.
pub const CORE_EMBEDDED: &str = "core:embedded";

/// The built-in image providers, seeded into `image_providers` as ordinary rows
/// so they sit in the same user-orderable chain as plugin providers — see the
/// `is_core_provider` note below for why they need a reserved id prefix.
///
/// Priorities are deliberately below the 100-step scale the Settings UI writes
/// (`(index + 1) * 100`), so seeding into an existing profile lands these ahead
/// of every plugin row instead of colliding with one. Folder art leads because
/// it is the higher-resolution, easier-to-fix copy and is what the folder-art
/// conventions assume; embedded follows, which is where it effectively sat
/// before it became reorderable at all.
pub const CORE_IMAGE_PROVIDERS: &[(&str, &str, i64)] = &[
    (CORE_FOLDER, "album", 10),
    (CORE_FOLDER, "artist", 10),
    (CORE_EMBEDDED, "album", 20),
];

/// Is this provider id one of the built-ins?
///
/// The `core:` prefix is load-bearing in three places that all walk the
/// `image_providers` table by `plugin_id`: `sync_image_providers` must not
/// deactivate or delete these rows when reconciling against the installed
/// plugin list, the Settings UI must not filter them out for having no
/// manifest, and the resolver must run them natively instead of asking the
/// plugin bridge for a plugin that doesn't exist. A plugin id can never collide
/// with it — plugin ids come from manifests and `:` is not a legal character.
pub fn is_core_provider(plugin_id: &str) -> bool {
    plugin_id.starts_with("core:")
}

/// Is this album title a stand-in for "no album tag" rather than a name?
///
/// Navidrome files untagged tracks under `[Unknown Album]`, one per artist, and
/// other servers and taggers use similar spellings. Searching a catalog for one
/// returns somebody else's record: before the providers checked the artist, one
/// stock photo became the cover of 216 of them. Matched loosely (case, brackets
/// and punctuation ignored) but only on the "unknown" family, because short or
/// generic titles ("Untitled", "Album") are real albums.
pub fn is_placeholder_album_title(title: &str) -> bool {
    matches!(fold_placeholder(title).as_str(), "" | "unknown" | "unknownalbum" | "noalbum")
}

/// Is this artist name a stand-in for "no artist tag" (`[Unknown Artist]`)?
/// Same reasoning and matching as [`is_placeholder_album_title`]. "Various
/// Artists" is deliberately not one: it is a real album owner.
pub fn is_placeholder_artist_name(name: &str) -> bool {
    matches!(fold_placeholder(name).as_str(), "" | "unknown" | "unknownartist" | "noartist")
}

fn fold_placeholder(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

pub trait AlbumImageProvider: Send + Sync {
    fn name(&self) -> &str;
    /// Returns the provider name that succeeded on Ok.
    fn fetch_album_image(
        &self,
        title: &str,
        artist_name: Option<&str>,
        dest_path: &Path,
    ) -> Result<String, String>;
}

pub fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")
        .build()
        .map_err(|e| e.to_string())
}

pub fn write_image(dest_path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(dest_path, bytes).map_err(|e| format!("Failed to write image: {}", e))
}

#[cfg(test)]
mod tests {
    use super::{is_placeholder_album_title, is_placeholder_artist_name};

    #[test]
    fn test_placeholder_album_titles_are_recognised() {
        for title in ["[Unknown Album]", "Unknown Album", "unknown", "<Unknown>", "[unknown]", "No Album", "", "  "] {
            assert!(is_placeholder_album_title(title), "{title:?} should be a placeholder");
        }
    }

    #[test]
    fn test_real_album_titles_are_not_placeholders() {
        for title in ["Untitled", "Album", "Unknown Pleasures", "The Unknown", "Blackstar"] {
            assert!(!is_placeholder_album_title(title), "{title:?} is a real title");
        }
    }

    #[test]
    fn test_placeholder_artist_names_are_recognised() {
        for name in ["[Unknown Artist]", "Unknown Artist", "Unknown", "<unknown>", "No Artist", ""] {
            assert!(is_placeholder_artist_name(name), "{name:?} should be a placeholder");
        }
        for name in ["Various Artists", "The Unknown", "Unknown Mortal Orchestra", "Artist"] {
            assert!(!is_placeholder_artist_name(name), "{name:?} is a real name");
        }
    }
}
