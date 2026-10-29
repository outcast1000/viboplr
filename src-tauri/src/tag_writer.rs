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
///
/// One failure `Relaxed` doesn't cover: a trailing APE tag whose item count is
/// one too high. Some taggers count the footer as an item, so lofty reads the
/// footer as an item with a garbage size and fails the whole file in every
/// parsing mode. Such a file is read again with the APE tag's bytes left out
/// (`read_without_trailing_ape`). Saving then writes only the tags that were
/// read (ID3v2 / ID3v1), and lofty's writers for those never parse the APE
/// tag, so the broken tag is left in the file, untouched.
pub fn read_tagged_file(path: impl AsRef<Path>) -> lofty::error::Result<TaggedFile> {
    let path = path.as_ref();
    match Probe::open(path)?.options(relaxed_parse_options()).read() {
        Ok(file) => Ok(file),
        Err(err) => match read_without_trailing_ape(path) {
            Some(file) => {
                log::warn!("Read {} without its unreadable APE tag ({err})", path.display());
                Ok(file)
            }
            None => Err(err),
        },
    }
}

/// The file read as if its trailing APE tag weren't there, or `None` when it
/// has none or still can't be read. Loads the whole file into memory, so it
/// first checks the file's last bytes for an APE footer: a failed read is not
/// rare — lofty can't identify a QuickTime `.mov` at all — and loading a
/// multi-GB video to find no footer held the disk for seconds, stalling the
/// playback reading the same file.
fn read_without_trailing_ape(path: &Path) -> Option<TaggedFile> {
    if !ends_with_ape_footer(path) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let ape = trailing_ape_range(&bytes)?;
    let mut rest = Vec::with_capacity(bytes.len() - ape.len());
    rest.extend_from_slice(&bytes[..ape.start]);
    rest.extend_from_slice(&bytes[ape.end..]);
    let cursor = std::io::Cursor::new(rest);
    let probe = match lofty::file::FileType::from_path(path) {
        Some(file_type) => Probe::with_file_type(cursor, file_type),
        None => Probe::new(cursor).guess_file_type().ok()?,
    };
    probe.options(relaxed_parse_options()).read().ok()
}

/// Whether the file's APE footer slot (the last 32 bytes, or the 32 before a
/// trailing ID3v1 tag) holds `APETAGEX`. Reads at most 160 bytes.
fn ends_with_ape_footer(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let Ok(len) = file.metadata().map(|m| m.len()) else { return false };
    let tail_len = len.min(160);
    let mut tail = vec![0u8; tail_len as usize];
    if file.seek(SeekFrom::Start(len - tail_len)).is_err() || file.read_exact(&mut tail).is_err() {
        return false;
    }
    let mut end = tail.len();
    if end >= 128 && &tail[end - 128..end - 125] == b"TAG" {
        end -= 128;
    }
    end.checked_sub(32)
        .and_then(|start| tail.get(start..start + 8))
        .is_some_and(|sig| sig == b"APETAGEX")
}

