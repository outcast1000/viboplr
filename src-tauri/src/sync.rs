use std::collections::HashSet;
use std::sync::Arc;

use crate::db::Database;
use crate::subsonic::SubsonicClient;

pub fn sync_collection(
    db: &Arc<Database>,
    client: &SubsonicClient,
    collection_id: i64,
    progress_callback: impl Fn(u64, u64) + Send,
) -> Result<(), String> {
    let start = std::time::Instant::now();

    // Build set of all existing paths for this collection (including already-deleted)
    let existing_paths: HashSet<String> = db
        .get_track_paths_for_collection(collection_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();

    let mut seen_paths: HashSet<String> = HashSet::new();

    // Paginate album list
    let page_size = 500u32;
    let mut offset = 0u32;
    let mut all_album_ids = Vec::new();

    loop {
        let albums = client
            .get_album_list(page_size, offset)
            .map_err(|e| e.to_string())?;
        if albums.is_empty() {
            break;
        }
        for album in &albums {
            all_album_ids.push(album.id.clone());
        }
        if (albums.len() as u32) < page_size {
            break;
        }
        offset += page_size;
    }

    let total = all_album_ids.len() as u64;
    let mut synced: u64 = 0;

    for album_id in &all_album_ids {
        let (album, tracks) = match client.get_album(album_id) {
            Ok(result) => result,
            Err(e) => {
                log::warn!("Failed to fetch album {}: {}", album_id, e);
                synced += 1;
                if synced % 5 == 0 || synced == total {
                    progress_callback(synced, total);
                }
                continue;
            }
        };

        let artist_name = album.artist.as_deref();
        let artist_id = artist_name
            .and_then(|name| db.get_or_create_artist(name).ok());

        let db_album_id = db
            .get_or_create_album(&album.name, artist_id, album.year)
            .ok();

        // Store album genre as a tag
        let album_genre_tag_id = album
            .genre
            .as_deref()
            .and_then(|g| db.get_or_create_tag(g).ok());

        for track in &tracks {
            let track_artist_id = track
                .artist
                .as_deref()
                .and_then(|name| db.get_or_create_artist(name).ok())
                .or(artist_id);

            let path = format!("subsonic://{}/{}", collection_id, track.id);
            seen_paths.insert(path.clone());

            if let Ok(track_db_id) = db.upsert_track(
                &path,
                &track.title,
                track_artist_id,
                db_album_id,
                track.track_number,
                track.duration_secs,
                track.suffix.as_deref(),
                track.size,
                None,
                Some(collection_id),
                Some(&track.id),
                album.year,
            ) {
                // Tag from track genre or album genre
                let genre = track.genre.as_deref().or(album.genre.as_deref());
                if let Some(genre_name) = genre {
                    if let Ok(tag_id) = db.get_or_create_tag(genre_name) {
                        let _ = db.add_track_tag(track_db_id, tag_id);
                    }
                } else if let Some(tag_id) = album_genre_tag_id {
                    let _ = db.add_track_tag(track_db_id, tag_id);
                }
            }
        }

        synced += 1;
        if synced % 5 == 0 || synced == total {
            progress_callback(synced, total);
        }
    }

    // Delete tracks that are no longer on the server
    let removed: Vec<String> = existing_paths
        .into_iter()
        .filter(|p| !seen_paths.contains(p))
        .collect();
    db.delete_tracks_by_paths(&removed)
        .map_err(|e| e.to_string())?;

    db.rebuild_fts().map_err(|e| e.to_string())?;
    db.recompute_counts().map_err(|e| e.to_string())?;
    db.update_collection_synced(collection_id, start.elapsed().as_secs_f64())
        .map_err(|e| e.to_string())?;

    Ok(())
}
