// Durable like/dislike store for tracks, artists, albums, tags.
// Shared types/helpers live in db/mod.rs; these are inherent impl Database methods.
use super::*;

/// Normalize a string segment for use in an entity_key (lowercased, diacritics stripped).
pub fn norm_segment(s: Option<&str>) -> String {
    strip_diacritics(&s.unwrap_or("").to_lowercase())
}

/// Build the canonical entity_key for a given kind from raw metadata parts.
/// - track:  `track:{artist}:{title}`
/// - artist: `artist:{name}`
/// - album:  `album:{artist}:{title}`
/// - tag:    `tag:{name}`
pub fn build_entity_key(kind: &str, name_or_title: &str, artist_name: Option<&str>) -> String {
    match kind {
        "track" => format!("track:{}:{}", norm_segment(artist_name), norm_segment(Some(name_or_title))),
        "album" => format!("album:{}:{}", norm_segment(artist_name), norm_segment(Some(name_or_title))),
        "artist" => format!("artist:{}", norm_segment(Some(name_or_title))),
        "tag" => format!("tag:{}", norm_segment(Some(name_or_title))),
        _ => format!("{}:{}", kind, norm_segment(Some(name_or_title))),
    }
}

impl Database {
    /// Upsert (or delete when liked==0) an entity_likes row.
    pub fn set_entity_like(&self, kind: &str, entity_key: &str, liked: i32, metadata: Option<&str>, updated_at: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        if liked == 0 {
            conn.execute(
                "DELETE FROM entity_likes WHERE kind = ?1 AND entity_key = ?2",
                params![kind, entity_key],
            )?;
        } else {
            conn.execute(
                "INSERT INTO entity_likes (kind, entity_key, liked, metadata, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(kind, entity_key) DO UPDATE SET
                   liked = excluded.liked,
                   metadata = excluded.metadata,
                   updated_at = excluded.updated_at",
                params![kind, entity_key, liked, metadata, updated_at],
            )?;
        }
        Ok(())
    }

    /// Read the current like state (0 if no row).
    pub fn get_entity_like_state(&self, kind: &str, entity_key: &str) -> SqlResult<i32> {
        let conn = self.conn.lock().unwrap();
        let v: Option<i32> = conn.query_row(
            "SELECT liked FROM entity_likes WHERE kind = ?1 AND entity_key = ?2",
            params![kind, entity_key],
            |r| r.get(0),
        ).optional()?;
        Ok(v.unwrap_or(0))
    }

