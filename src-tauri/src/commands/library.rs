// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

// --- Library commands ---

#[tauri::command]
pub fn get_artists(
    state: State<'_, AppState>,
    liked_only: Option<bool>,
) -> Result<Vec<Artist>, String> {
    state.db.get_artists_filtered(liked_only.unwrap_or(false)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_artist_by_id(state: State<'_, AppState>, artist_id: i64) -> Result<Option<Artist>, String> {
    state.db.get_artist_by_id(artist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_albums(
    state: State<'_, AppState>,
    artist_id: Option<i64>,
    sort: Option<String>,
    liked_only: Option<bool>,
) -> Result<Vec<Album>, String> {
    state.db.get_albums_sorted(artist_id, sort.as_deref(), liked_only.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_album_by_id(state: State<'_, AppState>, album_id: i64) -> Result<Option<Album>, String> {
    state.db.get_album_by_id(album_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_track_count(state: State<'_, AppState>) -> Result<i64, String> {
    state.db.get_track_count().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_tracks(
    state: State<'_, AppState>,
    opts: TrackQuery,
) -> Result<Vec<Track>, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || db.get_tracks(&opts).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn search_all(
    state: State<'_, AppState>,
    query: String,
    artist_limit: i64,
    album_limit: i64,
    track_limit: i64,
) -> Result<SearchAllResults, String> {
    state
        .db
        .search_all(&query, artist_limit, album_limit, track_limit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_entity(
    state: State<'_, AppState>,
    query: String,
    entity: String,
    limit: i64,
    offset: i64,
    sort_field: Option<String>,
    sort_dir: Option<String>,
    sort_chain: Option<Vec<SortKey>>,
    media_type: Option<String>,
    liked_only: Option<bool>,
    has_youtube_url: Option<bool>,
) -> Result<SearchEntityResult, String> {
    let track_opts = TrackQuery {
        limit: Some(limit),
        offset: Some(offset),
        sort_field,
        sort_dir,
        sort_chain,
        media_type,
        liked_only: liked_only.unwrap_or(false),
        has_youtube_url: has_youtube_url.unwrap_or(false),
        ..Default::default()
    };
    state
        .db
        .search_entity(&query, &entity, &track_opts)
        .map_err(|e| e.to_string())
}

// --- Track lookup command ---

#[tauri::command]
pub fn get_track_by_id(state: State<'_, AppState>, track_id: i64) -> Result<Track, String> {
    state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_artist_by_name(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<Artist>, String> {
    state
        .db
        .find_artist_by_name(&name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_album_by_name(
    state: State<'_, AppState>,
    title: String,
    artist_name: Option<String>,
) -> Result<Option<Album>, String> {
    state
        .db
        .find_album_by_name(&title, artist_name.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_track_by_metadata(
    state: State<'_, AppState>,
    title: String,
    artist_name: Option<String>,
    album_name: Option<String>,
) -> Result<Option<Track>, String> {
    state
        .db
        .find_track_by_metadata(&title, artist_name.as_deref(), album_name.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_track_id_by_path(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<i64>, String> {
    state.db.find_track_id_by_path(&path).map_err(|e| e.to_string())
}

// --- Track path command ---

#[tauri::command]
pub fn get_track_path(state: State<'_, AppState>, track_id: i64) -> Result<String, String> {
    let track = state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())?;

    log::info!("Playing: {} — {} (id={})", track.artist_name.as_deref().unwrap_or("?"), track.title, track_id);

    if let Some(remote_id) = track.remote_id() {
        let collection_id = track
            .collection_id
            .ok_or("Track has remote path but no collection_id")?;
        let creds = state
            .db
            .get_collection_credentials(collection_id)
            .map_err(|e| e.to_string())?;
        let client = SubsonicClient::from_stored(
            &creds.url,
            &creds.username,
            &creds.password_token,
            creds.salt.as_deref(),
            &creds.auth_method,
        );
        Ok(client.stream_url(remote_id))
    } else {
        Ok(track.filesystem_path().unwrap_or(&track.path).to_string())
    }
}

#[tauri::command]
pub fn resolve_subsonic_location(
    state: State<'_, AppState>,
    location: String,
) -> Result<String, String> {
    // Parse: subsonic://{host}/{subsonic_id}
    let without_scheme = location
        .strip_prefix("subsonic://")
        .ok_or("Invalid subsonic location: missing subsonic:// prefix")?;
    let last_slash = without_scheme
        .rfind('/')
        .ok_or("Invalid subsonic location: missing track id")?;
    let host = &without_scheme[..last_slash];
    let track_id = &without_scheme[last_slash + 1..];

    if track_id.is_empty() {
        return Err("Invalid subsonic location: empty track id".to_string());
    }

    let collections = state.db.get_collections().map_err(|e| e.to_string())?;
    let collection = collections
        .iter()
        .find(|c| {
            c.kind == "subsonic"
                && c.url.as_ref().map_or(false, |u| {
                    let normalized = u
                        .trim_start_matches("https://")
                        .trim_start_matches("http://")
                        .trim_end_matches('/');
                    normalized == host
                })
        })
        .ok_or_else(|| format!("No subsonic collection found matching host: {}", host))?;

    let creds = state
        .db
        .get_collection_credentials(collection.id)
        .map_err(|e| e.to_string())?;
    let client = crate::subsonic::SubsonicClient::from_stored(
        &creds.url,
        &creds.username,
        &creds.password_token,
        creds.salt.as_deref(),
        &creds.auth_method,
    );
    Ok(client.stream_url(track_id))
}

#[tauri::command]
pub fn get_tracks_by_paths(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<Track>, String> {
    state.db.get_tracks_by_paths(&paths).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tracks_by_ids(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<Vec<Track>, String> {
    state
        .db
        .get_tracks_by_ids(&ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tracks_by_artist(
    state: State<'_, AppState>,
    artist_id: i64,
) -> Result<Vec<Track>, String> {
    state
        .db
        .get_tracks_by_artist(artist_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tags(state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    state.db.get_tags().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tag_by_id(state: State<'_, AppState>, tag_id: i64) -> Result<Option<Tag>, String> {
    state.db.get_tag_by_id(tag_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_tag_by_name(state: State<'_, AppState>, name: String) -> Result<Option<Tag>, String> {
    state.db.find_tag_by_name(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tags_for_track(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<Vec<Tag>, String> {
    state
        .db
        .get_tags_for_track(track_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tracks_by_tag(
    state: State<'_, AppState>,
    tag_id: i64,
) -> Result<Vec<Track>, String> {
    state
        .db
        .get_tracks_by_tag(tag_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_top_artists_for_tag(
    state: State<'_, AppState>,
    tag_id: i64,
    limit: i64,
) -> Result<Vec<(String, i64)>, String> {
    state
        .db
        .get_top_artists_for_tag(tag_id, limit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_liked(
    state: State<'_, AppState>,
    kind: String,
    id: i64,
    liked: i32,
) -> Result<(), String> {
    let table = match kind.as_str() {
        "track" => "tracks",
        "artist" => "artists",
        "album" => "albums",
        "tag" => "tags",
        _ => return Err(format!("Unknown kind: {}", kind)),
    };
    state.db.toggle_liked(table, id, liked).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_entity_like_state(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    entity: EntityLikePayload,
    like_state: i32,
) -> Result<i32, String> {
    if !matches!(kind.as_str(), "track" | "artist" | "album" | "tag") {
        return Err(format!("Unknown kind: {}", kind));
    }
    let db = &state.db;

    let entity_key = crate::db::likes::build_entity_key(
        &kind, &entity.title, entity.artist_name.as_deref(),
    );

    let metadata = serde_json::json!({
        "title": entity.title,
        "name": entity.title,
        "artist_name": entity.artist_name,
        "album_title": entity.album_title,
        "duration_secs": entity.duration_secs,
        "source": entity.source,
        "image_url": entity.image_url,
    }).to_string();

    let now_ts: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    db.set_entity_like(&kind, &entity_key, like_state, Some(&metadata), now_ts)
        .map_err(|e| e.to_string())?;

    db.mirror_entity_like_to_library(
        &kind, &entity.title, entity.artist_name.as_deref(), entity.album_title.as_deref(), like_state,
    ).map_err(|e| e.to_string())?;

    let _ = app.emit("entity-likes-changed", serde_json::json!({ "kind": kind }));

    Ok(like_state)
}

#[tauri::command]
pub fn get_liked_tracks(state: State<'_, AppState>) -> Result<Vec<Track>, String> {
    state.db.get_liked_tracks().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rebuild_search_index(state: State<'_, AppState>) -> Result<(), String> {
    state.db.rebuild_fts().map_err(|e| e.to_string())?;
    state.db.recompute_counts().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_in_folder(state: State<'_, AppState>, track_id: i64) -> Result<(), String> {
    let track = state
        .db
        .get_track_by_id(track_id)
        .map_err(|e| e.to_string())?;

    // Only show in folder for local tracks
    if track.is_remote() {
        return Err("Cannot open folder for server tracks".to_string());
    }

    let fs_path = track.filesystem_path().ok_or("Track has no local file path")?;
    tauri_plugin_opener::reveal_item_in_dir(fs_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_in_folder_path(file_path: String) -> Result<(), String> {
    let bare = file_path.strip_prefix("file://").unwrap_or(&file_path);
    let path = std::path::Path::new(bare);
    if !path.exists() {
        return Err(format!("File not found: {}", bare));
    }
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_tracks(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    track_ids: Vec<i64>,
) -> Result<DeleteTracksResult, String> {
    let tracks = state.db.get_tracks_by_ids(&track_ids).map_err(|e| e.to_string())?;
    let mut deleted_ids = Vec::new();
    let mut failures = Vec::new();
    for track in &tracks {
        if track.is_remote() {
            failures.push(DeleteFailure {
                title: track.title.clone(),
                reason: "Remote tracks cannot be deleted locally".to_string(),
            });
            continue;
        }
        let fs_path = track.filesystem_path().unwrap_or(&track.path);
        let path = std::path::Path::new(fs_path);
        if path.exists() {
            if let Err(e) = trash::delete(path) {
                log::warn!("Failed to trash file {}: {}", track.path, e);
                failures.push(DeleteFailure {
                    title: track.title.clone(),
                    reason: e.to_string(),
                });
                continue;
            }
        }
        deleted_ids.push(track.id);
    }
    if !deleted_ids.is_empty() {
        state.db.delete_tracks_by_ids(&deleted_ids).map_err(|e| e.to_string())?;
        state.db.recompute_counts().map_err(|e| e.to_string())?;
        for &id in &deleted_ids {
            crate::video_frames::delete_cached_frames(&state.app_dir, id);
        }
        for track in &tracks {
            if deleted_ids.contains(&track.id) {
                let _ = app.emit("track-removed", serde_json::json!({
                    "trackId": track.id,
                    "path": track.path,
                }));
            }
        }
    }
    let deleted_paths: Vec<String> = tracks.iter()
        .filter(|t| deleted_ids.contains(&t.id))
        .map(|t| t.path.clone())
        .collect();
    Ok(DeleteTracksResult { deleted_ids, deleted_paths, failures })
}

#[tauri::command]
pub fn bulk_update_tracks(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    track_ids: Vec<i64>,
    fields: BulkUpdateFields,
) -> Result<Vec<String>, String> {
    // Perform DB updates
    let track_info = state.db.bulk_update_tracks(
        &track_ids,
        fields.artist_name.as_deref(),
        fields.album_title.as_deref(),
        fields.year,
        fields.tag_names.as_deref(),
    ).map_err(|e| e.to_string())?;

    // Write tags to local files
    let mut errors = Vec::new();
    let updates = crate::tag_writer::TagUpdates {
        artist: fields.artist_name.clone(),
        album: fields.album_title.clone(),
        year: fields.year.map(|y| y as u32),
        genre: fields.tag_names.as_ref().map(|tags| tags.join(", ")),
    };

    const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv"];

    for (_track_id, path, _collection_id) in &track_info {
        // Skip non-local files
        if !path.starts_with("file://") {
            continue;
        }

        // Strip file:// prefix for filesystem access
        let bare_path = path.strip_prefix("file://").unwrap_or(path);
        let file_path = std::path::Path::new(bare_path);
        if !file_path.exists() {
            continue;
        }

        // Skip video files — they don't support embedded metadata tags
        let is_video = file_path.extension()
            .and_then(|e| e.to_str())
            .map(|e| VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);
        if is_video {
            continue;
        }

        if let Err(e) = crate::tag_writer::write_tags(file_path, &updates) {
            errors.push(format!("{}: {}", path, e));
        }
    }

    let _ = app.emit("bulk-edit-complete", serde_json::json!({}));

    if errors.is_empty() {
        Ok(vec![])
    } else {
        Ok(errors)
    }
}

#[tauri::command]
pub fn replace_track_tags(state: State<'_, AppState>, track_id: i64, tag_names: Vec<String>) -> Result<Vec<(i64, String)>, String> {
    let result = state.db.replace_track_tags(track_id, &tag_names).map_err(|e| e.to_string())?;
    let _ = state.db.rebuild_fts();
    Ok(result)
}

#[tauri::command]
pub fn delete_tag(state: State<'_, AppState>, tag_id: i64) -> Result<(), String> {
    let affected_track_ids = state.db.delete_tag(tag_id).map_err(|e| e.to_string())?;
    for tid in &affected_track_ids {
        let _ = state.db.update_fts_for_track(*tid);
    }
    Ok(())
}
