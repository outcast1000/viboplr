pub mod embedded;

use std::path::Path;

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
        .user_agent("Viboplr/0.1.0 (https://github.com/viboplr)")
        .build()
        .map_err(|e| e.to_string())
}

pub fn write_image(dest_path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(dest_path, bytes).map_err(|e| format!("Failed to write image: {}", e))
}
