use crate::entity_image::canonical_slug;
use crate::models::{BundleManifest, MixtapePreview, BundleTrack, MixtapeType};
use image::imageops::FilterType;
use image::GenericImageView;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read as IoRead, Write as IoWrite, BufReader, BufWriter};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::ZipArchive;

/// Generate the in-archive filename for a track audio file.
/// Format: `tracks/{zero-padded position}-{slug}.{ext}`
pub fn track_archive_path(position: usize, title: &str, source_path: &str) -> String {
    let ext = Path::new(source_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");
    let slug = canonical_slug(title);
    format!("tracks/{:02}-{}.{}", position + 1, slug, ext)
}

/// Generate the in-archive filename for a track thumbnail.
/// Format: `thumbs/{zero-padded position}.{ext}` — `jpg` unless the image had
/// to be packed as-is (see `archive_image`).
pub fn thumb_archive_path(position: usize, ext: &str) -> String {
    format!("thumbs/{:02}.{}", position + 1, ext)
}

/// The file name an extracted cover is written under: `cover.<ext>`, the
/// extension taken from the manifest's own cover entry when it names an image
/// format, else `jpg` (what every mixtape before webp/gif covers carried).
pub fn cover_file_name(manifest_cover: &str) -> String {
    let ext = Path::new(manifest_cover)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| matches!(e.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif"))
        .unwrap_or_else(|| "jpg".to_string());
    format!("cover.{}", ext)
}

/// Build a BundleManifest from export options and resolved track data.
pub fn build_manifest(
    title: String,
    mixtape_type: MixtapeType,
    metadata: HashMap<String, String>,
    created_by: Option<String>,
    tracks: Vec<BundleTrack>,
) -> BundleManifest {
    BundleManifest {
        version: 1,
        title,
        mixtape_type,
        metadata,
        created_at: chrono::Utc::now().to_rfc3339(),
        created_by,
        cover: None,
        tracks,
    }
}

/// Resize an image to fit within max_dimension, preserving aspect ratio, and return JPEG bytes.
fn resize_image_to_jpeg(path: &Path, max_dimension: u32) -> Result<Vec<u8>, String> {
    let img = image::open(path).map_err(|e| format!("Failed to open image: {}", e))?;
    encode_resized_jpeg(img, max_dimension)
}

fn encode_resized_jpeg(img: image::DynamicImage, max_dimension: u32) -> Result<Vec<u8>, String> {
    let (width, height) = img.dimensions();
    let needs_resize = width > max_dimension || height > max_dimension;

    let resized = if needs_resize {
        let scale = (max_dimension as f32) / width.max(height) as f32;
        let new_width = (width as f32 * scale) as u32;
        let new_height = (height as f32 * scale) as u32;
        img.resize(new_width, new_height, FilterType::Lanczos3)
    } else {
        img
    };

    let rgb = resized.to_rgb8();
    let mut jpeg_bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, 85);
    encoder
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("Failed to encode JPEG: {}", e))?;

    Ok(jpeg_bytes)
}

/// An image ready to go into a mixtape: `(bytes, extension)`. Resized to a JPEG
/// when the `image` crate can decode it (jpeg/png); a webp or gif — formats the
/// picker and the image cache accept but the build has no decoder for — is
/// packed as-is under its own extension rather than adding decoders for them.
/// Anything else is an error, which every caller treats as "leave it out".
fn archive_image(path: &Path, max_dimension: u32) -> Result<(Vec<u8>, &'static str), String> {
    match resize_image_to_jpeg(path, max_dimension) {
        Ok(bytes) => Ok((bytes, "jpg")),
        Err(decode_err) => {
            let bytes = std::fs::read(path).map_err(|e| format!("Failed to read image: {}", e))?;
            match crate::commands::sniff_image_ext(&bytes) {
                Some(ext @ ("webp" | "gif")) => Ok((bytes, ext)),
                _ => Err(decode_err),
            }
        }
    }
}

/// Write the cover into the archive, if there is one and it can be read. A
/// cover that can't is logged and left out — the mixtape is still worth
/// having without it. Returns the in-archive name for the manifest.
fn write_cover<W: IoWrite + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    cover_path: Option<&Path>,
    options: SimpleFileOptions,
) -> Result<Option<String>, String> {
    let Some(cp) = cover_path else { return Ok(None) };
    let (bytes, ext) = match archive_image(cp, 800) {
        Ok(image) => image,
        Err(e) => {
            log::warn!("Mixtape: leaving out the cover {}: {}", cp.display(), e);
            return Ok(None);
        }
    };
    let name = format!("cover.{}", ext);
    zip.start_file(&name, options)
        .map_err(|e| format!("Failed to start {}: {}", name, e))?;
    zip.write_all(&bytes)
        .map_err(|e| format!("Failed to write {}: {}", name, e))?;
    Ok(Some(name))
}

/// Write the thumbnails that can be read; one that can't is logged and that
/// track goes without. Returns the in-archive name per position.
fn write_thumbs<W: IoWrite + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    thumb_paths: &[Option<&str>],
    options: SimpleFileOptions,
) -> Result<Vec<Option<String>>, String> {
    let mut names = Vec::with_capacity(thumb_paths.len());
    for (i, thumb) in thumb_paths.iter().enumerate() {
        let Some(tp) = thumb else {
            names.push(None);
            continue;
        };
        let (bytes, ext) = match archive_image(Path::new(tp), 150) {
            Ok(image) => image,
            Err(e) => {
                log::warn!("Mixtape: leaving out the thumbnail {}: {}", tp, e);
                names.push(None);
                continue;
            }
        };
        let name = thumb_archive_path(i, ext);
        zip.start_file(&name, options)
            .map_err(|e| format!("Failed to start {}: {}", name, e))?;
        zip.write_all(&bytes)
            .map_err(|e| format!("Failed to write thumb: {}", e))?;
        names.push(Some(name));
    }
    Ok(names)
}

