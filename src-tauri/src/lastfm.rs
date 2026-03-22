use std::fmt;

#[derive(Debug)]
pub struct LastfmError(pub String);

impl fmt::Display for LastfmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for LastfmError {}

pub struct LastfmClient {
    api_key: String,
    api_secret: String,
    client: reqwest::blocking::Client,
}

const BASE_URL: &str = "https://ws.audioscrobbler.com/2.0/";

impl LastfmClient {
    pub fn new(api_key: &str, api_secret: &str) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        Self {
            api_key: api_key.to_string(),
            api_secret: api_secret.to_string(),
            client,
        }
    }

    pub fn get_auth_url(&self, callback_url: &str) -> String {
        format!(
            "https://www.last.fm/api/auth/?api_key={}&cb={}",
            self.api_key,
            urlencoding::encode(callback_url)
        )
    }

    /// Sort params alphabetically, concatenate key-value pairs, append secret, MD5 hash.
    pub fn sign_params(&self, params: &mut Vec<(String, String)>) -> String {
        params.sort_by(|a, b| a.0.cmp(&b.0));
        let mut sig_input = String::new();
        for (k, v) in params.iter() {
            sig_input.push_str(k);
            sig_input.push_str(v);
        }
        sig_input.push_str(&self.api_secret);
        format!("{:x}", md5::compute(sig_input))
    }

    /// Exchange an auth token for a session key and username.
    pub fn get_session(&self, token: &str) -> Result<(String, String), LastfmError> {
        let mut params = vec![
            ("method".to_string(), "auth.getSession".to_string()),
            ("api_key".to_string(), self.api_key.clone()),
            ("token".to_string(), token.to_string()),
        ];
        let sig = self.sign_params(&mut params);

        let resp = self.client
            .get(BASE_URL)
            .query(&[
                ("method", "auth.getSession"),
                ("api_key", &self.api_key),
                ("token", token),
                ("api_sig", &sig),
                ("format", "json"),
            ])
            .send()
            .map_err(|e| LastfmError(format!("HTTP error: {}", e)))?;

        let body: serde_json::Value = resp.json()
            .map_err(|e| LastfmError(format!("JSON error: {}", e)))?;

        if let Some(err) = body.get("error") {
            let msg = body.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown error");
            return Err(LastfmError(format!("Last.fm error {}: {}", err, msg)));
        }

        let session = body.get("session")
            .ok_or_else(|| LastfmError("Missing session in response".to_string()))?;
        let key = session.get("key").and_then(|k| k.as_str())
            .ok_or_else(|| LastfmError("Missing session key".to_string()))?;
        let name = session.get("name").and_then(|n| n.as_str())
            .ok_or_else(|| LastfmError("Missing username".to_string()))?;

        Ok((key.to_string(), name.to_string()))
    }

    /// Send "now playing" notification to Last.fm.
    pub fn update_now_playing(
        &self,
        session_key: &str,
        artist: &str,
        track: &str,
        album: Option<&str>,
        duration: Option<f64>,
    ) -> Result<(), LastfmError> {
        let mut params = vec![
            ("method".to_string(), "track.updateNowPlaying".to_string()),
            ("api_key".to_string(), self.api_key.clone()),
            ("sk".to_string(), session_key.to_string()),
            ("artist".to_string(), artist.to_string()),
            ("track".to_string(), track.to_string()),
        ];
        if let Some(a) = album {
            params.push(("album".to_string(), a.to_string()));
        }
        if let Some(d) = duration {
            params.push(("duration".to_string(), (d as i64).to_string()));
        }
        let sig = self.sign_params(&mut params);
        params.push(("api_sig".to_string(), sig));
        params.push(("format".to_string(), "json".to_string()));

        let resp = self.client
            .post(BASE_URL)
            .form(&params)
            .send()
            .map_err(|e| LastfmError(format!("HTTP error: {}", e)))?;

        let body: serde_json::Value = resp.json()
            .map_err(|e| LastfmError(format!("JSON error: {}", e)))?;

        if let Some(err_code) = body.get("error").and_then(|e| e.as_i64()) {
            if err_code == 9 || err_code == 14 {
                return Err(LastfmError(format!("auth_error:{}", err_code)));
            }
        }

        Ok(())
    }

    /// Scrobble a track to Last.fm.
    pub fn scrobble(
        &self,
        session_key: &str,
        artist: &str,
        track: &str,
        timestamp: i64,
        album: Option<&str>,
        duration: Option<f64>,
    ) -> Result<(), LastfmError> {
        let mut params = vec![
            ("method".to_string(), "track.scrobble".to_string()),
            ("api_key".to_string(), self.api_key.clone()),
            ("sk".to_string(), session_key.to_string()),
            ("artist".to_string(), artist.to_string()),
            ("track".to_string(), track.to_string()),
            ("timestamp".to_string(), timestamp.to_string()),
        ];
        if let Some(a) = album {
            params.push(("album".to_string(), a.to_string()));
        }
        if let Some(d) = duration {
            params.push(("duration".to_string(), (d as i64).to_string()));
        }
        let sig = self.sign_params(&mut params);
        params.push(("api_sig".to_string(), sig));
        params.push(("format".to_string(), "json".to_string()));

        let resp = self.client
            .post(BASE_URL)
            .form(&params)
            .send()
            .map_err(|e| LastfmError(format!("HTTP error: {}", e)))?;

        let body: serde_json::Value = resp.json()
            .map_err(|e| LastfmError(format!("JSON error: {}", e)))?;

        if let Some(err_code) = body.get("error").and_then(|e| e.as_i64()) {
            if err_code == 9 || err_code == 14 {
                return Err(LastfmError(format!("auth_error:{}", err_code)));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sign_params() {
        let client = LastfmClient::new("test_api_key", "test_secret");
        let mut params = vec![
            ("method".to_string(), "auth.getSession".to_string()),
            ("api_key".to_string(), "test_api_key".to_string()),
            ("token".to_string(), "abc123".to_string()),
        ];
        let sig = client.sign_params(&mut params);
        let expected = format!("{:x}", md5::compute("api_keytest_api_keymethodauth.getSessiontokenabc123test_secret"));
        assert_eq!(sig, expected);
    }

    #[test]
    fn test_get_auth_url() {
        let client = LastfmClient::new("MY_KEY", "secret");
        let url = client.get_auth_url("viboplr://lastfm-callback");
        assert_eq!(url, "https://www.last.fm/api/auth/?api_key=MY_KEY&cb=viboplr%3A%2F%2Flastfm-callback");
    }
}
