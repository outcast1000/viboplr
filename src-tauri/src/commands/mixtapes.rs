// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

// ── Mixtape operations ───────────────────────────────────────────

#[tauri::command]
pub fn preview_mixtape(
    path: String,
    state: State<'_, AppState>,
) -> Result<crate::models::MixtapePreview, String> {
    let temp_dir = state.app_dir.join("temp");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    crate::mixtape::read_mixtape(std::path::Path::new(&path), &temp_dir)
}

#[tauri::command]
pub fn export_mixtape(
    dest_path: String,
    options: crate::models::MixtapeExportOptions,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let db = state.db.clone();
    let cancel = state.mixtape_cancel.clone();
    let app_dir = state.app_dir.clone();
    cancel.store(false, Ordering::Relaxed);

    let tracks = db.get_tracks_by_ids(&options.track_ids)
        .map_err(|e| format!("Failed to get tracks: {}", e))?;

    let mut sources = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for track in &tracks {
        let audio_path = if let Some(fs_path) = track.filesystem_path() {
            if std::path::Path::new(fs_path).exists() {
                fs_path.to_string()
            } else {
                skipped.push(format!("{} (file missing)", track.title));
                continue;
            }
        } else {
            skipped.push(format!("{} (remote track — download first)", track.title));
            continue;
        };

        let thumb_path = if let (Some(album_title), Some(artist_name)) = (&track.album_title, &track.artist_name) {
            let slug = crate::entity_image::entity_image_slug("album", album_title, Some(artist_name));
            crate::entity_image::get_image_path(&app_dir, "album", &slug)
                .map(|p| p.to_string_lossy().to_string())
        } else {
            None
        };

        sources.push(crate::mixtape::MixtapeTrackSource {
            title: track.title.clone(),
            artist: track.artist_name.clone().unwrap_or_default(),
            album: track.album_title.clone(),
            duration_secs: track.duration_secs,
            audio_path,
            thumb_path,
        });
    }
    if sources.is_empty() {
        return Err(format!("No exportable tracks. Skipped: {}", skipped.join(", ")));
    }

    let manifest = crate::mixtape::build_manifest(
        options.title, options.mixtape_type, options.metadata,
        options.created_by, vec![],
    );

    let cover_image_path = options.cover_image_path.clone();
    let include_thumbs = options.include_thumbs;

    thread::spawn(move || {
        let dest = std::path::Path::new(&dest_path);
        let cover = cover_image_path.as_ref().map(|p| std::path::Path::new(p.as_str()));

        match crate::mixtape::build_mixtape(
            dest, cover, &sources, manifest, include_thumbs, &cancel,
            |current, total, title, _sub_progress| {
                let _ = app.emit("mixtape-export-progress", crate::models::MixtapeExportProgress {
                    current_track: current, total_tracks: total,
                    phase: "packing".to_string(), track_title: title.to_string(),
                });
            },
        ) {
            Ok(file_size) => {
                let _ = app.emit("mixtape-export-complete", serde_json::json!({
                    "path": dest_path, "fileSize": file_size,
                }));
            }
            Err(e) => {
                let _ = app.emit("mixtape-export-error", serde_json::json!({ "message": e }));
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn export_mixtape_playlist_only(
    dest_path: String,
    options: crate::models::MixtapePlaylistExportOptions,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Emitter;

    let dest_path = if !dest_path.ends_with(".mixtape") {
        format!("{}.mixtape", dest_path)
    } else {
        dest_path
    };

    if std::path::Path::new(&dest_path).is_dir() {
        return Err("Destination path is a directory".to_string());
    }

    let app_dir = state.app_dir.clone();

    let track_entries: Vec<crate::models::MixtapeTrack> = options.tracks.iter().map(|t| {
        crate::models::MixtapeTrack {
            title: t.title.clone(),
            artist: t.artist.clone().unwrap_or_default(),
            album: t.album.clone(),
            duration_secs: t.duration_secs,
            file: None,
            thumb: None,
        }
    }).collect();

    // Resolve thumbnail paths from cached album images
    let thumb_paths: Vec<Option<String>> = options.tracks.iter().map(|t| {
        // Try local cached album image first
        if let (Some(album), Some(artist)) = (&t.album, &t.artist) {
            let slug = crate::entity_image::entity_image_slug("album", album, Some(artist));
            if let Some(p) = crate::entity_image::get_image_path(&app_dir, "album", &slug) {
                return Some(p.to_string_lossy().to_string());
            }
        }
        // Fall back to image_url if it's a local path
        if let Some(ref url) = t.image_url {
            if !url.starts_with("http") && std::path::Path::new(url).exists() {
                return Some(url.clone());
            }
        }
        None
    }).collect();

    let manifest = crate::mixtape::build_manifest(
        options.title, options.mixtape_type, options.metadata,
        options.created_by, track_entries,
    );

    let cover = options.cover_image_path.clone();
    let include_thumbs = options.include_thumbs;

    thread::spawn(move || {
        let dest = std::path::Path::new(&dest_path);
        let cover_path = cover.as_ref().map(|p| std::path::Path::new(p.as_str()));
        match crate::mixtape::build_playlist_mixtape(dest, cover_path, manifest, &thumb_paths, include_thumbs) {
            Ok(file_size) => {
                let _ = app.emit("mixtape-export-complete", serde_json::json!({
                    "path": dest_path, "fileSize": file_size,
                }));
            }
            Err(e) => {
                let _ = app.emit("mixtape-export-error", serde_json::json!({ "message": e }));
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn export_mixtape_full(
    dest_path: String,
    options: crate::models::MixtapeFullExportOptions,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Emitter;

    let dest_path = if !dest_path.ends_with(".mixtape") {
        format!("{}.mixtape", dest_path)
    } else {
        dest_path
    };

    if std::path::Path::new(&dest_path).is_dir() {
        return Err("Destination path is a directory".to_string());
    }

    let cancel = state.mixtape_cancel.clone();
    let app_dir = state.app_dir.clone();
    let resolve_registry = state.download_resolve_registry.clone();
    cancel.store(false, Ordering::Relaxed);

    let tracks_input = options.tracks.clone();
    let cover_image_path = options.cover_image_path.clone();
    let include_thumbs = options.include_thumbs;
    let format = options.format.as_deref().unwrap_or("flac").to_string();

    thread::spawn(move || {
        let temp_dir = app_dir.join("temp_mixtape_export");
        let _ = std::fs::create_dir_all(&temp_dir);

        let mut sources: Vec<crate::mixtape::MixtapeTrackSource> = Vec::new();
        let mut skipped: Vec<String> = Vec::new();
        let total = tracks_input.len();

        for (i, track) in tracks_input.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                let _ = std::fs::remove_dir_all(&temp_dir);
                let _ = app.emit("mixtape-export-error",
                    serde_json::json!({ "message": "Export cancelled" }));
                return;
            }

            let audio_path: Option<String> = if let Some(ref path) = track.path {
                if path.starts_with("file://") {
                    let _ = app.emit("mixtape-export-progress", crate::models::MixtapeExportProgress {
                        current_track: (i + 1) as u32,
                        total_tracks: total as u32,
                        phase: "packing".to_string(),
                        track_title: track.title.clone(),
                    });
                    let fs_path = &path[7..];
                    if std::path::Path::new(fs_path).exists() {
                        Some(fs_path.to_string())
                    } else {
                        None
                    }
                } else {
                    let source = if path.starts_with("subsonic://") { "subsonic" }
                        else if path.starts_with("file://") { "local" }
                        else { "plugin" };
                    resolve_and_download_track(&resolve_registry, &app, &temp_dir, i, total, track, source, &cancel, &format)
                }
            } else {
                resolve_and_download_track(&resolve_registry, &app, &temp_dir, i, total, track, "plugin", &cancel, &format)
            };

            match audio_path {
                Some(path) => {
                    let thumb_path = track.album.as_ref().and_then(|album| {
                        let artist = track.artist.as_deref().unwrap_or("");
                        let slug = crate::entity_image::entity_image_slug("album", album, Some(artist));
                        crate::entity_image::get_image_path(&app_dir, "album", &slug)
                            .map(|p| p.to_string_lossy().to_string())
                    }).or_else(|| {
                        track.image_url.as_ref().and_then(|url| {
                            if !url.starts_with("http") && std::path::Path::new(url).exists() {
                                Some(url.clone())
                            } else {
                                None
                            }
                        })
                    });
                    sources.push(crate::mixtape::MixtapeTrackSource {
                        title: track.title.clone(),
                        artist: track.artist.clone().unwrap_or_default(),
                        album: track.album.clone(),
                        duration_secs: track.duration_secs,
                        audio_path: path,
                        thumb_path,
                    });
                }
                None => {
                    skipped.push(track.title.clone());
                }
            }
        }

        if sources.is_empty() {
            let _ = std::fs::remove_dir_all(&temp_dir);
            let _ = app.emit("mixtape-export-error", serde_json::json!({
                "message": format!("No tracks could be resolved. Skipped: {}", skipped.join(", ")),
            }));
            return;
        }

        let manifest = crate::mixtape::build_manifest(
            options.title, options.mixtape_type, options.metadata,
            options.created_by, vec![],
        );
        let dest = std::path::Path::new(&dest_path);
        let cover = cover_image_path.as_ref().map(|p| std::path::Path::new(p.as_str()));

        match crate::mixtape::build_mixtape(
            dest, cover, &sources, manifest, include_thumbs, &cancel,
            |current, total, title, _| {
                let _ = app.emit("mixtape-export-progress", crate::models::MixtapeExportProgress {
                    current_track: current, total_tracks: total,
                    phase: "packing".to_string(), track_title: title.to_string(),
                });
            },
        ) {
            Ok(file_size) => {
                let complete_payload = if !skipped.is_empty() {
                    serde_json::json!({ "path": dest_path, "fileSize": file_size, "skipped": skipped })
                } else {
                    serde_json::json!({ "path": dest_path, "fileSize": file_size })
                };
                let _ = app.emit("mixtape-export-complete", complete_payload);
            }
            Err(e) => {
                let _ = app.emit("mixtape-export-error", serde_json::json!({ "message": e }));
            }
        }

        let _ = std::fs::remove_dir_all(&temp_dir);
    });

    Ok(())
}

#[tauri::command]
pub fn import_mixtape(
    path: String,
    mode: crate::models::MixtapeImportMode,
    dest_dir: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let db = state.db.clone();
    let cancel = state.mixtape_cancel.clone();
    let app_dir = state.app_dir.clone();
    cancel.store(false, Ordering::Relaxed);

    thread::spawn(move || {
        let mixtape_path = std::path::Path::new(&path);

        match mode {
            crate::models::MixtapeImportMode::PlaylistAndFiles => {
                // Read the manifest first to get metadata
                let temp_dir = app_dir.join("temp");
                let _ = std::fs::create_dir_all(&temp_dir);
                let preview = match crate::mixtape::read_mixtape(mixtape_path, &temp_dir) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e }));
                        return;
                    }
                };

                let track_count = preview.manifest.tracks.len() as u32;
                let mixtape_title = preview.manifest.title.clone();

                // Extract to app_dir/mixtapes/{slug}/
                let slug = crate::entity_image::canonical_slug(&mixtape_title);
                let extract_dir = app_dir.join("mixtapes").join(&slug);
                let extract_opts = crate::mixtape::ExtractOptions { audio: true, images: true };

                let manifest = match crate::mixtape::extract_mixtape(
                    mixtape_path, &extract_dir, &extract_opts, &cancel,
                    |current, total, title| {
                        let _ = app.emit("mixtape-import-progress", crate::models::MixtapeImportProgress {
                            current_track: current, total_tracks: total,
                            track_title: title.to_string(),
                        });
                    },
                ) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e }));
                        return;
                    }
                };

                // Create playlist, extracting description and source from manifest metadata
                let source = manifest.metadata.get("source").cloned().or(Some("mixtape".to_string()));
                let description = manifest.metadata.get("description").cloned();
                let rest_meta: std::collections::HashMap<&str, &str> = manifest.metadata.iter()
                    .filter(|(k, _)| k.as_str() != "source" && k.as_str() != "description")
                    .map(|(k, v)| (k.as_str(), v.as_str()))
                    .collect();
                let metadata_json = if rest_meta.is_empty() { None } else { serde_json::to_string(&rest_meta).ok() };
                let playlist_id = match db.save_playlist(&mixtape_title, source.as_deref(), None, description.as_deref(), metadata_json.as_deref()) {
                    Ok(id) => id,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e.to_string() }));
                        return;
                    }
                };

                // Save playlist tracks with file:// paths to extracted audio
                let track_tuples: Vec<(String, Option<String>, Option<String>, Option<f64>, Option<String>, Option<String>)> =
                    manifest.tracks.iter().map(|t| {
                        let audio_path = t.file.as_ref().map(|f| format!("file://{}", extract_dir.join(f).to_string_lossy())).unwrap_or_default();
                        (
                            t.title.clone(),
                            Some(t.artist.clone()),
                            t.album.clone(),
                            t.duration_secs,
                            Some(audio_path),
                            None,
                        )
                    }).collect();

                let track_refs: Vec<(&str, Option<&str>, Option<&str>, Option<f64>, Option<&str>, Option<&str>)> =
                    track_tuples.iter().map(|(title, artist, album, dur, source, img)| {
                        (
                            title.as_str(),
                            artist.as_deref(),
                            album.as_deref(),
                            *dur,
                            source.as_deref(),
                            img.as_deref(),
                        )
                    }).collect();

                if let Err(e) = db.save_playlist_tracks(playlist_id, &track_refs) {
                    let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e.to_string() }));
                    return;
                }

                // Save cover as playlist image
                let cover_path = extract_dir.join("cover.jpg");
                if cover_path.exists() {
                    let img_dir = app_dir.join("playlist_images");
                    let _ = std::fs::create_dir_all(&img_dir);
                    let dest_img = img_dir.join(format!("{}.jpg", playlist_id));
                    if std::fs::copy(&cover_path, &dest_img).is_ok() {
                        let abs = dest_img.to_string_lossy().to_string();
                        let _ = db.update_playlist_image(playlist_id, &abs);
                    }
                }

                let _ = app.emit("mixtape-import-complete", serde_json::json!({
                    "mode": "PlaylistAndFiles", "trackCount": track_count, "playlistId": playlist_id,
                }));
            }

            crate::models::MixtapeImportMode::PlaylistOnly => {
                // Read manifest without extracting audio
                let temp_dir = app_dir.join("temp");
                let _ = std::fs::create_dir_all(&temp_dir);
                let preview = match crate::mixtape::read_mixtape(mixtape_path, &temp_dir) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e }));
                        return;
                    }
                };

                let track_count = preview.manifest.tracks.len() as u32;
                let mixtape_title = preview.manifest.title.clone();

                // Create playlist with metadata only (no file paths)
                let source = preview.manifest.metadata.get("source").cloned().or(Some("mixtape".to_string()));
                let description = preview.manifest.metadata.get("description").cloned();
                let rest_meta: std::collections::HashMap<&str, &str> = preview.manifest.metadata.iter()
                    .filter(|(k, _)| k.as_str() != "source" && k.as_str() != "description")
                    .map(|(k, v)| (k.as_str(), v.as_str()))
                    .collect();
                let metadata_json = if rest_meta.is_empty() { None } else { serde_json::to_string(&rest_meta).ok() };
                let playlist_id = match db.save_playlist(&mixtape_title, source.as_deref(), None, description.as_deref(), metadata_json.as_deref()) {
                    Ok(id) => id,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e.to_string() }));
                        return;
                    }
                };

                let track_tuples: Vec<(String, Option<String>, Option<String>, Option<f64>, Option<String>, Option<String>)> =
                    preview.manifest.tracks.iter().map(|t| {
                        (
                            t.title.clone(),
                            Some(t.artist.clone()),
                            t.album.clone(),
                            t.duration_secs,
                            None,
                            None,
                        )
                    }).collect();

                let track_refs: Vec<(&str, Option<&str>, Option<&str>, Option<f64>, Option<&str>, Option<&str>)> =
                    track_tuples.iter().map(|(title, artist, album, dur, source, img)| {
                        (
                            title.as_str(),
                            artist.as_deref(),
                            album.as_deref(),
                            *dur,
                            source.as_deref(),
                            img.as_deref(),
                        )
                    }).collect();

                if let Err(e) = db.save_playlist_tracks(playlist_id, &track_refs) {
                    let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e.to_string() }));
                    return;
                }

                // Save cover as playlist image from the temp preview
                if let Some(ref cover_temp_str) = preview.cover_temp_path {
                    let cover_temp = std::path::Path::new(cover_temp_str);
                    if cover_temp.exists() {
                        let img_dir = app_dir.join("playlist_images");
                        let _ = std::fs::create_dir_all(&img_dir);
                        let dest_img = img_dir.join(format!("{}.jpg", playlist_id));
                        if std::fs::copy(cover_temp, &dest_img).is_ok() {
                            let abs = dest_img.to_string_lossy().to_string();
                            let _ = db.update_playlist_image(playlist_id, &abs);
                        }
                    }
                }

                let _ = app.emit("mixtape-import-complete", serde_json::json!({
                    "mode": "PlaylistOnly", "trackCount": track_count, "playlistId": playlist_id,
                }));
            }

            crate::models::MixtapeImportMode::FilesOnly => {
                let extract_dest = match dest_dir {
                    Some(ref d) => std::path::PathBuf::from(d),
                    None => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({
                            "message": "dest_dir is required for FilesOnly mode"
                        }));
                        return;
                    }
                };

                let extract_opts = crate::mixtape::ExtractOptions { audio: true, images: false };

                let manifest = match crate::mixtape::extract_mixtape(
                    mixtape_path, &extract_dest, &extract_opts, &cancel,
                    |current, total, title| {
                        let _ = app.emit("mixtape-import-progress", crate::models::MixtapeImportProgress {
                            current_track: current, total_tracks: total,
                            track_title: title.to_string(),
                        });
                    },
                ) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e }));
                        return;
                    }
                };

                let track_count = manifest.tracks.len() as u32;
                let _ = app.emit("mixtape-import-complete", serde_json::json!({
                    "mode": "FilesOnly", "trackCount": track_count,
                }));
            }

            crate::models::MixtapeImportMode::JustPlay => {
                // Extract to temp directory for immediate playback
                let playback_dir = app_dir.join("temp").join("mixtape_playback");
                let _ = std::fs::remove_dir_all(&playback_dir);
                let _ = std::fs::create_dir_all(&playback_dir);

                let extract_opts = crate::mixtape::ExtractOptions { audio: true, images: true };

                let manifest = match crate::mixtape::extract_mixtape(
                    mixtape_path, &playback_dir, &extract_opts, &cancel,
                    |current, total, title| {
                        let _ = app.emit("mixtape-import-progress", crate::models::MixtapeImportProgress {
                            current_track: current, total_tracks: total,
                            track_title: title.to_string(),
                        });
                    },
                ) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = app.emit("mixtape-import-error", serde_json::json!({ "message": e }));
                        return;
                    }
                };

                let track_paths: Vec<serde_json::Value> = manifest.tracks.iter().map(|t| {
                    let thumb_path = t.thumb.as_ref()
                        .map(|th| playback_dir.join(th))
                        .filter(|p| p.exists())
                        .map(|p| p.to_string_lossy().to_string());
                    serde_json::json!({
                        "title": t.title,
                        "artist_name": t.artist,
                        "album_title": t.album,
                        "duration_secs": t.duration_secs,
                        "path": t.file.as_ref().map(|f| format!("file://{}", playback_dir.join(f).to_string_lossy())).unwrap_or_default(),
                        "image_url": thumb_path,
                    })
                }).collect();

                let track_count = manifest.tracks.len() as u32;

                let cover_path = playback_dir.join("cover.jpg");
                let cover_value = if cover_path.exists() {
                    serde_json::Value::String(cover_path.to_string_lossy().to_string())
                } else {
                    serde_json::Value::Null
                };

                let _ = app.emit("mixtape-just-play", serde_json::json!({
                    "tracks": track_paths,
                    "coverPath": cover_value,
                    "title": manifest.title,
                    "metadata": manifest.metadata,
                }));

                let _ = app.emit("mixtape-import-complete", serde_json::json!({
                    "mode": "JustPlay", "trackCount": track_count,
                }));
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_mixtape_operation(state: State<'_, AppState>) -> Result<(), String> {
    state.mixtape_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn cleanup_temp_mixtapes(state: State<'_, AppState>) -> Result<(), String> {
    let temp_mixtape_dir = state.app_dir.join("temp").join("mixtape_playback");
    if temp_mixtape_dir.exists() {
        std::fs::remove_dir_all(&temp_mixtape_dir)
            .map_err(|e| format!("Cleanup failed: {}", e))?;
    }
    Ok(())
}
