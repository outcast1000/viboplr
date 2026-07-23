// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

impl Database {

    // --- Playlists ---

    pub fn save_playlist(&self, name: &str, source: Option<&str>, image_path: Option<&str>, description: Option<&str>, metadata: Option<&str>) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO playlists (name, source, image_path, description, metadata) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![name, source, image_path, description, metadata],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn save_playlist_tracks(
        &self,
        playlist_id: i64,
        tracks: &[(&str, Option<&str>, Option<&str>, Option<f64>, Option<&str>, Option<&str>)],
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "INSERT INTO playlist_tracks (playlist_id, position, title, artist_name, album_name, duration_secs, source, image_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        )?;
        for (i, (title, artist, album, duration, source, image)) in tracks.iter().enumerate() {
            stmt.execute(params![playlist_id, i as i64, title, artist, album, duration, source, image])?;
        }
        Ok(())
    }

    pub fn get_playlists(&self) -> SqlResult<Vec<Playlist>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT p.id, p.name, p.source, p.saved_at, p.image_path,
                    (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) as track_count,
                    p.description, p.metadata, p.system_kind
             FROM playlists p ORDER BY p.saved_at DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Playlist {
                id: row.get(0)?,
                name: row.get(1)?,
                source: row.get(2)?,
                saved_at: row.get(3)?,
                image_path: row.get(4)?,
                track_count: row.get(5)?,
                description: row.get(6)?,
                metadata: row.get(7)?,
                system_kind: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_playlist_tracks(&self, playlist_id: i64) -> SqlResult<Vec<PlaylistTrack>> {
        // The protected `liked`/`disliked` system playlists project their
        // membership from entity_likes. Auto-playlists (`auto:*`) carry a
        // system_kind too, but they DO store materialized rows — fall through
        // to the real-rows query below for those.
        if let Some(kind) = self.system_playlist_kind(playlist_id)? {
            if !kind.starts_with("auto:") {
            let want: i32 = if kind == "disliked" { -1 } else { 1 };
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT entity_key, metadata FROM entity_likes
                 WHERE kind = 'track' AND liked = ?1 ORDER BY updated_at DESC"
            )?;
            let rows = stmt.query_map(params![want], |row| {
                let entity_key: String = row.get(0)?;
                let metadata: Option<String> = row.get(1)?;
                Ok((entity_key, metadata))
            })?;
            let mut out = Vec::new();
            for (i, r) in rows.enumerate() {
                let (entity_key, metadata) = r?;
                let meta: serde_json::Value = metadata.as_deref()
                    .and_then(|m| serde_json::from_str(m).ok())
                    .unwrap_or(serde_json::Value::Null);
                let get = |k: &str| meta.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
                out.push(PlaylistTrack {
                    id: i as i64,            // synthetic; system playlists have no real rows
                    playlist_id,
                    position: i as i64,
                    title: get("title").unwrap_or_else(|| entity_key.clone()),
                    artist_name: get("artist_name"),
                    album_name: get("album_title"),
                    duration_secs: meta.get("duration_secs").and_then(|v| v.as_f64()),
                    source: get("source"),
                    // Deliberately omit the captured `image_url`: it's a remote URL
                    // that may break (expired CDN link, etc.). Leave empty so the
                    // frontend resolves artwork in real time via the name-based
                    // chain (album image → artist image → placeholder).
                    image_path: None,
                });
            }
            return Ok(out);
            }
        }

        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, playlist_id, position, title, artist_name, album_name, duration_secs, source, image_path
             FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position"
        )?;
        let rows = stmt.query_map(params![playlist_id], |row| {
            Ok(PlaylistTrack {
                id: row.get(0)?,
                playlist_id: row.get(1)?,
                position: row.get(2)?,
                title: row.get(3)?,
                artist_name: row.get(4)?,
                album_name: row.get(5)?,
                duration_secs: row.get(6)?,
                source: row.get(7)?,
                image_path: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    /// Playlist ids with at least one track whose title or artist matches
    /// `query` (case- and diacritic-insensitive, via the shared SQL functions).
    /// Covers materialized `playlist_tracks` rows (user + auto playlists) and the
    /// live `entity_likes` projection that backs the protected liked/disliked
    /// system playlists. Name/description matching stays on the frontend (the
    /// list already holds that data); this is only the track-content half.
    pub fn search_playlist_track_ids(&self, query: &str) -> SqlResult<Vec<i64>> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let mut ids: std::collections::HashSet<i64> = std::collections::HashSet::new();

        // Materialized rows (user + auto playlists).
        {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT playlist_id FROM playlist_tracks
                 WHERE strip_diacritics(unicode_lower(title))
                         LIKE '%' || strip_diacritics(unicode_lower(?1)) || '%'
                    OR strip_diacritics(unicode_lower(COALESCE(artist_name, '')))
                         LIKE '%' || strip_diacritics(unicode_lower(?1)) || '%'",
            )?;
            let rows = stmt.query_map(params![q], |r| r.get::<_, i64>(0))?;
            for r in rows {
                ids.insert(r?);
            }
        }

        // Protected liked/disliked: membership is projected from entity_likes,
        // whose entity_key is already strip_diacritics(lowercase(artist+title)),
        // so matching the normalized query against it covers title and artist.
        let (mut liked_match, mut disliked_match) = (false, false);
        {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT liked FROM entity_likes
                 WHERE kind = 'track' AND liked != 0
                   AND entity_key LIKE '%' || strip_diacritics(unicode_lower(?1)) || '%'",
            )?;
            let rows = stmt.query_map(params![q], |r| r.get::<_, i32>(0))?;
            for r in rows {
                match r? {
                    1 => liked_match = true,
                    -1 => disliked_match = true,
                    _ => {}
                }
            }
        }
        if liked_match || disliked_match {
            let mut stmt = conn.prepare(
                "SELECT id, system_kind FROM playlists
                 WHERE system_kind IN ('liked', 'disliked')",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            for r in rows {
                let (id, kind) = r?;
                if (kind == "liked" && liked_match) || (kind == "disliked" && disliked_match) {
                    ids.insert(id);
                }
            }
        }

        Ok(ids.into_iter().collect())
    }

    pub fn delete_playlist(&self, playlist_id: i64) -> SqlResult<()> {
        // Only the protected `liked`/`disliked` system playlists are
        // undeletable. Auto-playlists (`auto:*`) are user-deletable (they
        // regenerate on the next `ensure_auto_playlists`).
        if let Some(kind) = self.system_playlist_kind(playlist_id)? {
            if !kind.starts_with("auto:") {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                    Some("Cannot delete a system playlist".to_string()),
                ));
            }
        }
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM playlists WHERE id = ?1", params![playlist_id])?;
        Ok(())
    }

    pub fn update_playlist_image(&self, playlist_id: i64, image_path: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlists SET image_path = ?1 WHERE id = ?2",
            params![image_path, playlist_id],
        )?;
        Ok(())
    }

    pub fn update_playlist_track_image(&self, track_id: i64, image_path: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlist_tracks SET image_path = ?1 WHERE id = ?2",
            params![image_path, track_id],
        )?;
        Ok(())
    }

    /// Override a playlist entry's display metadata (title/artist/album). Only
    /// the playlist row is touched — the underlying library/source is untouched.
    pub fn update_playlist_track_metadata(
        &self,
        track_id: i64,
        title: &str,
        artist_name: Option<&str>,
        album_name: Option<&str>,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlist_tracks SET title = ?1, artist_name = ?2, album_name = ?3 WHERE id = ?4",
            params![title, artist_name, album_name, track_id],
        )?;
        Ok(())
    }
}
