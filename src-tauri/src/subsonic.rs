use serde_json::Value;
use std::fmt;

const API_VERSION: &str = "1.16.1";
const CLIENT_NAME: &str = "viboplr";

#[derive(Debug)]
pub struct SubsonicError(pub String);

impl fmt::Display for SubsonicError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for SubsonicError {}

pub struct SubsonicClient {
    base_url: String,
    auth_params: String,
    pub password_token: String,
    pub salt: Option<String>,
    pub auth_method: String,
}

pub struct SubsonicAlbum {
    pub id: String,
    pub name: String,
    pub artist: Option<String>,
    /// OpenSubsonic `albumArtist` (absent on legacy servers). When present it
    /// outranks `artist` as the artist the album files under.
    pub album_artist: Option<String>,
    pub year: Option<i32>,
    pub genre: Option<String>,
    /// When the album entered the server (`created`, unix seconds). Fallback
    /// for a song that carries no `created` of its own.
    pub created: Option<i64>,
}

pub struct SubsonicTrack {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub track_number: Option<i32>,
    pub duration_secs: Option<f64>,
    pub size: Option<i64>,
    pub suffix: Option<String>,
    pub genre: Option<String>,
    /// When the song entered the server (`created`, unix seconds) — stored as
    /// the track's `added_at`, so "Recently added" follows the server's order.
    pub created: Option<i64>,
    // OpenSubsonic ReplayGain (absent on legacy servers). Folded into extra_tags on sync.
    pub rg_track_gain: Option<f64>,
    pub rg_track_peak: Option<f64>,
    pub rg_album_gain: Option<f64>,
    pub rg_album_peak: Option<f64>,
}

/// A Subsonic `created` timestamp as unix seconds. The spec types it
/// `xs:dateTime`: Navidrome/OpenSubsonic send RFC 3339 (`…Z`, often with
/// millis), older servers a bare zone-less `2013-05-01T19:22:09`, read as UTC.
/// Anything else — missing, unparseable, before 1970 — is `None`, and the
/// track falls back to being stamped when it was synced. A date in the future
/// (a server with a wrong clock) is clamped to now, or that album would sit at
/// the front of Recently added until the calendar caught up.
pub(crate) fn parse_created(value: &Value) -> Option<i64> {
    let raw = value.as_str()?.trim();
    let secs = chrono::DateTime::parse_from_rfc3339(raw)
        .map(|d| d.timestamp())
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f")
                .map(|d| d.and_utc().timestamp())
        })
        .ok()?;
    if secs <= 0 {
        return None;
    }
    Some(secs.min(chrono::Utc::now().timestamp()))
}

fn generate_salt() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{:x}{:x}", nanos, nanos.wrapping_mul(2654435761))
}

impl SubsonicClient {
    pub fn new(url: &str, username: &str, password: &str) -> Result<Self, SubsonicError> {
        let base_url = url.trim_end_matches('/').to_string();

        // Try token auth first
        let salt = generate_salt();
        let token = format!("{:x}", md5::compute(format!("{}{}", password, salt)));
        let auth_params = format!(
            "u={}&t={}&s={}&v={}&c={}&f=json",
            username, token, salt, API_VERSION, CLIENT_NAME
        );

        let client = Self {
            base_url: base_url.clone(),
            auth_params: auth_params.clone(),
            password_token: token.clone(),
            salt: Some(salt.clone()),
            auth_method: "token".to_string(),
        };

        match client.ping() {
            Ok(()) => return Ok(client),
            Err(_) => {
                // Fall back to plaintext auth
                let auth_params = format!(
                    "u={}&p={}&v={}&c={}&f=json",
                    username, password, API_VERSION, CLIENT_NAME
                );
                let client = Self {
                    base_url,
                    auth_params,
                    password_token: password.to_string(),
                    salt: None,
                    auth_method: "plaintext".to_string(),
                };
                client.ping()?;
                Ok(client)
            }
        }
    }

    pub fn from_stored(
        url: &str,
        username: &str,
        password_token: &str,
        salt: Option<&str>,
        auth_method: &str,
    ) -> Self {
        let base_url = url.trim_end_matches('/').to_string();
        let auth_params = if auth_method == "plaintext" || salt.is_none() {
            format!(
                "u={}&p={}&v={}&c={}&f=json",
                username, password_token, API_VERSION, CLIENT_NAME
            )
        } else {
            format!(
                "u={}&t={}&s={}&v={}&c={}&f=json",
                username, password_token, salt.unwrap(), API_VERSION, CLIENT_NAME
            )
        };

        Self {
            base_url,
            auth_params,
            password_token: password_token.to_string(),
            salt: salt.map(|s| s.to_string()),
            auth_method: auth_method.to_string(),
        }
    }

