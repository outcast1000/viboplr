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
