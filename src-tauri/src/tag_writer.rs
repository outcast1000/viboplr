use lofty::config::WriteOptions;
use lofty::prelude::*;
use lofty::probe::Probe;
use std::path::Path;

/// Fields to write back to the audio file. Only `Some` fields are written.
pub struct TagUpdates {
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<u32>,
    pub genre: Option<String>,
}

/// Write metadata updates to a local audio file.
/// Returns Ok(()) on success, Err(message) on failure.
pub fn write_tags(path: &Path, updates: &TagUpdates) -> Result<(), String> {
    let mut tagged_file = Probe::open(path)
        .map_err(|e| format!("Failed to open {}: {}", path.display(), e))?
        .read()
        .map_err(|e| format!("Failed to read tags from {}: {}", path.display(), e))?;

    let tag_type = tagged_file.primary_tag_type();
    let tag = match tagged_file.tag_mut(tag_type) {
        Some(t) => t,
        None => {
            tagged_file.insert_tag(lofty::tag::Tag::new(tag_type));
            tagged_file.tag_mut(tag_type).unwrap()
        }
    };

    if let Some(artist) = &updates.artist {
        tag.set_artist(artist.clone());
    }
    if let Some(album) = &updates.album {
        tag.set_album(album.clone());
    }
    if let Some(year) = updates.year {
        tag.set_year(year);
    }
    if let Some(genre) = &updates.genre {
        tag.set_genre(genre.clone());
    }

    tagged_file
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("Failed to save tags to {}: {}", path.display(), e))?;

    Ok(())
}
