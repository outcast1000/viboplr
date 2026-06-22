// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

// --- Download commands ---

#[tauri::command]
pub fn get_download_status(
    state: State<'_, AppState>,
) -> Result<crate::downloader::DownloadQueueInfo, String> {
    Ok(state.track_download_manager.get_status())
}

#[tauri::command]
pub fn cancel_download(state: State<'_, AppState>, download_id: u64) -> Result<bool, String> {
    Ok(state.track_download_manager.cancel(download_id))
}

// --- Generic download commands ---

#[tauri::command]
pub fn enqueue_download(
    state: State<'_, AppState>,
    title: String,
    artist_name: Option<String>,
    album_title: Option<String>,
    uri: Option<String>,
    duration_secs: Option<f64>,
    dest_collection_id: Option<i64>,
    dest_collection_path: Option<String>,
    format: Option<String>,
    path_pattern: Option<String>,
    is_batch_last: Option<bool>,
    provider: Option<String>,
) -> Result<u64, String> {
    let (dest_cid, dest_path) = resolve_dest_collection(&state, dest_collection_id, dest_collection_path)?;

    let fmt = format
        .as_deref()
        .map(|s| DownloadFormat::from_str(s).unwrap_or(DownloadFormat::Flac))
        .unwrap_or(DownloadFormat::Flac);

    let id = state.track_download_manager.next_id();
    let request = crate::downloader::DownloadRequest {
        id,
        title,
        artist_name,
        album_title,
        dest_collection_id: dest_cid,
        dest_collection_path: dest_path,
        format: fmt,
        path_pattern,
        is_batch_last: is_batch_last.unwrap_or(true),
        uri,
        duration_secs,
        provider,
    };
    state.track_download_manager.enqueue(request);
    Ok(id)
}

#[tauri::command]
pub fn download_resolve_response(
    state: State<'_, AppState>,
    id: u64,
    result: Option<crate::downloader::DownloadResolveResponse>,
) -> Result<(), String> {
    state.download_resolve_registry.respond(id, result);
    Ok(())
}

/// Resolved Subsonic download target: the URL to fetch plus the file extension
/// to save as. `ext` may be `"auto"` when the original file's container must be
/// sniffed from the downloaded bytes (original of unknown format).
#[derive(serde::Serialize)]
pub struct SubsonicDownloadTarget {
    pub url: String,
    pub ext: String,
}

#[tauri::command]
pub fn resolve_subsonic_download_url(
    state: State<'_, AppState>,
    location: String,
    format: Option<String>,
) -> Result<SubsonicDownloadTarget, String> {
    // Subsonic track paths are host-based (`subsonic://{host}/{id}`), so resolve
    // the collection by host here — same parse the streaming path uses.
    let (collection_id, remote_track_id) =
        resolve_subsonic_location_parts(&state.db, &location)?;

    let creds = state.db.get_collection_credentials(collection_id)
        .map_err(|e| format!("Failed to get collection credentials: {}", e))?;
    let client = SubsonicClient::from_stored(
        &creds.url,
        &creds.username,
        &creds.password_token,
        creds.salt.as_deref(),
        &creds.auth_method,
    );

    let dl_format = format
        .as_deref()
        .and_then(|f| DownloadFormat::from_str(f).ok())
        .unwrap_or(DownloadFormat::Flac);

    // The track's stored source suffix (e.g. "mp3"/"flac") lets us name an
    // original download correctly without re-downloading to probe it.
    let source_suffix = state
        .db
        .get_track_format_by_remote(collection_id, &remote_track_id)
        .unwrap_or(None);

    let (transcode_param, ext) =
        crate::downloader::subsonic_download_target(dl_format, source_suffix.as_deref());

    match transcode_param {
        // AAC/MP3: ask the server to transcode via stream.view.
        Some(param) => Ok(SubsonicDownloadTarget {
            url: client.stream_url_with_format(&remote_track_id, Some(param)),
            ext: ext.unwrap_or_else(|| dl_format.extension().to_string()),
        }),
        // FLAC/original: fetch the untouched source file via download.view.
        // Extension comes from the stored suffix, or "auto" to sniff post-download.
        None => Ok(SubsonicDownloadTarget {
            url: client.download_url(&remote_track_id),
            ext: ext.unwrap_or_else(|| "auto".to_string()),
        }),
    }
}

