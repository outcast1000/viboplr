mod commands;
mod composite_image;
mod db;
mod entity_image;
mod image_provider;
mod logging;
mod models;
mod tidal;
mod scanner;
#[cfg(debug_assertions)]
mod seed;
mod plugins;
mod skins;
mod subsonic;
mod sync;
mod tag_writer;
mod timing;
mod downloader;
use commands::{AppState, DownloadQueue, ImageDownloadRequest, ImageResolveRegistry};
use db::Database;
use downloader::DownloadManager;
use image_provider::AlbumImageProvider;
use std::sync::{Arc, Condvar, Mutex};
use tauri::{Emitter, Manager};

#[cfg(debug_assertions)]
fn get_invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::get_profile_info,
        commands::add_collection,
        commands::remove_collection,
        commands::update_collection,
        commands::get_collections,
        commands::get_collection_stats,
        commands::resync_collection,
        commands::get_artists,
        commands::get_albums,
        commands::get_tracks,
        commands::search_all,
        commands::get_track_count,
        commands::get_track_by_id,
        commands::get_tracks_by_ids,
        commands::get_tracks_by_paths,
        commands::get_tracks_by_artist,
        commands::get_track_path,
        commands::resolve_subsonic_location,
        commands::toggle_liked,
        commands::get_liked_tracks,
        commands::rebuild_search_index,
        commands::show_in_folder,
        commands::show_in_folder_path,
        commands::open_folder,
        commands::delete_tracks,
        commands::bulk_update_tracks,
        commands::clear_database,
        commands::get_tags,
        commands::get_tags_for_track,
        commands::get_tracks_by_tag,
        commands::get_entity_image,
        commands::get_entity_image_by_name,
        commands::set_entity_image,
        commands::paste_entity_image,
        commands::remove_entity_image,
        commands::fetch_artist_image,
        commands::fetch_album_image,
        commands::fetch_tag_image,
        commands::clear_image_failures,
        commands::record_play,
        commands::get_history_recent,
        commands::get_history_most_played,
        commands::get_history_most_played_since,
        commands::get_history_most_played_artists,
        commands::search_history_artists,
        commands::search_history_tracks,
        commands::reconnect_history_track,
        commands::reconnect_history_artist,
        commands::get_track_rank,
        commands::get_artist_rank,
        commands::get_track_play_history,
        commands::get_track_play_stats,
        commands::get_auto_continue_track,
        commands::save_playlist_entries,
        commands::load_playlist,
        commands::get_startup_timings,
        commands::test_collection_connection,
        commands::subsonic_test_connection,
        commands::tidal_check_status,
        commands::tidal_get_artist_albums,
        commands::tidal_search,
        commands::tidal_save_track,
        commands::tidal_get_album,
        commands::tidal_get_artist,
        commands::tidal_get_stream_url,
        commands::search_youtube,
        commands::set_track_youtube_url,
        commands::clear_track_youtube_url,
        commands::get_track_audio_properties,
        commands::replace_track_tags,
        commands::download_track,
        commands::download_album,
        commands::get_download_status,
        commands::cancel_download,
        commands::tidal_download_preview,
        commands::confirm_track_upgrade,
        commands::cancel_track_upgrade,
        commands::save_track_as_copy,
        commands::get_cached_waveform,
        commands::cache_waveform,
        commands::list_user_skins,
        commands::read_user_skin,
        commands::save_user_skin,
        commands::delete_user_skin,
        commands::import_skin_file,
        commands::fetch_skin_gallery,
        commands::install_gallery_skin,
        commands::open_devtools,
        commands::plugin_get_dir,
        commands::plugin_list_installed,
        commands::plugin_read_file,
        commands::plugin_storage_get,
        commands::plugin_storage_set,
        commands::plugin_storage_delete,

        commands::plugin_get_lastfm_credentials,
        commands::plugin_record_history_plays_batch,
        commands::plugin_apply_tags,
        commands::info_sync_types,
        commands::info_get_types_for_entity,
        commands::info_get_value,
        commands::info_get_values_for_entity,
        commands::info_upsert_value,
        commands::info_delete_value,
        commands::info_delete_values_for_type,
        commands::sync_image_providers,
        commands::get_image_providers,
        commands::get_all_provider_config,
        commands::update_image_provider_priority,
        commands::update_image_provider_active,
        commands::update_info_type_priority,
        commands::update_info_type_active,
        commands::reset_provider_priorities,
        commands::image_resolve_response,
        commands::plugin_fetch,
        commands::fetch_plugin_gallery,
        commands::install_gallery_plugin,
        commands::delete_user_plugin,
        commands::oauth_listen,
        commands::open_profile_folder,
        commands::open_logs_folder,
        commands::write_frontend_log,
    ]
}

