use std::path::Path;
use std::sync::Arc;

use lofty::picture::PictureType;
use lofty::prelude::*;

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
    ) -> Result<String, String> {
        let track_path = self
            .db
            .get_track_path_for_album(album_title, artist_name)
            .map_err(|e| format!("DB lookup failed: {}", e))?
            .ok_or("No local track found for album")?;

        let tagged_file = crate::tag_writer::read_tagged_file(&track_path)
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

        let (data, sniffed) = trim_to_image_start(picture.data());

        // Extension from the bytes when they're recognisable, else the tag's mime type
        let ext = sniffed.unwrap_or(match picture.mime_type() {
            Some(lofty::picture::MimeType::Png) => "png",
            _ => "jpg",
        });

        // Replace the .jpg extension in dest_path with the correct one
        let actual_dest = dest_path.with_extension(ext);

        write_image(&actual_dest, data)?;
        Ok(self.name().to_string())
    }
}

/// How far into a picture frame's data to look for the image signature.
const MAX_LEADING_JUNK: usize = 16;

/// Strips a short run of junk before the image signature, returning the image bytes and
/// the extension the signature implies (`None` when no signature is found — the data is
/// then returned untouched).
///
/// Some taggers write a malformed ID3 APIC frame — e.g. a UTF-16 two-byte description
/// terminator under a UTF-8/Latin-1 encoding byte — so the picture data lofty hands back
/// starts with stray `00` bytes. Other players sniff past them; written out verbatim the
/// file isn't a decodable image and the album shows a broken cover.
fn trim_to_image_start(data: &[u8]) -> (&[u8], Option<&'static str>) {
    const SIGNATURES: &[(&[u8], &str)] = &[
        (&[0xFF, 0xD8, 0xFF], "jpg"),
        (&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A], "png"),
    ];
    let window = &data[..data.len().min(MAX_LEADING_JUNK + 8)];
    for start in 0..=MAX_LEADING_JUNK.min(data.len()) {
        for (sig, ext) in SIGNATURES {
            if window[start..].starts_with(sig) {
                return (&data[start..], Some(ext));
            }
        }
    }
    (data, None)
}

#[cfg(test)]
mod tests {
    use super::trim_to_image_start;

    #[test]
    fn clean_jpeg_and_png_are_untouched() {
        let jpg = [0xFF, 0xD8, 0xFF, 0xE0, 1, 2];
        assert_eq!(trim_to_image_start(&jpg), (&jpg[..], Some("jpg")));
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 9];
        assert_eq!(trim_to_image_start(&png), (&png[..], Some("png")));
    }

    #[test]
    fn leading_nulls_from_a_malformed_apic_frame_are_skipped() {
        // Shape seen in the wild: two stray nulls before the JPEG SOI.
        let data = [0x00, 0x00, 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        assert_eq!(trim_to_image_start(&data), (&data[2..], Some("jpg")));
        let png = [0, 0, 0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(trim_to_image_start(&png), (&png[2..], Some("png")));
    }

    #[test]
    fn unrecognised_or_tiny_data_is_returned_as_is() {
        let data = [b'G', b'I', b'F', b'8', b'9', b'a'];
        assert_eq!(trim_to_image_start(&data), (&data[..], None));
        assert_eq!(trim_to_image_start(&[]), (&[][..], None));
        let junk = [0u8; 40];
        assert_eq!(trim_to_image_start(&junk), (&junk[..], None));
    }
}