// --- Download provider CRUD commands ---

#[tauri::command]
pub fn sync_download_providers(
    state: State<'_, AppState>,
    providers: Vec<(String, String, String, i64)>,
) -> Result<(), String> {
    state.db.sync_download_providers(&providers).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_download_providers(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String, String, i64, bool)>, String> {
    state.db.get_download_providers().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_active_download_providers(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String, String, i64)>, String> {
    state.db.get_active_download_providers().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_download_provider_priority(
    state: State<'_, AppState>,
    plugin_id: String,
    provider_id: String,
    priority: i64,
) -> Result<(), String> {
    state.db.update_download_provider_priority(&plugin_id, &provider_id, priority)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_download_provider_active(
    state: State<'_, AppState>,
    plugin_id: String,
    provider_id: String,
    active: bool,
) -> Result<(), String> {
    state.db.update_download_provider_active(&plugin_id, &provider_id, active)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reset_download_provider_priorities(
    state: State<'_, AppState>,
    defaults: Vec<(String, String, String, i64)>,
) -> Result<(), String> {
    state.db.reset_download_provider_priorities(&defaults).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_dest_conflict(
    artist_name: String,
    track_title: String,
    dest_dir: String,
    format: String,
    ext: Option<String>,
) -> Result<ConflictCheck, String> {
    let fmt = DownloadFormat::from_str(&format)?;
    // A resolver-provided extension (e.g. a Subsonic original file's true suffix)
    // overrides the format default so the conflict check and resulting filename
    // match what will actually be saved.
    let ext = ext
        .as_deref()
        .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e != "auto")
        .unwrap_or_else(|| fmt.extension().to_string());
    let filename = crate::downloader::download_filename(&artist_name, &track_title, &ext);
    let dest_path = std::path::Path::new(&dest_dir).join(&filename);
    let dest_str = dest_path.to_string_lossy().to_string();

    if dest_path.exists() {
        let meta = std::fs::metadata(&dest_path).ok();
        Ok(ConflictCheck {
            has_conflict: true,
            dest_path: dest_str,
            existing_size: meta.as_ref().map(|m| m.len()),
            existing_format: dest_path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_uppercase()),
        })
    } else {
        Ok(ConflictCheck {
            has_conflict: false,
            dest_path: dest_str,
            existing_size: None,
            existing_format: None,
        })
    }
}

#[tauri::command]
pub async fn cancel_direct_download(
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.direct_download_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn download_to_path(
    stream_url: String,
    dest_path: String,
    format: String,
    overwrite: bool,
    title: Option<String>,
    artist_name: Option<String>,
    album_title: Option<String>,
    track_number: Option<u32>,
    cover_url: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<DownloadPathResult, String> {
    let fmt = DownloadFormat::from_str(&format)?;
    let dest = std::path::PathBuf::from(&dest_path);

    // Pre-check: if not overwriting and file exists, error
    if !overwrite && dest.exists() {
        return Err("File already exists and overwrite is false".to_string());
    }

    // Reset cancel flag
    state.direct_download_cancel.store(false, Ordering::SeqCst);
    let cancel_flag = state.direct_download_cancel.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<DownloadPathResult, String> {
        let final_dest = dest.clone();

        // Ensure parent directory exists
        if let Some(parent) = final_dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        // Download to temp file first
        let ext = final_dest.extension().and_then(|e| e.to_str()).unwrap_or(fmt.extension());
        let temp_path = final_dest.with_extension(format!("viboplr-dl.{}", ext));

        crate::downloader::download_file(
            &stream_url,
            None,
            &temp_path,
            Some(&cancel_flag),
            Some(&|pct| {
                let _ = app.emit("direct-download-progress", pct);
            }),
        )?;

        // Write tags if metadata was provided
        if title.is_some() || artist_name.is_some() {
            let _ = crate::downloader::write_tags(
                &temp_path,
                title.as_deref().unwrap_or("Unknown"),
                artist_name.as_deref().unwrap_or("Unknown Artist"),
                album_title.as_deref().unwrap_or("Unknown Album"),
                track_number,
                None, // year
                None, // genre
                cover_url.as_deref(),
                &fmt,
            );
        }

        // Move temp to final destination
        if overwrite && final_dest.exists() {
            std::fs::remove_file(&final_dest)
                .map_err(|e| format!("Failed to remove existing file: {}", e))?;
        }
        std::fs::rename(&temp_path, &final_dest)
            .map_err(|e| format!("Failed to move downloaded file: {}", e))?;

        let file_size = std::fs::metadata(&final_dest)
            .map(|m| m.len())
            .unwrap_or(0);

        let actual_format = final_dest.extension()
            .and_then(|e| e.to_str())
            .unwrap_or(fmt.extension())
            .to_uppercase();

        Ok(DownloadPathResult {
            path: final_dest.to_string_lossy().to_string(),
            format: actual_format,
            file_size,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_downloaded_track(
    path: String,
    collection_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(&path);
    if !file_path.exists() {
        return Err("File does not exist".to_string());
    }
    let db = state.db.clone();
    let collection_root = db.get_collection_by_id(collection_id)
        .map_err(|e| e.to_string())?
        .path;
    tauri::async_runtime::spawn_blocking(move || {
        scanner::process_media_file(&db, &file_path, Some(collection_id), collection_root.as_deref());
        let _ = db.rebuild_fts();
        let _ = db.recompute_counts();
        let _ = db.reconcile_track_likes_from_entity_likes();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_preview(
    state: State<'_, AppState>,
    app: AppHandle,
    track_id: i64,
    stream_url: String,
    format: String,
    title: Option<String>,
    artist_name: Option<String>,
    album_title: Option<String>,
    track_number: Option<u32>,
    cover_url: Option<String>,
) -> Result<UpgradePreviewInfo, String> {
    let fmt = DownloadFormat::from_str(&format)?;
    let db = state.db.clone();
    let track = db.get_track_by_id(track_id).map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || -> Result<UpgradePreviewInfo, String> {
        let actual_ext = fmt.extension();

        // Build temp path next to original file
        let bare = track.filesystem_path()
            .ok_or("Track has no local file path")?
            .to_string();
        let old_path = std::path::Path::new(&bare);
        let parent = old_path.parent().ok_or("Track has no parent directory")?;
        let stem = old_path.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
        let new_filename = format!("{}.upgrade.{}", stem, actual_ext);
        let new_path = parent.join(&new_filename);

        if new_path.exists() {
            std::fs::remove_file(&new_path)
                .map_err(|e| format!("Failed to remove existing preview: {}", e))?;
        }

        // Download to temp path with progress events
        crate::downloader::download_file(
            &stream_url,
            None,
            &new_path,
            None,
            Some(&|pct| {
                let _ = app.emit("upgrade-download-progress", pct);
            }),
        )?;

        // Write tags if metadata was provided
        if title.is_some() || artist_name.is_some() {
            if let Err(e) = crate::downloader::write_tags(
                &new_path,
                title.as_deref().unwrap_or("Unknown"),
                artist_name.as_deref().unwrap_or("Unknown Artist"),
                album_title.as_deref().unwrap_or("Unknown Album"),
                track_number,
                None, // year
                None, // genre
                cover_url.as_deref(),
                &fmt,
            ) {
                log::warn!("Failed to write tags to upgrade preview: {}", e);
            }
        }

        let new_file_size = std::fs::metadata(&new_path).ok().map(|m| m.len() as i64);
        let new_format = Some(actual_ext.to_string());

        Ok(UpgradePreviewInfo {
            old_path: track.path.clone(),
            old_format: track.format.clone(),
            old_file_size: track.file_size,
            new_path: new_path.to_string_lossy().to_string(),
            new_format,
            new_file_size,
        })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn confirm_track_upgrade(
    state: State<'_, AppState>,
    track_id: i64,
    new_path: String,
) -> Result<(), String> {
    let db = state.db.clone();
    let track = db.get_track_by_id(track_id).map_err(|e| e.to_string())?;

    let bare_old = track.filesystem_path()
        .ok_or("Track has no local file path")?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let old_path = std::path::Path::new(&bare_old);
        let new_file = std::path::Path::new(&new_path);

        if !new_file.exists() {
            return Err("Preview file not found".to_string());
        }

        // Delete old file
        if old_path.exists() {
            std::fs::remove_file(old_path)
                .map_err(|e| format!("Failed to delete old file: {}", e))?;
        }

        // Rename: remove ".upgrade" from filename
        let parent = new_file.parent().ok_or("No parent directory")?;
        let filename = new_file.file_name().and_then(|f| f.to_str()).ok_or("Invalid filename")?;
        let final_filename = filename.replace(".upgrade.", ".");
        let final_path = parent.join(&final_filename);

        // If final path already exists (same extension as old), remove it
        if final_path.exists() && final_path != new_file {
            std::fs::remove_file(&final_path)
                .map_err(|e| format!("Failed to remove existing file at target: {}", e))?;
        }

        std::fs::rename(new_file, &final_path)
            .map_err(|e| format!("Failed to rename file: {}", e))?;

        // Remove old track from DB and re-scan the new file
        let _ = db.remove_track_by_id(track.id);
        let collection_id = track.collection_id;
        let collection_root = collection_id
            .and_then(|cid| db.get_collection_by_id(cid).ok())
            .and_then(|c| c.path);
        crate::scanner::process_media_file(&db, &final_path, collection_id, collection_root.as_deref());
        let _ = db.rebuild_fts();
        let _ = db.recompute_counts();
        let _ = db.reconcile_track_likes_from_entity_likes();

        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cancel_track_upgrade(new_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let path = std::path::Path::new(&new_path);
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("Failed to remove preview file: {}", e))?;
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_track_as_copy(
    state: State<'_, AppState>,
    track_id: i64,
    new_path: String,
) -> Result<(), String> {
    let db = state.db.clone();
    let track = db.get_track_by_id(track_id).map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let new_file = std::path::Path::new(&new_path);

        if !new_file.exists() {
            return Err("Preview file not found".to_string());
        }

        // Rename: {stem}.upgrade.{ext} -> {stem} (upgraded).{ext}
        let parent = new_file.parent().ok_or("No parent directory")?;
        let filename = new_file.file_name().and_then(|f| f.to_str()).ok_or("Invalid filename")?;
        let final_filename = if let Some(pos) = filename.find(".upgrade.") {
            let stem = &filename[..pos];
            let ext = &filename[pos + ".upgrade.".len()..];
            format!("{} (upgraded).{}", stem, ext)
        } else {
            let p = std::path::Path::new(filename);
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("flac");
            format!("{} (upgraded).{}", stem, ext)
        };
        let final_path = parent.join(&final_filename);

        if final_path.exists() {
            return Err(format!("File already exists: {}", final_path.display()));
        }

        std::fs::rename(new_file, &final_path)
            .map_err(|e| format!("Failed to rename file: {}", e))?;

        // Register in library
        let collection_id = track.collection_id;
        let collection_root = collection_id
            .and_then(|cid| db.get_collection_by_id(cid).ok())
            .and_then(|c| c.path);
        crate::scanner::process_media_file(&db, &final_path, collection_id, collection_root.as_deref());
        let _ = db.rebuild_fts();
        let _ = db.recompute_counts();
        let _ = db.reconcile_track_likes_from_entity_likes();

        Ok(())
    }).await.map_err(|e| e.to_string())?
}