/// Write a mixtape to `<dest>.mixtape.tmp` and move it into place. `body`
/// writes every entry but the manifest and returns it. On any failure (or a
/// cancel) the partial `.tmp` is removed rather than left beside the user's
/// file.
fn write_mixtape_file<F>(dest_path: &Path, body: F) -> Result<u64, String>
where
    F: FnOnce(&mut ZipWriter<BufWriter<File>>, SimpleFileOptions) -> Result<BundleManifest, String>,
{
    let temp_path = dest_path.with_extension("mixtape.tmp");
    let file = File::create(&temp_path).map_err(|e| format!("Failed to create mixtape file: {}", e))?;
    let result = (|| -> Result<u64, String> {
        let mut zip = ZipWriter::new(BufWriter::new(file));
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let manifest = body(&mut zip, options)?;
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
        zip.start_file("manifest.json", options)
            .map_err(|e| format!("Failed to start manifest.json: {}", e))?;
        zip.write_all(manifest_json.as_bytes())
            .map_err(|e| format!("Failed to write manifest: {}", e))?;
        let final_zip = zip.finish().map_err(|e| format!("Failed to finalize ZIP: {}", e))?;
        let size = final_zip
            .into_inner()
            .map_err(|e| format!("Failed to flush ZIP: {}", e))?
            .metadata()
            .map_err(|e| format!("Failed to read metadata: {}", e))?
            .len();
        std::fs::rename(&temp_path, dest_path)
            .map_err(|e| format!("Failed to finalize mixtape file: {}", e))?;
        Ok(size)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

/// Source data for a single track to be included in a mixtape.
pub struct MixtapeTrackSource {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_secs: Option<f64>,
    pub audio_path: String,
    pub thumb_path: Option<String>,
}

/// Build a .mixtape ZIP archive.
///
/// Returns the file size in bytes on success.
pub fn build_mixtape<F>(
    dest_path: &Path,
    cover_path: Option<&Path>,
    track_sources: &[MixtapeTrackSource],
    mut manifest: BundleManifest,
    include_thumbs: bool,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<u64, String>
where
    F: FnMut(u32, u32, &str, u32),
{
    write_mixtape_file(dest_path, |zip, options| {
        manifest.cover = write_cover(zip, cover_path, options)?;

        // Build track entries for manifest
        let mut track_entries = Vec::new();

        // Write audio files
        let total_tracks = track_sources.len() as u32;
        for (i, source) in track_sources.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err("Mixtape creation cancelled".to_string());
            }

            let archive_path = track_archive_path(i, &source.title, &source.audio_path);
            on_progress(i as u32 + 1, total_tracks, &source.title, 0);

            let audio_file = File::open(&source.audio_path)
                .map_err(|e| format!("Failed to open audio file: {}", e))?;
            let mut reader = BufReader::new(audio_file);

            zip.start_file(&archive_path, options)
                .map_err(|e| format!("Failed to start {}: {}", archive_path, e))?;

            let mut buffer = vec![0u8; 65536]; // 64KB buffer
            loop {
                let bytes_read = reader
                    .read(&mut buffer)
                    .map_err(|e| format!("Failed to read audio: {}", e))?;
                if bytes_read == 0 {
                    break;
                }
                zip.write_all(&buffer[..bytes_read])
                    .map_err(|e| format!("Failed to write audio: {}", e))?;
            }

            track_entries.push(BundleTrack {
                title: source.title.clone(),
                artist: source.artist.clone(),
                album_artist: None,
                album: source.album.clone(),
                duration_secs: source.duration_secs,
                file: Some(archive_path),
                thumb: None,
                format: None,
                image_url: None,
                file_size: None,
            });
        }

        // A track's thumb is named in the manifest only once it was written.
        if include_thumbs {
            let paths: Vec<Option<&str>> =
                track_sources.iter().map(|s| s.thumb_path.as_deref()).collect();
            for (entry, name) in track_entries.iter_mut().zip(write_thumbs(zip, &paths, options)?) {
                entry.thumb = name;
            }
        }

        manifest.tracks = track_entries;
        Ok(manifest)
    })
}

/// Build a playlist-only .mixtape ZIP (manifest + cover + optional thumbnails, no audio files).
pub fn build_playlist_mixtape(
    dest_path: &Path,
    cover_path: Option<&Path>,
    mut manifest: BundleManifest,
    thumb_paths: &[Option<String>],
    include_thumbs: bool,
) -> Result<u64, String> {
    write_mixtape_file(dest_path, |zip, options| {
        if let Some(name) = write_cover(zip, cover_path, options)? {
            manifest.cover = Some(name);
        }
        if include_thumbs {
            let paths: Vec<Option<&str>> = thumb_paths.iter().map(|t| t.as_deref()).collect();
            for (i, name) in write_thumbs(zip, &paths, options)?.into_iter().enumerate() {
                if let (Some(name), Some(track)) = (name, manifest.tracks.get_mut(i)) {
                    track.thumb = Some(name);
                }
            }
        }
        Ok(manifest)
    })
}

/// Read and preview a .mixtape archive without extracting it.
///
/// Extracts the cover image to temp_dir and returns metadata.
pub fn read_mixtape(path: &Path, temp_dir: &Path) -> Result<MixtapePreview, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open mixtape: {}", e))?;
    let file_size = file
        .metadata()
        .map_err(|e| format!("Failed to read file size: {}", e))?
        .len();
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP archive: {}", e))?;
    let manifest = read_manifest(&mut archive)?;

    if manifest.version != 1 {
        return Err(format!("Unsupported mixtape version: {}", manifest.version));
    }

    // Extract cover to temp directory if present
    let cover_temp_path = if let Some(ref cover_name) = manifest.cover {
        if let Ok(mut cover_file) = archive.by_name(cover_name) {
            let cover_dest = temp_dir.join(format!("mixtape-{}", cover_file_name(cover_name)));
            let mut cover_out = File::create(&cover_dest)
                .map_err(|e| format!("Failed to create temp cover file: {}", e))?;
            std::io::copy(&mut cover_file, &mut cover_out)
                .map_err(|e| format!("Failed to extract cover: {}", e))?;
            Some(cover_dest.to_string_lossy().to_string())
        } else {
            None
        }
    } else {
        None
    };

    let total_duration_secs = manifest
        .tracks
        .iter()
        .filter_map(|t| t.duration_secs)
        .sum();

    Ok(MixtapePreview {
        manifest,
        cover_temp_path,
        file_size,
        total_duration_secs,
    })
}

/// Options for extracting a mixtape archive.
pub struct ExtractOptions {
    pub audio: bool,
    pub images: bool,
}

/// Extract a .mixtape archive to a destination directory.
///
/// Returns the manifest on success.
pub fn extract_mixtape<F>(
    path: &Path,
    dest_dir: &Path,
    options: &ExtractOptions,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<BundleManifest, String>
where
    F: FnMut(u32, u32, &str),
{
    let file = File::open(path).map_err(|e| format!("Failed to open mixtape: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP archive: {}", e))?;
    let manifest = read_manifest(&mut archive)?;

    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Failed to create destination directory: {}", e))?;

    let total_items = manifest.tracks.len() as u32;

    // Extract cover if images requested and cover exists
    if options.images {
        if let Some(ref cover_name) = manifest.cover {
            if let Ok(mut cover_file) = archive.by_name(cover_name) {
                let cover_dest = dest_dir.join(cover_file_name(cover_name));
                let mut cover_out = File::create(&cover_dest)
                    .map_err(|e| format!("Failed to create cover file: {}", e))?;
                std::io::copy(&mut cover_file, &mut cover_out)
                    .map_err(|e| format!("Failed to extract cover: {}", e))?;
            }
        }
    }

    // Extract tracks
    for (i, track) in manifest.tracks.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("Extraction cancelled".to_string());
        }

        on_progress(i as u32 + 1, total_items, &track.title);

        // Extract audio. The name comes from the archive, which may be
        // anyone's: `enclosed_name` refuses `../…` and absolute names, so
        // nothing is written outside `dest_dir`.
        if options.audio {
            if let Some(ref file) = track.file {
            let mut track_file = archive
                .by_name(file)
                .map_err(|_| format!("Track file not found: {}", file))?;
            let rel = track_file
                .enclosed_name()
                .ok_or_else(|| format!("Unsafe track path in mixtape: {}", file))?;
            let track_dest = dest_dir.join(rel);
            if let Some(parent) = track_dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create tracks directory: {}", e))?;
            }
            let mut track_out = File::create(&track_dest)
                .map_err(|e| format!("Failed to create track file: {}", e))?;
            std::io::copy(&mut track_file, &mut track_out)
                .map_err(|e| format!("Failed to extract track: {}", e))?;
            }
        }

        // Extract thumbnail
        if options.images {
            if let Some(ref thumb) = track.thumb {
                if let Ok(mut thumb_file) = archive.by_name(thumb) {
                    let Some(rel) = thumb_file.enclosed_name() else {
                        log::warn!("Mixtape: skipping unsafe thumbnail path {}", thumb);
                        continue;
                    };
                    let thumb_dest = dest_dir.join(rel);
                    if let Some(parent) = thumb_dest.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Ok(mut thumb_out) = File::create(&thumb_dest) {
                        let _ = std::io::copy(&mut thumb_file, &mut thumb_out);
                    }
                }
            }
        }
    }

    Ok(manifest)
}

