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
        commands::get_tracks_by_artist,
        commands::get_track_path,
        commands::search,
        commands::rebuild_search_index,
        commands::show_in_folder,
        commands::seed_database,
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
        commands::get_tracks_by_artist,
        commands::get_track_path,
        commands::search,
        commands::rebuild_search_index,
        commands::show_in_folder,
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

            // Start watchers for existing folders
            if let Ok(folders) = db.get_folders() {
                let paths: Vec<String> = folders.into_iter().map(|f| f.path).collect();
                if !paths.is_empty() {
                    let db_clone = db.clone();
                    let _ = watcher::start_watcher(db_clone, paths);
                }
            }

            app.manage(AppState { db });
            Ok(())
        })
        .invoke_handler(get_invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
