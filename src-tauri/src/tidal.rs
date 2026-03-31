use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::Value;
use std::fmt;
use std::sync::Mutex;
use std::time::Instant;

use crate::models::{
    TidalAlbumDetail, TidalArtistDetail, TidalSearchAlbum, TidalSearchArtist, TidalSearchResult,
    TidalSearchTrack,
};

// --- Global access for image providers (which lack AppState) ---

static GLOBAL_TIDAL: Mutex<Option<std::sync::Arc<TidalClient>>> = Mutex::new(None);

pub fn set_global_client(client: std::sync::Arc<TidalClient>) {
    *GLOBAL_TIDAL.lock().unwrap() = Some(client);
}

pub fn get_global_client() -> Option<std::sync::Arc<TidalClient>> {
    GLOBAL_TIDAL.lock().unwrap().clone()
}

// --- Cover URL helper ---

/// Build a TIDAL cover art URL from a cover/picture ID.
pub fn cover_url(cover_id: &str, size: u32) -> String {
    let path = cover_id.replace('-', "/");
    format!(
        "https://resources.tidal.com/images/{}/{}x{}.jpg",
        path, size, size
    )
}

// --- Error type ---

#[derive(Debug)]
pub struct TidalError(pub String);

impl fmt::Display for TidalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for TidalError {}

// --- Stream info ---

#[derive(Debug, Clone, Serialize)]
pub struct TidalStreamInfo {
    pub url: String,
    pub mime_type: Option<String>,
}

impl TidalStreamInfo {
    pub fn extension(&self) -> &'static str {
        match self.mime_type.as_deref() {
            Some("audio/flac") => "flac",
            Some("audio/mpeg") => "mp3",
            Some("audio/mp4") | Some("audio/m4a") | Some("audio/aac") => "m4a",
            _ => "flac",
        }
    }
}

// --- Instance failover cache ---

const UPTIME_URLS: &[&str] = &[
    "https://tidal-uptime.jiffy-puffs-1j.workers.dev/",
    "https://tidal-uptime.props-76styles.workers.dev/",
];
const CACHE_TTL_SECS: u64 = 86_400;

struct InstanceCache {
    api_urls: Vec<String>,
    streaming_urls: Vec<String>,
    fetched_at: Instant,
}

static INSTANCE_CACHE: Mutex<Option<InstanceCache>> = Mutex::new(None);

fn fetch_instance_list(client: &reqwest::blocking::Client) -> Option<InstanceCache> {
    for uptime_url in UPTIME_URLS {
        let resp = client
            .get(*uptime_url)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .ok()?;
        if !resp.status().is_success() {
            continue;
        }
        let json: Value = resp.json().ok()?;

        let parse_urls = |key: &str| -> Vec<String> {
            json[key]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            item["url"]
                                .as_str()
                                .map(|u| u.trim_end_matches('/').to_string())
                        })
                        .collect()
                })
                .unwrap_or_default()
        };

        let api_urls = parse_urls("api");
        let streaming_urls = parse_urls("streaming");

        if !api_urls.is_empty() || !streaming_urls.is_empty() {
            return Some(InstanceCache {
                api_urls,
                streaming_urls,
                fetched_at: Instant::now(),
            });
        }
    }
    None
}

fn get_fallback_urls(
    client: &reqwest::blocking::Client,
    path: &str,
    exclude: &str,
) -> Vec<String> {
    let mut cache = INSTANCE_CACHE.lock().unwrap_or_else(|e| e.into_inner());

    let needs_refresh = match &*cache {
        Some(c) => c.fetched_at.elapsed().as_secs() > CACHE_TTL_SECS,
        None => true,
    };

    if needs_refresh {
        if let Some(new_cache) = fetch_instance_list(client) {
            *cache = Some(new_cache);
        }
    }

    let is_streaming = path.starts_with("/track") || path.starts_with("/video");

    match &*cache {
        Some(c) => {
            let urls = if is_streaming {
                &c.streaming_urls
            } else {
                &c.api_urls
            };
            urls.iter()
                .filter(|u| u.as_str() != exclude)
                .cloned()
                .collect()
        }
        None => Vec::new(),
    }
}

