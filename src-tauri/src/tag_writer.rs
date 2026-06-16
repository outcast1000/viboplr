use crate::models::FieldUpdate;
use lofty::config::WriteOptions;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::items::Timestamp;
use std::path::Path;

/// Fields to write back to the audio file.
///
/// `title`/`genre` are written only when `Some`. The nullable fields use
/// `FieldUpdate` so the writer can tell apart "leave alone" (`Unchanged`),
/// "blank the tag" (`Clear`), and "set" (`Set`).
pub struct TagUpdates {
    pub title: Option<String>,
    pub track_number: FieldUpdate<u32>,
    pub artist: FieldUpdate<String>,
    pub album: FieldUpdate<String>,
    pub year: FieldUpdate<u32>,
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

    if let Some(title) = &updates.title {
        tag.set_title(title.clone());
    }
    match updates.track_number {
        FieldUpdate::Unchanged => {}
        FieldUpdate::Clear => { tag.remove_track(); }
        FieldUpdate::Set(track_number) => tag.set_track(track_number),
    }
    match &updates.artist {
        FieldUpdate::Unchanged => {}
        FieldUpdate::Clear => { tag.remove_artist(); }
        FieldUpdate::Set(artist) => tag.set_artist(artist.clone()),
    }
    match &updates.album {
        FieldUpdate::Unchanged => {}
        FieldUpdate::Clear => { tag.remove_album(); }
        FieldUpdate::Set(album) => tag.set_album(album.clone()),
    }
    match updates.year {
        FieldUpdate::Unchanged => {}
        // The scanner reads year from `tag.date()`, so clear the date item.
        FieldUpdate::Clear => { tag.remove_date(); }
        FieldUpdate::Set(year) => {
            tag.set_date(Timestamp { year: year as u16, month: None, day: None, hour: None, minute: None, second: None });
        }
    }
    if let Some(genre) = &updates.genre {
        tag.set_genre(genre.clone());
    }

    tagged_file
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("Failed to save tags to {}: {}", path.display(), e))?;

    Ok(())
}
