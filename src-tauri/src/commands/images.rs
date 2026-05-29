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

#[tauri::command]
pub fn fetch_artist_image(state: State<'_, AppState>, artist_name: String) {
    let slug = crate::entity_image::entity_image_slug("artist", &artist_name, None);
    crate::entity_image::remove_image(&state.app_dir, "artist", &slug);
    let _ = state.db.clear_image_failure("artist", &slug);
    log::info!("Queued artist image download: {}", artist_name);
    let mut queue = state.download_queue.queue.lock().unwrap();
    queue.push(ImageDownloadRequest::Artist { name: artist_name, force: true });
    state.download_queue.condvar.notify_one();
}

#[tauri::command]
pub fn fetch_album_image(state: State<'_, AppState>, album_title: String, artist_name: Option<String>) {
    let slug = crate::entity_image::entity_image_slug("album", &album_title, artist_name.as_deref());
    crate::entity_image::remove_image(&state.app_dir, "album", &slug);
    let _ = state.db.clear_image_failure("album", &slug);
    log::info!("Queued album image download: {}", album_title);
    let mut queue = state.download_queue.queue.lock().unwrap();
    queue.push(ImageDownloadRequest::Album { title: album_title, artist_name, force: true });
    state.download_queue.condvar.notify_one();
}

#[tauri::command]
pub fn fetch_tag_image(state: State<'_, AppState>, tag_name: String) {
    let slug = crate::entity_image::entity_image_slug("tag", &tag_name, None);
    crate::entity_image::remove_image(&state.app_dir, "tag", &slug);
    let _ = state.db.clear_image_failure("tag", &slug);
    log::info!("Queued tag image download: {}", tag_name);
    let mut queue = state.download_queue.queue.lock().unwrap();
    queue.push(ImageDownloadRequest::Tag { name: tag_name, force: true });
    state.download_queue.condvar.notify_one();
}

#[tauri::command]
pub fn clear_image_failures(state: State<'_, AppState>) -> Result<(), String> {
    state.db.clear_image_failures().map_err(|e| e.to_string())
}