fn invalidate_instance_cache() {
    let mut cache = INSTANCE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *cache = None;
}

// --- TidalClient ---

pub struct TidalClient {
    override_url: Option<String>,
    client: reqwest::blocking::Client,
}

impl TidalClient {
    pub fn new(url: Option<&str>) -> Self {
        let override_url = url
            .filter(|u| !u.is_empty())
            .map(|u| u.trim_end_matches('/').to_string());
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        Self {
            override_url,
            client,
        }
    }

    fn fetch_json(&self, url: &str) -> Result<Value, TidalError> {
        let resp = self
            .client
            .get(url)
            .send()
            .map_err(|e| TidalError(format!("HTTP error: {}", e)))?;
        let status = resp.status();
        let body = resp
            .text()
            .map_err(|e| TidalError(format!("Failed to read response: {}", e)))?;

        if !status.is_success() {
            return Err(TidalError(format!(
                "HTTP {}: {}",
                status,
                &body[..body.len().min(200)]
            )));
        }

        serde_json::from_str(&body).map_err(|e| {
            TidalError(format!(
                "JSON parse error: {} — body starts with: {}",
                e,
                &body[..body.len().min(200)]
            ))
        })
    }

    fn get_json(&self, path: &str) -> Result<Value, TidalError> {
        // If user set an override URL, try it first
        if let Some(ref base) = self.override_url {
            let url = format!("{}{}", base, path);
            match self.fetch_json(&url) {
                Ok(json) => return Ok(json),
                Err(e) => {
                    log::warn!(
                        "TIDAL: override instance {} failed ({}), trying auto-discovery",
                        base,
                        e
                    );
                }
            }
        }

        // Try instances from the uptime API
        let exclude = self.override_url.as_deref().unwrap_or("");
        let instances = get_fallback_urls(&self.client, path, exclude);
        if instances.is_empty() && self.override_url.is_none() {
            return Err(TidalError(
                "No TIDAL instances available (uptime API unreachable and no override URL set)"
                    .to_string(),
            ));
        }

        let mut last_err = None;
        for instance in &instances {
            let url = format!("{}{}", instance, path);
            match self.fetch_json(&url) {
                Ok(json) => return Ok(json),
                Err(e) => {
                    last_err = Some(e);
                }
            }
        }

        // All instances failed — invalidate cache so next request re-fetches
        invalidate_instance_cache();
        Err(last_err
            .unwrap_or_else(|| TidalError("All TIDAL instances failed".to_string())))
    }

    /// Combined search: tracks + albums + artists.
    /// The API uses different query params per type: s= for tracks, a= for artists, al= for albums.
    /// We fire all three in parallel to keep latency low.
    pub fn search(
        &self,
        query: &str,
        limit: u32,
        offset: u32,
    ) -> Result<TidalSearchResult, TidalError> {
        let encoded = urlencoding::encode(query);
        let track_path = format!("/search/?s={}&limit={}&offset={}", encoded, limit, offset);
        let artist_path = format!("/search/?a={}&limit={}&offset={}", encoded, limit, offset);
        let album_path = format!("/search/?al={}&limit={}&offset={}", encoded, limit, offset);

        let (tracks, artists, albums) = std::thread::scope(|s| {
            let t_handle = s.spawn(|| self.get_json(&track_path));
            let a_handle = s.spawn(|| self.get_json(&artist_path));
            let al_handle = s.spawn(|| self.get_json(&album_path));

            let tracks = t_handle
                .join()
                .ok()
                .and_then(|r| r.ok())
                .and_then(|json| {
                    json["data"]["items"]
                        .as_array()
                        .map(|arr| arr.iter().map(|t| parse_track(t)).collect())
                })
                .unwrap_or_default();

            let artists = a_handle
                .join()
                .ok()
                .and_then(|r| r.ok())
                .and_then(|json| {
                    json["data"]["artists"]["items"]
                        .as_array()
                        .map(|arr| arr.iter().map(|a| parse_artist(a)).collect())
                })
                .unwrap_or_default();

            let albums = al_handle
                .join()
                .ok()
                .and_then(|r| r.ok())
                .and_then(|json| {
                    json["data"]["albums"]["items"]
                        .as_array()
                        .map(|arr| arr.iter().map(|a| parse_album(a)).collect())
                })
                .unwrap_or_default();

            (tracks, artists, albums)
        });

        Ok(TidalSearchResult {
            tracks,
            albums,
            artists,
        })
    }

