use std::path::Path;

use super::{write_image, AlbumImageProvider, ArtistImageProvider};
use crate::tidal::TidalClient;

pub struct TidalArtistProvider;

impl ArtistImageProvider for TidalArtistProvider {
    fn name(&self) -> &str {
        "TIDAL"
    }

    fn fetch_artist_image(&self, artist_name: &str, dest_path: &Path) -> Result<String, String> {
        let client = TidalClient::new(None);
        let artists = client
            .search_artists(artist_name, 1, 0)
            .map_err(|e| format!("TIDAL artist search failed: {}", e))?;

        let artist = artists.first().ok_or("No artist found on TIDAL")?;
        let picture_id = artist
            .picture_id
            .as_deref()
            .ok_or("TIDAL artist has no picture")?;

        let image_url = TidalClient::artist_picture_url(picture_id, 750);

        let http_client = super::http_client()?;
        let bytes = http_client
            .get(&image_url)
            .send()
            .map_err(|e| format!("TIDAL image download failed: {}", e))?
            .bytes()
            .map_err(|e| format!("Failed to read image bytes: {}", e))?;

        write_image(dest_path, &bytes)?;
        Ok(self.name().to_string())
    }
}

pub struct TidalAlbumProvider;

impl AlbumImageProvider for TidalAlbumProvider {
    fn name(&self) -> &str {
        "TIDAL"
    }

    fn fetch_album_image(
        &self,
        album_title: &str,
        artist_name: Option<&str>,
        dest_path: &Path,
    ) -> Result<String, String> {
        let client = TidalClient::new(None);
        let query = match artist_name {
            Some(artist) => format!("{} {}", artist, album_title),
            None => album_title.to_string(),
        };
        let albums = client
            .search_albums(&query, 1, 0)
            .map_err(|e| format!("TIDAL album search failed: {}", e))?;

        let album = albums.first().ok_or("No album found on TIDAL")?;
        let cover_id = album
            .cover_id
            .as_deref()
            .ok_or("TIDAL album has no cover")?;

        let image_url = TidalClient::cover_url(cover_id, 1280);

        let http_client = super::http_client()?;
        let bytes = http_client
            .get(&image_url)
            .send()
            .map_err(|e| format!("TIDAL image download failed: {}", e))?
            .bytes()
            .map_err(|e| format!("Failed to read image bytes: {}", e))?;

        write_image(dest_path, &bytes)?;
        Ok(self.name().to_string())
    }
}
