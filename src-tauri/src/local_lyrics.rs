//! Local lyrics discovery (issue #131): lyrics that live with the user's own
//! files rather than on a lyrics service. Three sources, probed in the order
//! the issue asks for — embedded tag lyrics, a sidecar `.lrc`/`.txt` named
//! like the audio file, and the same files inside a `Lyrics/` subfolder.
//!
//! Everything here is probed live on every lookup and deliberately never
//! cached: the file is the source of truth, re-reading it costs a stat or one
//! tag parse, and a user who just saved an `.lrc` expects it on the next look.
//! (The network lyrics providers keep going through the information-value
//! cache — see `utils/infoFetchChain.ts` — this module sits in front of it.)

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LocalLyrics {
    pub text: String,
    /// "synced" (LRC timestamps present) or "plain".
    pub kind: &'static str,
    /// Which probe answered: "embedded" | "sidecar" | "folder".
    pub source: &'static str,
}

/// True when any line opens with an LRC timestamp (`[m:ss` / `[mm:ss.xx` …).
/// The character after `[` must be a digit, so LRC metadata tags like
/// `[ar:Artist]` never count — a `.txt` full of those but no timestamps is
/// still plain text.
pub fn is_synced_lyrics(text: &str) -> bool {
    text.lines().any(line_has_lrc_timestamp)
}

fn line_has_lrc_timestamp(line: &str) -> bool {
    let Some(rest) = line.trim_start().strip_prefix('[') else {
        return false;
    };
    let minutes = rest.bytes().take_while(u8::is_ascii_digit).count();
    if minutes == 0 || minutes > 3 {
        return false;
    }
    let Some(rest) = rest[minutes..].strip_prefix(':') else {
        return false;
    };
    rest.bytes().take_while(u8::is_ascii_digit).count() == 2
}

fn kind_of(text: &str) -> &'static str {
    if is_synced_lyrics(text) { "synced" } else { "plain" }
}

/// The lyrics an audio tag carries, if any. lofty splits the concept in two:
/// `ItemKey::Lyrics` (Vorbis `LYRICS`, MP4 `©lyr` — may carry LRC text) and
/// `ItemKey::UnsyncLyrics` (ID3v2 `USLT`, Vorbis `UNSYNCEDLYRICS`) — an ID3v2
/// tag's lyrics only ever surface under the second key, so both must be
/// checked. Whitespace-only values count as absent (some taggers write an
/// empty frame).
pub fn lyrics_from_tag(tag: &lofty::tag::Tag) -> Option<String> {
    use lofty::tag::ItemKey;
    [ItemKey::Lyrics, ItemKey::UnsyncLyrics].into_iter().find_map(|key| {
        tag.get_string(key)
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
    })
}

fn embedded_lyrics(path: &Path) -> Option<String> {
    use lofty::prelude::*;

    let tagged_file = lofty::probe::Probe::open(path).and_then(|p| p.read()).ok()?;
    tagged_file
        .primary_tag()
        .and_then(lyrics_from_tag)
        .or_else(|| tagged_file.tags().iter().find_map(lyrics_from_tag))
}

/// `<stem>.lrc` preferred over `<stem>.txt` — when both exist the synced file
/// is the richer one.
fn lyrics_file_in(dir: &Path, stem: &str) -> Option<PathBuf> {
    ["lrc", "txt"]
        .iter()
        .map(|ext| dir.join(format!("{stem}.{ext}")))
        .find(|p| p.is_file())
}