    /// Get single track metadata.
    pub fn get_track_info(&self, id: &str) -> Result<TidalSearchTrack, TidalError> {
        let json = self.get_json(&format!("/info/?id={}", id))?;
        Ok(parse_track(&json["data"]))
    }

    /// Get stream URL for a track (decodes BTS manifest).
    pub fn get_stream_url(&self, id: &str, quality: &str) -> Result<TidalStreamInfo, TidalError> {
        let json = self.get_json(&format!("/track/?id={}&quality={}", id, quality))?;
        let data = &json["data"];

        let manifest_b64 = data["manifest"]
            .as_str()
            .ok_or_else(|| TidalError("No manifest in response".to_string()))?;

        let manifest_type = data["manifestMimeType"]
            .as_str()
            .unwrap_or("application/vnd.tidal.bts");

        if manifest_type == "application/vnd.tidal.bts" {
            let decoded = STANDARD
                .decode(manifest_b64)
                .map_err(|e| TidalError(format!("Base64 decode error: {}", e)))?;
            let manifest_json: Value = serde_json::from_slice(&decoded)
                .map_err(|e| TidalError(format!("Manifest JSON error: {}", e)))?;
            let url = manifest_json["urls"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|u| u.as_str())
                .ok_or_else(|| TidalError("No URLs in manifest".to_string()))?;
            let mime_type = manifest_json["mimeType"].as_str().map(|s| s.to_string());
            Ok(TidalStreamInfo {
                url: url.to_string(),
                mime_type,
            })
        } else {
            Err(TidalError(format!(
                "Unsupported manifest type: {}. Only BTS manifests are supported.",
                manifest_type
            )))
        }
    }