/// The scheme of a track played straight out of a `.mixtape`:
/// `mixtape://<offset>+<length>@<absolute path of the .mixtape>`. Mixtapes
/// store their audio uncompressed, so each track is one contiguous byte range
/// of the archive and the engine reads it in place (mpv's `slice://`) — no
/// copy on disk. The frontend parses it in `queueEntry.ts` `parseUrlScheme`.
pub const ENTRY_SCHEME: &str = "mixtape://";

pub fn entry_uri(mixtape: &Path, offset: u64, length: u64) -> String {
    format!("{ENTRY_SCHEME}{offset}+{length}@{}", mixtape.to_string_lossy())
}

/// `entry_uri`'s inverse: `(offset, length, path of the .mixtape)`. The range
/// ends at the first `@`; everything after it is the path, whatever it holds.
pub fn parse_entry_uri(uri: &str) -> Option<(u64, u64, &str)> {
    let (range, path) = uri.strip_prefix(ENTRY_SCHEME)?.split_once('@')?;
    let (offset, length) = range.split_once('+')?;
    Some((offset.parse().ok()?, length.parse().ok()?, path))
}

/// Copy a `mixtape://` track's bytes out to `dir/<stem>.<ext>`, the extension
/// taken from the archive entry the range belongs to — so exporting a queue
/// played from a mixtape packs its audio like any local file.
pub fn extract_entry(uri: &str, dir: &Path, stem: &str) -> Result<String, String> {
    use std::io::{Seek, SeekFrom};
    let (offset, length, path) =
        parse_entry_uri(uri).ok_or_else(|| format!("Not a mixtape track: {}", uri))?;
    let file = File::open(path).map_err(|e| format!("Failed to open mixtape: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP archive: {}", e))?;
    let mut ext = None;
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(|e| e.to_string())?;
        if entry.data_start() == Some(offset) {
            ext = Path::new(entry.name())
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_string);
            break;
        }
    }
    let ext = ext.ok_or("The track is no longer in the mixtape")?;
    let dest = dir.join(format!("{}.{}", stem, ext));
    let mut src = File::open(path).map_err(|e| format!("Failed to open mixtape: {}", e))?;
    src.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut out = File::create(&dest).map_err(|e| e.to_string())?;
    let copied = std::io::copy(&mut src.take(length), &mut out).map_err(|e| e.to_string())?;
    if copied != length {
        return Err("The mixtape is shorter than its track".to_string());
    }
    Ok(dest.to_string_lossy().to_string())
}

/// A `.mixtape` opened for playback in place.
pub struct PlayableMixtape {
    pub manifest: BundleManifest,
    /// One per manifest track, same order.
    pub tracks: Vec<PlayableTrack>,
    /// The cover, copied out to the art folder.
    pub cover_path: Option<String>,
}

pub struct PlayableTrack {
    /// `mixtape://…` for a stored entry; `file://…` for one written
    /// compressed (another tool's archive), which had to be unpacked.
    pub path: Option<String>,
    pub thumb_path: Option<String>,
}

