use crate::entity_image::canonical_slug;
use crate::models::{MixtapeManifest, MixtapePreview, MixtapeTrack, MixtapeType};
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

/// Build a MixtapeManifest from export options and resolved track data.
pub fn build_manifest(
    title: String,
    mixtape_type: MixtapeType,
    metadata: HashMap<String, String>,
    created_by: Option<String>,
    tracks: Vec<MixtapeTrack>,
) -> MixtapeManifest {
    MixtapeManifest {
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
    mut manifest: MixtapeManifest,
    include_thumbs: bool,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<u64, String>
where
    F: FnMut(u32, u32, &str, u32),
{
    let file = File::create(dest_path).map_err(|e| format!("Failed to create mixtape file: {}", e))?;
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
            let _ = std::fs::remove_file(dest_path);
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

        track_entries.push(MixtapeTrack {
            title: source.title.clone(),
            artist: source.artist.clone(),
            album: source.album.clone(),
            duration_secs: source.duration_secs,
            file: archive_path,
            thumb,
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
        .map_err(|e| format!("Failed to get file size: {}", e))?
        .metadata()
        .map_err(|e| format!("Failed to read metadata: {}", e))?
        .len();

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

    // Read and parse manifest
    let manifest = {
        let mut manifest_file = archive
            .by_name("manifest.json")
            .map_err(|_| "manifest.json not found in mixtape".to_string())?;
        let mut manifest_str = String::new();
        manifest_file
            .read_to_string(&mut manifest_str)
            .map_err(|e| format!("Failed to read manifest: {}", e))?;
        serde_json::from_str::<MixtapeManifest>(&manifest_str)
            .map_err(|e| format!("Failed to parse manifest: {}", e))?
    };

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
) -> Result<MixtapeManifest, String>
where
    F: FnMut(u32, u32, &str),
{
    let file = File::open(path).map_err(|e| format!("Failed to open mixtape: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    // Read manifest
    let manifest = {
        let mut manifest_file = archive
            .by_name("manifest.json")
            .map_err(|_| "manifest.json not found".to_string())?;
        let mut manifest_str = String::new();
        manifest_file
            .read_to_string(&mut manifest_str)
            .map_err(|e| format!("Failed to read manifest: {}", e))?;
        serde_json::from_str::<MixtapeManifest>(&manifest_str)
            .map_err(|e| format!("Failed to parse manifest: {}", e))?
    };

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
            let mut track_file = archive
                .by_name(&track.file)
                .map_err(|_| format!("Track file not found: {}", track.file))?;
            let track_dest = dest_dir.join(&track.file);
            if let Some(parent) = track_dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create tracks directory: {}", e))?;
            }
            let mut track_out = File::create(&track_dest)
                .map_err(|e| format!("Failed to create track file: {}", e))?;
            std::io::copy(&mut track_file, &mut track_out)
                .map_err(|e| format!("Failed to extract track: {}", e))?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
            vec![MixtapeTrack {
                title: "Track 1".into(),
                artist: "Artist".into(),
                album: None,
                duration_secs: Some(180.0),
                file: "tracks/01-track-1.flac".into(),
                thumb: None,
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
        let parsed: MixtapeManifest = serde_json::from_str(&json).unwrap();
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
        let parsed: MixtapeManifest = serde_json::from_str(&manifest_str).unwrap();
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
        assert!(extract_dir.join(&manifest.tracks[0].file).exists());
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
        assert!(extract_dir.join(&manifest.tracks[0].file).exists());
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
}