    /// Get album detail with full track listing.
    pub fn get_album(&self, id: &str) -> Result<TidalAlbumDetail, TidalError> {
        let json = self.get_json(&format!("/album/?id={}", id))?;
        let data = &json["data"];
        let album_data = if data["album"].is_object() {
            &data["album"]
        } else {
            data
        };

        let tracks = data["items"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let t = &item["item"];
                        if t.is_null() {
                            None
                        } else {
                            Some(parse_track(t))
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(TidalAlbumDetail {
            tidal_id: album_data["id"]
                .as_i64()
                .map(|n| n.to_string())
                .unwrap_or_default(),
            title: album_data["title"]
                .as_str()
                .unwrap_or("Unknown")
                .to_string(),
            artist_name: album_data["artists"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|a| a["name"].as_str())
                .map(|s| s.to_string()),
            cover_id: album_data["cover"].as_str().map(|s| s.to_string()),
            year: album_data["releaseDate"]
                .as_str()
                .and_then(|d| d.split('-').next())
                .and_then(|y| y.parse().ok()),
            tracks,
        })
    }

    /// Get artist detail with album discography.
    pub fn get_artist(&self, id: &str) -> Result<TidalArtistDetail, TidalError> {
        let json = self.get_json(&format!("/artist/?id={}", id))?;
        let artist_data = if json["artist"].is_object() {
            &json["artist"]
        } else {
            &json["data"]
        };

        let albums = self.get_artist_albums(id).unwrap_or_default();

        Ok(TidalArtistDetail {
            tidal_id: artist_data["id"]
                .as_i64()
                .map(|n| n.to_string())
                .unwrap_or_default(),
            name: artist_data["name"]
                .as_str()
                .unwrap_or("Unknown")
                .to_string(),
            picture_id: artist_data["picture"].as_str().map(|s| s.to_string()),
            albums,
        })
    }

    /// Get an artist's album discography.
    pub fn get_artist_albums(&self, id: &str) -> Result<Vec<TidalSearchAlbum>, TidalError> {
        let json = self.get_json(&format!("/artist/?f={}&skip_tracks=true", id))?;
        let items = json["albums"]["items"]
            .as_array()
            .or_else(|| json["data"]["albums"].as_array());
        Ok(items
            .map(|arr| arr.iter().map(|a| parse_album(a)).collect())
            .unwrap_or_default())
    }

    /// Check whether TIDAL instances are reachable.
    pub fn check_status(&self) -> Result<TidalStatus, TidalError> {
        let mut cache = INSTANCE_CACHE.lock().unwrap_or_else(|e| e.into_inner());

        let needs_refresh = match &*cache {
            Some(c) => c.fetched_at.elapsed().as_secs() > CACHE_TTL_SECS,
            None => true,
        };

        if needs_refresh {
            if let Some(new_cache) = fetch_instance_list(&self.client) {
                *cache = Some(new_cache);
            }
        }

        match &*cache {
            Some(c) => Ok(TidalStatus {
                available: !c.api_urls.is_empty(),
                instance_count: (c.api_urls.len() + c.streaming_urls.len()) as u32,
            }),
            None => Ok(TidalStatus {
                available: false,
                instance_count: 0,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TidalStatus {
    pub available: bool,
    pub instance_count: u32,
}

// --- JSON parsing helpers ---

fn parse_track(t: &Value) -> TidalSearchTrack {
    TidalSearchTrack {
        tidal_id: t["id"]
            .as_i64()
            .map(|n| n.to_string())
            .unwrap_or_default(),
        title: t["title"].as_str().unwrap_or("Unknown").to_string(),
        artist_name: t["artist"]["name"]
            .as_str()
            .or_else(|| {
                t["artists"]
                    .as_array()
                    .and_then(|arr| arr.first())
                    .and_then(|a| a["name"].as_str())
            })
            .map(|s| s.to_string()),
        artist_id: t["artist"]["id"]
            .as_i64()
            .or_else(|| {
                t["artists"]
                    .as_array()
                    .and_then(|arr| arr.first())
                    .and_then(|a| a["id"].as_i64())
            })
            .map(|n| n.to_string()),
        album_title: t["album"]["title"].as_str().map(|s| s.to_string()),
        album_id: t["album"]["id"].as_i64().map(|n| n.to_string()),
        cover_id: t["album"]["cover"].as_str().map(|s| s.to_string()),
        duration_secs: t["duration"].as_i64().map(|d| d as f64),
        track_number: t["trackNumber"].as_i64().map(|n| n as i32),
    }
}

fn parse_album(a: &Value) -> TidalSearchAlbum {
    TidalSearchAlbum {
        tidal_id: a["id"]
            .as_i64()
            .map(|n| n.to_string())
            .unwrap_or_default(),
        title: a["title"].as_str().unwrap_or("Unknown").to_string(),
        artist_name: a["artists"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|a| a["name"].as_str())
            .map(|s| s.to_string()),
        cover_id: a["cover"].as_str().map(|s| s.to_string()),
        year: a["releaseDate"]
            .as_str()
            .and_then(|d| d.split('-').next())
            .and_then(|y| y.parse().ok()),
    }
}

fn parse_artist(a: &Value) -> TidalSearchArtist {
    TidalSearchArtist {
        tidal_id: a["id"]
            .as_i64()
            .map(|n| n.to_string())
            .unwrap_or_default(),
        name: a["name"].as_str().unwrap_or("Unknown").to_string(),
        picture_id: a["picture"].as_str().map(|s| s.to_string()),
    }
}
