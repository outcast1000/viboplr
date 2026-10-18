use crate::models::FieldUpdate;
use lofty::config::{ParseOptions, ParsingMode, WriteOptions};
use lofty::file::TaggedFile;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::items::Timestamp;
use std::path::Path;

/// Open and read an audio file's tags + properties. Every lofty read in the app
/// goes through here.
///
/// `Relaxed` is the point: under lofty's default (`BestAttempt`) one malformed
/// item — a TDRC date like "1987/xx" is the common case — fails the WHOLE file.
/// The scanner then fell back to path parsing, so a `1987 - Album` folder
/// became artist "1987" with filename titles, and the tag writer refused to
/// open the file to fix it. `Relaxed` discards just the bad item. The cost is
/// on write: a discarded item isn't written back, so saving drops it — which
/// for an unparseable item is no loss.
pub fn read_tagged_file(path: impl AsRef<Path>) -> lofty::error::Result<TaggedFile> {
    Probe::open(path)?.options(relaxed_parse_options()).read()
}

/// The options behind `read_tagged_file`, for a caller that has to build its own
/// `Probe` (e.g. one that sniffs the type from content rather than extension).
pub fn relaxed_parse_options() -> ParseOptions {
    ParseOptions::new().parsing_mode(ParsingMode::Relaxed)
}

/// Fields to write back to the audio file.
///
/// `title`/`genre` are written only when `Some`. The nullable fields use
/// `FieldUpdate` so the writer can tell apart "leave alone" (`Unchanged`),
/// "blank the tag" (`Clear`), and "set" (`Set`).
pub struct TagUpdates {
    pub title: Option<String>,
    pub track_number: FieldUpdate<u32>,
    pub artist: FieldUpdate<String>,
    /// ALBUMARTIST (TPE2/aART/ALBUMARTIST — lofty maps the per-format frame).
    pub album_artist: FieldUpdate<String>,
    pub album: FieldUpdate<String>,
    pub year: FieldUpdate<u32>,
    pub genre: Option<String>,
}

/// Write metadata updates to a local audio file.
/// Returns Ok(()) on success, Err(message) on failure.
pub fn write_tags(path: &Path, updates: &TagUpdates) -> Result<(), String> {
    let mut tagged_file = read_tagged_file(path)
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
    match &updates.album_artist {
        FieldUpdate::Unchanged => {}
        FieldUpdate::Clear => { tag.remove_key(lofty::tag::ItemKey::AlbumArtist); }
        FieldUpdate::Set(album_artist) => {
            tag.insert_text(lofty::tag::ItemKey::AlbumArtist, album_artist.clone());
        }
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

/// An MP3 whose ID3v2.4 tag carries a TDRC date lofty can't parse ("19xx"):
/// the shape of the files that came in as artist "1987" with filename titles.
#[cfg(test)]
pub(crate) fn mp3_with_malformed_date(title: &str, artist: &str) -> Vec<u8> {
    fn synchsafe(n: usize) -> [u8; 4] {
        [(n >> 21) as u8 & 0x7f, (n >> 14) as u8 & 0x7f, (n >> 7) as u8 & 0x7f, n as u8 & 0x7f]
    }
    fn text_frame(id: &[u8; 4], text: &str) -> Vec<u8> {
        let mut body = vec![0x03]; // UTF-8
        body.extend_from_slice(text.as_bytes());
        let mut frame = id.to_vec();
        frame.extend_from_slice(&synchsafe(body.len()));
        frame.extend_from_slice(&[0, 0]);
        frame.extend(body);
        frame
    }
    let mut frames = text_frame(b"TIT2", title);
    frames.extend(text_frame(b"TPE1", artist));
    frames.extend(text_frame(b"TDRC", "19xx"));

    let mut file = b"ID3\x04\x00\x00".to_vec();
    file.extend_from_slice(&synchsafe(frames.len()));
    file.extend(frames);
    // MPEG-1 Layer III, 128 kbps, 44.1 kHz: 417-byte frames of silence.
    for _ in 0..8 {
        file.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        file.extend(std::iter::repeat(0u8).take(413));
    }
    file
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_a_malformed_date_no_longer_fails_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken-date.mp3");
        std::fs::write(&path, mp3_with_malformed_date("Η Πρώτη Φορά", "Τρύπες")).unwrap();

        // lofty's default mode rejects the file outright — the bug this guards.
        assert!(Probe::open(&path).unwrap().read().is_err());

        let file = read_tagged_file(&path).expect("relaxed read");
        let tag = file.primary_tag().expect("tag");
        assert_eq!(tag.title().as_deref(), Some("Η Πρώτη Φορά"));
        assert_eq!(tag.artist().as_deref(), Some("Τρύπες"));
        assert!(tag.date().is_none(), "the unparseable date is skipped");
    }

    #[test]
    fn test_write_tags_succeeds_on_a_file_with_a_malformed_date() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken-date.mp3");
        std::fs::write(&path, mp3_with_malformed_date("Tripes - I Proti Fora", "1987")).unwrap();

        write_tags(
            &path,
            &TagUpdates {
                title: Some("Η Πρώτη Φορά".into()),
                track_number: FieldUpdate::Unchanged,
                artist: FieldUpdate::Set("Τρύπες".into()),
                album_artist: FieldUpdate::Unchanged,
                album: FieldUpdate::Unchanged,
                year: FieldUpdate::Unchanged,
                genre: None,
            },
        )
        .expect("write");

        // The rewritten file is clean: even lofty's default mode reads it now.
        let file = Probe::open(&path).unwrap().read().expect("default read after save");
        let tag = file.primary_tag().unwrap();
        assert_eq!(tag.title().as_deref(), Some("Η Πρώτη Φορά"));
        assert_eq!(tag.artist().as_deref(), Some("Τρύπες"));
    }
}