/// Open a `.mixtape` to play it without unpacking the audio. Only the images
/// (and an audio entry stored compressed, which can't be read in place) are
/// written, into `art_dir` — the queue copies the images into its own folder,
/// so they need to outlive nothing but this play.
pub fn open_for_play(path: &Path, art_dir: &Path) -> Result<PlayableMixtape, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open mixtape: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP archive: {}", e))?;
    let manifest = read_manifest(&mut archive)?;
    if manifest.version != 1 {
        return Err(format!("Unsupported mixtape version: {}", manifest.version));
    }
    std::fs::create_dir_all(art_dir)
        .map_err(|e| format!("Failed to create mixtape art folder: {}", e))?;

    let cover_path = manifest
        .cover
        .as_ref()
        .and_then(|name| copy_entry_out(&mut archive, name, art_dir));
    let mut tracks = Vec::with_capacity(manifest.tracks.len());
    for track in &manifest.tracks {
        // One broken entry (missing from the zip, or deflated under an unsafe
        // name) costs that track its audio, not the whole mixtape — it is
        // left metadata-only, for the stream resolvers to find.
        let path = track.file.as_ref().and_then(|name| {
            playable_entry(&mut archive, path, name, art_dir)
                .map_err(|e| log::warn!("Mixtape: {}", e))
                .ok()
        });
        let thumb_path = track
            .thumb
            .as_ref()
            .and_then(|name| copy_entry_out(&mut archive, name, art_dir));
        tracks.push(PlayableTrack { path, thumb_path });
    }
    Ok(PlayableMixtape { manifest, tracks, cover_path })
}

/// Largest cover entry `cover_data_uri` will read; a real one is well under a
/// megabyte (exports resize to 800px), and this is a stranger's archive.
const COVER_READ_CAP: u64 = 16 * 1024 * 1024;
/// Largest cover passed through as-is when it can't be resized (webp/gif).
const COVER_PASSTHROUGH_CAP: usize = 512 * 1024;

/// A mixtape's cover as a small `data:` URI, read in memory — nothing is
/// written to disk. Backs the Home "Latest play" card of a mixtape the user
/// opened: the cover a play extracts lives in a temp folder emptied at the
/// next launch, and the card should need nothing but the `.mixtape` itself.
/// The cover is shrunk to `max_dimension` (the card is small, and the URI is
/// kept in the Home snapshot); a webp/gif the build can't decode is passed
/// through when small enough. `Ok(None)`: no cover, or one that can't be shown.
pub fn cover_data_uri(path: &Path, max_dimension: u32) -> Result<Option<String>, String> {
    use base64::Engine;
    let file = File::open(path).map_err(|e| format!("Failed to open mixtape: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP archive: {}", e))?;
    let Some(name) = read_manifest(&mut archive)?.cover else { return Ok(None) };
    let bytes = {
        let Ok(entry) = archive.by_name(&name) else { return Ok(None) };
        if entry.size() > COVER_READ_CAP {
            return Ok(None);
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .take(COVER_READ_CAP)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Failed to read cover: {}", e))?;
        bytes
    };
    let encoded = match image::load_from_memory(&bytes) {
        Ok(img) => ("image/jpeg", encode_resized_jpeg(img, max_dimension)?),
        Err(_) => match crate::commands::sniff_image_ext(&bytes) {
            Some(ext @ ("webp" | "gif")) if bytes.len() <= COVER_PASSTHROUGH_CAP => {
                (if ext == "webp" { "image/webp" } else { "image/gif" }, bytes)
            }
            _ => return Ok(None),
        },
    };
    Ok(Some(format!(
        "data:{};base64,{}",
        encoded.0,
        base64::engine::general_purpose::STANDARD.encode(encoded.1)
    )))
}

fn read_manifest(archive: &mut ZipArchive<File>) -> Result<BundleManifest, String> {
    let mut manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| "manifest.json not found in mixtape".to_string())?;
    let mut manifest_str = String::new();
    manifest_file
        .read_to_string(&mut manifest_str)
        .map_err(|e| format!("Failed to read manifest: {}", e))?;
    serde_json::from_str::<BundleManifest>(&manifest_str)
        .map_err(|e| format!("Failed to parse manifest: {}", e))
}

fn playable_entry(
    archive: &mut ZipArchive<File>,
    mixtape: &Path,
    name: &str,
    art_dir: &Path,
) -> Result<String, String> {
    {
        let entry = archive
            .by_name(name)
            .map_err(|_| format!("Track file not found: {}", name))?;
        if entry.compression() == zip::CompressionMethod::Stored && !entry.encrypted() {
            if let Some(start) = entry.data_start() {
                return Ok(entry_uri(mixtape, start, entry.compressed_size()));
            }
        }
    }
    let dest = copy_entry_out(archive, name, art_dir)
        .ok_or_else(|| format!("Failed to unpack track: {}", name))?;
    Ok(format!("file://{}", dest))
}

/// Copy one entry into `dir` under its own in-archive path, which must stay
/// inside `dir` (a third-party archive may name `../…`). Best-effort: the
/// failure is logged and the caller goes without.
fn copy_entry_out(archive: &mut ZipArchive<File>, name: &str, dir: &Path) -> Option<String> {
    let result = (|| -> Result<String, String> {
        let mut entry = archive.by_name(name).map_err(|e| e.to_string())?;
        let rel = entry.enclosed_name().ok_or("unsafe path in archive")?;
        let dest = dir.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        Ok(dest.to_string_lossy().to_string())
    })();
    result
        .map_err(|e| log::warn!("Mixtape: couldn't copy out {}: {}", name, e))
        .ok()
}

/// Where this run puts the images of the mixtapes it plays:
/// `temp/mixtape_play/<run>/<n>/`, a fresh folder per play. Per run so the
/// startup sweep can clear earlier runs' folders without touching one in use;
/// per play so opening a second mixtape never overwrites the first one's
/// files while its queue still points at them.
pub fn play_art_dir(temp_dir: &Path) -> std::path::PathBuf {
    use std::sync::atomic::AtomicU32;
    static NEXT: AtomicU32 = AtomicU32::new(0);
    temp_dir
        .join(PLAY_ART_DIR)
        .join(run_id())
        .join(NEXT.fetch_add(1, Ordering::Relaxed).to_string())
}

const PLAY_ART_DIR: &str = "mixtape_play";

fn run_id() -> &'static str {
    static RUN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    RUN.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{}-{}", std::process::id(), nanos)
    })
}

/// Startup sweep: earlier runs' mixtape art folders, plus `mixtape_playback`,
/// where mixtapes used to be unpacked whole before they were played in place.
/// Leaves this run's folder alone, so it can run concurrently with a play.
pub fn sweep_play_leftovers(temp_dir: &Path) {
    let legacy = temp_dir.join("mixtape_playback");
    if legacy.exists() {
        if let Err(e) = std::fs::remove_dir_all(&legacy) {
            log::warn!("Mixtape: couldn't remove {}: {}", legacy.display(), e);
        }
    }
    let Ok(entries) = std::fs::read_dir(temp_dir.join(PLAY_ART_DIR)) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == run_id() {
            continue;
        }
        if let Err(e) = std::fs::remove_dir_all(entry.path()) {
            log::warn!("Mixtape: couldn't remove {}: {}", entry.path().display(), e);
        }
    }
}

