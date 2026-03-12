pub mod musicbrainz;

use std::path::Path;

pub trait ArtistImageProvider: Send + Sync {
    fn name(&self) -> &str;
    fn fetch_artist_image(&self, artist_name: &str, dest_path: &Path) -> Result<(), String>;
}

pub trait AlbumImageProvider: Send + Sync {
    fn name(&self) -> &str;
    fn fetch_album_image(
        &self,
        title: &str,
        artist_name: Option<&str>,
        dest_path: &Path,
    ) -> Result<(), String>;
}

pub struct ArtistImageFallbackChain {
    providers: Vec<Box<dyn ArtistImageProvider>>,
}

impl ArtistImageFallbackChain {
    pub fn new(providers: Vec<Box<dyn ArtistImageProvider>>) -> Self {
        Self { providers }
    }
}

impl ArtistImageProvider for ArtistImageFallbackChain {
    fn name(&self) -> &str {
        "FallbackChain"
    }

    fn fetch_artist_image(&self, artist_name: &str, dest_path: &Path) -> Result<(), String> {
        let mut last_err = String::from("No artist image providers configured");
        for provider in &self.providers {
            match provider.fetch_artist_image(artist_name, dest_path) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    log::warn!(
                        "Artist image provider '{}' failed for '{}': {}",
                        provider.name(),
                        artist_name,
                        e
                    );
                    last_err = e;
                }
            }
        }
        Err(last_err)
    }
}

pub struct AlbumImageFallbackChain {
    providers: Vec<Box<dyn AlbumImageProvider>>,
}

impl AlbumImageFallbackChain {
    pub fn new(providers: Vec<Box<dyn AlbumImageProvider>>) -> Self {
        Self { providers }
    }
}

impl AlbumImageProvider for AlbumImageFallbackChain {
    fn name(&self) -> &str {
        "FallbackChain"
    }

    fn fetch_album_image(
        &self,
        title: &str,
        artist_name: Option<&str>,
        dest_path: &Path,
    ) -> Result<(), String> {
        let mut last_err = String::from("No album image providers configured");
        for provider in &self.providers {
            match provider.fetch_album_image(title, artist_name, dest_path) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    log::warn!(
                        "Album image provider '{}' failed for '{}': {}",
                        provider.name(),
                        title,
                        e
                    );
                    last_err = e;
                }
            }
        }
        Err(last_err)
    }
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
        .user_agent("FastPlayer/0.1.0 (https://github.com/fastplayer)")
        .build()
        .map_err(|e| e.to_string())
}

pub fn write_image(dest_path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(dest_path, bytes).map_err(|e| format!("Failed to write image: {}", e))
}
