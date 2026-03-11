mod album_image;
mod artist_image;
mod commands;
mod db;
mod models;
mod scanner;
#[cfg(debug_assertions)]
mod seed;
mod watcher;

use commands::AppState;
use db::Database;
use std::sync::Arc;
use tauri::Manager;

#[cfg(debug_assertions)]
fn get_invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::add_folder,
        commands::remove_folder,
        commands::get_folders,
        commands::get_artists,
        commands::get_albums,
        commands::get_tracks,
        commands::get_track_count,
        commands::get_tracks_by_artist,
        commands::get_track_path,
        commands::search,
        commands::rebuild_search_index,
        commands::show_in_folder,
        commands::seed_database,
        commands::clear_database,
        commands::get_tags,
        commands::get_tags_for_track,
        commands::get_tracks_by_tag,
        commands::get_artist_image,
        commands::fetch_artist_image,
        commands::set_artist_image,
        commands::remove_artist_image,
        commands::get_album_image,
        commands::fetch_album_image,
        commands::set_album_image,
        commands::remove_album_image,
    ]
}

#[cfg(not(debug_assertions))]
fn get_invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::add_folder,
        commands::remove_folder,
        commands::get_folders,
        commands::get_artists,
        commands::get_albums,
        commands::get_tracks,
        commands::get_track_count,
        commands::get_tracks_by_artist,
        commands::get_track_path,
        commands::search,
        commands::rebuild_search_index,
        commands::show_in_folder,
        commands::get_tags,
        commands::get_tags_for_track,
        commands::get_tracks_by_tag,
        commands::get_artist_image,
        commands::fetch_artist_image,
        commands::set_artist_image,
        commands::remove_artist_image,
        commands::get_album_image,
        commands::fetch_album_image,
        commands::set_album_image,
        commands::remove_album_image,
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");
            let db = Arc::new(Database::new(&app_dir).expect("Failed to init database"));

            // Ensure image directories exist
            let _ = std::fs::create_dir_all(app_dir.join("artist_images"));
            let _ = std::fs::create_dir_all(app_dir.join("album_images"));

            // Start watchers for existing folders
            if let Ok(folders) = db.get_folders() {
                let paths: Vec<String> = folders.into_iter().map(|f| f.path).collect();
                if !paths.is_empty() {
                    let db_clone = db.clone();
                    let _ = watcher::start_watcher(db_clone, paths);
                }
            }

            app.manage(AppState { db, app_dir });
            Ok(())
        })
        .invoke_handler(get_invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
