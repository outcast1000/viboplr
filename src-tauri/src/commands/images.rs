// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

// --- Entity image commands (generic) ---

#[tauri::command]
pub fn get_entity_image(state: State<'_, AppState>, kind: String, name: String, artist_name: Option<String>) -> Option<String> {
    let slug = crate::entity_image::entity_image_slug(&kind, &name, artist_name.as_deref());
    crate::entity_image::get_image_path(&state.app_dir, &kind, &slug)
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_entity_image(state: State<'_, AppState>, kind: String, name: String, artist_name: Option<String>, source_path: String) -> Result<String, String> {
    let slug = crate::entity_image::entity_image_slug(&kind, &name, artist_name.as_deref());
    let source = std::path::Path::new(&source_path);
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_lowercase();
    crate::entity_image::remove_image(&state.app_dir, &kind, &slug);
    let dest_dir = crate::entity_image::image_dir(&state.app_dir, &kind);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.{}", slug, ext));
    std::fs::copy(source, &dest).map_err(|e| format!("Failed to copy image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn paste_entity_image(state: State<'_, AppState>, kind: String, name: String, artist_name: Option<String>, image_data: Vec<u8>) -> Result<String, String> {
    let slug = crate::entity_image::entity_image_slug(&kind, &name, artist_name.as_deref());
    let ext = detect_image_format(&image_data);
    crate::entity_image::remove_image(&state.app_dir, &kind, &slug);
    let dest_dir = crate::entity_image::image_dir(&state.app_dir, &kind);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.{}", slug, ext));
    std::fs::write(&dest, &image_data).map_err(|e| format!("Failed to write image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn paste_entity_image_from_clipboard(state: State<'_, AppState>, kind: String, name: String, artist_name: Option<String>) -> Result<String, String> {
    let slug = crate::entity_image::entity_image_slug(&kind, &name, artist_name.as_deref());
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
    crate::entity_image::remove_image(&state.app_dir, &kind, &slug);
    let dest_dir = crate::entity_image::image_dir(&state.app_dir, &kind);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(format!("{}.png", slug));
    std::fs::write(&dest, &buf).map_err(|e| format!("Failed to write image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn remove_entity_image(state: State<'_, AppState>, kind: String, name: String, artist_name: Option<String>) {
    let slug = crate::entity_image::entity_image_slug(&kind, &name, artist_name.as_deref());
    crate::entity_image::remove_image(&state.app_dir, &kind, &slug);
}

// --- Artist/album image fetch commands ---
//
// `force` separates the two callers, and conflating them was a real bug. A user
// asking to re-fetch an image (`useImageCache.requestFetch`) means "throw away
// what you know and try again": drop the file and the recorded failure. A
// surface merely needing a thumbnail it hasn't got (`useImageCache.getImage`)
// means "fetch this if you can" — and must NOT clear the failure record, or the
// 24h suppression in `is_image_failed` can never engage. Every call used to be
// `force: true`, which made that suppression — and so the whole
// `image_fetch_failures` table — unreachable: an entity no provider has art for
// was re-resolved on a loop, each pass costing an iTunes + Deezer + MusicBrainz
// (+ CoverArtArchive) round trip for an answer already known to be "no".

/// Queue an image fetch, dropping any cached negative result only when the
/// caller explicitly asked for a refresh.
fn queue_image_fetch(
    state: &State<'_, AppState>,
    kind: &str,
    slug: &str,
    label: &str,
    force: bool,
    request: ImageDownloadRequest,
) {
    if force {
        crate::entity_image::remove_image(&state.app_dir, kind, slug);
        let _ = state.db.clear_image_failure(kind, slug);
    }
    let mut queue = state.download_queue.queue.lock().unwrap();
    // The queue is drained one entity at a time with a 1100ms courtesy delay, so
    // a duplicate is not merely redundant work — it is a second full pass over
    // every provider for an answer already in flight. Several surfaces ask for
    // the same thumbnail in the same tick (observed: four entities queued twice
    // within 21ms), so dedupe on the way in.
    if queue.contains(&request) {
        return;
    }
    log::info!(
        "Queued {} image download: {}{}",
        kind,
        label,
        if force { " (forced)" } else { "" }
    );
    queue.push(request);
    state.download_queue.condvar.notify_one();
}

#[tauri::command]
pub fn fetch_artist_image(state: State<'_, AppState>, artist_name: String, force: Option<bool>) {
    let slug = crate::entity_image::entity_image_slug("artist", &artist_name, None);
    let force = force.unwrap_or(false);
    let request = ImageDownloadRequest::Artist { name: artist_name.clone(), force };
    queue_image_fetch(&state, "artist", &slug, &artist_name, force, request);
}

#[tauri::command]
pub fn fetch_album_image(
    state: State<'_, AppState>,
    album_title: String,
    artist_name: Option<String>,
    force: Option<bool>,
) {
    let slug = crate::entity_image::entity_image_slug("album", &album_title, artist_name.as_deref());
    let force = force.unwrap_or(false);
    let request = ImageDownloadRequest::Album { title: album_title.clone(), artist_name, force };
    queue_image_fetch(&state, "album", &slug, &album_title, force, request);
}

#[tauri::command]
pub fn fetch_tag_image(state: State<'_, AppState>, tag_name: String, force: Option<bool>) {
    let slug = crate::entity_image::entity_image_slug("tag", &tag_name, None);
    let force = force.unwrap_or(false);
    let request = ImageDownloadRequest::Tag { name: tag_name.clone(), force };
    queue_image_fetch(&state, "tag", &slug, &tag_name, force, request);
}

#[tauri::command]
pub fn clear_image_failures(state: State<'_, AppState>) -> Result<(), String> {
    state.db.clear_image_failures().map_err(|e| e.to_string())
}

/// Save an entity image fetched from a specific provider (the "preview then
/// Apply" path used by the Retrieve modal). Unlike the background worker, this
/// does NOT walk the provider chain — the caller has already resolved a single
/// provider's result (a URL+headers or base64 data) in JS and confirms the save.
/// Returns the saved file path on success. Clears any recorded failure so the
/// entity is re-fetchable later.
#[tauri::command]
pub fn save_entity_image_from_provider(
    state: State<'_, AppState>,
    kind: String,
    name: String,
    artist_name: Option<String>,
    url: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    data: Option<String>,
) -> Result<String, String> {
    let slug = crate::entity_image::entity_image_slug(&kind, &name, artist_name.as_deref());
    let dir = crate::entity_image::image_dir(&state.app_dir, &kind);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Remove any existing image (all extensions) so we don't leave a stale copy
    // in a different extension alongside the new one.
    crate::entity_image::remove_image(&state.app_dir, &kind, &slug);
    let dest = dir.join(format!("{}.jpg", slug));

    if let Some(data) = data {
        crate::base64_decode_and_save(&data, &dest)?;
    } else if let Some(url) = url {
        crate::download_image_from_url(&url, headers.as_ref(), &dest)?;
    } else {
        return Err("No url or data provided".into());
    }

    let _ = state.db.clear_image_failure(&kind, &slug);
    // The actual written file may be .png (write_image preserves the source
    // format); resolve the real path for the caller.
    let saved = crate::entity_image::get_image_path(&state.app_dir, &kind, &slug)
        .unwrap_or(dest);
    Ok(saved.to_string_lossy().to_string())
}

/// Extract an album's embedded artwork (from the audio file's tags) to a temp
/// file and return its path, so the Retrieve modal can offer "Embedded artwork"
/// as a selectable provider and preview it before applying. Returns an error
/// when the album has no local track or no embedded picture.
#[tauri::command]
pub fn extract_embedded_album_image(
    state: State<'_, AppState>,
    album_title: String,
    artist_name: Option<String>,
) -> Result<String, String> {
    let provider = crate::image_provider::embedded::EmbeddedArtworkProvider::new(state.db.clone());
    let slug = crate::entity_image::entity_image_slug("album", &album_title, artist_name.as_deref());
    let tmp_dir = state.app_dir.join("tmp_preview");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let dest = tmp_dir.join(format!("{}.jpg", slug));
    crate::image_provider::AlbumImageProvider::fetch_album_image(
        &provider,
        &album_title,
        artist_name.as_deref(),
        &dest,
    )?;
    // write_image may have written .png; resolve actual file.
    let actual = if dest.with_extension("png").exists() { dest.with_extension("png") } else { dest };
    Ok(actual.to_string_lossy().to_string())
}