#[cfg(not(debug_assertions))]
fn get_invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::get_profile_info,
        commands::add_collection,
        commands::remove_collection,
        commands::update_collection,
        commands::get_collections,
        commands::get_collection_stats,
        commands::resync_collection,
        commands::get_artists,
        commands::get_albums,
        commands::get_tracks,
        commands::search_all,
        commands::get_track_count,
        commands::get_track_by_id,
        commands::get_tracks_by_ids,
        commands::get_tracks_by_paths,
        commands::get_tracks_by_artist,
        commands::get_track_path,
        commands::resolve_subsonic_location,
        commands::toggle_liked,
        commands::get_liked_tracks,
        commands::rebuild_search_index,
        commands::show_in_folder,
        commands::show_in_folder_path,
        commands::open_folder,
        commands::delete_tracks,
        commands::bulk_update_tracks,
        commands::get_tags,
        commands::get_tags_for_track,
        commands::get_tracks_by_tag,
        commands::get_entity_image,
        commands::get_entity_image_by_name,
        commands::set_entity_image,
        commands::paste_entity_image,
        commands::remove_entity_image,
        commands::fetch_artist_image,
        commands::fetch_album_image,
        commands::fetch_tag_image,
        commands::clear_image_failures,
        commands::record_play,
        commands::get_history_recent,
        commands::get_history_most_played,
        commands::get_history_most_played_since,
        commands::get_history_most_played_artists,
        commands::search_history_artists,
        commands::search_history_tracks,
        commands::reconnect_history_track,
        commands::reconnect_history_artist,
        commands::get_track_rank,
        commands::get_artist_rank,
        commands::get_track_play_history,
        commands::get_track_play_stats,
        commands::get_auto_continue_track,
        commands::save_playlist_entries,
        commands::load_playlist,
        commands::get_startup_timings,
        commands::test_collection_connection,
        commands::subsonic_test_connection,
        commands::tidal_check_status,
        commands::tidal_get_artist_albums,
        commands::tidal_search,
        commands::tidal_save_track,
        commands::tidal_get_album,
        commands::tidal_get_artist,
        commands::tidal_get_stream_url,
        commands::search_youtube,
        commands::set_track_youtube_url,
        commands::clear_track_youtube_url,
        commands::get_track_audio_properties,
        commands::replace_track_tags,
        commands::download_track,
        commands::download_album,
        commands::get_download_status,
        commands::cancel_download,
        commands::tidal_download_preview,
        commands::confirm_track_upgrade,
        commands::cancel_track_upgrade,
        commands::save_track_as_copy,
        commands::get_cached_waveform,
        commands::cache_waveform,
        commands::list_user_skins,
        commands::read_user_skin,
        commands::save_user_skin,
        commands::delete_user_skin,
        commands::import_skin_file,
        commands::fetch_skin_gallery,
        commands::install_gallery_skin,
        commands::open_devtools,
        commands::plugin_get_dir,
        commands::plugin_list_installed,
        commands::plugin_read_file,
        commands::plugin_storage_get,
        commands::plugin_storage_set,
        commands::plugin_storage_delete,

        commands::plugin_get_lastfm_credentials,
        commands::plugin_record_history_plays_batch,
        commands::plugin_apply_tags,
        commands::info_sync_types,
        commands::info_get_types_for_entity,
        commands::info_get_value,
        commands::info_get_values_for_entity,
        commands::info_upsert_value,
        commands::info_delete_value,
        commands::info_delete_values_for_type,
        commands::sync_image_providers,
        commands::get_image_providers,
        commands::get_all_provider_config,
        commands::update_image_provider_priority,
        commands::update_image_provider_active,
        commands::update_info_type_priority,
        commands::update_info_type_active,
        commands::reset_provider_priorities,
        commands::image_resolve_response,
        commands::plugin_fetch,
        commands::fetch_plugin_gallery,
        commands::install_gallery_plugin,
        commands::delete_user_plugin,
        commands::oauth_listen,
        commands::open_logs_folder,
        commands::write_frontend_log,
    ]
}

fn download_image_from_url(
    url: &str,
    headers: Option<&std::collections::HashMap<String, String>>,
    dest: &std::path::Path,
) -> Result<(), String> {
    let client = image_provider::http_client()?;
    let mut req = client.get(url);
    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    let start = std::time::Instant::now();
    let resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status();
    log::info!("HTTP GET {} -> {} ({:.0}ms)", url, status, start.elapsed().as_secs_f64() * 1000.0);
    if !status.is_success() {
        return Err(format!("HTTP {} from {}", status, url));
    }
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    image_provider::write_image(dest, &bytes)
}

