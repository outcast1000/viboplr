use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub enum DownloadFormat {
    Flac,
    Aac,
    Mp3,
}

impl DownloadFormat {
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            // "original" is the source-quality choice (e.g. Subsonic): no
            // transcode, same raw/lossless handling as FLAC.
            "flac" | "original" => Ok(Self::Flac),
            "aac" => Ok(Self::Aac),
            "mp3" => Ok(Self::Mp3),
            _ => Err(format!("Unknown format: {}", s)),
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            Self::Flac => "flac",
            Self::Aac => "m4a",
            Self::Mp3 => "mp3",
        }
    }
}

/// Decide how to fetch a Subsonic track for a requested download format.
///
/// Returns `(transcode_param, extension)`:
/// - `transcode_param` is the `format=` query value for `stream.view`, or `None`
///   to fetch the original file untouched via `download.view`.
/// - `extension` is the file extension to save as, or `None` when it must be
///   sniffed from the downloaded bytes (original file whose source format is
///   unknown).
///
/// FLAC is the "original quality" choice: it downloads the source file as-is and
/// names it by the track's real stored suffix. AAC/MP3 ask the server to
/// transcode and always land on a known container.
pub fn subsonic_download_target(
    format: DownloadFormat,
    source_suffix: Option<&str>,
) -> (Option<&'static str>, Option<String>) {
    match format {
        DownloadFormat::Aac => (Some("aac"), Some("m4a".to_string())),
        DownloadFormat::Mp3 => (Some("mp3"), Some("mp3".to_string())),
        DownloadFormat::Flac => {
            let ext = source_suffix
                .map(|s| s.trim().trim_start_matches('.').to_ascii_lowercase())
                .filter(|s| !s.is_empty());
            (None, ext)
        }
    }
}

/// Fallback extension for a requested format value when neither the resolver
/// nor the downloaded bytes pin one: host-known formats map to their container
/// ("original" keeps its legacy "flac" naming), while provider-specific quality
/// values (e.g. "video", "opus" from a plugin's `onGetQualities`) get a neutral
/// "bin" that the scanner will never mistake for media.
pub fn format_fallback_extension(format: &str) -> &'static str {
    DownloadFormat::from_str(format)
        .map(|f| f.extension())
        .unwrap_or("bin")
}


impl std::fmt::Display for DownloadFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DownloadFormat::Flac => write!(f, "flac"),
            DownloadFormat::Aac => write!(f, "aac"),
            DownloadFormat::Mp3 => write!(f, "mp3"),
        }
    }
}

// --- Filesystem helpers ---

/// Sanitize a string for use as a filename/directory name
pub fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let trimmed = sanitized.trim().trim_matches('.');
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Build the flat `{Artist} - {Title}.{ext}` filename used by the download
/// modal's conflict check and direct-to-path download. Components are sanitized.
pub fn download_filename(artist: &str, title: &str, ext: &str) -> String {
    format!(
        "{} - {}.{}",
        sanitize_filename(artist),
        sanitize_filename(title),
        ext
    )
}

// --- Download pipeline ---