/// Non-empty file text, BOM stripped, read lossily — `.lrc` files from the
/// wild aren't reliably UTF-8 and a replacement char beats no lyrics.
fn read_text_file(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_start_matches('\u{feff}');
    if text.trim().is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// Probe one local audio file for lyrics: embedded tag → sidecar →
/// `Lyrics`/`lyrics` subfolder, first hit wins.
pub fn probe_local_lyrics(audio_path: &Path) -> Option<LocalLyrics> {
    if !audio_path.is_file() {
        return None;
    }

    if let Some(text) = embedded_lyrics(audio_path) {
        return Some(LocalLyrics { kind: kind_of(&text), text, source: "embedded" });
    }

    let dir = audio_path.parent()?;
    let stem = audio_path.file_stem()?.to_str()?;

    if let Some(text) = lyrics_file_in(dir, stem).and_then(|f| read_text_file(&f)) {
        return Some(LocalLyrics { kind: kind_of(&text), text, source: "sidecar" });
    }

    // Both casings probed literally: on a case-sensitive filesystem they are
    // different folders; on macOS's default they resolve to the same one.
    for name in ["Lyrics", "lyrics"] {
        let sub = dir.join(name);
        if !sub.is_dir() {
            continue;
        }
        if let Some(text) = lyrics_file_in(&sub, stem).and_then(|f| read_text_file(&f)) {
            return Some(LocalLyrics { kind: kind_of(&text), text, source: "folder" });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const LRC: &str = "[ar:Artist]\n[00:12.30]First line\n[00:15.80]Second line\n";
    const PLAIN: &str = "First line\nSecond line\n";

    #[test]
    fn test_lrc_timestamps_classify_as_synced() {
        assert!(is_synced_lyrics(LRC));
        assert!(is_synced_lyrics("[0:05]short minute form"));
        assert!(is_synced_lyrics("  [112:00.5] over an hour, leading spaces"));
    }

    #[test]
    fn test_plain_text_and_bare_lrc_metadata_tags_classify_as_plain() {
        assert!(!is_synced_lyrics(PLAIN));
        // Metadata-only LRC tags carry no timeline — treating them as synced
        // would render an empty karaoke view.
        assert!(!is_synced_lyrics("[ar:Artist]\n[ti:Title]\njust words"));
        assert!(!is_synced_lyrics("[verse 1] not a timestamp"));
    }

    #[test]
    fn test_embedded_tag_lyrics_are_read_and_empty_frames_are_not() {
        use lofty::tag::{ItemKey, Tag, TagType};

        // ID3v2's USLT frame surfaces as UnsyncLyrics — ItemKey::Lyrics is
        // not a valid ID3v2 key in lofty, which is why both keys are probed.
        let mut id3 = Tag::new(TagType::Id3v2);
        assert!(id3.insert_text(ItemKey::UnsyncLyrics, LRC.to_string()));
        assert_eq!(lyrics_from_tag(&id3), Some(LRC.to_string()));

        // Vorbis carries the plain LYRICS comment under ItemKey::Lyrics.
        let mut vorbis = Tag::new(TagType::VorbisComments);
        assert!(vorbis.insert_text(ItemKey::Lyrics, PLAIN.to_string()));
        assert_eq!(lyrics_from_tag(&vorbis), Some(PLAIN.to_string()));

        let mut empty = Tag::new(TagType::Id3v2);
        empty.insert_text(ItemKey::UnsyncLyrics, "   \n ".to_string());
        assert_eq!(lyrics_from_tag(&empty), None);
        assert_eq!(lyrics_from_tag(&Tag::new(TagType::Id3v2)), None);
    }

    #[test]
    fn test_sidecar_lrc_wins_over_txt_and_reports_synced() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"not really audio").unwrap();
        fs::write(dir.path().join("song.txt"), PLAIN).unwrap();
        fs::write(dir.path().join("song.lrc"), LRC).unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert_eq!(found.source, "sidecar");
        assert_eq!(found.kind, "synced");
        assert_eq!(found.text, LRC);
    }

    #[test]
    fn test_txt_sidecar_reports_plain() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.flac");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("song.txt"), PLAIN).unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert_eq!(found.source, "sidecar");
        assert_eq!(found.kind, "plain");
    }

    #[test]
    fn test_lyrics_subfolder_is_probed_after_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        let sub = dir.path().join("Lyrics");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("song.lrc"), LRC).unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert_eq!(found.source, "folder");
        assert_eq!(found.kind, "synced");
    }

    #[test]
    fn test_a_wrong_stem_empty_file_or_missing_track_finds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("other.lrc"), LRC).unwrap();
        fs::write(dir.path().join("song.lrc"), "  \n ").unwrap(); // whitespace-only
        assert_eq!(probe_local_lyrics(&audio), None);
        assert_eq!(probe_local_lyrics(&dir.path().join("gone.mp3")), None);
    }

    #[test]
    fn test_bom_is_stripped_from_sidecar_text() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("song.lrc"), format!("\u{feff}{LRC}")).unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert!(found.text.starts_with("[ar:"));
        assert_eq!(found.kind, "synced");
    }
}
