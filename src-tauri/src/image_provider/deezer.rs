use std::path::Path;

use super::{http_client, urlencoded, write_image, AlbumImageProvider, ArtistImageProvider};

pub struct DeezerArtistProvider;

impl ArtistImageProvider for DeezerArtistProvider {
    fn name(&self) -> &str {
        "Deezer"
    }

    fn fetch_artist_image(&self, artist_name: &str, dest_path: &Path) -> Result<(), String> {
        let client = http_client()?;

        let url = format!(
            "https://api.deezer.com/search/artist?q={}&limit=1",
            urlencoded(artist_name)
        );
        let resp: serde_json::Value = client
            .get(&url)
            .send()
            .map_err(|e| format!("Deezer search failed: {}", e))?
            .json()
            .map_err(|e| format!("Failed to parse Deezer response: {}", e))?;

        let artist = resp["data"]
            .as_array()
            .and_then(|a| a.first())
            .ok_or("No artist found on Deezer")?;

        let image_url = artist["picture_xl"]
            .as_str()
            .ok_or("No picture_xl in Deezer response")?;

        let bytes = client
            .get(image_url)
            .send()
            .map_err(|e| format!("Deezer image download failed: {}", e))?
            .bytes()
            .map_err(|e| format!("Failed to read image bytes: {}", e))?;

        write_image(dest_path, &bytes)
    }
}

pub struct DeezerAlbumProvider;

impl AlbumImageProvider for DeezerAlbumProvider {
    fn name(&self) -> &str {
        "Deezer"
    }

    fn fetch_album_image(
        &self,
        album_title: &str,
        artist_name: Option<&str>,
        dest_path: &Path,
    ) -> Result<(), String> {
        let client = http_client()?;

        let query = match artist_name {
            Some(artist) => format!("{} {}", artist, album_title),
            None => album_title.to_string(),
        };
        let url = format!(
            "https://api.deezer.com/search/album?q={}&limit=1",
            urlencoded(&query)
        );
        let resp: serde_json::Value = client
            .get(&url)
            .send()
            .map_err(|e| format!("Deezer search failed: {}", e))?
            .json()
            .map_err(|e| format!("Failed to parse Deezer response: {}", e))?;

        let album = resp["data"]
            .as_array()
            .and_then(|a| a.first())
            .ok_or("No album found on Deezer")?;

        let image_url = album["cover_xl"]
            .as_str()
            .ok_or("No cover_xl in Deezer response")?;

        let bytes = client
            .get(image_url)
            .send()
            .map_err(|e| format!("Deezer image download failed: {}", e))?
            .bytes()
            .map_err(|e| format!("Failed to read image bytes: {}", e))?;

        write_image(dest_path, &bytes)
    }
}
