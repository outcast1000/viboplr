// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

#[tauri::command]
pub fn save_playlist_entries(
    path: String,
    entries: Vec<QueueEntryPayload>,
) -> Result<(), String> {
    let mut content = String::from("#EXTM3U\n");
    for entry in &entries {
        let duration = entry.duration_secs.unwrap_or(0.0) as i64;
        let artist = entry.artist_name.as_deref().unwrap_or("Unknown");
        content.push_str(&format!("#EXTINF:{},{} - {}\n", duration, artist, entry.title));
        content.push_str(&entry.location);
        content.push('\n');
    }
    std::fs::write(&path, content).map_err(|e| format!("Failed to write playlist: {}", e))
}

#[tauri::command]
pub fn load_playlist(
    path: String,
) -> Result<PlaylistLoadResult, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read playlist: {}", e))?;
    let playlist_path = std::path::Path::new(&path);
    let parent_dir = playlist_path.parent();

    let mut entries: Vec<PlaylistEntry> = Vec::new();
    let mut pending_extinf: Option<(String, Option<String>, f64)> = None; // (title, artist, duration)

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if line.starts_with("#EXTINF:") {
            if let Some(rest) = line.strip_prefix("#EXTINF:") {
                let parts: Vec<&str> = rest.splitn(2, ',').collect();
                let dur = parts.first().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                let display = parts.get(1).unwrap_or(&"");
                let (artist, title) = if let Some(idx) = display.find(" - ") {
                    (Some(display[..idx].to_string()), display[idx + 3..].to_string())
                } else {
                    (None, display.to_string())
                };
                pending_extinf = Some((title, artist, dur));
            }
            continue;
        }
        if line.starts_with('#') { continue; }

        // Resolve the location to a URI
        let url = if line.contains("://") || std::path::Path::new(line).is_absolute() {
            // Absolute path without scheme → add file://
            if !line.contains("://") {
                format!("file://{}", line)
            } else {
                line.to_string()
            }
        } else if let Some(parent) = parent_dir {
            // Relative path — resolve relative to playlist
            format!("file://{}", parent.join(line).to_string_lossy())
        } else {
            format!("file://{}", line)
        };

        let (title, artist, dur) = pending_extinf.take().unwrap_or_else(|| {
            let name = url.rsplit('/').next().unwrap_or(&url).to_string();
            (name, None, 0.0)
        });

        entries.push(PlaylistEntry {
            url,
            title,
            artist_name: artist,
            duration_secs: Some(dur),
        });
    }

    let playlist_name = playlist_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Playlist")
        .to_string();

    Ok(PlaylistLoadResult {
        entries,
        playlist_name,
    })
}

#[tauri::command]
pub fn save_playlist_record(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    source: Option<String>,
    image_url: Option<String>,
    description: Option<String>,
    metadata: Option<String>,
    tracks: Vec<PlaylistTrackPayload>,
) -> Result<i64, String> {
    let db = &state.db;
    let playlist_id = db
        .save_playlist(&name, source.as_deref(), None, description.as_deref(), metadata.as_deref())
        .map_err(|e| e.to_string())?;

    let track_tuples: Vec<(&str, Option<&str>, Option<&str>, Option<f64>, Option<&str>, Option<&str>)> =
        tracks.iter().map(|t| {
            (
                t.title.as_str(),
                t.artist_name.as_deref(),
                t.album_name.as_deref(),
                t.duration_secs,
                t.source.as_deref(),
                None,
            )
        }).collect();

    db.save_playlist_tracks(playlist_id, &track_tuples)
        .map_err(|e| e.to_string())?;

    // Notify any mounted Playlists view to reload (queue "Save as Playlist",
    // plugin saves, etc. all flow through here).
    let _ = app.emit("playlists-changed", ());

    // Background image download
    let app_dir = state.app_dir.clone();
    let db_arc = state.db.clone();
    let image_url_clone = image_url.clone();
    let track_image_urls: Vec<(i64, Option<String>)> = {
        let saved_tracks = db.get_playlist_tracks(playlist_id).map_err(|e| e.to_string())?;
        saved_tracks.iter().zip(tracks.iter()).map(|(saved, payload)| {
            (saved.id, payload.image_url.clone())
        }).collect()
    };

    std::thread::spawn(move || {
        let img_dir = app_dir.join("playlist_images");
        let _ = std::fs::create_dir_all(&img_dir);
        let client = reqwest::blocking::Client::new();

        // Download/copy playlist cover
        if let Some(url) = image_url_clone {
            if let Some(abs) = store_playlist_image(&img_dir, &client, &format!("{}", playlist_id), &url) {
                let _ = db_arc.update_playlist_image(playlist_id, &abs);
            }
        }

        // Download/copy track images
        download_playlist_track_images(&img_dir, &client, &db_arc, playlist_id, track_image_urls);
    });

    Ok(playlist_id)
}

