// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

// --- Collection commands ---

#[tauri::command]
pub fn add_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    name: String,
    path: Option<String>,
    url: Option<String>,
    username: Option<String>,
    password: Option<String>,
) -> Result<Collection, String> {
    match kind.as_str() {
        "local" => {
            let folder_path = path.as_deref().ok_or("Path is required for local collections")?;
            let collection = state
                .db
                .add_collection("local", &name, Some(folder_path), None, None, None, None, None)
                .map_err(|e| e.to_string())?;
            let collection_id = collection.id;

            // Start background scan
            let db = state.db.clone();
            let scan_path = folder_path.to_string();
            let track_count_before = db.get_track_count_for_collection(collection_id).unwrap_or(0);
            thread::spawn(move || {
                let start = std::time::Instant::now();
                let removed_tracks = scanner::scan_folder(&db, &scan_path, Some(collection_id), |scanned, total| {
                    let _ = app.emit(
                        "scan-progress",
                        ScanProgress {
                            folder: scan_path.clone(),
                            scanned,
                            total,
                            collection_id,
                        },
                    );
                });
                let _ = db.rebuild_fts();
                let _ = db.recompute_counts();
                let _ = db.reconcile_track_likes_from_entity_likes();
                let _ = db.update_collection_synced(collection_id, start.elapsed().as_secs_f64());
                let track_count_after = db.get_track_count_for_collection(collection_id).unwrap_or(0);
                let new_tracks = (track_count_after - track_count_before).max(0);
                let _ = app.emit("scan-complete", serde_json::json!({
                    "folder": scan_path,
                    "collectionId": collection_id,
                    "newTracks": new_tracks,
                    "removedTracks": removed_tracks,
                }));
            });

            Ok(collection)
        }
        "subsonic" => {
            let server_url = url.as_deref().ok_or("URL is required for subsonic collections")?;
            let user = username.as_deref().ok_or("Username is required for subsonic collections")?;
            let pass = password.as_deref().ok_or("Password is required for subsonic collections")?;

            // Test connection and determine auth method
            let client = SubsonicClient::new(server_url, user, pass)
                .map_err(|e| format!("Failed to connect: {}", e))?;

            let collection = state
                .db
                .add_collection(
                    "subsonic",
                    &name,
                    None,
                    Some(server_url),
                    Some(user),
                    Some(&client.password_token),
                    client.salt.as_deref(),
                    Some(&client.auth_method),
                )
                .map_err(|e| e.to_string())?;

            let collection_id = collection.id;
            let collection_name = collection.name.clone();

            // Start background sync
            let db = state.db.clone();
            let creds_url = server_url.to_string();
            let creds_user = user.to_string();
            let creds_token = client.password_token.clone();
            let creds_salt = client.salt.clone();
            let creds_method = client.auth_method.clone();

            let track_count_before = db.get_track_count_for_collection(collection_id).unwrap_or(0);
            thread::spawn(move || {
                let client = SubsonicClient::from_stored(
                    &creds_url,
                    &creds_user,
                    &creds_token,
                    creds_salt.as_deref(),
                    &creds_method,
                );
                let _ = app.emit(
                    "sync-progress",
                    SyncProgress {
                        collection: collection_name.clone(),
                        synced: 0,
                        total: 0,
                        collection_id,
                    },
                );
                match crate::sync::sync_collection(&db, &client, collection_id, |synced, total| {
                    let _ = app.emit(
                        "sync-progress",
                        SyncProgress {
                            collection: collection_name.clone(),
                            synced,
                            total,
                            collection_id,
                        },
                    );
                }) {
                    Ok(removed_tracks) => {
                        let track_count_after = db.get_track_count_for_collection(collection_id).unwrap_or(0);
                        let new_tracks = (track_count_after - track_count_before).max(0);
                        let _ = app.emit(
                            "sync-complete",
                            serde_json::json!({
                                "collectionId": collection_id,
                                "newTracks": new_tracks,
                                "removedTracks": removed_tracks,
                            }),
                        );
                    }
                    Err(e) => {
                        log::error!("Sync failed for collection {}: {}", collection_id, e);
                        let _ = db.update_collection_sync_error(collection_id, &e);
                        let _ = app.emit(
                            "sync-error",
                            serde_json::json!({ "collectionId": collection_id, "error": e }),
                        );
                    }
                }
            });

            Ok(collection)
        }
        "manifest" => {
            let manifest_url = url.as_deref().ok_or("URL is required for manifest collections")?;

            // Validate by fetching + parsing the manifest BEFORE creating anything.
            // A bad / unreachable URL or malformed JSON fails here and propagates to
            // the UI, so we never leave a dead, empty collection behind.
            let (manifest, etag, last_modified) = match crate::manifest_sync::fetch_manifest(manifest_url, None, None)? {
                crate::manifest_sync::FetchOutcome::Fetched { manifest, etag, last_modified } => (manifest, etag, last_modified),
                crate::manifest_sync::FetchOutcome::NotModified => return Err("Manifest could not be fetched".to_string()),
            };

            let collection = state
                .db
                .add_collection("manifest", &name, None, Some(manifest_url), None, None, None, None)
                .map_err(|e| e.to_string())?;
            let collection_id = collection.id;
            let collection_name = collection.name.clone();

            // Manifest sources are remote and change over time, so subscribe them
            // to the generic auto-update loop by default (daily). The user can
            // adjust the cadence or disable it in Settings > Collections.
            let _ = state
                .db
                .update_collection(collection_id, &name, true, 1440, true);
            // Store the HTTP validators so the next resync can do a conditional GET.
            let _ = state.db.set_manifest_http_cache(collection_id, etag.as_deref(), last_modified.as_deref());

            // Ingest the already-validated manifest in the background (DB work +
            // progress events) so the command returns promptly.
            let db = state.db.clone();
            let base_url = manifest_url.to_string();
            let track_count_before = db.get_track_count_for_collection(collection_id).unwrap_or(0);
            thread::spawn(move || {
                let _ = app.emit(
                    "sync-progress",
                    SyncProgress { collection: collection_name.clone(), synced: 0, total: 0, collection_id },
                );
                match crate::manifest_sync::ingest_manifest(&db, &manifest, collection_id, &base_url, |synced, total| {
                    let _ = app.emit(
                        "sync-progress",
                        SyncProgress { collection: collection_name.clone(), synced, total, collection_id },
                    );
                }) {
                    Ok(removed_tracks) => {
                        let track_count_after = db.get_track_count_for_collection(collection_id).unwrap_or(0);
                        let new_tracks = (track_count_after - track_count_before).max(0);
                        let _ = app.emit(
                            "sync-complete",
                            serde_json::json!({
                                "collectionId": collection_id,
                                "newTracks": new_tracks,
                                "removedTracks": removed_tracks,
                            }),
                        );
                    }
                    Err(e) => {
                        log::error!("Sync failed for manifest collection {}: {}", collection_id, e);
                        let _ = db.update_collection_sync_error(collection_id, &e);
                        let _ = app.emit(
                            "sync-error",
                            serde_json::json!({ "collectionId": collection_id, "error": e }),
                        );
                    }
                }
            });

            // Re-read so the returned collection reflects the auto-update defaults.
            state.db.get_collection_by_id(collection_id).map_err(|e| e.to_string())
        }
        "seed" => {
            #[cfg(debug_assertions)]
            {
                let collection = state
                    .db
                    .add_collection("seed", &name, None, None, None, None, None, None)
                    .map_err(|e| e.to_string())?;
                crate::seed::seed_database(&state.db, collection.id, 50, 200, 2000)?;
                Ok(collection)
            }
            #[cfg(not(debug_assertions))]
            {
                Err("Seed collections are only available in debug mode".to_string())
            }
        }
        _ => Err(format!("Unknown collection kind: {}", kind)),
    }
}