/// Shared download helper: streams HTTP URL to file, or copies file:// paths.
pub fn download_file(
    url: &str,
    headers: Option<&HashMap<String, String>>,
    dest: &Path,
    cancel_flag: Option<&std::sync::atomic::AtomicBool>,
    progress_cb: Option<&dyn Fn(u8)>,
) -> Result<(), String> {
    use std::io::{Read, Write};

    if url.starts_with("file://") {
        let raw = &url[7..];
        let decoded = urlencoding::decode(raw)
            .map_err(|e| format!("URL decode error: {}", e))?;
        std::fs::copy(decoded.as_ref(), dest)
            .map_err(|e| format!("Failed to copy local file: {}", e))?;
        return Ok(());
    }

    // TLS verification stays ON — the Subsonic client and every other host
    // fetch verify certificates; downloads must not be the one weak spot.
    let http_client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut req_builder = http_client.get(url);
    if let Some(h) = headers {
        for (k, v) in h {
            req_builder = req_builder.header(k.as_str(), v.as_str());
        }
    }

    let mut response = req_builder
        .send()
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let content_length = response.content_length();
    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("Failed to create file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut buf = [0u8; 32768];
    let mut last_progress = std::time::Instant::now();

    loop {
        if let Some(flag) = cancel_flag {
            if flag.load(std::sync::atomic::Ordering::SeqCst) {
                drop(file);
                let _ = std::fs::remove_file(dest);
                return Err("Download cancelled".to_string());
            }
        }

        let n = response.read(&mut buf).map_err(|e| format!("Read error: {}", e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("Write error: {}", e))?;
        downloaded += n as u64;

        if last_progress.elapsed() >= std::time::Duration::from_millis(500) {
            if let Some(cb) = progress_cb {
                let pct = if let Some(total) = content_length {
                    if total > 0 { ((downloaded as f64 / total as f64) * 100.0).min(99.0) as u8 } else { 0 }
                } else {
                    0
                };
                cb(pct);
            }
            last_progress = std::time::Instant::now();
        }
    }

    if let Some(cb) = progress_cb {
        cb(100);
    }

    Ok(())
}

/// Run a single download: download from resolved URL -> tag -> index in library.
/// Move `src` into place at `dest` without a data-loss window: any existing
/// file at `dest` is set aside (never deleted) until the rename has succeeded,
/// and restored if it fails. The set-aside copy carries a non-media suffix so a
/// concurrent scan can't ingest it.
pub fn replace_file_safely(src: &Path, dest: &Path) -> Result<(), String> {
    let displaced: Option<PathBuf> = if dest.exists() {
        let mut name = dest.file_name().map(|f| f.to_os_string()).unwrap_or_default();
        name.push(".viboplr-replaced");
        let bak = dest.with_file_name(name);
        if bak.exists() {
            let _ = std::fs::remove_file(&bak);
        }
        std::fs::rename(dest, &bak)
            .map_err(|e| format!("Failed to set aside existing file: {}", e))?;
        Some(bak)
    } else {
        None
    };

    match std::fs::rename(src, dest) {
        Ok(()) => {
            if let Some(bak) = displaced {
                if let Err(e) = std::fs::remove_file(&bak) {
                    log::warn!("Failed to remove replaced copy {}: {}", bak.display(), e);
                }
            }
            Ok(())
        }
        Err(e) => {
            if let Some(bak) = displaced {
                let _ = std::fs::rename(&bak, dest);
            }
            Err(format!("Failed to move file into place: {}", e))
        }
    }
}

pub fn write_tags(
    path: &Path,
    title: &str,
    artist: &str,
    album: &str,
    track_number: Option<u32>,
    year: Option<i32>,
    genre: Option<&str>,
    cover_url: Option<&str>,
) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::prelude::*;
    use lofty::probe::Probe;
    use lofty::tag::items::Timestamp;

    let mut tagged_file = Probe::open(path)
        .map_err(|e| format!("Probe open: {}", e))?
        .read()
        .map_err(|e| format!("Probe read: {}", e))?;

    let tag_type = tagged_file.primary_tag_type();
    let tag = match tagged_file.tag_mut(tag_type) {
        Some(t) => t,
        None => {
            tagged_file.insert_tag(lofty::tag::Tag::new(tag_type));
            tagged_file.tag_mut(tag_type).unwrap()
        }
    };

    tag.set_title(title.to_string());
    tag.set_artist(artist.to_string());
    tag.set_album(album.to_string());
    if let Some(num) = track_number {
        tag.set_track(num);
    }
    if let Some(genre) = genre {
        tag.set_genre(genre.to_string());
    }
    if let Some(year) = year {
        tag.set_date(Timestamp { year: year as u16, month: None, day: None, hour: None, minute: None, second: None });
    }

    // Embed cover art
    if let Some(cover_url) = cover_url {
        let http_client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        match http_client.get(cover_url).send() {
            Ok(resp) => {
                if let Ok(bytes) = resp.bytes() {
                    let mime = if cover_url.contains(".png") {
                        MimeType::Png
                    } else {
                        MimeType::Jpeg
                    };
                    let picture = Picture::unchecked(bytes.to_vec())
                        .pic_type(PictureType::CoverFront)
                        .mime_type(mime)
                        .build();
                    tag.push_picture(picture);

                    // Also save as cover.jpg alongside the file
                    if let Some(parent) = path.parent() {
                        let cover_path = parent.join("cover.jpg");
                        if !cover_path.exists() {
                            let _ = std::fs::write(&cover_path, &bytes);
                        }
                    }
                }
            }
            Err(e) => log::warn!("Failed to fetch cover art: {}", e),
        }
    }

    tagged_file
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("Save tags: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- sanitize_filename tests ---

    #[test]
    fn test_sanitize_filename_normal() {
        assert_eq!(sanitize_filename("My Song"), "My Song");
        assert_eq!(sanitize_filename("Track 01"), "Track 01");
    }

    #[test]
    fn test_sanitize_filename_illegal_chars() {
        assert_eq!(sanitize_filename("A/B\\C:D*E?F\"G<H>I|J"), "A_B_C_D_E_F_G_H_I_J");
        assert_eq!(sanitize_filename("file:name"), "file_name");
    }

    #[test]
    fn test_sanitize_filename_whitespace_trim() {
        assert_eq!(sanitize_filename("  spaced  "), "spaced");
        assert_eq!(sanitize_filename("\t\ntab\n\t"), "tab");
    }

    #[test]
    fn test_sanitize_filename_dots_trim() {
        assert_eq!(sanitize_filename("...dots..."), "dots");
        assert_eq!(sanitize_filename(".hidden"), "hidden");
        assert_eq!(sanitize_filename("file."), "file");
    }

    #[test]
    fn test_sanitize_filename_empty() {
        assert_eq!(sanitize_filename(""), "Unknown");
        assert_eq!(sanitize_filename("   "), "Unknown");
        assert_eq!(sanitize_filename("..."), "Unknown");
        assert_eq!(sanitize_filename(" . "), "Unknown");
    }

    #[test]
    fn test_sanitize_filename_unicode() {
        assert_eq!(sanitize_filename("Café"), "Café");
        assert_eq!(sanitize_filename("日本語"), "日本語");
        assert_eq!(sanitize_filename("Привет"), "Привет");
    }

    #[test]
    fn test_sanitize_filename_mixed() {
        assert_eq!(sanitize_filename(" Café:2024 "), "Café_2024");
        assert_eq!(sanitize_filename("...Song/Title?..."), "Song_Title_");
    }

    // --- DownloadFormat tests ---

    #[test]
    fn test_download_format_from_str_valid() {
        assert_eq!(DownloadFormat::from_str("flac").unwrap(), DownloadFormat::Flac);
        assert_eq!(DownloadFormat::from_str("aac").unwrap(), DownloadFormat::Aac);
        assert_eq!(DownloadFormat::from_str("mp3").unwrap(), DownloadFormat::Mp3);
    }

    #[test]
    fn test_download_format_from_str_original_is_flac() {
        // "original" is the Subsonic source-quality choice: same raw/lossless
        // semantics as FLAC (no transcode requested).
        assert_eq!(DownloadFormat::from_str("original").unwrap(), DownloadFormat::Flac);
    }

    #[test]
    fn test_download_filename_uses_given_extension() {
        assert_eq!(
            download_filename("Pink Floyd", "Time", "flac"),
            "Pink Floyd - Time.flac"
        );
        assert_eq!(
            download_filename("Pink Floyd", "Time", "mp3"),
            "Pink Floyd - Time.mp3"
        );
    }

    #[test]
    fn test_download_filename_sanitizes_components() {
        assert_eq!(
            download_filename("AC/DC", "T:N/T", "m4a"),
            "AC_DC - T_N_T.m4a"
        );
    }

    #[test]
    fn test_download_format_from_str_invalid() {
        assert!(DownloadFormat::from_str("wav").is_err());
        assert!(DownloadFormat::from_str("ogg").is_err());
        assert!(DownloadFormat::from_str("").is_err());
    }

    #[test]
    fn test_download_format_extension() {
        assert_eq!(DownloadFormat::Flac.extension(), "flac");
        assert_eq!(DownloadFormat::Aac.extension(), "m4a");
        assert_eq!(DownloadFormat::Mp3.extension(), "mp3");
    }

    #[test]
    fn test_download_format_display() {
        assert_eq!(format!("{}", DownloadFormat::Flac), "flac");
        assert_eq!(format!("{}", DownloadFormat::Aac), "aac");
        assert_eq!(format!("{}", DownloadFormat::Mp3), "mp3");
    }

    // --- subsonic_download_target tests ---

    #[test]
    fn test_subsonic_target_flac_downloads_original_with_known_suffix() {
        // FLAC (default) means "give me the original file". No transcode param,
        // and the extension comes from the source suffix — even when that suffix
        // is mp3, the file must NOT be mislabeled .flac.
        let (param, ext) = subsonic_download_target(DownloadFormat::Flac, Some("mp3"));
        assert_eq!(param, None, "FLAC/original must not request a transcode");
        assert_eq!(ext.as_deref(), Some("mp3"));
    }

    #[test]
    fn test_subsonic_target_flac_normalizes_suffix() {
        let (_, ext) = subsonic_download_target(DownloadFormat::Flac, Some(".FLAC"));
        assert_eq!(ext.as_deref(), Some("flac"));
    }

    #[test]
    fn test_subsonic_target_flac_unknown_suffix_defers_to_sniff() {
        // No stored suffix -> extension is unknown, must be sniffed after download.
        let (param, ext) = subsonic_download_target(DownloadFormat::Flac, None);
        assert_eq!(param, None);
        assert_eq!(ext, None);
        // blank suffix is treated as unknown too
        let (_, ext_blank) = subsonic_download_target(DownloadFormat::Flac, Some("  "));
        assert_eq!(ext_blank, None);
    }

    #[test]
    fn test_subsonic_target_aac_transcodes_to_m4a() {
        let (param, ext) = subsonic_download_target(DownloadFormat::Aac, Some("flac"));
        assert_eq!(param, Some("aac"));
        assert_eq!(ext.as_deref(), Some("m4a"));
    }

    #[test]
    fn test_subsonic_target_mp3_transcodes_to_mp3() {
        let (param, ext) = subsonic_download_target(DownloadFormat::Mp3, Some("flac"));
        assert_eq!(param, Some("mp3"));
        assert_eq!(ext.as_deref(), Some("mp3"));
    }

    // --- resolve_download_extension / format_fallback_extension tests ---

    #[test]
    fn test_format_fallback_extension() {
        assert_eq!(format_fallback_extension("flac"), "flac");
        assert_eq!(format_fallback_extension("original"), "flac");
        assert_eq!(format_fallback_extension("aac"), "m4a");
        assert_eq!(format_fallback_extension("mp3"), "mp3");
        // Provider-specific quality values get a neutral non-media extension.
        assert_eq!(format_fallback_extension("video"), "bin");
        assert_eq!(format_fallback_extension("opus"), "bin");
        assert_eq!(format_fallback_extension(""), "bin");
    }

    // --- replace_file_safely tests ---

    #[test]
    fn test_replace_file_safely_no_existing_dest() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("new.mp3");
        std::fs::write(&src, b"new bytes").unwrap();
        let dest = dir.path().join("song.mp3");

        replace_file_safely(&src, &dest).unwrap();

        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new bytes");
        assert!(!src.exists());
    }

    #[test]
    fn test_replace_file_safely_replaces_existing_dest() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("new.mp3");
        std::fs::write(&src, b"new bytes").unwrap();
        let dest = dir.path().join("song.mp3");
        std::fs::write(&dest, b"old bytes").unwrap();

        replace_file_safely(&src, &dest).unwrap();

        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new bytes");
        assert!(!src.exists());
        // The displaced copy is cleaned up after a successful swap.
        assert!(!dir.path().join("song.mp3.viboplr-replaced").exists());
    }

    #[test]
    fn test_replace_file_safely_restores_dest_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("missing.mp3"); // never created -> rename fails
        let dest = dir.path().join("song.mp3");
        std::fs::write(&dest, b"old bytes").unwrap();

        let result = replace_file_safely(&src, &dest);

        assert!(result.is_err());
        // The existing file must survive a failed replacement, under its own name.
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "old bytes");
        assert!(!dir.path().join("song.mp3.viboplr-replaced").exists());
    }

    // --- download_file tests ---

    #[test]
    fn test_download_file_from_local_file() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source.txt");
        std::fs::write(&src, b"hello world").unwrap();

        let dest = dir.path().join("dest.txt");
        let src_url = format!("file://{}", src.to_string_lossy());
        download_file(&src_url, None, &dest, None, None).unwrap();

        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "hello world");
    }

    #[test]
    fn test_download_file_from_percent_encoded_file_url() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("my file.txt");
        std::fs::write(&src, b"encoded path").unwrap();

        let dest = dir.path().join("dest.txt");
        let encoded_path = src.to_string_lossy().replace(' ', "%20");
        let src_url = format!("file://{}", encoded_path);
        download_file(&src_url, None, &dest, None, None).unwrap();

        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "encoded path");
    }

    #[test]
    fn test_download_file_cancel_flag() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source.txt");
        std::fs::write(&src, b"data").unwrap();

        let dest = dir.path().join("dest.txt");
        let cancel = std::sync::atomic::AtomicBool::new(true);
        let src_url = format!("file://{}", src.to_string_lossy());

        // For file:// copies, cancel is not checked (instantaneous), so this still succeeds.
        let result = download_file(&src_url, None, &dest, Some(&cancel), None);
        assert!(result.is_ok());
    }
}

