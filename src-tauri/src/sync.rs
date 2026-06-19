use std::collections::HashSet;
use std::sync::Arc;

use crate::db::Database;
use crate::subsonic::SubsonicClient;

pub fn sync_collection(
    db: &Arc<Database>,
    client: &SubsonicClient,
    collection_id: i64,
    progress_callback: impl Fn(u64, u64) + Send,
) -> Result<u64, String> {
    let start = std::time::Instant::now();

    // Build set of all existing relative paths (track IDs) for this collection
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
    // Tracks whether any per-album fetch failed. A failed fetch means its tracks
    // never make it into `seen_paths`, which would make them look "removed on the
    // server" below. We only trust the seen/not-seen diff for pruning when the
    // server view was complete -- see the deletion phase.
    let mut fetch_failures: u64 = 0;

    for album_id in &all_album_ids {
        let (album, tracks) = match client.get_album(album_id) {
            Ok(result) => result,
            Err(e) => {
                log::warn!("Failed to fetch album {}: {}", album_id, e);
                fetch_failures += 1;
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

            let path = track.id.clone();
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

    // Delete tracks that are no longer on the server.
    //
    // Pruning is destructive and relies on `seen_paths` being a complete picture
    // of what the server currently holds. If any album fetch failed this run, its
    // tracks are missing from `seen_paths` even though they still exist on the
    // server -- pruning then would silently delete real tracks (e.g. a flaky
    // connection that fails 70% of album fetches would wipe 70% of the library
    // while still reporting success). Only prune when we have a trustworthy,
    // complete snapshot; otherwise keep everything and let the next clean sync
    // do the pruning.
    let removed_count = if fetch_failures > 0 {
        log::warn!(
            "Skipping prune for collection {}: {} of {} album fetch(es) failed, server view is incomplete",
            collection_id,
            fetch_failures,
            total
        );
        0
    } else {
        let removed: Vec<String> = existing_paths
            .into_iter()
            .filter(|p| !seen_paths.contains(p))
            .collect();
        let count = removed.len() as u64;
        db.delete_tracks_by_paths_in_collection(collection_id, &removed)
            .map_err(|e| e.to_string())?;
        count
    };

    db.rebuild_fts().map_err(|e| e.to_string())?;
    db.recompute_counts().map_err(|e| e.to_string())?;
    // Seed tracks.liked for freshly-synced rows that were liked before they
    // existed in the library (durable entity_likes is the source of truth).
    let _ = db.reconcile_track_likes_from_entity_likes();
    db.update_collection_synced(collection_id, start.elapsed().as_secs_f64())
        .map_err(|e| e.to_string())?;

    Ok(removed_count)
}
