mod commands;
mod db;
mod entity_image;
mod image_provider;
mod models;
mod scanner;
#[cfg(debug_assertions)]
mod seed;
mod subsonic;
mod sync;
mod timing;
mod tidal;
mod downloader;
mod lastfm;

use commands::{AppState, DownloadQueue, ImageDownloadRequest};
use db::Database;
use downloader::DownloadManager;
use image_provider::{
    AlbumImageFallbackChain, AlbumImageProvider, ArtistImageFallbackChain, ArtistImageProvider,
};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{Emitter, Manager};

#[cfg(debug_assertions)]
fn get_invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::add_collection,
        commands::remove_collection,
        commands::update_collection,
        commands::get_collections,
        commands::resync_collection,
        commands::get_artists,
        commands::get_albums,
        commands::get_tracks,
        commands::get_track_count,
        commands::get_track_by_id,
        commands::get_tracks_by_ids,
        commands::get_tracks_by_artist,
        commands::get_track_path,
        commands::toggle_liked,
        commands::get_liked_tracks,
        commands::rebuild_search_index,
        commands::show_in_folder,
        commands::delete_tracks,
        commands::clear_database,
        commands::get_tags,
        commands::get_tags_for_track,
        commands::get_tracks_by_tag,
        commands::get_entity_image,
        commands::set_entity_image,
        commands::paste_entity_image,
        commands::remove_entity_image,
        commands::fetch_artist_image,
        commands::fetch_album_image,
        commands::clear_image_failures,
        commands::record_play,
        commands::get_history_recent,
        commands::get_history_most_played,
        commands::get_history_most_played_since,
        commands::get_history_most_played_artists,
        commands::get_auto_continue_track,
        commands::save_playlist,
        commands::load_playlist,
        commands::get_startup_timings,
        commands::test_collection_connection,
        commands::subsonic_test_connection,
        commands::tidal_test_connection,
        commands::tidal_search,
        commands::tidal_save_track,
        commands::tidal_get_album,
        commands::tidal_get_artist,
        commands::tidal_get_stream_url,
        commands::search_youtube,
        commands::set_track_youtube_url,
        commands::clear_track_youtube_url,
        commands::get_track_audio_properties,
        commands::lastfm_get_auth_url,
        commands::lastfm_authenticate,
        commands::lastfm_set_session,
        commands::lastfm_disconnect,
        commands::lastfm_get_status,
        commands::lastfm_now_playing,
        commands::lastfm_scrobble,
        commands::download_track,
        commands::download_album,
        commands::get_download_status,
        commands::cancel_download,
    ]
}

