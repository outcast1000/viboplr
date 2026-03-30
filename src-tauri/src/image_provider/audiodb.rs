use std::path::Path;

use super::{http_client, logged_get, urlencoded, write_image, ArtistImageProvider};

pub struct AudioDbArtistProvider;

impl ArtistImageProvider for AudioDbArtistProvider {
    fn name(&self) -> &str {
        "TheAudioDB"
    }

    fn fetch_artist_image(&self, artist_name: &str, dest_path: &Path) -> Result<String, String> {
        let client = http_client()?;

        let url = format!(
            "https://theaudiodb.com/api/v1/json/2/search.php?s={}",
            urlencoded(artist_name)
        );
        let resp: serde_json::Value = logged_get(&client, &url)
            .map_err(|e| format!("TheAudioDB search failed: {}", e))?
            .json()
            .map_err(|e| format!("Failed to parse TheAudioDB response: {}", e))?;

        let artist = resp["artists"]
            .as_array()
            .and_then(|a| a.first())
            .ok_or("No artist found on TheAudioDB")?;

        let image_url = artist["strArtistThumb"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("No strArtistThumb in TheAudioDB response")?;

        let bytes = logged_get(&client, image_url)
            .map_err(|e| format!("TheAudioDB image download failed: {}", e))?
            .bytes()
            .map_err(|e| format!("Failed to read image bytes: {}", e))?;

        write_image(dest_path, &bytes)?;
        Ok(self.name().to_string())
    }
}
