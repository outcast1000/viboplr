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
mod watcher;

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
    ]
}

#[cfg(not(debug_assertions))]
fn get_invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::add_collection,
        commands::remove_collection,
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
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");
            let db = Arc::new(Database::new(&app_dir).expect("Failed to init database"));

            // Ensure image directories exist
            let _ = std::fs::create_dir_all(app_dir.join("artist_images"));
            let _ = std::fs::create_dir_all(app_dir.join("album_images"));

            // Start watchers for existing local collections
            if let Ok(collections) = db.get_collections() {
                let paths: Vec<(String, Option<i64>)> = collections
                    .iter()
                    .filter(|c| c.kind == "local")
                    .filter_map(|c| c.path.clone().map(|p| (p, Some(c.id))))
                    .collect();
                if !paths.is_empty() {
                    let db_clone = db.clone();
                    let _ = watcher::start_watcher(db_clone, paths);
                }
            }

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
            Ok(())
        })
        .invoke_handler(get_invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
