use std::path::Path;
use std::sync::Arc;

use lofty::picture::PictureType;
use lofty::prelude::*;
use lofty::probe::Probe;

use super::{write_image, AlbumImageProvider};
use crate::db::Database;

pub struct EmbeddedArtworkProvider {
    db: Arc<Database>,
}

impl EmbeddedArtworkProvider {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }
}

impl AlbumImageProvider for EmbeddedArtworkProvider {
    fn name(&self) -> &str {
        "EmbeddedArtwork"
    }

    fn fetch_album_image(
        &self,
        album_title: &str,
        artist_name: Option<&str>,
        dest_path: &Path,
    ) -> Result<(), String> {
        let track_path = self
            .db
            .get_track_path_for_album(album_title, artist_name)
            .map_err(|e| format!("DB lookup failed: {}", e))?
            .ok_or("No local track found for album")?;

        let tagged_file = Probe::open(&track_path)
            .and_then(|p| p.read())
            .map_err(|e| format!("Failed to read tags from {}: {}", track_path, e))?;

        let tag = tagged_file
            .primary_tag()
            .or_else(|| tagged_file.first_tag())
            .ok_or("No tags found in file")?;

        let pictures = tag.pictures();
        if pictures.is_empty() {
            return Err("No embedded pictures found".into());
        }

        // Prefer CoverFront, fall back to first picture
        let picture = pictures
            .iter()
            .find(|p| p.pic_type() == PictureType::CoverFront)
            .unwrap_or(&pictures[0]);

        // Determine extension from mime type
        let ext = match picture.mime_type() {
            Some(lofty::picture::MimeType::Png) => "png",
            _ => "jpg",
        };

        // Replace the .jpg extension in dest_path with the correct one
        let actual_dest = dest_path.with_extension(ext);

        write_image(&actual_dest, picture.data())
    }
}
