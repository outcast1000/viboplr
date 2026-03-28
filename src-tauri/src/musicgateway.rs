use serde::Deserialize;
use serde_json::Value;
use std::fmt;
use std::io::BufRead;
use std::sync::Mutex;

use crate::models::{TidalAlbumDetail, TidalArtistDetail, TidalSearchResult, TidalSearchTrack};

// Global URL so image providers can access it without AppState
static GLOBAL_URL: Mutex<Option<String>> = Mutex::new(None);

pub fn set_global_url(url: Option<String>) {
    *GLOBAL_URL.lock().unwrap() = url;
}

pub fn get_global_url() -> Option<String> {
    GLOBAL_URL.lock().unwrap().clone()
}

/// Build a TIDAL cover art URL from a cover/picture ID.
pub fn cover_url(cover_id: &str, size: u32) -> String {
    let path = cover_id.replace('-', "/");
    format!(
        "https://resources.tidal.com/images/{}/{}x{}.jpg",
        path, size, size
    )
}

#[derive(Debug)]
pub struct MusicGatewayError(pub String);

impl fmt::Display for MusicGatewayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for MusicGatewayError {}

/// Response from `GET /`
#[derive(Debug, Deserialize)]
pub struct ServerIdentity {
    pub version: String,
    pub bin: Option<String>,
}

pub struct StreamInfo {
    pub url: String,
    pub mime_type: String,
}

impl StreamInfo {
    pub fn extension(&self) -> &'static str {
        match self.mime_type.as_str() {
            "audio/flac" => "flac",
            "audio/mpeg" => "mp3",
            "audio/mp4" | "audio/m4a" | "audio/aac" => "m4a",
            _ => "flac",
        }
    }
}

pub struct DownloadResult {
    pub path: String,
}

pub struct MusicGatewayClient {
    base_url: String,
    client: reqwest::blocking::Client,
}

impl MusicGatewayClient {
    pub fn new(base_url: &str) -> Self {
        let base_url = base_url.trim_end_matches('/').to_string();
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        Self { base_url, client }
    }

    fn fetch_text(&self, url: &str) -> Result<String, MusicGatewayError> {
        let resp = self
            .client
            .get(url)
            .send()
            .map_err(|e| MusicGatewayError(format!("HTTP error: {}", e)))?;
        let status = resp.status();
        let body = resp
            .text()
            .map_err(|e| MusicGatewayError(format!("Failed to read response: {}", e)))?;
        if !status.is_success() {
            return Err(MusicGatewayError(format!(
                "HTTP {}: {}",
                status,
                &body[..body.len().min(200)]
            )));
        }
        Ok(body)
    }

    fn fetch_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T, MusicGatewayError> {
        let body = self.fetch_text(url)?;
        serde_json::from_str(&body)
            .map_err(|e| MusicGatewayError(format!("JSON parse error: {}", e)))
    }

    /// `GET /` — returns version and binary path.
    pub fn ping(&self) -> Result<ServerIdentity, MusicGatewayError> {
        self.fetch_json(&format!("{}/", self.base_url))
    }

    /// `GET /shutdown` — graceful shutdown.
    pub fn shutdown(&self) -> Result<(), MusicGatewayError> {
        // Use a short timeout — the server may close the connection before replying
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        let _ = client
            .get(&format!("{}/shutdown", self.base_url))
            .send();
        Ok(())
    }

    /// `GET /search/?s=query&limit=N&offset=N` — combined search.
    /// Returns `{ tracks, albums, artists }` directly.
    pub fn search(
        &self,
        query: &str,
        limit: u32,
        offset: u32,
    ) -> Result<TidalSearchResult, MusicGatewayError> {
        self.fetch_json(&format!(
            "{}/search/?s={}&limit={}&offset={}",
            self.base_url,
            urlencoding::encode(query),
            limit,
            offset
        ))
    }

    /// `GET /tracks/{id}` — single track metadata.
    pub fn get_track(&self, track_id: &str) -> Result<TidalSearchTrack, MusicGatewayError> {
        self.fetch_json(&format!("{}/tracks/{}", self.base_url, track_id))
    }

    /// `GET /albums/{id}` — album detail with tracks.
    pub fn get_album(&self, album_id: &str) -> Result<TidalAlbumDetail, MusicGatewayError> {
        self.fetch_json(&format!("{}/albums/{}", self.base_url, album_id))
    }

    /// `GET /artists/{id}` — artist detail with discography.
    pub fn get_artist(&self, artist_id: &str) -> Result<TidalArtistDetail, MusicGatewayError> {
        self.fetch_json(&format!("{}/artists/{}", self.base_url, artist_id))
    }

    pub fn get_stream_url(
        &self,
        track_id: &str,
        quality: &str,
    ) -> Result<StreamInfo, MusicGatewayError> {
        let json: Value = self.fetch_json(&format!(
            "{}/tracks/{}/stream-url?quality={}",
            self.base_url, track_id, quality
        ))?;
        let stream_url = json["url"]
            .as_str()
            .ok_or_else(|| MusicGatewayError("No 'url' in response".to_string()))?
            .to_string();
        let mime_type = json["mime_type"]
            .as_str()
            .unwrap_or("audio/flac")
            .to_string();
        Ok(StreamInfo {
            url: stream_url,
            mime_type,
        })
    }

    pub fn download_track<F>(
        &self,
        track_id: &str,
        dest_dir: &str,
        quality: &str,
        mut progress_cb: F,
    ) -> Result<DownloadResult, MusicGatewayError>
    where
        F: FnMut(&str, u8),
    {
        let url = format!(
            "{}/tracks/{}/download?dest={}&quality={}&progress=true",
            self.base_url,
            track_id,
            urlencoding::encode(dest_dir),
            quality
        );

        // Use a longer timeout for downloads (10 minutes)
        let dl_client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| MusicGatewayError(format!("HTTP client error: {}", e)))?;

        let resp = dl_client
            .get(&url)
            .send()
            .map_err(|e| MusicGatewayError(format!("Download request failed: {}", e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(MusicGatewayError(format!(
                "HTTP {}: {}",
                status,
                &body[..body.len().min(200)]
            )));
        }

        // Parse SSE events from the response body
        let reader = std::io::BufReader::new(resp);
        let mut final_path: Option<String> = None;

        for line in reader.lines() {
            let line = line.map_err(|e| MusicGatewayError(format!("Read error: {}", e)))?;

            let data = match line.strip_prefix("data: ") {
                Some(d) => d,
                None => continue,
            };

            let event: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let stage = event["stage"].as_str().unwrap_or("");
            match stage {
                "downloading" => {
                    let pct = event["percent"].as_u64().unwrap_or(0) as u8;
                    progress_cb("downloading", pct);
                }
                "tagging" => {
                    progress_cb("tagging", 100);
                }
                "done" => {
                    if let Some(path) = event["path"].as_str() {
                        final_path = Some(path.to_string());
                    }
                }
                "error" => {
                    let msg = event["message"]
                        .as_str()
                        .unwrap_or("Unknown error from MusicGateAway");
                    return Err(MusicGatewayError(msg.to_string()));
                }
                _ => {}
            }
        }

        match final_path {
            Some(path) => Ok(DownloadResult { path }),
            None => Err(MusicGatewayError(
                "Download stream ended without completion event".to_string(),
            )),
        }
    }
}