/// Put one image — a remote URL or a local path — into `playlist_images/` as
/// `<stem>.<ext>` and return the stored absolute path (None on any failure).
///
/// The extension is read off the bytes, never assumed: these sources are
/// arbitrary (a plugin's catalog, a scraped page, a file the user picked), and
/// writing a PNG or WebP under a `.jpg` name makes the file lie to everything
/// that later reads it by name. The webview sniffs content and so never
/// noticed, which is exactly why this went unseen. A local file whose bytes
/// aren't recognizable falls back to its own extension.
fn store_playlist_image(
    img_dir: &std::path::Path,
    client: &reqwest::blocking::Client,
    stem: &str,
    url: &str,
) -> Option<String> {
    let (bytes, fallback_ext) = if url.starts_with("http://") || url.starts_with("https://") {
        let bytes = client.get(url).send().ok()
            .filter(|r| r.status().is_success())
            .and_then(|r| r.bytes().ok())?;
        (bytes.to_vec(), "jpg".to_string())
    } else {
        let src = std::path::Path::new(url);
        let ext = src.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg")
            .to_lowercase();
        (std::fs::read(src).ok()?, ext)
    };
    let ext = super::sniff_image_ext(&bytes).map(str::to_string).unwrap_or(fallback_ext);
    let dest = img_dir.join(format!("{}.{}", stem, ext));
    std::fs::write(&dest, &bytes).ok()?;
    Some(dest.to_string_lossy().to_string())
}

/// Download/copy per-track images into `playlist_images/` and record the
/// resulting paths. Shared by `save_playlist_record` and
/// `append_playlist_tracks` — run it on a background thread.
fn download_playlist_track_images(
    img_dir: &std::path::Path,
    client: &reqwest::blocking::Client,
    db: &Database,
    playlist_id: i64,
    track_image_urls: Vec<(i64, Option<String>)>,
) {
    for (track_id, maybe_url) in track_image_urls {
        if let Some(url) = maybe_url {
            let stem = format!("{}_{}", playlist_id, track_id);
            if let Some(abs) = store_playlist_image(img_dir, client, &stem, &url) {
                let _ = db.update_playlist_track_image(track_id, &abs);
            }
        }
    }
}

/// Append tracks to a user playlist. With `allow_duplicates` false, entries
/// already in the playlist are skipped (exact source match, falling back to
/// title+artist) and reported — counts plus which payload indices — so the
/// caller can warn and re-send just those with `allow_duplicates: true` once
/// the user confirms.
#[tauri::command]
pub fn append_playlist_tracks(
    app: AppHandle,
    state: State<'_, AppState>,
    playlist_id: i64,
    tracks: Vec<PlaylistTrackPayload>,
    allow_duplicates: bool,
) -> Result<AppendPlaylistResult, String> {
    let track_tuples: Vec<(&str, Option<&str>, Option<&str>, Option<f64>, Option<&str>, Option<&str>)> =
        tracks.iter().map(|t| {
            (
                t.title.as_str(),
                t.artist_name.as_deref(),
                t.album_name.as_deref(),
                t.duration_secs,
                t.source.as_deref(),
                None,
            )
        }).collect();

    let (inserted, skipped) = state.db
        .append_playlist_tracks(playlist_id, &track_tuples, allow_duplicates)
        .map_err(|e| e.to_string())?;
    let added = inserted.len();
    let inserted_set: std::collections::HashSet<usize> = inserted.iter().map(|(i, _)| *i).collect();
    let skipped_indices: Vec<usize> = (0..tracks.len()).filter(|i| !inserted_set.contains(i)).collect();

    let _ = app.emit("playlists-changed", ());

    // Background image download for the rows that were actually inserted.
    // The DB returns (payload index, row id) pairs so a skipped duplicate
    // can't shift an image onto the wrong row.
    let track_image_urls: Vec<(i64, Option<String>)> = inserted.into_iter()
        .map(|(idx, row_id)| (row_id, tracks[idx].image_url.clone()))
        .collect();

    if !track_image_urls.is_empty() {
        let app_dir = state.app_dir.clone();
        let db_arc = state.db.clone();
        std::thread::spawn(move || {
            let img_dir = app_dir.join("playlist_images");
            let _ = std::fs::create_dir_all(&img_dir);
            let client = reqwest::blocking::Client::new();
            download_playlist_track_images(&img_dir, &client, &db_arc, playlist_id, track_image_urls);
        });
    }

    Ok(AppendPlaylistResult { added, skipped, skipped_indices })
}