    fn api_url(&self, endpoint: &str) -> String {
        // Endpoint may contain additional query params after the first '&'
        // e.g. "getAlbumList2.view&type=alphabeticalByName&size=500"
        // Split so base goes in path, extra params go after '?' with auth
        match endpoint.find('&') {
            Some(pos) => {
                let base = &endpoint[..pos];
                let extra = &endpoint[pos..]; // includes leading '&'
                format!("{}/rest/{}?{}{}", self.base_url, base, self.auth_params, extra)
            }
            None => format!("{}/rest/{}?{}", self.base_url, endpoint, self.auth_params),
        }
    }

    fn get_json(&self, endpoint: &str) -> Result<Value, SubsonicError> {
        let url = self.api_url(endpoint);
        let start = std::time::Instant::now();
        let resp = reqwest::blocking::get(&url)
            .map_err(|e| SubsonicError(format!("HTTP error: {}", e)))?;
        let status_code = resp.status();
        let endpoint_name = endpoint.split('?').next().unwrap_or(endpoint);
        log::info!("HTTP GET subsonic/{} -> {} ({:.0}ms)", endpoint_name, status_code, start.elapsed().as_secs_f64() * 1000.0);
        let body = resp
            .text()
            .map_err(|e| SubsonicError(format!("Failed to read response body: {}", e)))?;

        if !status_code.is_success() {
            return Err(SubsonicError(format!(
                "HTTP {}: {}",
                status_code,
                &body[..body.len().min(200)]
            )));
        }

        let json: Value = serde_json::from_str(&body).map_err(|e| {
            SubsonicError(format!(
                "JSON parse error: {} — body starts with: {}",
                e,
                &body[..body.len().min(200)]
            ))
        })?;

        let response = &json["subsonic-response"];
        let status = response["status"].as_str().unwrap_or("unknown");
        if status != "ok" {
            let error_msg = response["error"]["message"]
                .as_str()
                .unwrap_or("Unknown error");
            return Err(SubsonicError(format!("Subsonic error: {}", error_msg)));
        }
        Ok(response.clone())
    }

    pub fn ping(&self) -> Result<(), SubsonicError> {
        self.get_json("ping.view")?;
        Ok(())
    }

    pub fn get_album_list(&self, size: u32, offset: u32) -> Result<Vec<SubsonicAlbum>, SubsonicError> {
        let resp = self.get_json(&format!(
            "getAlbumList2.view&type=alphabeticalByName&size={}&offset={}",
            size, offset
        ))?;
        let mut albums = Vec::new();
        if let Some(album_arr) = resp["albumList2"]["album"].as_array() {
            for a in album_arr {
                albums.push(SubsonicAlbum {
                    id: a["id"].as_str().unwrap_or("").to_string(),
                    name: a["name"].as_str().unwrap_or("Unknown").to_string(),
                    artist: a["artist"].as_str().map(|s| s.to_string()),
                    album_artist: a["albumArtist"].as_str().map(|s| s.to_string()),
                    year: a["year"].as_i64().map(|y| y as i32),
                    genre: a["genre"].as_str().map(|s| s.to_string()),
                    created: parse_created(&a["created"]),
                });
            }
        }
        Ok(albums)
    }

