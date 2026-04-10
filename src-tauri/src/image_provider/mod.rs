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

pub fn urlencoded(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                String::from(b as char)
            }
            b' ' => "+".to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

pub fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Viboplr/0.1.0 (https://github.com/viboplr)")
        .build()
        .map_err(|e| e.to_string())
}

pub fn logged_get(client: &reqwest::blocking::Client, url: &str) -> Result<reqwest::blocking::Response, String> {
    let start = std::time::Instant::now();
    let resp = client
        .get(url)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    log::info!("HTTP GET {} -> {} ({:.0}ms)", url, status, start.elapsed().as_secs_f64() * 1000.0);
    Ok(resp)
}

pub fn write_image(dest_path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(dest_path, bytes).map_err(|e| format!("Failed to write image: {}", e))
}