/// Remove tracks from a user playlist and delete their cached image files.
#[tauri::command]
pub fn remove_playlist_tracks(
    app: AppHandle,
    state: State<'_, AppState>,
    playlist_id: i64,
    track_ids: Vec<i64>,
) -> Result<(), String> {
    let image_paths = state.db
        .remove_playlist_tracks(playlist_id, &track_ids)
        .map_err(|e| e.to_string())?;
    for path in image_paths {
        let _ = std::fs::remove_file(&path);
    }
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

/// Apply a full permutation to a user playlist's track order.
#[tauri::command]
pub fn reorder_playlist_tracks(
    app: AppHandle,
    state: State<'_, AppState>,
    playlist_id: i64,
    ordered_ids: Vec<i64>,
) -> Result<(), String> {
    state.db
        .reorder_playlist_tracks(playlist_id, &ordered_ids)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

/// Rename a user playlist / edit its description.
#[tauri::command]
pub fn update_playlist_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    playlist_id: i64,
    name: String,
    description: Option<String>,
) -> Result<(), String> {
    state.db
        .update_playlist_meta(playlist_id, &name, description.as_deref())
        .map_err(|e| e.to_string())?;
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

/// Set or remove a user playlist's cover. `image_path` is a picked file
/// (typically a temp copy from `paste_clipboard_to_playlist_images` /
/// `copy_to_playlist_images`); it is copied into `playlist_images/` under a
/// timestamped name owned by this playlist — never stored as-is, because
/// `delete_playlist_record` later `remove_file`s whatever path is in the DB
/// and an arbitrary caller path could be a shared cache file. Returns the new
/// stored path (None when removed).
#[tauri::command]
pub fn set_playlist_cover(
    app: AppHandle,
    state: State<'_, AppState>,
    playlist_id: i64,
    image_path: Option<String>,
) -> Result<Option<String>, String> {
    let previous = state.db.get_playlists().map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.id == playlist_id)
        .ok_or_else(|| "Playlist not found".to_string())?
        .image_path;

    let stored = match &image_path {
        Some(src) => {
            let img_dir = state.app_dir.join("playlist_images");
            std::fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            // Keep the source's real extension (the feeders already pick it
            // correctly: `.png` from a clipboard paste, the picked file's own
            // from `copy_to_playlist_images`). Hardcoding `.jpg` here wrote a
            // PNG under a JPEG name — the webview sniffs content so it still
            // rendered, but the file lied to everything else that reads it.
            // Matches `set_entity_image`, which is the artist/album precedent.
            let ext = std::path::Path::new(src)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg")
                .to_lowercase();
            // Timestamped name: replacing a cover must change the path, or
            // convertFileSrc's URL stays identical and the webview keeps
            // showing the cached old image.
            let dest = img_dir.join(format!("{}_{}.{}", playlist_id, timestamp, ext));
            std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
            Some(dest.to_string_lossy().to_string())
        }
        None => None,
    };

    state.db
        .set_user_playlist_image(playlist_id, stored.as_deref())
        .map_err(|e| e.to_string())?;

    // Clean up: the previous stored cover, and the picked temp source.
    if let Some(prev) = previous {
        if stored.as_deref() != Some(prev.as_str()) {
            let _ = std::fs::remove_file(&prev);
        }
    }
    if let Some(src) = image_path {
        if stored.as_deref() != Some(src.as_str()) {
            let _ = std::fs::remove_file(&src);
        }
    }

    let _ = app.emit("playlists-changed", ());
    Ok(stored)
}

#[tauri::command]
pub fn get_playlists(state: State<'_, AppState>) -> Result<Vec<Playlist>, String> {
    state.db.get_playlists().map_err(|e| e.to_string())
}

/// Decide which algorithmic ("auto") playlists should exist and (re)generate the
/// stale/missing ones into materialized tracks. `force` regenerates regardless of
/// age; with `force == false` the per-mix 24h staleness check decides, so calling
/// this on view-mount is cheap when everything is fresh.
#[tauri::command]
pub fn ensure_auto_playlists(state: State<'_, AppState>, force: bool) -> Result<(), String> {
    state.db.ensure_auto_playlists(force).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_playlist_tracks(state: State<'_, AppState>, playlist_id: i64) -> Result<Vec<PlaylistTrack>, String> {
    state.db.get_playlist_tracks(playlist_id).map_err(|e| e.to_string())
}

/// Playlist ids whose track titles/artists match `query`. Backs the Playlists
/// view search (name/description are matched on the frontend).
#[tauri::command]
pub fn search_playlist_track_ids(state: State<'_, AppState>, query: String) -> Result<Vec<i64>, String> {
    state.db.search_playlist_track_ids(&query).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_playlist_record(app: AppHandle, state: State<'_, AppState>, playlist_id: i64) -> Result<(), String> {
    // Collect image paths before deleting DB rows (cascade deletes tracks)
    let playlist_image = state.db.get_playlists().ok()
        .and_then(|ps| ps.into_iter().find(|p| p.id == playlist_id))
        .and_then(|p| p.image_path);
    let track_images: Vec<String> = state.db.get_playlist_tracks(playlist_id).ok()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|t| t.image_path)
        .collect();

    state.db.delete_playlist(playlist_id).map_err(|e| e.to_string())?;

    // Clean up image files (absolute paths stored in DB)
    if let Some(path) = playlist_image {
        let _ = std::fs::remove_file(&path);
    }
    for path in track_images {
        let _ = std::fs::remove_file(&path);
    }
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

#[tauri::command]
pub fn update_playlist_image(
    state: State<'_, AppState>,
    playlist_id: i64,
    image_path: String,
) -> Result<(), String> {
    state.db.update_playlist_image(playlist_id, &image_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_playlist_track_metadata(
    state: State<'_, AppState>,
    track_id: i64,
    title: String,
    artist_name: Option<String>,
    album_name: Option<String>,
) -> Result<(), String> {
    state.db
        .update_playlist_track_metadata(track_id, &title, artist_name.as_deref(), album_name.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn paste_clipboard_to_playlist_images(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("Clipboard error: {}", e))?;
    let img = clipboard.get_image().map_err(|_| "No image in clipboard".to_string())?;
    let mut buf = Vec::new();
    {
        let encoder = image::codecs::png::PngEncoder::new(&mut buf);
        image::ImageEncoder::write_image(
            encoder,
            &img.bytes,
            img.width as u32,
            img.height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("Failed to encode image: {}", e))?;
    }
    let img_dir = state.app_dir.join("playlist_images");
    std::fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dest = img_dir.join(format!("pasted_{}.png", timestamp));
    std::fs::write(&dest, &buf).map_err(|e| format!("Failed to write image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn copy_to_playlist_images(
    state: State<'_, AppState>,
    source_path: String,
) -> Result<String, String> {
    let img_dir = state.app_dir.join("playlist_images");
    std::fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
    let ext = std::path::Path::new(&source_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dest = img_dir.join(format!("custom_{}.{}", timestamp, ext));
    std::fs::copy(&source_path, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn download_url_to_playlist_images(
    state: State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    let img_dir = state.app_dir.join("playlist_images");
    std::fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let ext = if url.contains(".png") { "png" } else { "jpg" };
    let dest = img_dir.join(format!("downloaded_{}.{}", timestamp, ext));
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let mut response = client.get(&url).send().map_err(|e| format!("Download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let mut file = std::fs::File::create(&dest).map_err(|e| format!("Create file: {}", e))?;
    std::io::copy(&mut response, &mut file).map_err(|e| format!("Write file: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn generate_playlist_composite(
    state: State<'_, AppState>,
    artist_names: Vec<String>,
) -> Result<Option<String>, String> {
    if artist_names.is_empty() {
        return Ok(None);
    }
    // async + spawn_blocking: decodes and composes PNGs via the image crate —
    // CPU work that froze the webview when run inline.
    let app_dir = state.app_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let artist_image_paths: Vec<std::path::PathBuf> = artist_names
            .iter()
            .take(3)
            .filter_map(|name| {
                let slug = crate::entity_image::entity_image_slug("artist", name, None);
                crate::entity_image::get_image_path(&app_dir, "artist", &slug)
            })
            .collect();
        if artist_image_paths.is_empty() {
            return Ok(None);
        }
        let img_dir = app_dir.join("playlist_images");
        std::fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let dest = img_dir.join(format!("composite_{}.png", timestamp));
        crate::composite_image::generate_tag_composite(&artist_image_paths, &dest, 400)?;
        Ok(Some(dest.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn export_playlist_m3u(state: State<'_, AppState>, playlist_id: i64, path: String) -> Result<(), String> {
    let tracks = state.db.get_playlist_tracks(playlist_id).map_err(|e| e.to_string())?;
    let mut content = String::from("#EXTM3U\n");
    for track in &tracks {
        let duration = track.duration_secs.unwrap_or(0.0) as i64;
        let artist = track.artist_name.as_deref().unwrap_or("Unknown");
        content.push_str(&format!("#EXTINF:{},{} - {}\n", duration, artist, track.title));
        content.push_str(track.source.as_deref().unwrap_or(""));
        content.push('\n');
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}
