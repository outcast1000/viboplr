use std::path::Path;

use super::{http_client, logged_get, urlencoded, write_image, AlbumImageProvider, ArtistImageProvider};

pub struct ITunesArtistProvider;

impl ArtistImageProvider for ITunesArtistProvider {
    fn name(&self) -> &str {
        "iTunes"
    }

    fn fetch_artist_image(&self, artist_name: &str, dest_path: &Path) -> Result<String, String> {
        let client = http_client()?;

        let url = format!(
            "https://itunes.apple.com/search?term={}&entity=musicArtist&limit=1",
            urlencoded(artist_name)
        );
        let resp: serde_json::Value = logged_get(&client, &url)
            .map_err(|e| format!("iTunes search failed: {}", e))?
            .json()
            .map_err(|e| format!("Failed to parse iTunes response: {}", e))?;

        let result = resp["results"]
            .as_array()
            .and_then(|a| a.first())
            .ok_or("No artist found on iTunes")?;

        let artwork_url = result["artworkUrl100"]
            .as_str()
            .ok_or("No artwork URL in iTunes response")?
            .replace("100x100", "600x600");

        let bytes = logged_get(&client, &artwork_url)
            .map_err(|e| format!("iTunes image download failed: {}", e))?
            .bytes()
            .map_err(|e| format!("Failed to read image bytes: {}", e))?;

        write_image(dest_path, &bytes)?;
        Ok(self.name().to_string())
    }
}

pub struct ITunesAlbumProvider;

impl AlbumImageProvider for ITunesAlbumProvider {
    fn name(&self) -> &str {
        "iTunes"
    }

    fn fetch_album_image(
        &self,
        album_title: &str,
        artist_name: Option<&str>,
        dest_path: &Path,
    ) -> Result<String, String> {
        let client = http_client()?;

        let term = match artist_name {
            Some(artist) => format!("{}+{}", urlencoded(artist), urlencoded(album_title)),
            None => urlencoded(album_title),
        };
        let url = format!(
            "https://itunes.apple.com/search?term={}&entity=album&limit=1",
            term
        );
        let resp: serde_json::Value = logged_get(&client, &url)
            .map_err(|e| format!("iTunes search failed: {}", e))?
            .json()
            .map_err(|e| format!("Failed to parse iTunes response: {}", e))?;

        let result = resp["results"]
            .as_array()
            .and_then(|a| a.first())
            .ok_or("No album found on iTunes")?;

        let artwork_url = result["artworkUrl100"]
            .as_str()
            .ok_or("No artwork URL in iTunes response")?
            .replace("100x100", "600x600");

        let bytes = logged_get(&client, &artwork_url)
            .map_err(|e| format!("iTunes image download failed: {}", e))?
            .bytes()
            .map_err(|e| format!("Failed to read image bytes: {}", e))?;

        write_image(dest_path, &bytes)?;
        Ok(self.name().to_string())
    }
}