#[cfg(not(debug_assertions))]
fn get_invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::add_collection,
        commands::remove_collection,
        commands::update_collection,
        commands::get_collections,
        commands::resync_collection,
        commands::get_artists,
        commands::get_albums,
        commands::get_tracks,
        commands::get_track_count,
        commands::get_track_by_id,
        commands::get_tracks_by_ids,
        commands::get_tracks_by_artist,
        commands::get_track_path,
        commands::toggle_liked,
        commands::get_liked_tracks,
        commands::rebuild_search_index,
        commands::show_in_folder,
        commands::delete_tracks,
        commands::get_tags,
        commands::get_tags_for_track,
        commands::get_tracks_by_tag,
        commands::get_entity_image,
        commands::set_entity_image,
        commands::paste_entity_image,
        commands::remove_entity_image,
        commands::fetch_artist_image,
        commands::fetch_album_image,
        commands::clear_image_failures,
        commands::record_play,
        commands::get_history_recent,
        commands::get_history_most_played,
        commands::get_history_most_played_since,
        commands::get_history_most_played_artists,
        commands::get_auto_continue_track,
        commands::save_playlist,
        commands::load_playlist,
        commands::get_startup_timings,
        commands::test_collection_connection,
        commands::subsonic_test_connection,
        commands::tidal_test_connection,
        commands::tidal_search,
        commands::tidal_save_track,
        commands::tidal_get_album,
        commands::tidal_get_artist,
        commands::tidal_get_stream_url,
        commands::search_youtube,
        commands::set_track_youtube_url,
        commands::clear_track_youtube_url,
        commands::get_track_audio_properties,
        commands::lastfm_get_auth_url,
        commands::lastfm_authenticate,
        commands::lastfm_set_session,
        commands::lastfm_disconnect,
        commands::lastfm_get_status,
        commands::lastfm_now_playing,
        commands::lastfm_scrobble,
        commands::download_track,
        commands::download_album,
        commands::get_download_status,
        commands::cancel_download,
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let timer = timing::init_timer();

    timer.time("env_logger::init", || env_logger::init());

    // Parse optional data directory override from env var or CLI argument
    // Usage: VIBOPLR_DATA_DIR=/path or --data-dir /path or --data-dir=/path
    let custom_data_dir: Option<std::path::PathBuf> = timer.time("parse_data_dir", || {
        let mut data_dir: Option<std::path::PathBuf> =
            std::env::var("VIBOPLR_DATA_DIR").ok().map(std::path::PathBuf::from);

        if data_dir.is_none() {
            let args: Vec<String> = std::env::args().collect();
            let mut i = 1;
            while i < args.len() {
                if args[i].starts_with("--data-dir=") {
                    data_dir = Some(std::path::PathBuf::from(
                        args[i].trim_start_matches("--data-dir="),
                    ));
                    i += 1;
                } else if args[i] == "--data-dir" {
                    if i + 1 < args.len() {
                        data_dir = Some(std::path::PathBuf::from(&args[i + 1]));
                        i += 2;
                    } else {
                        eprintln!("Error: --data-dir requires a path argument");
                        std::process::exit(1);
                    }
                } else {
                    i += 1;
                }
            }
        }

        if let Some(ref dir) = data_dir {
            log::info!("Using custom data directory: {}", dir.display());
        }
        data_dir
    });

    let builder = tauri::Builder::default();
    let builder = timer.time("plugin: single_instance", || {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Focus existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // Check argv for subsonic:// and viboplr:// deep link URLs (Windows/Linux)
            for arg in &argv {
                if arg.starts_with("subsonic://") || arg.starts_with("viboplr://") {
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
            let timer = timing::timer();

            let app_dir = timer.time("resolve_app_dir", || match custom_data_dir {
                Some(dir) => dir,
                None => app
                    .path()
                    .app_data_dir()
                    .expect("Failed to get app data dir"),
            });
            let db = Arc::new(timer.time("Database::new", || Database::new(&app_dir).expect("Failed to init database")));

            timer.time("create_image_dirs", || {
                let _ = std::fs::create_dir_all(app_dir.join("artist_images"));
                let _ = std::fs::create_dir_all(app_dir.join("album_images"));
                let _ = std::fs::create_dir_all(app_dir.join("tag_images"));
            });

            let download_queue = timer.time("setup_download_queue", || Arc::new(DownloadQueue {
                queue: Mutex::new(Vec::new()),
                condvar: Condvar::new(),
            }));

            // Build image provider fallback chains
            let (artist_provider, album_provider) = timer.time("build_image_providers", || {
                let artist_provider: Arc<dyn ArtistImageProvider> = Arc::new(
                    ArtistImageFallbackChain::new(vec![
                        Box::new(image_provider::deezer::DeezerArtistProvider),
                        Box::new(image_provider::itunes::ITunesArtistProvider),
                        Box::new(image_provider::audiodb::AudioDbArtistProvider),
                        Box::new(image_provider::musicbrainz::MusicBrainzArtistProvider),
                    ]),
                );
                let album_provider: Arc<dyn AlbumImageProvider> = Arc::new(
                    AlbumImageFallbackChain::new(vec![
                        Box::new(image_provider::embedded::EmbeddedArtworkProvider::new(db.clone())),
                        Box::new(image_provider::itunes::ITunesAlbumProvider),
                        Box::new(image_provider::deezer::DeezerAlbumProvider),
                        Box::new(image_provider::musicbrainz::MusicBrainzAlbumProvider),
                    ]),
                );
                (artist_provider, album_provider)
            });

            // Spawn the image download worker thread
            let worker_queue = download_queue.clone();
            let worker_app_dir = app_dir.clone();
            let worker_db = db.clone();
            let app_handle = app.handle().clone();
            let worker_artist_provider = artist_provider.clone();
            let worker_album_provider = album_provider.clone();
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
                        ImageDownloadRequest::Artist { id, name } => {
                            if worker_db.is_image_failed("artist", *id).unwrap_or(false) {
                                log::info!("Skipping previously failed artist image: {} (id={})", name, id);
                                continue;
                            }
                            let dest = worker_app_dir.join("artist_images").join(format!("{}.jpg", id));
                            if dest.exists() {
                                log::info!("Artist image already exists for {} (id={}), skipping", name, id);
                                continue;
                            }
                            log::info!("Downloading image for artist: {} (id={})", name, id);
                            match worker_artist_provider.fetch_artist_image(name, &dest) {
                                Ok(()) => {
                                    let path = dest.to_string_lossy().to_string();
                                    log::info!("Downloaded image for artist: {} (id={})", name, id);
                                    let _ = app_handle.emit(
                                        "artist-image-ready",
                                        serde_json::json!({ "artistId": id, "path": &path }),
                                    );
                                }
                                Err(e) => {
                                    log::warn!("Failed to download image for artist {}: {}", name, e);
                                    let _ = worker_db.record_image_failure("artist", *id);
                                    let _ = app_handle.emit(
                                        "artist-image-error",
                                        serde_json::json!({ "artistId": id, "error": e.to_string() }),
                                    );
                                }
                            }
                        }
                        ImageDownloadRequest::Album { id, title, artist_name } => {
                            if worker_db.is_image_failed("album", *id).unwrap_or(false) {
                                log::info!("Skipping previously failed album image: {} (id={})", title, id);
                                continue;
                            }
                            let dest = worker_app_dir.join("album_images").join(format!("{}.jpg", id));
                            if dest.exists() {
                                log::info!("Album image already exists for {} (id={}), skipping", title, id);
                                continue;
                            }
                            log::info!("Downloading image for album: {} (id={})", title, id);
                            match worker_album_provider.fetch_album_image(title, artist_name.as_deref(), &dest) {
                                Ok(()) => {
                                    let path = dest.to_string_lossy().to_string();
                                    log::info!("Downloaded image for album: {} (id={})", title, id);
                                    let _ = app_handle.emit(
                                        "album-image-ready",
                                        serde_json::json!({ "albumId": id, "path": &path }),
                                    );
                                }
                                Err(e) => {
                                    log::warn!("Failed to download image for album {}: {}", title, e);
                                    let _ = worker_db.record_image_failure("album", *id);
                                    let _ = app_handle.emit(
                                        "album-image-error",
                                        serde_json::json!({ "albumId": id, "error": e.to_string() }),
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

                        let is_mini = json.get("miniMode").and_then(|v| v.as_bool()).unwrap_or(false);
                        if is_mini {
                            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: 500.0, height: 40.0 }));
                            if let (Some(x), Some(y)) = (
                                json.get("miniWindowX").and_then(|v| v.as_f64()),
                                json.get("miniWindowY").and_then(|v| v.as_f64()),
                            ) {
                                if is_visible(x, y) {
                                    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                                }
                            }
                            let _ = window.set_always_on_top(true);
                            let _ = window.set_decorations(false);
                        } else {
                            if let (Some(w), Some(h)) = (
                                json.get("windowWidth").and_then(|v| v.as_f64()),
                                json.get("windowHeight").and_then(|v| v.as_f64()),
                            ) {
                                if w > 0.0 && h > 0.0 {
                                    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: w, height: h }));
                                }
                            }
                            if let (Some(x), Some(y)) = (
                                json.get("windowX").and_then(|v| v.as_f64()),
                                json.get("windowY").and_then(|v| v.as_f64()),
                            ) {
                                if is_visible(x, y) {
                                    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                                }
                            }
                        }
                    }
                }
            });

            timer.time("manage_app_state", || {
                app.manage(AppState {
                    db,
                    app_dir,
                    download_queue,
                    track_download_manager: dl_manager,
                    lastfm: crate::lastfm::LastfmClient::new(crate::commands::LASTFM_API_KEY, crate::commands::LASTFM_API_SECRET),
                    lastfm_session: Mutex::new(None),
                });
            });

            Ok(())
        })
        .invoke_handler(timer.time("invoke_handler", || get_invoke_handler()))
        .run(timer.time("generate_context", || tauri::generate_context!()))
        .expect("error while running tauri application");
}
