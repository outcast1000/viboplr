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
/// Format: `thumbs/{zero-padded position}.jpg`
pub fn thumb_archive_path(position: usize) -> String {
    format!("thumbs/{:02}.jpg", position + 1)
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
    let temp_path = dest_path.with_extension("mixtape.tmp");
    let file = File::create(&temp_path).map_err(|e| format!("Failed to create mixtape file: {}", e))?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    // Write cover.jpg if provided
    if let Some(cp) = cover_path {
        let cover_bytes = resize_image_to_jpeg(cp, 800)?;
        zip.start_file("cover.jpg", options)
            .map_err(|e| format!("Failed to start cover.jpg: {}", e))?;
        zip.write_all(&cover_bytes)
            .map_err(|e| format!("Failed to write cover.jpg: {}", e))?;
        manifest.cover = Some("cover.jpg".to_string());
    } else {
        manifest.cover = None;
    }

    // Build track entries for manifest
    let mut track_entries = Vec::new();

    // Write audio files
    let total_tracks = track_sources.len() as u32;
    for (i, source) in track_sources.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            drop(zip);
            let _ = std::fs::remove_file(&temp_path);
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

        // Create track entry with thumb path if thumbnails are included
        let thumb = if include_thumbs && source.thumb_path.is_some() {
            Some(thumb_archive_path(i))
        } else {
            None
        };

        track_entries.push(BundleTrack {
            title: source.title.clone(),
            artist: source.artist.clone(),
            album_artist: None,
            album: source.album.clone(),
            duration_secs: source.duration_secs,
            file: Some(archive_path),
            thumb,
            format: None,
            image_url: None,
            file_size: None,
        });
    }

    // Write thumbnails if requested
    if include_thumbs {
        for (i, source) in track_sources.iter().enumerate() {
            if let Some(ref thumb_path) = source.thumb_path {
                let thumb_bytes = resize_image_to_jpeg(Path::new(thumb_path), 150)?;
                let archive_path = thumb_archive_path(i);
                zip.start_file(&archive_path, options)
                    .map_err(|e| format!("Failed to start {}: {}", archive_path, e))?;
                zip.write_all(&thumb_bytes)
                    .map_err(|e| format!("Failed to write thumb: {}", e))?;
            }
        }
    }

    // Update manifest with track entries
    manifest.tracks = track_entries;

    // Write manifest.json
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

    std::fs::rename(&temp_path, dest_path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to finalize mixtape file: {}", e)
    })?;

    Ok(size)
}

/// Build a playlist-only .mixtape ZIP (manifest + cover + optional thumbnails, no audio files).
pub fn build_playlist_mixtape(
    dest_path: &Path,
    cover_path: Option<&Path>,
    mut manifest: BundleManifest,
    thumb_paths: &[Option<String>],
    include_thumbs: bool,
) -> Result<u64, String> {
    let temp_path = dest_path.with_extension("mixtape.tmp");
    let file = File::create(&temp_path)
        .map_err(|e| format!("Failed to create mixtape file: {}", e))?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);

    if let Some(cp) = cover_path {
        let cover_bytes = resize_image_to_jpeg(cp, 800)?;
        zip.start_file("cover.jpg", options)
            .map_err(|e| format!("Failed to start cover.jpg: {}", e))?;
        zip.write_all(&cover_bytes)
            .map_err(|e| format!("Failed to write cover.jpg: {}", e))?;
        manifest.cover = Some("cover.jpg".to_string());
    }

    if include_thumbs {
        for (i, thumb) in thumb_paths.iter().enumerate() {
            if let Some(ref tp) = thumb {
                if let Ok(thumb_bytes) = resize_image_to_jpeg(Path::new(tp), 150) {
                    let archive_path = thumb_archive_path(i);
                    if zip.start_file(&archive_path, options).is_ok() {
                        let _ = zip.write_all(&thumb_bytes);
                    }
                    if let Some(track) = manifest.tracks.get_mut(i) {
                        track.thumb = Some(archive_path);
                    }
                }
            }
        }
    }

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    zip.start_file("manifest.json", options)
        .map_err(|e| format!("Failed to start manifest.json: {}", e))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("Failed to write manifest: {}", e))?;

    let final_zip = zip.finish()
        .map_err(|e| format!("Failed to finalize ZIP: {}", e))?;
    let size = final_zip.into_inner()
        .map_err(|e| format!("Failed to flush ZIP: {}", e))?
        .metadata()
        .map_err(|e| format!("Failed to read metadata: {}", e))?
        .len();

    std::fs::rename(&temp_path, dest_path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to finalize mixtape file: {}", e)
    })?;

    Ok(size)
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
            let cover_dest = temp_dir.join("mixtape-cover.jpg");
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
                let cover_dest = dest_dir.join("cover.jpg");
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

        // Extract audio
        if options.audio {
            if let Some(ref file) = track.file {
            let mut track_file = archive
                .by_name(file)
                .map_err(|_| format!("Track file not found: {}", file))?;
            let track_dest = dest_dir.join(file);
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
                    let thumb_dest = dest_dir.join(thumb);
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
        .filter(|a| {
            Path::new(a)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("mixtape"))
        })
        .last()
        .cloned()
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
        assert_eq!(thumb_archive_path(0), "thumbs/01.jpg");
        assert_eq!(thumb_archive_path(11), "thumbs/12.jpg");
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
