//! `core:server` — an album's cover from the Subsonic/Navidrome server it
//! lives on (`getCoverArt`). Without it a server library got its art only from
//! the online providers: one album at a time behind the courtesy delay, hours
//! to fill a large library, and nothing at all for an album no catalog knows —
//! while the server had the art all along.
//!
//! Three things make it safe to put ahead of the online providers:
//!
//! - **A placeholder is not a cover.** Navidrome answers an album without art
//!   with HTTP 200 and its stock image, and storing that would end the chain
//!   before a provider that does have the cover is asked. It is recognised by
//!   `Cache-Control: no-store` (Navidrome since its 2026 artwork pipeline) and,
//!   for older servers, by the bytes of every placeholder Navidrome has
//!   bundled — placeholders are served as-is, never resized, so the hash holds
//!   whatever `size` was asked for.
//! - **A dead server must not stall the image worker.** The worker is one
//!   serial thread; a self-hoster away from home would otherwise make every
//!   queued album wait out a timeout, for hours. Short timeouts, and after a
//!   connection failure the collection is skipped for `OFFLINE_BACKOFF`.
//! - **The URL carries the credentials** (`auth_params`), so nothing here logs
//!   it — only the collection id, status and content type.
//!
//! The song id stands in for the cover-art id: Navidrome resolves a media-file
//! id to that file's (or its album's) art. A server that doesn't answers with
//! an error, and the chain moves on to the next provider.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::{write_image, AlbumImageProvider};
use crate::db::Database;
use crate::subsonic::SubsonicClient;

/// Long edge, px, the server is asked to resize to: big enough for the
/// fullscreen and hero surfaces, small enough not to store a 5 MB original.
const COVER_SIZE: u32 = 1200;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a collection that couldn't be reached is skipped.
const OFFLINE_BACKOFF: Duration = Duration::from_secs(5 * 60);

/// sha256 of each album placeholder Navidrome has shipped: `placeholder.png`
/// (before and after the 2022 image optimisation) and `album-placeholder.webp`
/// (2024-12, and its 2025-03 replacement, still current).
const NAVIDROME_PLACEHOLDERS: &[&str] = &[
    "292b20b877469b8030a08d1a262e84280a2b3334b9a254fba2fa3dd5600fd74c",
    "6ee8f3c379050e52f8c5cdf7eb215f6d14c38cc7c4d8c59000d619d7a6a07888",
    "b502979c464ab7a61f79bfd820e23b8dc3eeb36034b0722f7588972fd9fa7392",
    "273a4dbd61dfbb0a12d5d8ffe780eb7a3d4d000bc9771c5411cc70ae4dfa8a1f",
];

/// What a `getCoverArt` response is: the extension to store a cover under, or
/// why it isn't one.
pub(crate) fn classify_cover_response(
    status: u16,
    content_type: Option<&str>,
    cache_control: Option<&str>,
    body: &[u8],
) -> Result<&'static str, String> {
    if !(200..300).contains(&status) {
        return Err(format!("server answered HTTP {}", status));
    }
    let mime = content_type
        .and_then(|c| c.split(';').next())
        .map(|c| c.trim().to_ascii_lowercase())
        .unwrap_or_default();
    // Subsonic errors (Navidrome's "Artwork not found", error 70) come back as
    // HTTP 200 with a JSON or XML body.
    let ext = match mime.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "" => return Err("server sent no content type".into()),
        other if other.starts_with("image/") => "jpg",
        other => return Err(format!("server has no cover for it ({})", other)),
    };
    if body.is_empty() {
        return Err("server sent an empty image".into());
    }
    if cache_control.is_some_and(|c| c.to_ascii_lowercase().contains("no-store")) {
        return Err("server has no cover for it (placeholder)".into());
    }
    let hash = format!("{:x}", Sha256::digest(body));
    if NAVIDROME_PLACEHOLDERS.contains(&hash.as_str()) {
        return Err("server has no cover for it (placeholder)".into());
    }
    Ok(ext)
}

pub struct ServerArtProvider {
    db: Arc<Database>,
    /// Collection id → when it may be tried again after failing to connect.
    offline_until: Mutex<HashMap<i64, Instant>>,
}