/// Byte range of an APE tag at the end of the file (before an ID3v1 tag, if
/// any), including its header when the footer says there is one.
fn trailing_ape_range(bytes: &[u8]) -> Option<std::ops::Range<usize>> {
    let mut end = bytes.len();
    if end >= 128 && &bytes[end - 128..end - 125] == b"TAG" {
        end -= 128;
    }
    let footer = bytes.get(end.checked_sub(32)?..end)?;
    if &footer[..8] != b"APETAGEX" {
        return None;
    }
    let le = |at: usize| u32::from_le_bytes(footer[at..at + 4].try_into().unwrap()) as usize;
    let size = le(12); // items + footer; excludes the header
    let has_header = le(20) & (1 << 31) != 0;
    let start = end.checked_sub(size + if has_header { 32 } else { 0 })?;
    if has_header && bytes.get(start..start + 8)? != b"APETAGEX" {
        return None;
    }
    Some(start..end)
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

    /// An MP3 with a valid ID3v2.4 tag, then an APE tag whose item count is
    /// one too high (the footer counted as an item), then ID3v1: the layout
    /// of the files that scanned as artist "1999" and that the writer
    /// couldn't open ("Encountered an invalid item size").
    fn mp3_with_overcounted_ape(title: &str, artist: &str) -> (Vec<u8>, std::ops::Range<usize>) {
        let mut file = mp3_with_malformed_date(title, artist);
        let mut items = Vec::new();
        for (key, value) in [("Title", title), ("Artist", artist)] {
            items.extend_from_slice(&(value.len() as u32).to_le_bytes());
            items.extend_from_slice(&0u32.to_le_bytes());
            items.extend_from_slice(key.as_bytes());
            items.push(0);
            items.extend_from_slice(value.as_bytes());
        }
        let block = |flags: u32| {
            let mut b = b"APETAGEX".to_vec();
            b.extend_from_slice(&2000u32.to_le_bytes());
            b.extend_from_slice(&(items.len() as u32 + 32).to_le_bytes());
            b.extend_from_slice(&3u32.to_le_bytes()); // two items, counted as three
            b.extend_from_slice(&flags.to_le_bytes());
            b.extend_from_slice(&[0; 8]);
            b
        };
        let start = file.len();
        file.extend(block((1 << 31) | (1 << 29))); // header
        file.extend(&items);
        file.extend(block(1 << 31)); // footer
        let ape = start..file.len();
        let mut id3v1 = b"TAG".to_vec();
        id3v1.resize(128, 0);
        file.extend(id3v1);
        (file, ape)
    }

    #[test]
    fn test_an_overcounted_ape_tag_no_longer_fails_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("overcounted-ape.mp3");
        let (bytes, ape) = mp3_with_overcounted_ape("Vocal", "Madrugada");
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(trailing_ape_range(&bytes), Some(ape));

        // Relaxed mode alone still fails — the APE reader errors in every mode.
        assert!(Probe::open(&path).unwrap().options(relaxed_parse_options()).read().is_err());

        let file = read_tagged_file(&path).expect("read without the APE tag");
        let tag = file.primary_tag().expect("ID3v2 tag");
        assert_eq!(tag.title().as_deref(), Some("Vocal"));
        assert_eq!(tag.artist().as_deref(), Some("Madrugada"));
    }

    #[test]
    fn test_the_ape_fallback_only_loads_a_file_that_ends_in_an_ape_footer() {
        let dir = tempfile::tempdir().unwrap();

        let ape_path = dir.path().join("overcounted-ape.mp3");
        let (bytes, _) = mp3_with_overcounted_ape("Vocal", "Madrugada");
        std::fs::write(&ape_path, &bytes).unwrap();
        assert!(ends_with_ape_footer(&ape_path));

        // A QuickTime movie: lofty can't identify the format, so every read
        // fails — and the fallback used to load the whole (multi-GB) file.
        let mov_path = dir.path().join("clip.mov");
        let mut mov = vec![0, 0, 0, 0x14];
        mov.extend_from_slice(b"ftypqt  \0\0\0\0qt  ");
        mov.extend(std::iter::repeat_n(0u8, 4096));
        std::fs::write(&mov_path, &mov).unwrap();
        assert!(read_tagged_file(&mov_path).is_err());
        assert!(!ends_with_ape_footer(&mov_path));

        let tiny = dir.path().join("tiny.bin");
        std::fs::write(&tiny, b"APETAG").unwrap();
        assert!(!ends_with_ape_footer(&tiny));
    }

    #[test]
    fn test_write_tags_succeeds_and_leaves_an_overcounted_ape_tag_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("overcounted-ape.mp3");
        let (bytes, ape) = mp3_with_overcounted_ape("Vocal", "1999");
        let ape_bytes = bytes[ape.clone()].to_vec();
        std::fs::write(&path, &bytes).unwrap();

        write_tags(
            &path,
            &TagUpdates {
                title: None,
                track_number: FieldUpdate::Unchanged,
                artist: FieldUpdate::Set("Madrugada".into()),
                album_artist: FieldUpdate::Set("Madrugada".into()),
                album: FieldUpdate::Unchanged,
                year: FieldUpdate::Unchanged,
                genre: None,
            },
        )
        .expect("write");

        let after = std::fs::read(&path).unwrap();
        let ape_after = trailing_ape_range(&after).expect("APE tag still there");
        assert_eq!(&after[ape_after], &ape_bytes[..], "the APE tag is left untouched");
        let tag = read_tagged_file(&path).unwrap().primary_tag().unwrap().clone();
        assert_eq!(tag.artist().as_deref(), Some("Madrugada"));
        assert_eq!(tag.get_string(lofty::tag::ItemKey::AlbumArtist), Some("Madrugada"));
    }

    #[test]
    fn test_no_trailing_ape_range_without_an_ape_footer() {
        let bytes = mp3_with_malformed_date("Song", "Artist");
        assert_eq!(trailing_ape_range(&bytes), None);
        assert_eq!(trailing_ape_range(b"short"), None);
    }
}