/// A `.mixtape` the OS asked us to open (Explorer double-click, "Open with",
/// macOS Finder) that the frontend hasn't played yet. Managed on the Builder
/// *before* the single-instance plugin registers, like `PendingProfileSwitch`.
/// The frontend consumes it via `take_pending_mixtape_open` once the restored
/// queue is applied; the `mixtape-file-opened` event is only a nudge. A stash
/// is needed because a cold launch delivers the path before any listener
/// exists — an event alone is simply lost.
#[derive(Default)]
pub struct PendingMixtapeOpen(pub std::sync::Mutex<Option<String>>);

impl PendingMixtapeOpen {
    pub fn stash(&self, path: String) {
        // Poison-tolerant: a panic elsewhere must not turn a double-click
        // into a crash of the running app.
        if let Ok(mut pending) = self.0.lock() {
            *pending = Some(path);
        }
    }
}

/// The `.mixtape` path in a launch argv, if any. Windows file associations
/// launch `viboplr.exe "<path>"`, so the path is a plain argument. `argv[0]`
/// (the executable) is skipped; the last match wins.
pub fn mixtape_path_from_argv(argv: &[String]) -> Option<String> {
    argv.iter()
        .skip(1)
        .filter(|a| !a.starts_with("--"))
        .filter(|a| is_mixtape_path(Path::new(a)))
        .last()
        .cloned()
}