    pub fn get_album(&self, album_id: &str) -> Result<(SubsonicAlbum, Vec<SubsonicTrack>), SubsonicError> {
        let resp = self.get_json(&format!("getAlbum.view&id={}", album_id))?;
        let a = &resp["album"];
        let album = SubsonicAlbum {
            id: a["id"].as_str().unwrap_or("").to_string(),
            name: a["name"].as_str().unwrap_or("Unknown").to_string(),
            artist: a["artist"].as_str().map(|s| s.to_string()),
            album_artist: a["albumArtist"].as_str().map(|s| s.to_string()),
            year: a["year"].as_i64().map(|y| y as i32),
            genre: a["genre"].as_str().map(|s| s.to_string()),
            created: parse_created(&a["created"]),
        };

        let mut tracks = Vec::new();
        if let Some(song_arr) = a["song"].as_array() {
            for s in song_arr {
                tracks.push(SubsonicTrack {
                    id: s["id"].as_str().unwrap_or("").to_string(),
                    title: s["title"].as_str().unwrap_or("Unknown").to_string(),
                    artist: s["artist"].as_str().map(|s| s.to_string()),
                    track_number: s["track"].as_i64().map(|t| t as i32),
                    duration_secs: s["duration"].as_i64().map(|d| d as f64),
                    size: s["size"].as_i64(),
                    suffix: s["suffix"].as_str().map(|s| s.to_string()),
                    genre: s["genre"].as_str().map(|s| s.to_string()),
                    created: parse_created(&s["created"]),
                    rg_track_gain: s["replayGain"]["trackGain"].as_f64(),
                    rg_track_peak: s["replayGain"]["trackPeak"].as_f64(),
                    rg_album_gain: s["replayGain"]["albumGain"].as_f64(),
                    rg_album_peak: s["replayGain"]["albumPeak"].as_f64(),
                });
            }
        }
        Ok((album, tracks))
    }

    pub fn stream_url(&self, track_id: &str) -> String {
        format!("{}/rest/stream.view?id={}&{}", self.base_url, track_id, self.auth_params)
    }

    pub fn stream_url_with_format(&self, track_id: &str, format: Option<&str>) -> String {
        let mut url = format!(
            "{}/rest/stream.view?id={}&{}",
            self.base_url, track_id, self.auth_params
        );
        if let Some(fmt) = format {
            url.push_str(&format!("&format={}", fmt));
        }
        url
    }

    /// URL for the original, untranscoded file via the `download.view` endpoint.
    /// Unlike `stream.view`, this never transcodes — the server returns the
    /// source file byte-for-byte.
    pub fn download_url(&self, track_id: &str) -> String {
        format!(
            "{}/rest/download.view?id={}&{}",
            self.base_url, track_id, self.auth_params
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token_client() -> SubsonicClient {
        SubsonicClient::from_stored(
            "https://music.example.com/",
            "alice",
            "tok123",
            Some("salty"),
            "token",
        )
    }

    #[test]
    fn test_parse_created_reads_every_server_shape() {
        use serde_json::json;
        // Navidrome / OpenSubsonic: RFC 3339 with millis and Z.
        assert_eq!(parse_created(&json!("2023-04-12T10:22:33.000Z")), Some(1_681_294_953));
        // An offset names the same instant.
        assert_eq!(parse_created(&json!("2023-04-12T12:22:33+02:00")), Some(1_681_294_953));
        // Legacy Subsonic: no zone, read as UTC.
        assert_eq!(parse_created(&json!("2023-04-12T10:22:33")), Some(1_681_294_953));
    }

    #[test]
    fn test_parse_created_rejects_what_is_not_a_date() {
        use serde_json::json;
        assert_eq!(parse_created(&Value::Null), None);
        assert_eq!(parse_created(&json!("")), None);
        assert_eq!(parse_created(&json!("yesterday")), None);
        assert_eq!(parse_created(&json!(1_681_294_953)), None);
        assert_eq!(parse_created(&json!("1969-12-31T00:00:00Z")), None);
    }

    #[test]
    fn test_parse_created_clamps_a_future_date_to_now() {
        let now = chrono::Utc::now().timestamp();
        let got = parse_created(&serde_json::json!("2999-01-01T00:00:00Z")).unwrap();
        assert!(got >= now && got <= now + 5, "expected ~now, got {got}");
    }

    #[test]
    fn test_download_url_uses_download_endpoint() {
        let client = token_client();
        let url = client.download_url("abc");
        assert!(
            url.starts_with("https://music.example.com/rest/download.view?id=abc&"),
            "expected download.view endpoint, got: {}",
            url
        );
    }

    #[test]
    fn test_download_url_never_transcodes() {
        let client = token_client();
        let url = client.download_url("abc");
        assert!(
            !url.contains("format="),
            "download.view must not carry a format/transcode param, got: {}",
            url
        );
    }

    #[test]
    fn test_download_url_includes_auth_params() {
        let client = token_client();
        let url = client.download_url("abc");
        assert!(url.contains("u=alice"), "missing username auth: {}", url);
        assert!(url.contains("t=tok123"), "missing token auth: {}", url);
        assert!(url.contains("s=salty"), "missing salt auth: {}", url);
    }
}