fn base64_decode_and_save(data: &str, dest: &std::path::Path) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    image_provider::write_image(dest, &bytes)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let timer = timing::init_timer();

    // Parse optional profile name from env var or CLI argument
    // Usage: VIBOPLR_PROFILE=name or --profile name or --profile=name
    // Default profile is "default" when no profile is specified
    let profile_name: String = timer.time("parse_profile", || {
        let mut profile: Option<String> =
            std::env::var("VIBOPLR_PROFILE").ok();

        if profile.is_none() {
            let args: Vec<String> = std::env::args().collect();
            let mut i = 1;
            while i < args.len() {
                if args[i].starts_with("--profile=") {
                    profile = Some(
                        args[i].trim_start_matches("--profile=").to_string(),
                    );
                    i += 1;
                } else if args[i] == "--profile" {
                    if i + 1 < args.len() {
                        profile = Some(args[i + 1].clone());
                        i += 2;
                    } else {
                        eprintln!("Error: --profile requires a name argument");
                        std::process::exit(1);
                    }
                } else {
                    i += 1;
                }
            }
        }

        let name = profile.unwrap_or_else(|| {
            #[cfg(debug_assertions)]
            {
                let manifest_dir = env!("CARGO_MANIFEST_DIR");
                let worktree_name = std::path::Path::new(manifest_dir)
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .unwrap_or("dev");
                format!("dev-{}", worktree_name)
            }
            #[cfg(not(debug_assertions))]
            { "default".to_string() }
        });

        // Validate profile name: alphanumeric, hyphens, underscores, 1-64 chars
        if name.is_empty() || name.len() > 64
            || !name.chars().next().unwrap().is_alphanumeric()
            || !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        {
            eprintln!("Error: invalid profile name '{}'. Must start with an alphanumeric character, contain only alphanumeric characters, hyphens, or underscores, and be 1-64 characters long.", name);
            std::process::exit(1);
        }

        name
    });

    // Compute app_data_dir before Tauri starts, to read store settings for logging
    let pre_app_data_dir = timer.time("resolve_pre_app_data_dir", || {
        #[cfg(target_os = "macos")]
        {
            let home = std::env::var("HOME").expect("HOME not set");
            std::path::PathBuf::from(home)
                .join("Library/Application Support/com.alex.viboplr")
        }
        #[cfg(target_os = "windows")]
        {
            let appdata = std::env::var("APPDATA").expect("APPDATA not set");
            std::path::PathBuf::from(appdata).join("com.alex.viboplr")
        }
        #[cfg(target_os = "linux")]
        {
            let home = std::env::var("HOME").expect("HOME not set");
            std::path::PathBuf::from(home)
                .join(".local/share/com.alex.viboplr")
        }
    });

    // Read loggingEnabled from the profile's store file
    let logging_enabled = timer.time("check_logging_enabled", || {
        let store_path = pre_app_data_dir
            .join("profiles")
            .join(&profile_name)
            .join("app-state.json");
        if let Ok(contents) = std::fs::read_to_string(&store_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) {
                return json.get("loggingEnabled").and_then(|v| v.as_bool()).unwrap_or(false);
            }
        }
        false
    });

    timer.time("logging::init", || {
        let log_dir = if logging_enabled {
            Some(pre_app_data_dir.join("logs"))
        } else {
            None
        };
        logging::init(log_dir);
    });

    log::info!("Using profile: {}", profile_name);

    let builder = tauri::Builder::default();
    #[cfg(not(debug_assertions))]
    let builder = timer.time("plugin: single_instance", || {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            eprintln!("[single_instance] callback fired, argv={:?}", argv);
            // Focus existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // Check argv for subsonic:// and viboplr:// deep link URLs
            for arg in &argv {
                if arg.starts_with("subsonic://") || arg.starts_with("viboplr://") {
                    eprintln!("[single_instance] emitting deep-link-received: {}", arg);
                    let _ = app.emit("deep-link-received", arg.clone());
                    break;
                }
            }
        }))
    });
    let builder = timer.time("plugin: deep_link", || builder.plugin(tauri_plugin_deep_link::init()));
    let builder = timer.time("plugin: opener", || builder.plugin(tauri_plugin_opener::init()));
    let builder = timer.time("plugin: dialog", || builder.plugin(tauri_plugin_dialog::init()));
    let builder = timer.time("plugin: store", || builder.plugin(tauri_plugin_store::Builder::new().build()));
    let builder = timer.time("plugin: updater", || builder.plugin(tauri_plugin_updater::Builder::new().build()));
    let builder = timer.time("plugin: process", || builder.plugin(tauri_plugin_process::init()));
    let builder = timer.time("plugin: global_shortcut", || builder.plugin(tauri_plugin_global_shortcut::Builder::new().build()));

    builder
        .setup(|app| {
            // Register Rust-side deep link handler to ensure URLs reach the frontend
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    eprintln!("[on_open_url] deep link: {}", url);
                    let _ = handle.emit("deep-link-received", url.to_string());
                }
            });

            let timer = timing::timer();

            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");

            let app_dir = timer.time("resolve_app_dir", || {
                let dir = app_data_dir.join("profiles").join(&profile_name);
                std::fs::create_dir_all(&dir).expect("Failed to create profile directory");
                dir
            });

            // Migrate legacy data from root app_data_dir to profiles/default/
            if profile_name == "default" {
                timer.time("migrate_legacy_data", || {
                    let legacy_db = app_data_dir.join("viboplr.db");
                    let profile_db = app_dir.join("viboplr.db");
                    if legacy_db.exists() && !profile_db.exists() {
                        log::info!("Migrating legacy data to profiles/default/");
                        let items = [
                            "viboplr.db", "viboplr.db-shm", "viboplr.db-wal",
                            "app-state.json",
                            "artist_images", "album_images", "tag_images", "waveforms",
                        ];
                        for item in &items {
                            let src = app_data_dir.join(item);
                            let dst = app_dir.join(item);
                            if src.exists() {
                                if let Err(e) = std::fs::rename(&src, &dst) {
                                    log::warn!("Failed to migrate {}: {}", item, e);
                                } else {
                                    log::info!("Migrated {} to profiles/default/", item);
                                }
                            }
                        }
                    }
                });
            }

            let db = Arc::new(timer.time("Database::new", || Database::new(&app_dir).expect("Failed to init database")));

            timer.time("create_image_dirs", || {
                let _ = std::fs::create_dir_all(app_dir.join("artist_images"));
                let _ = std::fs::create_dir_all(app_dir.join("album_images"));
                let _ = std::fs::create_dir_all(app_dir.join("tag_images"));
            });

            // Migrate waveform cache to v2 (new RMS-based algorithm)
            timer.time("migrate_waveform_cache", || {
                let waveform_v2 = app_dir.join("waveforms").join("v2");
                if !waveform_v2.exists() {
                    let _ = std::fs::create_dir_all(&waveform_v2);
                    // Clean up old v1 cache files
                    if let Ok(entries) = std::fs::read_dir(app_dir.join("waveforms")) {
                        for entry in entries.flatten() {
                            if entry.path().extension().map_or(false, |e| e == "json") {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                }
            });

            let download_queue = timer.time("setup_download_queue", || Arc::new(DownloadQueue {
                queue: Mutex::new(Vec::new()),
                condvar: Condvar::new(),
            }));

            // Create embedded artwork provider for album images (Rust-native, no bridge needed)
            let embedded_provider = image_provider::embedded::EmbeddedArtworkProvider::new(db.clone());

            // Spawn the image download worker thread
            let worker_queue = download_queue.clone();
            let worker_app_dir = app_dir.clone();
            let worker_db = db.clone();
            let app_handle = app.handle().clone();
            let worker_registry = Arc::new(ImageResolveRegistry {
                pending: Mutex::new(std::collections::HashMap::new()),
            });
            let worker_registry_for_state = worker_registry.clone();
            timer.time("spawn_image_worker", || { std::thread::spawn(move || {
                loop {
                    let request = {
                        let mut queue = worker_queue.queue.lock().unwrap();
                        while queue.is_empty() {
                            queue = worker_queue.condvar.wait(queue).unwrap();
                        }
                        queue.pop().unwrap() // LIFO: pop from the end
                    };

                    match &request {
                        ImageDownloadRequest::Artist { id, name, force } => {
                            if !force && worker_db.is_image_failed("artist", *id).unwrap_or(false) {
                                log::info!("Skipping previously failed artist image: {} (id={})", name, id);
                                continue;
                            }
                            let slug = entity_image::entity_image_slug("artist", name, None);
                            let dest = worker_app_dir.join("artist_images").join(format!("{}.jpg", slug));
                            if !force && dest.exists() {
                                log::info!("Artist image already exists for {} (id={}), skipping", name, id);
                                continue;
                            }

                            log::info!("Requesting image resolve for artist: {} (id={})", name, id);

                            // Create a one-shot channel for this request
                            let request_id = format!("artist-{}-{}", id, std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
                            let (tx, rx) = std::sync::mpsc::channel();

                            // Register the sender
                            worker_registry.pending.lock().unwrap().insert(request_id.clone(), tx);

                            // Emit event to frontend
                            let _ = app_handle.emit("image-resolve-request", serde_json::json!({
                                "request_id": request_id,
                                "entity": "artist",
                                "id": id,
                                "name": name,
                            }));

                            // Wait for response with 30s timeout
                            match rx.recv_timeout(std::time::Duration::from_secs(30)) {
                                Ok(result) => {
                                    // Clean up registry
                                    worker_registry.pending.lock().unwrap().remove(&request_id);

                                    if let Some(error) = result.error {
                                        log::warn!("All providers failed for artist {}: {}", name, error);
                                        let _ = worker_db.record_image_failure("artist", *id);
                                        let _ = app_handle.emit("artist-image-error",
                                            serde_json::json!({ "artistId": id, "name": name, "error": error }));
                                    } else if let Some(data) = result.data {
                                        match base64_decode_and_save(&data, &dest) {
                                            Ok(()) => {
                                                let path = dest.to_string_lossy().to_string();
                                                log::info!("Saved artist image from base64 data: {} (id={})", name, id);
                                                let _ = app_handle.emit("artist-image-ready",
                                                    serde_json::json!({ "artistId": id, "path": &path, "name": name, "source": "plugin" }));
                                            }
                                            Err(e) => {
                                                log::warn!("Failed to decode/save base64 image for artist {}: {}", name, e);
                                                let _ = worker_db.record_image_failure("artist", *id);
                                                let _ = app_handle.emit("artist-image-error",
                                                    serde_json::json!({ "artistId": id, "name": name, "error": e }));
                                            }
                                        }
                                    } else if let Some(url) = result.url {
                                        match download_image_from_url(&url, result.headers.as_ref(), &dest) {
                                            Ok(()) => {
                                                let path = dest.to_string_lossy().to_string();
                                                log::info!("Downloaded artist image from {}: {} (id={})", url, name, id);
                                                let _ = app_handle.emit("artist-image-ready",
                                                    serde_json::json!({ "artistId": id, "path": &path, "name": name, "source": "plugin" }));
                                            }
                                            Err(e) => {
                                                log::warn!("Failed to download artist image from {}: {}", url, e);
                                                let _ = worker_db.record_image_failure("artist", *id);
                                                let _ = app_handle.emit("artist-image-error",
                                                    serde_json::json!({ "artistId": id, "name": name, "error": e }));
                                            }
                                        }
                                    } else {
                                        log::warn!("Empty resolve result for artist {}", name);
                                        let _ = worker_db.record_image_failure("artist", *id);
                                    }
                                }
                                Err(_) => {
                                    // Timeout or channel closed
                                    worker_registry.pending.lock().unwrap().remove(&request_id);
                                    log::warn!("Image resolve timeout for artist {} (id={})", name, id);
                                    let _ = worker_db.record_image_failure("artist", *id);
                                    let _ = app_handle.emit("artist-image-error",
                                        serde_json::json!({ "artistId": id, "name": name, "error": "Resolve timeout" }));
                                }
                            }
                        }
                        ImageDownloadRequest::Album { id, title, artist_name, force } => {
                            if !force && worker_db.is_image_failed("album", *id).unwrap_or(false) {
                                log::info!("Skipping previously failed album image: {} (id={})", title, id);
                                continue;
                            }
                            let slug = entity_image::entity_image_slug("album", title, artist_name.as_deref());
                            let dest = worker_app_dir.join("album_images").join(format!("{}.jpg", slug));
                            if !force && dest.exists() {
                                log::info!("Album image already exists for {} (id={}), skipping", title, id);
                                continue;
                            }

                            // Try embedded artwork first (Rust-native, no bridge needed)
                            if let Ok(source) = embedded_provider.fetch_album_image(title, artist_name.as_deref(), &dest) {
                                let path_str = {
                                    // embedded might write .png instead of .jpg, find the actual file
                                    let actual = dest.with_extension("png");
                                    if actual.exists() { actual.to_string_lossy().to_string() }
                                    else { dest.to_string_lossy().to_string() }
                                };
                                log::info!("Album image from embedded artwork: {} (id={}) from {}", title, id, source);
                                let _ = app_handle.emit("album-image-ready",
                                    serde_json::json!({ "albumId": id, "path": &path_str, "title": title, "source": &source }));
                                std::thread::sleep(std::time::Duration::from_millis(1100));
                                continue;
                            }

                            // Fall through to bridge for external providers
                            log::info!("Requesting image resolve for album: {} (id={})", title, id);

                            // Create a one-shot channel for this request
                            let request_id = format!("album-{}-{}", id, std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
                            let (tx, rx) = std::sync::mpsc::channel();

                            // Register the sender
                            worker_registry.pending.lock().unwrap().insert(request_id.clone(), tx);

                            // Emit event to frontend
                            let _ = app_handle.emit("image-resolve-request", serde_json::json!({
                                "request_id": request_id,
                                "entity": "album",
                                "id": id,
                                "title": title,
                                "artist_name": artist_name,
                            }));

                            // Wait for response with 30s timeout
                            match rx.recv_timeout(std::time::Duration::from_secs(30)) {
                                Ok(result) => {
                                    // Clean up registry
                                    worker_registry.pending.lock().unwrap().remove(&request_id);

                                    if let Some(error) = result.error {
                                        log::warn!("All providers failed for album {}: {}", title, error);
                                        let _ = worker_db.record_image_failure("album", *id);
                                        let _ = app_handle.emit("album-image-error",
                                            serde_json::json!({ "albumId": id, "title": title, "error": error }));
                                    } else if let Some(data) = result.data {
                                        match base64_decode_and_save(&data, &dest) {
                                            Ok(()) => {
                                                let path = dest.to_string_lossy().to_string();
                                                log::info!("Saved album image from base64 data: {} (id={})", title, id);
                                                let _ = app_handle.emit("album-image-ready",
                                                    serde_json::json!({ "albumId": id, "path": &path, "title": title, "source": "plugin" }));
                                            }
                                            Err(e) => {
                                                log::warn!("Failed to decode/save base64 image for album {}: {}", title, e);
                                                let _ = worker_db.record_image_failure("album", *id);
                                                let _ = app_handle.emit("album-image-error",
                                                    serde_json::json!({ "albumId": id, "title": title, "error": e }));
                                            }
                                        }
                                    } else if let Some(url) = result.url {
                                        match download_image_from_url(&url, result.headers.as_ref(), &dest) {
                                            Ok(()) => {
                                                let path = dest.to_string_lossy().to_string();
                                                log::info!("Downloaded album image from {}: {} (id={})", url, title, id);
                                                let _ = app_handle.emit("album-image-ready",
                                                    serde_json::json!({ "albumId": id, "path": &path, "title": title, "source": "plugin" }));
                                            }
                                            Err(e) => {
                                                log::warn!("Failed to download album image from {}: {}", url, e);
                                                let _ = worker_db.record_image_failure("album", *id);
                                                let _ = app_handle.emit("album-image-error",
                                                    serde_json::json!({ "albumId": id, "title": title, "error": e }));
                                            }
                                        }
                                    } else {
                                        log::warn!("Empty resolve result for album {}", title);
                                        let _ = worker_db.record_image_failure("album", *id);
                                    }
                                }
                                Err(_) => {
                                    // Timeout or channel closed
                                    worker_registry.pending.lock().unwrap().remove(&request_id);
                                    log::warn!("Image resolve timeout for album {} (id={})", title, id);
                                    let _ = worker_db.record_image_failure("album", *id);
                                    let _ = app_handle.emit("album-image-error",
                                        serde_json::json!({ "albumId": id, "title": title, "error": "Resolve timeout" }));
                                }
                            }
                        }
                        ImageDownloadRequest::Tag { id, name } => {
                            if worker_db.is_image_failed("tag", *id).unwrap_or(false) {
                                log::info!("Skipping previously failed tag image: {} (id={})", name, id);
                                continue;
                            }
                            let slug = entity_image::entity_image_slug("tag", name, None);
                            if entity_image::get_image_path(&worker_app_dir, "tag", &slug).is_some() {
                                log::info!("Tag image already exists for {} (id={}), skipping", name, id);
                                continue;
                            }
                            let top_artists = match worker_db.get_top_artists_for_tag(*id, 3) {
                                Ok(a) => a,
                                Err(e) => {
                                    log::warn!("Failed to get top artists for tag {}: {}", name, e);
                                    let _ = worker_db.record_image_failure("tag", *id);
                                    let _ = app_handle.emit(
                                        "tag-image-error",
                                        serde_json::json!({ "tagId": id, "name": name, "error": e.to_string() }),
                                    );
                                    continue;
                                }
                            };
                            let artist_image_paths: Vec<std::path::PathBuf> = top_artists.iter()
                                .filter_map(|(_, artist_name)| {
                                    let artist_slug = entity_image::entity_image_slug("artist", artist_name, None);
                                    entity_image::get_image_path(&worker_app_dir, "artist", &artist_slug)
                                })
                                .collect();
                            if artist_image_paths.is_empty() {
                                log::info!("No artist images available for tag {} (id={}), skipping composite", name, id);
                                let _ = worker_db.record_image_failure("tag", *id);
                                let _ = app_handle.emit(
                                    "tag-image-error",
                                    serde_json::json!({ "tagId": id, "name": name, "error": "No artist images available" }),
                                );
                                continue;
                            }
                            let dest = worker_app_dir.join("tag_images").join(format!("{}.png", slug));
                            log::info!("Generating composite tag image for: {} (id={}) with {} artist images", name, id, artist_image_paths.len());
                            match composite_image::generate_tag_composite(&artist_image_paths, &dest, 400) {
                                Ok(()) => {
                                    let path = dest.to_string_lossy().to_string();
                                    log::info!("Generated composite tag image for: {} (id={})", name, id);
                                    let _ = app_handle.emit(
                                        "tag-image-ready",
                                        serde_json::json!({ "tagId": id, "path": &path, "name": name, "source": "composite" }),
                                    );
                                }
                                Err(e) => {
                                    log::warn!("Failed to generate composite tag image for {}: {}", name, e);
                                    let _ = worker_db.record_image_failure("tag", *id);
                                    let _ = app_handle.emit(
                                        "tag-image-error",
                                        serde_json::json!({ "tagId": id, "name": name, "error": e.to_string() }),
                                    );
                                }
                            }
                        }
                    }

                    std::thread::sleep(std::time::Duration::from_millis(1100));
                }
            }); });

            // Spawn the track download worker thread
            let dl_manager = Arc::new(DownloadManager::new());
            let dl_worker_manager = dl_manager.clone();
            let dl_worker_db = db.clone();
            let dl_app_handle = app.handle().clone();
            timer.time("spawn_download_worker", || { std::thread::spawn(move || {
                loop {
                    let request = dl_worker_manager.wait_for_next();
                    let status = crate::downloader::DownloadStatus {
                        id: request.id,
                        track_title: request.track_title.clone(),
                        artist_name: request.artist_name.clone(),
                        status: "downloading".to_string(),
                        progress_pct: 0,
                        error: None,
                    };
                    dl_worker_manager.set_active(Some(status.clone()));
                    let _ = dl_app_handle.emit("download-progress", &status);

                    match crate::downloader::process_download(&request, &dl_worker_db, &dl_app_handle, &dl_worker_manager) {
                        Ok(dest_path) => {
                            let complete = crate::downloader::DownloadStatus {
                                id: request.id,
                                track_title: request.track_title.clone(),
                                artist_name: request.artist_name.clone(),
                                status: "complete".to_string(),
                                progress_pct: 100,
                                error: None,
                            };
                            dl_worker_manager.set_active(None);
                            dl_worker_manager.push_completed(complete.clone());
                            let _ = dl_app_handle.emit("download-complete", serde_json::json!({
                                "id": request.id,
                                "trackTitle": request.track_title,
                                "destPath": dest_path.to_string_lossy(),
                            }));

                            // Emit scan-complete so frontend refreshes library
                            let _ = dl_app_handle.emit("scan-complete", serde_json::json!({
                                "folder": request.dest_collection_path,
                            }));
                        }
                        Err(e) => {
                            log::error!("Download failed for {}: {}", request.track_title, e);
                            let error_status = crate::downloader::DownloadStatus {
                                id: request.id,
                                track_title: request.track_title.clone(),
                                artist_name: request.artist_name.clone(),
                                status: "error".to_string(),
                                progress_pct: 0,
                                error: Some(e.clone()),
                            };
                            dl_worker_manager.set_active(None);
                            dl_worker_manager.push_completed(error_status);
                            let _ = dl_app_handle.emit("download-error", serde_json::json!({
                                "id": request.id,
                                "trackTitle": request.track_title,
                                "error": e,
                            }));
                        }
                    }
                }
            }); });

            // Restore window size/position from store before showing, to avoid IPC round-trips
            timer.time("restore_window", || {
                let window = app.get_webview_window("main").unwrap();

                // Make window background transparent for rounded mini player corners
                #[cfg(target_os = "macos")]
                {
                    #[allow(deprecated)]
                    {
                        use cocoa::appkit::{NSColor, NSWindow};
                        use cocoa::base::{id, nil};
                        let ns_window = window.ns_window().unwrap() as id;
                        unsafe {
                            ns_window.setBackgroundColor_(NSColor::clearColor(nil));
                        }
                    }
                }

                // Read persisted window state from the store JSON file
                let store_path = app_dir.join("app-state.json");
                if let Ok(data) = std::fs::read_to_string(&store_path) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) {
                        // Collect monitor bounds for off-screen validation
                        let monitors: Vec<(f64, f64, f64, f64)> = window.available_monitors()
                            .unwrap_or_default()
                            .iter()
                            .filter_map(|m| {
                                let pos = m.position();
                                let size = m.size();
                                let scale = m.scale_factor();
                                Some((
                                    pos.x as f64 / scale,
                                    pos.y as f64 / scale,
                                    pos.x as f64 / scale + size.width as f64 / scale,
                                    pos.y as f64 / scale + size.height as f64 / scale,
                                ))
                            })
                            .collect();
                        let is_visible = |x: f64, y: f64| -> bool {
                            if monitors.is_empty() { return true; }
                            monitors.iter().any(|(mx, my, mx2, my2)| {
                                x >= *mx && x < *mx2 && y >= *my && y < *my2
                            })
                        };
                        // Find the monitor containing a point, or the first monitor as fallback
                        let monitor_at = |x: f64, y: f64| -> Option<(f64, f64, f64, f64)> {
                            monitors.iter()
                                .find(|(mx, my, mx2, my2)| x >= *mx && x < *mx2 && y >= *my && y < *my2)
                                .or(monitors.first())
                                .copied()
                        };

                        let is_mini = json.get("miniMode").and_then(|v| v.as_bool()).unwrap_or(false);
                        if is_mini {
                            let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize { width: 280.0, height: 40.0 })));
                            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: 500.0, height: 52.0 }));
                            if let (Some(x), Some(y)) = (
                                json.get("miniWindowX").and_then(|v| v.as_f64()),
                                json.get("miniWindowY").and_then(|v| v.as_f64()),
                            ) {
                                if is_visible(x, y) {
                                    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                                }
                            }
                            let _ = window.set_always_on_top(true);
                            let _ = window.set_resizable(false);
                            let _ = window.set_decorations(false);
                        } else {
                            let saved_w = json.get("windowWidth").and_then(|v| v.as_f64());
                            let saved_h = json.get("windowHeight").and_then(|v| v.as_f64());
                            let saved_x = json.get("windowX").and_then(|v| v.as_f64());
                            let saved_y = json.get("windowY").and_then(|v| v.as_f64());

                            // Determine target monitor from saved position, or use first monitor
                            let target = saved_x.zip(saved_y)
                                .and_then(|(x, y)| monitor_at(x, y))
                                .or(monitors.first().copied());

                            if let (Some(mut w), Some(mut h)) = (saved_w, saved_h) {
                                if w > 0.0 && h > 0.0 {
                                    // Clamp size to target monitor bounds
                                    if let Some((mx, my, mx2, my2)) = target {
                                        let mw = mx2 - mx;
                                        let mh = my2 - my;
                                        if w > mw { w = mw; }
                                        if h > mh { h = mh; }
                                    }
                                    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: w, height: h }));
                                }
                            }

                            if let (Some(mut x), Some(mut y)) = (saved_x, saved_y) {
                                if is_visible(x, y) {
                                    // Ensure the window doesn't extend beyond the monitor
                                    if let Some((mx, _my, mx2, my2)) = target {
                                        let w = saved_w.unwrap_or(800.0).min(mx2 - mx);
                                        let h = saved_h.unwrap_or(600.0).min(my2 - _my);
                                        if x + w > mx2 { x = (mx2 - w).max(mx); }
                                        if y + h > my2 { y = (my2 - h).max(_my); }
                                    }
                                    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                                }
                            }
                        }
                    }
                }
            });

            // Set window title for named profiles (like Chrome)
            if profile_name != "default" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&format!("Viboplr [{}]", profile_name));
                }
            }

            let native_plugins_dir = timer.time("resolve_native_plugins_dir", || {
                // In dev mode, use the plugins dir next to Cargo.toml (src-tauri/plugins/)
                // In production, use the bundled resources directory
                let candidates: Vec<std::path::PathBuf> = {
                    let mut c = Vec::new();
                    #[cfg(debug_assertions)]
                    c.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("plugins"));
                    if let Ok(res) = app.path().resource_dir() {
                        c.push(res.join("plugins"));
                    }
                    c
                };
                for dir in candidates {
                    if dir.is_dir() {
                        log::info!("Native plugins dir: {}", dir.display());
                        return Some(dir);
                    }
                }
                log::info!("No native plugins dir found");
                None
            });

            timer.time("manage_app_state", || {
                let tidal_client = Arc::new(tidal::TidalClient::new(None));
                tidal::set_global_client(tidal_client.clone());

                app.manage(AppState {
                    db,
                    app_dir,
                    app_data_dir,
                    profile_name,
                    download_queue,
                    track_download_manager: dl_manager,
                    tidal_client,
                    native_plugins_dir,
                    image_resolve_registry: worker_registry_for_state,
                });
            });

            // Dump startup timings to log file
            for entry in timing::timer().get_entries() {
                log::info!(
                    "Startup: {} \u{2014} {:.1}ms (offset {:.1}ms)",
                    entry.label,
                    entry.duration_ms,
                    entry.offset_ms
                );
            }

            Ok(())
        })
        .invoke_handler(timer.time("invoke_handler", || get_invoke_handler()))
        .build(timer.time("generate_context", || tauri::generate_context!()))
        .expect("error while building tauri application")
        .run(|app, event| {
            match &event {
                tauri::RunEvent::Exit => {}
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    eprintln!("[RunEvent::Opened] urls: {:?}", urls);
                    for url in urls {
                        eprintln!("[RunEvent::Opened] emitting deep-link-received: {}", url);
                        let _ = app.emit("deep-link-received", url.to_string());
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    eprintln!("[RunEvent::Reopen] has_visible_windows={}", has_visible_windows);
                    if !has_visible_windows {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                _ => {}
            }
        });
}
