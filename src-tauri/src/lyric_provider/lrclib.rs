use super::{LyricKind, LyricProvider, LyricResult};
use crate::image_provider::{http_client, logged_get, urlencoded};

pub struct LrclibProvider;

impl LyricProvider for LrclibProvider {
    fn name(&self) -> &str {
        "lrclib"
    }

    fn fetch_lyrics(
        &self,
        artist: &str,
        title: &str,
        duration_secs: Option<f64>,
    ) -> Result<LyricResult, String> {
        let client = http_client()?;

        let mut url = format!(
            "https://lrclib.net/api/get?artist_name={}&track_name={}",
            urlencoded(artist),
            urlencoded(title),
        );
        if let Some(dur) = duration_secs {
            url.push_str(&format!("&duration={}", dur.round() as i64));
        }

        let resp = logged_get(&client, &url)
            .map_err(|e| format!("LRCLIB request failed: {}", e))?;

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err("No lyrics found on LRCLIB".to_string());
        }
        if !resp.status().is_success() {
            return Err(format!("LRCLIB returned status {}", resp.status()));
        }

        let body: serde_json::Value = resp
            .json()
            .map_err(|e| format!("Failed to parse LRCLIB response: {}", e))?;

        // Prefer synced lyrics, fall back to plain
        if let Some(synced) = body["syncedLyrics"].as_str() {
            if !synced.trim().is_empty() {
                return Ok(LyricResult {
                    text: synced.to_string(),
                    kind: LyricKind::Synced,
                    provider_name: self.name().to_string(),
                });
            }
        }

        if let Some(plain) = body["plainLyrics"].as_str() {
            if !plain.trim().is_empty() {
                return Ok(LyricResult {
                    text: plain.to_string(),
                    kind: LyricKind::Plain,
                    provider_name: self.name().to_string(),
                });
            }
        }

        Err("LRCLIB returned empty lyrics".to_string())
    }
}