/// Whether a path names a `.mixtape` file (by extension, any case).
pub fn is_mixtape_path(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("mixtape"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_mixtape_path_from_argv_finds_the_file_argument() {
        assert_eq!(
            mixtape_path_from_argv(&argv(&["C:\\Viboplr\\viboplr.exe", "D:\\Music\\Road Trip.mixtape"])),
            Some("D:\\Music\\Road Trip.mixtape".to_string())
        );
        // Extension match is case-insensitive (Windows paths often aren't).
        assert_eq!(
            mixtape_path_from_argv(&argv(&["viboplr", "--profile", "work", "/m/x.MIXTAPE"])),
            Some("/m/x.MIXTAPE".to_string())
        );
    }

    #[test]
    fn test_mixtape_path_from_argv_ignores_everything_else() {
        assert_eq!(mixtape_path_from_argv(&argv(&["viboplr.mixtape"])), None); // argv[0]
        assert_eq!(mixtape_path_from_argv(&argv(&["viboplr", "--profile", "work"])), None);
        assert_eq!(mixtape_path_from_argv(&argv(&["viboplr", "viboplr://quiz"])), None);
        assert_eq!(mixtape_path_from_argv(&argv(&["viboplr", "song.mp3"])), None);
    }

    #[test]
    fn test_track_archive_path() {
        assert_eq!(
            track_archive_path(0, "Karma Police", "/music/karma-police.flac"),
            "tracks/01-karma police.flac"
        );
        assert_eq!(
            track_archive_path(9, "Exit Music (For a Film)", "/music/exit.mp3"),
            "tracks/10-exit music (for a film).mp3"
        );
    }

    #[test]
    fn test_track_archive_path_unicode() {
        assert_eq!(
            track_archive_path(0, "Björk - Jóga", "/music/joga.flac"),
            "tracks/01-bjork - joga.flac"
        );
    }

    #[test]
    fn test_thumb_archive_path() {
        assert_eq!(thumb_archive_path(0, "jpg"), "thumbs/01.jpg");
        assert_eq!(thumb_archive_path(11, "webp"), "thumbs/12.webp");
    }

    #[test]
    fn test_build_manifest() {
        let manifest = build_manifest(
            "Test Mixtape".into(),
            MixtapeType::Custom,
            HashMap::new(),
            Some("alex".into()),
            vec![BundleTrack {
                title: "Track 1".into(),
                artist: "Artist".into(),
                album_artist: None,
                album: None,
                duration_secs: Some(180.0),
                file: Some("tracks/01-track-1.flac".into()),
                thumb: None,
                format: None,
                image_url: None,
                file_size: None,
            }],
        );
        assert_eq!(manifest.version, 1);
        assert_eq!(manifest.title, "Test Mixtape");
        assert_eq!(manifest.cover, None);
        assert_eq!(manifest.tracks.len(), 1);
    }

    #[test]
    fn test_manifest_json_roundtrip() {
        let manifest = build_manifest(
            "Roundtrip Test".into(),
            MixtapeType::BestOfArtist,
            HashMap::new(),
            None,
            vec![],
        );
        let json = serde_json::to_string(&manifest).unwrap();
        let parsed: BundleManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.title, "Roundtrip Test");
        assert_eq!(parsed.version, 1);
    }

    #[test]
    fn test_build_mixtape_creates_valid_zip() {
        let tmp = tempfile::tempdir().unwrap();

        let audio_path = tmp.path().join("song.mp3");
        std::fs::write(&audio_path, b"fake mp3 data").unwrap();

        let cover_path = tmp.path().join("cover.jpg");
        let img = image::RgbImage::from_pixel(100, 100, image::Rgb([255, 0, 0]));
        img.save(&cover_path).unwrap();

        let dest = tmp.path().join("test.mixtape");
        let manifest = build_manifest(
            "Test".into(),
            MixtapeType::Custom,
            HashMap::new(),
            None,
            vec![],
        );
        let sources = vec![MixtapeTrackSource {
            title: "Song One".into(),
            artist: "Artist".into(),
            album: Some("Album".into()),
            duration_secs: Some(180.0),
            audio_path: audio_path.to_str().unwrap().to_string(),
            thumb_path: None,
        }];
        let cancel = AtomicBool::new(false);
        let size = build_mixtape(&dest, Some(cover_path.as_path()), &sources, manifest, false, &cancel, |_, _, _, _| {}).unwrap();
        assert!(size > 0);
        assert!(dest.exists());

        // Verify ZIP contents
        let file = File::open(&dest).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.contains(&"manifest.json".to_string()));
        assert!(names.contains(&"cover.jpg".to_string()));
        assert!(names.iter().any(|n| n.starts_with("tracks/")));

        // Verify manifest is valid JSON
        let mut manifest_file = archive.by_name("manifest.json").unwrap();
        let mut manifest_str = String::new();
        manifest_file.read_to_string(&mut manifest_str).unwrap();
        let parsed: BundleManifest = serde_json::from_str(&manifest_str).unwrap();
        assert_eq!(parsed.title, "Test");
        assert_eq!(parsed.tracks.len(), 1);
        assert_eq!(parsed.tracks[0].title, "Song One");
    }

    fn create_test_mixtape(dir: &Path) -> std::path::PathBuf {
        let audio_path = dir.join("song.mp3");
        std::fs::write(&audio_path, b"fake mp3 data for testing").unwrap();
        let cover_path = dir.join("cover.jpg");
        let img = image::RgbImage::from_pixel(100, 100, image::Rgb([0, 128, 255]));
        img.save(&cover_path).unwrap();
        let dest = dir.join("test.mixtape");
        let manifest = build_manifest(
            "Preview Test".into(),
            MixtapeType::Album,
            HashMap::new(),
            Some("tester".into()),
            vec![],
        );
        let sources = vec![MixtapeTrackSource {
            title: "Test Song".into(),
            artist: "Test Artist".into(),
            album: Some("Test Album".into()),
            duration_secs: Some(200.0),
            audio_path: audio_path.to_str().unwrap().to_string(),
            thumb_path: Some(cover_path.to_str().unwrap().to_string()),
        }];
        let cancel = AtomicBool::new(false);
        build_mixtape(&dest, Some(cover_path.as_path()), &sources, manifest, true, &cancel, |_, _, _, _| {}).unwrap();
        dest
    }

    #[test]
    fn test_read_mixtape() {
        let tmp = tempfile::tempdir().unwrap();
        let mixtape_path = create_test_mixtape(tmp.path());
        let preview = read_mixtape(&mixtape_path, tmp.path()).unwrap();
        assert_eq!(preview.manifest.title, "Preview Test");
        assert_eq!(preview.manifest.tracks.len(), 1);
        assert_eq!(preview.manifest.tracks[0].artist, "Test Artist");
        assert!(preview.file_size > 0);
        assert!((preview.total_duration_secs - 200.0).abs() < 0.1);
        assert!(preview.cover_temp_path.as_ref().map(|p| Path::new(p).exists()).unwrap_or(false));
    }

    #[test]
    fn test_extract_mixtape_audio_only() {
        let tmp = tempfile::tempdir().unwrap();
        let mixtape_path = create_test_mixtape(tmp.path());
        let extract_dir = tmp.path().join("extracted");
        let cancel = AtomicBool::new(false);
        let manifest = extract_mixtape(
            &mixtape_path,
            &extract_dir,
            &ExtractOptions {
                audio: true,
                images: false,
            },
            &cancel,
            |_, _, _| {},
        )
        .unwrap();
        assert_eq!(manifest.tracks.len(), 1);
        assert!(extract_dir.join(manifest.tracks[0].file.as_ref().unwrap()).exists());
        assert!(!extract_dir.join("cover.jpg").exists());
    }

    #[test]
    fn test_extract_mixtape_full() {
        let tmp = tempfile::tempdir().unwrap();
        let mixtape_path = create_test_mixtape(tmp.path());
        let extract_dir = tmp.path().join("full");
        let cancel = AtomicBool::new(false);
        let manifest = extract_mixtape(
            &mixtape_path,
            &extract_dir,
            &ExtractOptions {
                audio: true,
                images: true,
            },
            &cancel,
            |_, _, _| {},
        )
        .unwrap();
        assert!(extract_dir.join("cover.jpg").exists());
        assert!(extract_dir.join(manifest.tracks[0].file.as_ref().unwrap()).exists());
        if let Some(ref thumb) = manifest.tracks[0].thumb {
            assert!(extract_dir.join(thumb).exists());
        }
    }

    #[test]
    fn test_build_mixtape_cancellation() {
        let tmp = tempfile::tempdir().unwrap();
        let audio_path = tmp.path().join("song.mp3");
        std::fs::write(&audio_path, b"data").unwrap();
        let cover_path = tmp.path().join("cover.jpg");
        let img = image::RgbImage::from_pixel(10, 10, image::Rgb([0, 0, 0]));
        img.save(&cover_path).unwrap();
        let dest = tmp.path().join("cancelled.mixtape");
        let manifest = build_manifest(
            "X".into(),
            MixtapeType::Custom,
            HashMap::new(),
            None,
            vec![],
        );
        let sources = vec![MixtapeTrackSource {
            title: "S".into(),
            artist: "A".into(),
            album: None,
            duration_secs: None,
            audio_path: audio_path.to_str().unwrap().to_string(),
            thumb_path: None,
        }];
        let cancel = AtomicBool::new(true);
        let result = build_mixtape(&dest, Some(cover_path.as_path()), &sources, manifest, false, &cancel, |_, _, _, _| {});
        assert!(result.is_err());
        assert!(!dest.exists());
    }

    #[test]
    fn test_open_for_play_points_at_the_audio_bytes_inside_the_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let mixtape_path = create_test_mixtape(tmp.path());
        let art = tmp.path().join("art");

        let opened = open_for_play(&mixtape_path, &art).unwrap();

        assert_eq!(opened.tracks.len(), 1);
        let uri = opened.tracks[0].path.as_deref().unwrap();
        let (offset, length, path) = parse_entry_uri(uri).expect("mixtape:// uri");
        assert_eq!(path, mixtape_path.to_string_lossy());
        let bytes = std::fs::read(&mixtape_path).unwrap();
        assert_eq!(
            &bytes[offset as usize..(offset + length) as usize],
            b"fake mp3 data for testing",
            "the range must be exactly the stored track"
        );
        // No audio is written anywhere; only the images are copied out.
        let thumb = opened.tracks[0].thumb_path.as_deref().unwrap();
        assert!(Path::new(thumb).starts_with(&art) && Path::new(thumb).exists());
        let cover = opened.cover_path.as_deref().unwrap();
        assert!(Path::new(cover).starts_with(&art) && Path::new(cover).exists());
        assert!(!art.join("tracks").exists());
    }

    #[test]
    fn test_cover_data_uri_reads_the_cover_in_memory_and_shrinks_it() {
        let tmp = tempfile::tempdir().unwrap();
        let mixtape_path = create_test_mixtape(tmp.path());
        let before: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().path()).collect();

        let uri = cover_data_uri(&mixtape_path, 40).unwrap().expect("the fixture has a cover");

        let b64 = uri.strip_prefix("data:image/jpeg;base64,").expect("a JPEG data URI");
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!(img.dimensions(), (40, 40), "shrunk to the card size");
        let after: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(before, after, "nothing is written next to the mixtape");
    }

    #[test]
    fn test_cover_data_uri_is_none_without_a_cover() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("plain.mixtape");
        let manifest = build_manifest("No Cover".into(), MixtapeType::Custom, HashMap::new(), None, vec![]);
        build_playlist_mixtape(&dest, None, manifest, &[], false).unwrap();
        assert_eq!(cover_data_uri(&dest, 40).unwrap(), None);
    }

    #[test]
    fn test_is_mixtape_path() {
        assert!(is_mixtape_path(Path::new("/a/Road Trip.mixtape")));
        assert!(is_mixtape_path(Path::new("C:\\a\\X.MIXTAPE")));
        assert!(!is_mixtape_path(Path::new("/a/cover.jpg")));
        assert!(!is_mixtape_path(Path::new("/a/mixtape")));
    }

    #[test]
    fn test_open_for_play_unpacks_a_track_stored_compressed() {
        // Another tool may deflate its entries; such a track can't be read in
        // place, so it is unpacked into the art folder instead. An entry whose
        // name climbs out of the folder is skipped, not written.
        let tmp = tempfile::tempdir().unwrap();
        let mixtape_path = tmp.path().join("deflated.mixtape");
        let manifest = build_manifest(
            "Deflated".into(),
            MixtapeType::Custom,
            HashMap::new(),
            None,
            vec![BundleTrack {
                title: "Song".into(),
                artist: "Artist".into(),
                album_artist: None,
                album: None,
                duration_secs: None,
                file: Some("tracks/01-song.mp3".into()),
                thumb: Some("../escape.jpg".into()),
                format: None,
                image_url: None,
                file_size: None,
            }],
        );
        {
            let mut zip = ZipWriter::new(File::create(&mixtape_path).unwrap());
            let deflated = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("manifest.json", deflated).unwrap();
            zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes()).unwrap();
            zip.start_file("tracks/01-song.mp3", deflated).unwrap();
            zip.write_all(&[7u8; 4096]).unwrap();
            zip.start_file("../escape.jpg", deflated).unwrap();
            zip.write_all(b"jpg").unwrap();
            zip.finish().unwrap();
        }
        let art = tmp.path().join("play").join("art");

        let opened = open_for_play(&mixtape_path, &art).unwrap();

        let path = opened.tracks[0].path.as_deref().unwrap();
        let file = path.strip_prefix("file://").expect("an unpacked file");
        assert!(Path::new(file).starts_with(&art));
        assert_eq!(std::fs::read(file).unwrap(), vec![7u8; 4096]);
        assert_eq!(opened.tracks[0].thumb_path, None);
        assert!(!tmp.path().join("play").join("escape.jpg").exists());
    }

    #[test]
    fn test_build_mixtape_packs_webp_as_is_and_skips_unreadable_images() {
        // The build has no webp/gif decoder, but the picker and the image
        // cache both hand those over: they are packed as they are. An image
        // nothing can read costs that image, never the export.
        let tmp = tempfile::tempdir().unwrap();
        let audio = tmp.path().join("song.mp3");
        std::fs::write(&audio, b"audio").unwrap();
        let webp = tmp.path().join("cover.webp");
        let mut webp_bytes = b"RIFF\x10\x00\x00\x00WEBPVP8 ".to_vec();
        webp_bytes.extend_from_slice(&[0u8; 8]);
        std::fs::write(&webp, &webp_bytes).unwrap();
        let junk = tmp.path().join("junk.jpg");
        std::fs::write(&junk, b"not an image").unwrap();
        let source = |title: &str, thumb: &Path| MixtapeTrackSource {
            title: title.into(),
            artist: "Artist".into(),
            album: None,
            duration_secs: None,
            audio_path: audio.to_string_lossy().to_string(),
            thumb_path: Some(thumb.to_string_lossy().to_string()),
        };
        let dest = tmp.path().join("out.mixtape");
        let manifest = build_manifest("Webp".into(), MixtapeType::Custom, HashMap::new(), None, vec![]);
        let cancel = AtomicBool::new(false);

        build_mixtape(
            &dest, Some(webp.as_path()), &[source("One", &webp), source("Two", &junk)],
            manifest, true, &cancel, |_, _, _, _| {},
        )
        .unwrap();

        let mut archive = ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        let parsed = read_manifest(&mut archive).unwrap();
        assert_eq!(parsed.cover.as_deref(), Some("cover.webp"));
        assert_eq!(parsed.tracks[0].thumb.as_deref(), Some("thumbs/01.webp"));
        assert_eq!(parsed.tracks[1].thumb, None, "an unreadable thumb is left out of the manifest too");
        let mut cover = Vec::new();
        archive.by_name("cover.webp").unwrap().read_to_end(&mut cover).unwrap();
        assert_eq!(cover, webp_bytes);
        assert!(archive.by_name("thumbs/02.jpg").is_err());

        // Extracting names the cover after its entry.
        let out = tmp.path().join("extracted");
        extract_mixtape(&dest, &out, &ExtractOptions { audio: false, images: true }, &cancel, |_, _, _| {}).unwrap();
        assert!(out.join("cover.webp").exists());
    }

    #[test]
    fn test_a_failed_build_leaves_no_tmp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("out.mixtape");
        let manifest = build_manifest("X".into(), MixtapeType::Custom, HashMap::new(), None, vec![]);
        let missing = MixtapeTrackSource {
            title: "Gone".into(),
            artist: "A".into(),
            album: None,
            duration_secs: None,
            audio_path: tmp.path().join("gone.mp3").to_string_lossy().to_string(),
            thumb_path: None,
        };
        let cancel = AtomicBool::new(false);

        assert!(build_mixtape(&dest, None, &[missing], manifest, false, &cancel, |_, _, _, _| {}).is_err());

        assert!(!dest.exists());
        assert!(!dest.with_extension("mixtape.tmp").exists());
    }

    #[test]
    fn test_cover_file_name_follows_the_entry() {
        assert_eq!(cover_file_name("cover.jpg"), "cover.jpg");
        assert_eq!(cover_file_name("cover.WEBP"), "cover.webp");
        assert_eq!(cover_file_name("art/front.gif"), "cover.gif");
        assert_eq!(cover_file_name("../../evil.sh"), "cover.jpg");
        assert_eq!(cover_file_name("cover"), "cover.jpg");
    }

    #[test]
    fn test_extract_mixtape_never_writes_outside_the_destination() {
        // A mixtape from anywhere may name `../…` entries in its manifest and
        // zip alike. An unsafe track fails the extract; an unsafe thumbnail is
        // skipped; neither is written outside `dest_dir`.
        let tmp = tempfile::tempdir().unwrap();
        let hostile = |name: &str, file: &str, thumb: &str| {
            let path = tmp.path().join(name);
            let manifest = build_manifest(
                "Hostile".into(),
                MixtapeType::Custom,
                HashMap::new(),
                None,
                vec![BundleTrack {
                    title: "Song".into(),
                    artist: "Artist".into(),
                    album_artist: None,
                    album: None,
                    duration_secs: None,
                    file: Some(file.into()),
                    thumb: Some(thumb.into()),
                    format: None,
                    image_url: None,
                    file_size: None,
                }],
            );
            let mut zip = ZipWriter::new(File::create(&path).unwrap());
            let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            zip.start_file("manifest.json", stored).unwrap();
            zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes()).unwrap();
            zip.start_file(file, stored).unwrap();
            zip.write_all(b"audio").unwrap();
            zip.start_file(thumb, stored).unwrap();
            zip.write_all(b"jpg").unwrap();
            zip.finish().unwrap();
            path
        };
        let dest = tmp.path().join("a").join("b").join("dest");
        let opts = ExtractOptions { audio: true, images: true };
        let cancel = AtomicBool::new(false);

        let bad_track = hostile("t.mixtape", "../../escaped-track.mp3", "thumbs/01.jpg");
        // The hostile name really is in the zip, so the refusal below is the
        // guard's, not a "not found".
        let mut raw = ZipArchive::new(File::open(&bad_track).unwrap()).unwrap();
        assert!(raw.by_name("../../escaped-track.mp3").is_ok());
        let err = extract_mixtape(&bad_track, &dest, &opts, &cancel, |_, _, _| {}).unwrap_err();
        assert!(err.contains("Unsafe track path"), "{err}");
        assert!(!tmp.path().join("a").join("escaped-track.mp3").exists());

        let bad_thumb = hostile("p.mixtape", "tracks/01-song.mp3", "../../escaped-thumb.jpg");
        let mut raw = ZipArchive::new(File::open(&bad_thumb).unwrap()).unwrap();
        assert!(raw.by_name("../../escaped-thumb.jpg").is_ok());
        extract_mixtape(&bad_thumb, &dest, &opts, &cancel, |_, _, _| {}).unwrap();
        assert!(dest.join("tracks/01-song.mp3").exists());
        assert!(!tmp.path().join("a").join("escaped-thumb.jpg").exists());
    }

    #[test]
    fn test_open_for_play_keeps_the_rest_when_one_track_is_missing() {
        // A manifest naming a file the zip doesn't hold leaves that track
        // metadata-only; the other tracks still play in place.
        let tmp = tempfile::tempdir().unwrap();
        let mixtape_path = tmp.path().join("gap.mixtape");
        let track = |title: &str, file: &str| BundleTrack {
            title: title.into(),
            artist: "Artist".into(),
            album_artist: None,
            album: None,
            duration_secs: None,
            file: Some(file.into()),
            thumb: None,
            format: None,
            image_url: None,
            file_size: None,
        };
        let manifest = build_manifest(
            "Gap".into(),
            MixtapeType::Custom,
            HashMap::new(),
            None,
            vec![track("Gone", "tracks/01-gone.mp3"), track("Here", "tracks/02-here.mp3")],
        );
        {
            let mut zip = ZipWriter::new(File::create(&mixtape_path).unwrap());
            let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            zip.start_file("manifest.json", stored).unwrap();
            zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes()).unwrap();
            zip.start_file("tracks/02-here.mp3", stored).unwrap();
            zip.write_all(b"here").unwrap();
            zip.finish().unwrap();
        }

        let opened = open_for_play(&mixtape_path, &tmp.path().join("art")).unwrap();

        assert_eq!(opened.tracks.len(), 2);
        assert_eq!(opened.tracks[0].path, None);
        assert!(opened.tracks[1].path.as_deref().unwrap().starts_with(ENTRY_SCHEME));
    }

    #[test]
    fn test_extract_entry_copies_the_track_out_with_its_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let mixtape_path = create_test_mixtape(tmp.path());
        let opened = open_for_play(&mixtape_path, &tmp.path().join("art")).unwrap();
        let uri = opened.tracks[0].path.as_deref().unwrap();
        let out = tmp.path().join("export");
        std::fs::create_dir_all(&out).unwrap();

        let extracted = extract_entry(uri, &out, "000").unwrap();

        assert_eq!(Path::new(&extracted), out.join("000.mp3"));
        assert_eq!(std::fs::read(&extracted).unwrap(), b"fake mp3 data for testing");
        assert!(extract_entry("mixtape://1+2@/nowhere.mixtape", &out, "001").is_err());
    }

    #[test]
    fn test_play_art_dir_is_new_per_play_and_survives_the_sweep() {
        let tmp = tempfile::tempdir().unwrap();
        let temp_dir = tmp.path();
        let first = play_art_dir(temp_dir);
        let second = play_art_dir(temp_dir);
        assert_ne!(first, second);
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(temp_dir.join(PLAY_ART_DIR).join("1234-5678")).unwrap();
        std::fs::create_dir_all(temp_dir.join("mixtape_playback").join("tracks")).unwrap();

        sweep_play_leftovers(temp_dir);

        assert!(first.exists(), "this run's folder must survive");
        assert!(!temp_dir.join(PLAY_ART_DIR).join("1234-5678").exists());
        assert!(!temp_dir.join("mixtape_playback").exists());
    }
}
