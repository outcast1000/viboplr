use notify::{recommended_watcher, Event, EventKind, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::thread;

use crate::db::Database;
use crate::scanner;

pub fn start_watcher(db: Arc<Database>, folders: Vec<(String, Option<i64>)>) -> notify::Result<()> {
    thread::spawn(move || {
        let (tx, rx) = channel::<notify::Result<Event>>();
        let mut watcher = match recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                log::error!("Failed to create file watcher: {}", e);
                return;
            }
        };

        for (folder, _) in &folders {
            if let Err(e) = watcher.watch(&PathBuf::from(folder), RecursiveMode::Recursive) {
                log::error!("Failed to watch folder {}: {}", folder, e);
            }
        }

        log::info!("File watcher started for {} folders", folders.len());

        for result in rx {
            match result {
                Ok(event) => handle_event(&db, &event, &folders),
                Err(e) => log::error!("Watch error: {:?}", e),
            }
        }
    });

    Ok(())
}

fn handle_event(db: &Arc<Database>, event: &Event, folders: &[(String, Option<i64>)]) {
    let media_extensions = [
        "mp3", "flac", "aac", "m4a", "wav", "opus", "alac", "wma",
        "mp4", "m4v", "mov", "webm",
    ];

    for path in &event.paths {
        let is_media = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| media_extensions.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);

        if !is_media {
            continue;
        }

        // Find matching collection_id for this path
        let path_str = path.to_string_lossy();
        let collection_id = folders.iter()
            .find(|(folder, _)| path_str.starts_with(folder.as_str()))
            .and_then(|(_, id)| *id);

        match event.kind {
            EventKind::Create(_) | EventKind::Modify(_) => {
                log::info!("File changed: {:?}", path);
                scanner::process_media_file(db, path, collection_id);
            }
            EventKind::Remove(_) => {
                log::info!("File removed: {:?}", path);
                scanner::remove_media_file(db, path);
            }
            _ => {}
        }
    }
}
