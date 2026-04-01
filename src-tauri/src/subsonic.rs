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
    pub year: Option<i32>,
    pub genre: Option<String>,
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
                    year: a["year"].as_i64().map(|y| y as i32),
                    genre: a["genre"].as_str().map(|s| s.to_string()),
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
            year: a["year"].as_i64().map(|y| y as i32),
            genre: a["genre"].as_str().map(|s| s.to_string()),
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
}