impl ServerArtProvider {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db, offline_until: Mutex::new(HashMap::new()) }
    }

    fn is_backing_off(&self, collection_id: i64) -> bool {
        let mut map = self.offline_until.lock().unwrap();
        match map.get(&collection_id) {
            Some(until) if Instant::now() < *until => true,
            Some(_) => {
                map.remove(&collection_id);
                false
            }
            None => false,
        }
    }
}

impl AlbumImageProvider for ServerArtProvider {
    fn name(&self) -> &str {
        "ServerArtwork"
    }

    fn fetch_album_image(
        &self,
        album_title: &str,
        artist_name: Option<&str>,
        dest_path: &Path,
    ) -> Result<String, String> {
        let (collection_id, song_id) = self
            .db
            .get_server_track_for_album(album_title, artist_name)
            .map_err(|e| format!("DB lookup failed: {}", e))?
            .ok_or("No server track for this album")?;
        if self.is_backing_off(collection_id) {
            return Err(format!("server collection {} unreachable, skipping for now", collection_id));
        }
        let creds = self
            .db
            .get_collection_credentials(collection_id)
            .map_err(|e| format!("Failed to get collection credentials: {}", e))?;
        let client = SubsonicClient::from_stored(
            &creds.url,
            &creds.username,
            &creds.password_token,
            creds.salt.as_deref(),
            &creds.auth_method,
        );
        let http = reqwest::blocking::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;

        let start = Instant::now();
        let resp = match http.get(client.cover_art_url(&song_id, COVER_SIZE)).send() {
            Ok(r) => r,
            Err(e) => {
                if e.is_connect() || e.is_timeout() {
                    self.offline_until
                        .lock()
                        .unwrap()
                        .insert(collection_id, Instant::now() + OFFLINE_BACKOFF);
                }
                // `without_url`: reqwest's error text includes the URL, which
                // carries the credentials.
                return Err(format!("server unreachable: {}", e.without_url()));
            }
        };
        let status = resp.status().as_u16();
        let header = |name: reqwest::header::HeaderName| {
            resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
        };
        let content_type = header(reqwest::header::CONTENT_TYPE);
        let cache_control = header(reqwest::header::CACHE_CONTROL);
        let body = resp.bytes().map_err(|e| format!("Failed to read cover: {}", e.without_url()))?;
        log::info!(
            "HTTP GET subsonic/getCoverArt (collection {}) -> {} {} ({:.0}ms)",
            collection_id,
            status,
            content_type.as_deref().unwrap_or("-"),
            start.elapsed().as_secs_f64() * 1000.0
        );

        let ext = classify_cover_response(status, content_type.as_deref(), cache_control.as_deref(), &body)?;
        write_image(&dest_path.with_extension(ext), &body)?;
        Ok(self.name().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::classify_cover_response;

    #[test]
    fn test_a_real_cover_is_kept_under_its_type() {
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];
        assert_eq!(classify_cover_response(200, Some("image/jpeg"), Some("public, no-cache"), &jpeg), Ok("jpg"));
        assert_eq!(classify_cover_response(200, Some("image/png; charset=binary"), None, &jpeg), Ok("png"));
        assert_eq!(classify_cover_response(200, Some("IMAGE/WEBP"), None, &jpeg), Ok("webp"));
    }

    #[test]
    fn test_a_subsonic_error_is_not_a_cover() {
        // Navidrome's "Artwork not found" (error 70): HTTP 200, JSON body.
        let body = br#"{"subsonic-response":{"status":"failed","error":{"code":70}}}"#;
        assert!(classify_cover_response(200, Some("application/json"), None, body).is_err());
        assert!(classify_cover_response(200, Some("text/xml"), None, b"<error/>").is_err());
        assert!(classify_cover_response(404, Some("image/jpeg"), None, b"x").is_err());
        assert!(classify_cover_response(200, None, None, b"x").is_err());
        assert!(classify_cover_response(200, Some("image/jpeg"), None, b"").is_err());
    }

    #[test]
    fn test_a_placeholder_is_not_a_cover() {
        // Current Navidrome marks it uncacheable.
        assert!(classify_cover_response(200, Some("image/webp"), Some("no-store"), b"anything").is_err());
        // Older Navidrome sends no such header and is recognised by its bytes
        // (`NAVIDROME_PLACEHOLDERS`); a cover that isn't one of them passes.
        assert!(classify_cover_response(200, Some("image/webp"), Some("public, max-age=315360000"), b"cover").is_ok());
    }
}
