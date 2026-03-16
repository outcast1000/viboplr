mod album_image;
mod artist_image;
mod commands;
mod db;
mod image_provider;
mod models;
mod scanner;
#[cfg(debug_assertions)]
mod seed;
mod subsonic;
mod sync;


use commands::{AppState, DownloadQueue, ImageDownloadRequest};
use db::Database;
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
        commands::search,
        commands::toggle_track_liked,
        commands::toggle_artist_liked,
        commands::toggle_album_liked,
        commands::get_liked_tracks,
        commands::rebuild_search_index,
        commands::show_in_folder,
        commands::clear_database,
        commands::get_tags,
        commands::get_tags_for_track,
        commands::get_tracks_by_tag,
        commands::get_artist_image,
        commands::fetch_artist_image,
        commands::set_artist_image,
        commands::paste_artist_image,
        commands::remove_artist_image,
        commands::get_album_image,
        commands::fetch_album_image,
        commands::set_album_image,
        commands::paste_album_image,
        commands::remove_album_image,
        commands::clear_image_failures,
        commands::record_play,
        commands::get_recent_plays,
        commands::get_most_played,
        commands::get_most_played_since,
        commands::get_auto_continue_track,
        commands::save_playlist,
        commands::load_playlist,
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
        commands::search,
        commands::toggle_track_liked,
        commands::toggle_artist_liked,
        commands::toggle_album_liked,
        commands::get_liked_tracks,
        commands::rebuild_search_index,
        commands::show_in_folder,
        commands::get_tags,
        commands::get_tags_for_track,
        commands::get_tracks_by_tag,
        commands::get_artist_image,
        commands::fetch_artist_image,
        commands::set_artist_image,
        commands::paste_artist_image,
        commands::remove_artist_image,
        commands::get_album_image,
        commands::fetch_album_image,
        commands::set_album_image,
        commands::paste_album_image,
        commands::remove_album_image,
        commands::clear_image_failures,
        commands::record_play,
        commands::get_recent_plays,
        commands::get_most_played,
        commands::get_most_played_since,
        commands::get_auto_continue_track,
        commands::save_playlist,
        commands::load_playlist,
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    // Parse optional data directory override from env var or CLI argument
    // Usage: FASTPLAYER_DATA_DIR=/path or --data-dir /path or --data-dir=/path
    let custom_data_dir: Option<std::path::PathBuf> = {
        let mut data_dir: Option<std::path::PathBuf> =
            std::env::var("FASTPLAYER_DATA_DIR").ok().map(std::path::PathBuf::from);

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
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let app_dir = match custom_data_dir {
                Some(dir) => dir,
                None => app
                    .path()
                    .app_data_dir()
                    .expect("Failed to get app data dir"),
            };
            let db = Arc::new(Database::new(&app_dir).expect("Failed to init database"));

            // Ensure image directories exist
            let _ = std::fs::create_dir_all(app_dir.join("artist_images"));
            let _ = std::fs::create_dir_all(app_dir.join("album_images"));

            let download_queue = Arc::new(DownloadQueue {
                queue: Mutex::new(Vec::new()),
                condvar: Condvar::new(),
            });

            // Build image provider fallback chains
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

            // Spawn the image download worker thread
            let worker_queue = download_queue.clone();
            let worker_app_dir = app_dir.clone();
            let worker_db = db.clone();
            let app_handle = app.handle().clone();
            let worker_artist_provider = artist_provider.clone();
            let worker_album_provider = album_provider.clone();
            std::thread::spawn(move || {
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
            });

            app.manage(AppState { db, app_dir, download_queue });

            // Make window background transparent for rounded mini player corners
            #[cfg(target_os = "macos")]
            {
                #[allow(deprecated)]
                {
                    use cocoa::appkit::{NSColor, NSWindow};
                    use cocoa::base::{id, nil};

                    let window = app.get_webview_window("main").unwrap();
                    let ns_window = window.ns_window().unwrap() as id;
                    unsafe {
                        ns_window.setBackgroundColor_(NSColor::clearColor(nil));
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(get_invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