    /// If the entity exists in the library, set its `liked` column. Returns true if a row was updated.
    pub fn mirror_entity_like_to_library(
        &self,
        kind: &str,
        name_or_title: &str,
        artist_name: Option<&str>,
        album_name: Option<&str>,
        liked: i32,
    ) -> SqlResult<bool> {
        let target: Option<(&str, i64)> = match kind {
            "track" => self.find_track_by_metadata(name_or_title, artist_name, album_name)?
                .map(|t| ("tracks", t.id)),
            "artist" => self.find_artist_by_name(name_or_title)?.map(|a| ("artists", a.id)),
            "album" => self.find_album_by_name(name_or_title, artist_name)?.map(|a| ("albums", a.id)),
            "tag" => self.find_tag_by_name(name_or_title)?.map(|t| ("tags", t.id)),
            _ => None,
        };
        if let Some((table, id)) = target {
            self.toggle_liked(table, id, liked)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Create the two protected system playlists if missing. Idempotent.
    pub fn ensure_system_playlists(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        for (kind, name) in [("liked", "Liked Songs"), ("disliked", "Disliked Songs")] {
            // Check if playlist already exists
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM playlists WHERE system_kind = ?1",
                params![kind],
                |r| r.get(0),
            )?;
            if exists == 0 {
                conn.execute(
                    "INSERT INTO playlists (name, system_kind) VALUES (?1, ?2)",
                    params![name, kind],
                )?;
            }
        }
        Ok(())
    }

    /// One-time backfill: populate entity_likes from existing library liked columns.
    /// `now_ts` is used as updated_at for all backfilled rows.
    pub fn backfill_entity_likes_from_library(&self, now_ts: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        // Tracks (join artist/album for keys + metadata).
        let mut stmt = conn.prepare(
            "SELECT t.title, ar.name, al.title, t.duration_secs, t.liked
             FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
             WHERE t.liked != 0"
        )?;
        let track_rows: Vec<(String, Option<String>, Option<String>, Option<f64>, i32)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<SqlResult<_>>()?;
        for (title, artist, album, dur, liked) in track_rows {
            let key = build_entity_key("track", &title, artist.as_deref());
            let meta = serde_json::json!({
                "title": title, "artist_name": artist, "album_title": album, "duration_secs": dur,
            }).to_string();
            conn.execute(
                "INSERT INTO entity_likes (kind, entity_key, liked, metadata, updated_at)
                 VALUES ('track', ?1, ?2, ?3, ?4) ON CONFLICT(kind, entity_key) DO NOTHING",
                params![key, liked, meta, now_ts],
            )?;
        }

        // Artists.
        let mut stmt = conn.prepare("SELECT name, liked FROM artists WHERE liked != 0")?;
        let artist_rows: Vec<(String, i32)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<SqlResult<_>>()?;
        for (name, liked) in artist_rows {
            let key = build_entity_key("artist", &name, None);
            let meta = serde_json::json!({ "name": name }).to_string();
            conn.execute(
                "INSERT INTO entity_likes (kind, entity_key, liked, metadata, updated_at)
                 VALUES ('artist', ?1, ?2, ?3, ?4) ON CONFLICT(kind, entity_key) DO NOTHING",
                params![key, liked, meta, now_ts],
            )?;
        }

        // Albums (join artist for key).
        let mut stmt = conn.prepare(
            "SELECT al.title, ar.name, al.liked FROM albums al
             LEFT JOIN artists ar ON al.artist_id = ar.id WHERE al.liked != 0"
        )?;
        let album_rows: Vec<(String, Option<String>, i32)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<SqlResult<_>>()?;
        for (title, artist, liked) in album_rows {
            let key = build_entity_key("album", &title, artist.as_deref());
            let meta = serde_json::json!({ "name": title, "artist_name": artist }).to_string();
            conn.execute(
                "INSERT INTO entity_likes (kind, entity_key, liked, metadata, updated_at)
                 VALUES ('album', ?1, ?2, ?3, ?4) ON CONFLICT(kind, entity_key) DO NOTHING",
                params![key, liked, meta, now_ts],
            )?;
        }

        // Tags.
        let mut stmt = conn.prepare("SELECT name, liked FROM tags WHERE liked != 0")?;
        let tag_rows: Vec<(String, i32)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<SqlResult<_>>()?;
        for (name, liked) in tag_rows {
            let key = build_entity_key("tag", &name, None);
            let meta = serde_json::json!({ "name": name }).to_string();
            conn.execute(
                "INSERT INTO entity_likes (kind, entity_key, liked, metadata, updated_at)
                 VALUES ('tag', ?1, ?2, ?3, ?4) ON CONFLICT(kind, entity_key) DO NOTHING",
                params![key, liked, meta, now_ts],
            )?;
        }

        Ok(())
    }

    /// Returns Some("liked"|"disliked") if the playlist is a system playlist.
    pub fn system_playlist_kind(&self, playlist_id: i64) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT system_kind FROM playlists WHERE id = ?1",
            params![playlist_id],
            |r| r.get(0),
        ).optional().map(|opt| opt.flatten())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        Database::new_in_memory().unwrap()
    }

    #[test]
    fn test_build_entity_key_track() {
        assert_eq!(build_entity_key("track", "Jóga", Some("Björk")), "track:bjork:joga");
        assert_eq!(build_entity_key("track", "Creep", None), "track::creep");
    }

    #[test]
    fn test_build_entity_key_artist_album_tag() {
        assert_eq!(build_entity_key("artist", "Björk", None), "artist:bjork");
        assert_eq!(build_entity_key("album", "Homogenic", Some("Björk")), "album:bjork:homogenic");
        assert_eq!(build_entity_key("tag", "Trip-Hop", None), "tag:trip-hop");
    }

    #[test]
    fn test_build_entity_key_dedups_case_and_diacritics() {
        assert_eq!(
            build_entity_key("track", "JOGA", Some("BJORK")),
            build_entity_key("track", "Jóga", Some("Björk")),
        );
    }

    #[test]
    fn test_set_entity_like_inserts_and_deletes() {
        let db = test_db();
        db.set_entity_like("track", "track:bjork:joga", 1, Some(r#"{"title":"Jóga"}"#), 100).unwrap();
        assert_eq!(db.get_entity_like_state("track", "track:bjork:joga").unwrap(), 1);

        db.set_entity_like("track", "track:bjork:joga", -1, Some(r#"{"title":"Jóga"}"#), 101).unwrap();
        assert_eq!(db.get_entity_like_state("track", "track:bjork:joga").unwrap(), -1);

        db.set_entity_like("track", "track:bjork:joga", 0, None, 102).unwrap();
        assert_eq!(db.get_entity_like_state("track", "track:bjork:joga").unwrap(), 0);
        let count: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM entity_likes", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(count, 0, "neutral state should leave no row");
    }

    #[test]
    fn test_mirror_like_to_library_track() {
        let db = test_db();
        let artist = db.get_or_create_artist("Björk").unwrap();
        let cid = db.add_collection("local", "L", Some("/m"), None, None, None, None, None).unwrap().id;
        let tid = db.upsert_track("joga.mp3", "Jóga", Some(artist), None, None, Some(180.0), Some("mp3"), None, None, Some(cid), None).unwrap();

        let matched = db.mirror_entity_like_to_library("track", "Jóga", Some("Björk"), None, 1).unwrap();
        assert!(matched, "should match the library track");
        assert_eq!(db.get_track_by_id(tid).unwrap().liked, 1);

        let matched = db.mirror_entity_like_to_library("track", "Ghost Song", Some("Nobody"), None, 1).unwrap();
        assert!(!matched);
    }

    #[test]
    fn test_mirror_like_to_library_artist_album_tag() {
        let db = test_db();
        let artist = db.get_or_create_artist("Radiohead").unwrap();
        let cid = db.add_collection("local", "L", Some("/m"), None, None, None, None, None).unwrap().id;
        let album = db.get_or_create_album("OK Computer", Some(artist), Some(1997)).unwrap();
        let tid = db.upsert_track("creep.mp3", "Creep", Some(artist), Some(album), None, Some(180.0), Some("mp3"), None, None, Some(cid), None).unwrap();
        let tag = db.get_or_create_tag("Alt").unwrap();
        db.add_track_tag(tid, tag).unwrap();
        db.recompute_counts().unwrap();

        assert!(db.mirror_entity_like_to_library("artist", "Radiohead", None, None, 1).unwrap());
        assert_eq!(db.get_artist_by_id(artist).unwrap().unwrap().liked, 1);

        assert!(db.mirror_entity_like_to_library("album", "OK Computer", Some("Radiohead"), None, -1).unwrap());
        assert_eq!(db.get_album_by_id(album).unwrap().unwrap().liked, -1);

        assert!(db.mirror_entity_like_to_library("tag", "Alt", None, None, 1).unwrap());
        assert_eq!(db.get_tag_by_id(tag).unwrap().unwrap().liked, 1);
    }

    #[test]
    fn test_ensure_system_playlists_idempotent() {
        let db = test_db();
        db.ensure_system_playlists().unwrap();
        db.ensure_system_playlists().unwrap(); // second call must not duplicate
        let conn = db.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM playlists WHERE system_kind IS NOT NULL", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(n, 2);
        let liked: i64 = conn.query_row(
            "SELECT COUNT(*) FROM playlists WHERE system_kind = 'liked'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(liked, 1);
    }

    #[test]
    fn test_get_playlist_tracks_projects_liked_songs() {
        let db = test_db();
        db.ensure_system_playlists().unwrap();
        db.set_entity_like("track", "track:a:song1", 1, Some(r#"{"title":"Song1","artist_name":"A","source":"ext://1"}"#), 100).unwrap();
        db.set_entity_like("track", "track:b:song2", 1, Some(r#"{"title":"Song2","artist_name":"B","source":"ext://2"}"#), 200).unwrap();
        db.set_entity_like("track", "track:c:song3", -1, Some(r#"{"title":"Song3","artist_name":"C","source":"ext://3"}"#), 150).unwrap();

        let liked_id: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT id FROM playlists WHERE system_kind='liked'", [], |r| r.get(0)).unwrap()
        };
        let tracks = db.get_playlist_tracks(liked_id).unwrap();
        assert_eq!(tracks.len(), 2);
        // Ordered by updated_at DESC → Song2 (200) before Song1 (100).
        assert_eq!(tracks[0].title, "Song2");
        assert_eq!(tracks[0].source.as_deref(), Some("ext://2"));
        assert_eq!(tracks[1].title, "Song1");

        let disliked_id: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT id FROM playlists WHERE system_kind='disliked'", [], |r| r.get(0)).unwrap()
        };
        let dtracks = db.get_playlist_tracks(disliked_id).unwrap();
        assert_eq!(dtracks.len(), 1);
        assert_eq!(dtracks[0].title, "Song3");
    }

    #[test]
    fn test_backfill_from_library_likes() {
        let db = test_db();
        let artist = db.get_or_create_artist("Björk").unwrap();
        let cid = db.add_collection("local", "L", Some("/m"), None, None, None, None, None).unwrap().id;
        let album = db.get_or_create_album("Homogenic", Some(artist), Some(1997)).unwrap();
        let liked_tid = db.upsert_track("joga.mp3", "Jóga", Some(artist), Some(album), None, Some(180.0), Some("mp3"), None, None, Some(cid), None).unwrap();
        let disliked_tid = db.upsert_track("hunter.mp3", "Hunter", Some(artist), Some(album), None, Some(200.0), Some("mp3"), None, None, Some(cid), None).unwrap();
        db.toggle_liked("tracks", liked_tid, 1).unwrap();
        db.toggle_liked("tracks", disliked_tid, -1).unwrap();
        db.toggle_liked("artists", artist, 1).unwrap();
        db.toggle_liked("albums", album, 1).unwrap();
        let tag = db.get_or_create_tag("Electronic").unwrap();
        db.toggle_liked("tags", tag, 1).unwrap();

        db.backfill_entity_likes_from_library(1000).unwrap();

        assert_eq!(db.get_entity_like_state("track", "track:bjork:joga").unwrap(), 1);
        assert_eq!(db.get_entity_like_state("track", "track:bjork:hunter").unwrap(), -1);
        assert_eq!(db.get_entity_like_state("artist", "artist:bjork").unwrap(), 1);
        assert_eq!(db.get_entity_like_state("album", "album:bjork:homogenic").unwrap(), 1);
        assert_eq!(db.get_entity_like_state("tag", "tag:electronic").unwrap(), 1);
    }

    #[test]
    fn test_migration_creates_system_playlists_on_new_db() {
        let db = Database::new_in_memory().unwrap();
        let playlists = db.get_playlists().unwrap();
        let kinds: Vec<Option<String>> = playlists.iter().map(|p| p.system_kind.clone()).collect();
        assert!(kinds.contains(&Some("liked".to_string())));
        assert!(kinds.contains(&Some("disliked".to_string())));
    }

    #[test]
    fn test_delete_system_playlist_is_blocked() {
        let db = test_db();
        db.ensure_system_playlists().unwrap();
        let liked_id: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT id FROM playlists WHERE system_kind='liked'", [], |r| r.get(0)).unwrap()
        };
        let result = db.delete_playlist(liked_id);
        assert!(result.is_err(), "deleting a system playlist must error");
        let conn = db.conn.lock().unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM playlists WHERE id=?1", params![liked_id], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }
}