#[tauri::command]
pub fn remove_collection(state: State<'_, AppState>, collection_id: i64) -> Result<(), String> {
    state
        .db
        .remove_collection(collection_id)
        .map_err(|e| e.to_string())?;
    let _ = state.db.rebuild_fts();
    let _ = state.db.recompute_counts();
    Ok(())
}

#[tauri::command]
pub fn get_collections(state: State<'_, AppState>) -> Result<Vec<Collection>, String> {
    state.db.get_collections().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_collection_stats(state: State<'_, AppState>) -> Result<Vec<CollectionStats>, String> {
    state.db.get_collection_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_track_in_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    title: String,
    artist_name: String,
) -> Result<Option<Track>, String> {
    state.db.find_track_in_collection(collection_id, &title, &artist_name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_collection(
    state: State<'_, AppState>,
    collection_id: i64,
    name: String,
    auto_update: bool,
    auto_update_interval_mins: i64,
    enabled: bool,
) -> Result<(), String> {
    state
        .db
        .update_collection(collection_id, &name, auto_update, auto_update_interval_mins, enabled)
        .map_err(|e| e.to_string())?;
    state.db.rebuild_fts().map_err(|e| e.to_string())?;
    state.db.recompute_counts().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resync_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    collection_id: i64,
) -> Result<(), String> {
    let collection = state
        .db
        .get_collection_by_id(collection_id)
        .map_err(|e| e.to_string())?;

    if !matches!(collection.kind.as_str(), "local" | "subsonic" | "manifest") {
        return Err(format!("Resync not supported for '{}' collections", collection.kind));
    }

    run_collection_resync(
        state.db.clone(),
        app,
        collection,
        state.resyncing_collections.clone(),
    );
    Ok(())
}

// --- Connection test commands ---

#[tauri::command]
pub fn test_collection_connection(
    state: State<'_, AppState>,
    collection_id: i64,
) -> Result<String, String> {
    let collection = state
        .db
        .get_collection_by_id(collection_id)
        .map_err(|e| e.to_string())?;

    let result = match collection.kind.as_str() {
        "subsonic" => {
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
            client.ping().map_err(|e| format!("{}", e))?;
            Ok("Connected successfully".to_string())
        }
        _ => Err(format!("Connection test not supported for '{}' collections", collection.kind)),
    };

    match &result {
        Ok(_) => { let _ = state.db.clear_collection_sync_error(collection_id); }
        Err(e) => { let _ = state.db.update_collection_sync_error(collection_id, e); }
    }

    result
}

#[tauri::command]
pub fn subsonic_test_connection(
    url: String,
    username: String,
    password: String,
) -> Result<String, String> {
    log::info!("subsonic_test_connection called with url: {}", url);
    SubsonicClient::new(&url, &username, &password)
        .map_err(|e| format!("{}", e))?;
    Ok("Connected successfully".to_string())
}

// --- Publish a music source (export bundle / publish to server) ---

/// Resolve a publish selection — a whole collection (`collection_id`) or an
/// explicit set of track ids — to local-file `PublishTrack`s plus the titles
/// of skipped remote/missing tracks. Shared by the static exporter
/// (`export_music_source`) and the publish-to-server path (`publish_to_server`)
/// so there is exactly one resolution behavior.
pub(crate) fn resolve_publish_tracks(
    state: &AppState,
    track_ids: Option<Vec<i64>>,
    collection_id: Option<i64>,
) -> Result<(Vec<crate::music_publish::PublishTrack>, Vec<String>), String> {
    use crate::music_publish::PublishTrack;

    let tracks: Vec<Track> = if let Some(cid) = collection_id {
        state.db.get_tracks_for_collection(cid).map_err(|e| e.to_string())?
    } else if let Some(ids) = track_ids {
        ids.iter().filter_map(|id| state.db.get_track_by_id(*id).ok()).collect()
    } else {
        return Err("No tracks specified to publish".to_string());
    };

    if tracks.is_empty() {
        return Err("No tracks to publish".to_string());
    }

    let mut remote_skipped: Vec<String> = Vec::new();
    let publish_tracks: Vec<PublishTrack> = tracks
        .iter()
        .filter_map(|t| match t.filesystem_path() {
            Some(p) if !t.is_remote() => Some(PublishTrack {
                title: t.title.clone(),
                artist: t.artist_name.clone(),
                album: t.album_title.clone(),
                duration_secs: t.duration_secs,
                track_number: t.track_number,
                format: t.format.clone(),
                src_path: p.to_string(),
                tags: state
                    .db
                    .get_tags_for_track(t.id)
                    .map(|tags| tags.into_iter().map(|tag| tag.name).collect())
                    .unwrap_or_default(),
            }),
            _ => {
                remote_skipped.push(t.title.clone());
                None
            }
        })
        .collect();

    if publish_tracks.is_empty() {
        return Err("None of the selected tracks are local files that can be published".to_string());
    }

    Ok((publish_tracks, remote_skipped))
}

/// Generate a self-contained, hostable music-source bundle (index.html +
/// manifest.json + tracks/) from a whole local collection or an explicit set of
/// track ids. Only local files can be bundled; remote/missing tracks are skipped
/// and reported in the result.
#[tauri::command]
pub fn export_music_source(
    state: State<'_, AppState>,
    dest_dir: String,
    name: String,
    base_url: String,
    track_ids: Option<Vec<i64>>,
    collection_id: Option<i64>,
) -> Result<crate::music_publish::ExportResult, String> {
    let (publish_tracks, remote_skipped) = resolve_publish_tracks(&state, track_ids, collection_id)?;

    let mut result = crate::music_publish::export_music_source(&dest_dir, &name, &base_url, &publish_tracks)?;
    result.skipped.extend(remote_skipped);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression pin for the extraction of `resolve_publish_tracks` out of
    /// `export_music_source`: for a seeded DB with one local and one remote
    /// track, the helper must return exactly what the old inline logic did —
    /// the local track fully resolved (path, metadata, tags) and the remote
    /// track's title in `skipped`.
    #[test]
    fn test_resolve_publish_tracks_matches_old_inline_logic() {
        let state = test_app_state();

        // Local collection + track (with a tag).
        let local_cid = state
            .db
            .add_collection("local", "Local", Some("/music"), None, None, None, None, None)
            .unwrap()
            .id;
        let artist_id = state.db.get_or_create_artist("Bloc Party").unwrap();
        let album_id = state.db.get_or_create_album("Silent Alarm", Some(artist_id), Some(2005)).unwrap();
        let local_id = state
            .db
            .upsert_track(
                "bloc-party/positive-tension.m4a", "Positive Tension", Some(artist_id), Some(album_id),
                Some(2), Some(235.9), Some("m4a"), Some(9_000_000), None, Some(local_cid), None,
            )
            .unwrap();
        let tag_id = state.db.get_or_create_tag("rock").unwrap();
        state.db.add_track_tag(local_id, tag_id).unwrap();

        // Remote (subsonic) collection + track — must land in `skipped`.
        let remote_cid = state
            .db
            .add_collection("subsonic", "Server", None, Some("https://music.example.com"), Some("u"), None, None, None)
            .unwrap()
            .id;
        let remote_id = state
            .db
            .upsert_track(
                "remote-id-1", "Remote Song", Some(artist_id), None,
                None, Some(200.0), Some("flac"), None, None, Some(remote_cid), None,
            )
            .unwrap();

        let (publish_tracks, skipped) =
            resolve_publish_tracks(&state, Some(vec![local_id, remote_id]), None).unwrap();

        // Exactly the old inline output: one resolved local PublishTrack…
        assert_eq!(publish_tracks.len(), 1);
        let pt = &publish_tracks[0];
        assert_eq!(pt.title, "Positive Tension");
        assert_eq!(pt.artist.as_deref(), Some("Bloc Party"));
        assert_eq!(pt.album.as_deref(), Some("Silent Alarm"));
        assert_eq!(pt.duration_secs, Some(235.9));
        assert_eq!(pt.track_number, Some(2));
        assert_eq!(pt.format.as_deref(), Some("m4a"));
        assert_eq!(pt.src_path, "/music/bloc-party/positive-tension.m4a");
        assert_eq!(pt.tags, vec!["rock".to_string()]);

        // …and the remote track skipped by title.
        assert_eq!(skipped, vec!["Remote Song".to_string()]);

        // The collection_id path resolves the same local track.
        let (by_collection, by_collection_skipped) =
            resolve_publish_tracks(&state, None, Some(local_cid)).unwrap();
        assert_eq!(by_collection.len(), 1);
        assert_eq!(by_collection[0].src_path, pt.src_path);
        assert!(by_collection_skipped.is_empty());
    }

    #[test]
    fn test_resolve_publish_tracks_error_cases() {
        let state = test_app_state();

        // Neither selector given.
        assert!(resolve_publish_tracks(&state, None, None)
            .unwrap_err()
            .contains("No tracks specified"));

        // Selector given but nothing resolves.
        assert!(resolve_publish_tracks(&state, Some(vec![99999]), None)
            .unwrap_err()
            .contains("No tracks to publish"));

        // Only remote tracks -> nothing publishable.
        let remote_cid = state
            .db
            .add_collection("subsonic", "Server", None, Some("https://music.example.com"), Some("u"), None, None, None)
            .unwrap()
            .id;
        let remote_id = state
            .db
            .upsert_track("rid-1", "Remote Only", None, None, None, None, None, None, None, Some(remote_cid), None)
            .unwrap();
        assert!(resolve_publish_tracks(&state, Some(vec![remote_id]), None)
            .unwrap_err()
            .contains("local files"));
    }
}
