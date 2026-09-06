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
                    p.description, p.metadata, p.system_kind, p.updated_at
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
                updated_at: row.get(9)?,
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

    /// Err unless the playlist exists and is a user playlist (`system_kind IS
    /// NULL`). Every incremental mutation goes through this: the protected
    /// liked/disliked playlists have no real rows (their tracks are projected
    /// from entity_likes, with synthetic ids), and auto mixes are regenerated
    /// snapshots where an edit would be silently clobbered on the next
    /// `ensure_auto_playlists`.
    fn ensure_user_playlist(&self, playlist_id: i64) -> SqlResult<()> {
        let exists: bool = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT 1 FROM playlists WHERE id = ?1",
                params![playlist_id],
                |_| Ok(true),
            ).optional()?.unwrap_or(false)
        };
        if !exists {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        if self.system_playlist_kind(playlist_id)?.is_some() {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                Some("Cannot modify a system playlist".to_string()),
            ));
        }
        Ok(())
    }

    /// Stamp a playlist's `updated_at` to now. Called by every incremental
    /// mutation so "recently used" ordering (the Add to Playlist submenu)
    /// reflects actual edits. Runs on the caller's connection/transaction.
    fn touch_playlist(conn: &rusqlite::Connection, playlist_id: i64) -> SqlResult<()> {
        conn.execute(
            "UPDATE playlists SET updated_at = strftime('%s','now') WHERE id = ?1",
            params![playlist_id],
        )?;
        Ok(())
    }

    /// Renumber a playlist's rows to `0..n-1` in their current `position`
    /// order. Two-phase because SQLite enforces UNIQUE(playlist_id, position)
    /// per-row during UPDATE: first flip every position negative (still
    /// unique, can't collide with any real position), then assign the final
    /// sequence. Must run inside the caller's transaction.
    fn renumber_positions(conn: &rusqlite::Connection, playlist_id: i64) -> SqlResult<()> {
        conn.execute(
            "UPDATE playlist_tracks SET position = -position - 1 WHERE playlist_id = ?1",
            params![playlist_id],
        )?;
        let ids: Vec<i64> = {
            let mut stmt = conn.prepare(
                "SELECT id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position DESC",
            )?;
            let rows = stmt.query_map(params![playlist_id], |r| r.get(0))?;
            rows.collect::<SqlResult<Vec<i64>>>()?
        };
        let mut stmt = conn.prepare(
            "UPDATE playlist_tracks SET position = ?1 WHERE id = ?2",
        )?;
        for (i, id) in ids.iter().enumerate() {
            stmt.execute(params![i as i64, id])?;
        }
        Ok(())
    }

    /// Append tracks to a user playlist. With `allow_duplicates` false,
    /// entries the playlist already contains are skipped — a duplicate is an
    /// exact `source` match when the incoming track has one, else a
    /// case-insensitive title+artist match; the caller warns and can re-append
    /// the skipped ones with `allow_duplicates` true once the user confirms.
    /// Returns `(input index, inserted row id)` pairs — the index says which
    /// payload each row came from, so the caller's image-download step can't
    /// pair an image with the wrong row when a skipped duplicate interleaves —
    /// plus the number of skipped duplicates.
    pub fn append_playlist_tracks(
        &self,
        playlist_id: i64,
        tracks: &[(&str, Option<&str>, Option<&str>, Option<f64>, Option<&str>, Option<&str>)],
        allow_duplicates: bool,
    ) -> SqlResult<(Vec<(usize, i64)>, usize)> {
        self.ensure_user_playlist(playlist_id)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;

        let norm = |title: &str, artist: Option<&str>| {
            format!("{}\u{1}{}", title.to_lowercase(), artist.unwrap_or("").to_lowercase())
        };
        let (mut sources, mut names) = (
            std::collections::HashSet::new(),
            std::collections::HashSet::new(),
        );
        {
            let mut stmt = tx.prepare(
                "SELECT source, title, artist_name FROM playlist_tracks WHERE playlist_id = ?1",
            )?;
            let rows = stmt.query_map(params![playlist_id], |r| {
                Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
            })?;
            for r in rows {
                let (source, title, artist) = r?;
                if let Some(s) = source {
                    sources.insert(s);
                }
                names.insert(norm(&title, artist.as_deref()));
            }
        }

        let mut next: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
            |r| r.get(0),
        )?;

        let mut inserted = Vec::new();
        let mut skipped = 0usize;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO playlist_tracks (playlist_id, position, title, artist_name, album_name, duration_secs, source, image_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for (i, (title, artist, album, duration, source, image)) in tracks.iter().enumerate() {
                let dup = !allow_duplicates && match source {
                    Some(s) => sources.contains(*s),
                    None => names.contains(&norm(title, *artist)),
                };
                if dup {
                    skipped += 1;
                    continue;
                }
                stmt.execute(params![playlist_id, next, title, artist, album, duration, source, image])?;
                inserted.push((i, tx.last_insert_rowid()));
                next += 1;
                if let Some(s) = source {
                    sources.insert((*s).to_string());
                }
                names.insert(norm(title, *artist));
            }
        }
        if !inserted.is_empty() {
            Self::touch_playlist(&tx, playlist_id)?;
        }
        tx.commit()?;
        Ok((inserted, skipped))
    }

    /// Remove rows from a user playlist and renumber the survivors
    /// contiguously. Returns the removed rows' image paths so the caller can
    /// delete the files (parity with `delete_playlist_record`).
    pub fn remove_playlist_tracks(&self, playlist_id: i64, track_ids: &[i64]) -> SqlResult<Vec<String>> {
        self.ensure_user_playlist(playlist_id)?;
        if track_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let placeholders = vec!["?"; track_ids.len()].join(",");
        let mut sql_params: Vec<&dyn rusqlite::types::ToSql> = vec![&playlist_id];
        for id in track_ids {
            sql_params.push(id);
        }
        let image_paths: Vec<String> = {
            let mut stmt = tx.prepare(&format!(
                "SELECT image_path FROM playlist_tracks
                 WHERE playlist_id = ?1 AND id IN ({placeholders}) AND image_path IS NOT NULL",
            ))?;
            let rows = stmt.query_map(sql_params.as_slice(), |r| r.get(0))?;
            rows.collect::<SqlResult<Vec<String>>>()?
        };
        tx.execute(
            &format!("DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND id IN ({placeholders})"),
            sql_params.as_slice(),
        )?;
        Self::renumber_positions(&tx, playlist_id)?;
        Self::touch_playlist(&tx, playlist_id)?;
        tx.commit()?;
        Ok(image_paths)
    }

    /// Apply a full permutation to a user playlist's track order.
    /// `ordered_ids` must be exactly the playlist's current id set — a stale
    /// frontend snapshot (row added/removed since it was taken) is rejected
    /// rather than allowed to corrupt positions.
    pub fn reorder_playlist_tracks(&self, playlist_id: i64, ordered_ids: &[i64]) -> SqlResult<()> {
        self.ensure_user_playlist(playlist_id)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let current: std::collections::HashSet<i64> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM playlist_tracks WHERE playlist_id = ?1",
            )?;
            let rows = stmt.query_map(params![playlist_id], |r| r.get(0))?;
            rows.collect::<SqlResult<_>>()?
        };
        let given: std::collections::HashSet<i64> = ordered_ids.iter().copied().collect();
        if given.len() != ordered_ids.len() || given != current {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                Some("Reorder does not match the playlist's current tracks".to_string()),
            ));
        }
        tx.execute(
            "UPDATE playlist_tracks SET position = -position - 1 WHERE playlist_id = ?1",
            params![playlist_id],
        )?;
        {
            let mut stmt = tx.prepare(
                "UPDATE playlist_tracks SET position = ?1 WHERE id = ?2",
            )?;
            for (i, id) in ordered_ids.iter().enumerate() {
                stmt.execute(params![i as i64, id])?;
            }
        }
        Self::touch_playlist(&tx, playlist_id)?;
        tx.commit()?;
        Ok(())
    }

    /// Rename a user playlist and set its description.
    pub fn update_playlist_meta(&self, playlist_id: i64, name: &str, description: Option<&str>) -> SqlResult<()> {
        self.ensure_user_playlist(playlist_id)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlists SET name = ?1, description = ?2, updated_at = strftime('%s','now') WHERE id = ?3",
            params![name, description, playlist_id],
        )?;
        Ok(())
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

    /// Set or clear a user playlist's cover image path. Guarded variant of
    /// `update_playlist_image` for the user-facing edit flow (that one stays
    /// unguarded for the save/import/auto-mix pipelines, which own the row).
    pub fn set_user_playlist_image(&self, playlist_id: i64, image_path: Option<&str>) -> SqlResult<()> {
        self.ensure_user_playlist(playlist_id)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlists SET image_path = ?1, updated_at = strftime('%s','now') WHERE id = ?2",
            params![image_path, playlist_id],
        )?;
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
