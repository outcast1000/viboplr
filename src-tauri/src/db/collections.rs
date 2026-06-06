// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

/// How tag edits are applied in bulk_update_tracks.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TagMode {
    /// Replace each track's tags with exactly `tag_names`.
    Replace,
    /// Add `tag_names` to each track, keeping existing tags.
    Add,
    /// Remove `tag_names` from each track, keeping the rest.
    Remove,
}

impl TagMode {
    /// Parse from the string the command layer receives. Unknown / None → Replace.
    pub fn from_opt(s: Option<&str>) -> TagMode {
        match s {
            Some("add") => TagMode::Add,
            Some("remove") => TagMode::Remove,
            _ => TagMode::Replace,
        }
    }
}

impl Database {

    // --- Collections ---

    pub fn add_collection(
        &self,
        kind: &str,
        name: &str,
        path: Option<&str>,
        url: Option<&str>,
        username: Option<&str>,
        password_token: Option<&str>,
        salt: Option<&str>,
        auth_method: Option<&str>,
    ) -> SqlResult<Collection> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO collections (kind, name, path, url, username, password_token, salt, auth_method)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![kind, name, path, url, username, password_token, salt, auth_method.unwrap_or("token")],
        )?;
        let id = conn.last_insert_rowid();
        Ok(Collection {
            id,
            kind: kind.to_string(),
            name: name.to_string(),
            path: path.map(|s| s.to_string()),
            url: url.map(|s| s.to_string()),
            username: username.map(|s| s.to_string()),
            last_synced_at: None,
            auto_update: false,
            auto_update_interval_mins: 60,
            enabled: true,
            last_sync_duration_secs: None,
            last_sync_error: None,
        })
    }

    pub fn remove_collection(&self, collection_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM tracks WHERE collection_id = ?1",
            params![collection_id],
        )?;
        conn.execute(
            "DELETE FROM collections WHERE id = ?1",
            params![collection_id],
        )?;
        Ok(())
    }

    pub fn get_collections(&self) -> SqlResult<Vec<Collection>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, kind, name, path, url, username, last_synced_at, auto_update, auto_update_interval_mins, enabled, last_sync_duration_secs, last_sync_error FROM collections ORDER BY name"
        )?;
        let rows = stmt.query_map([], |row| collection_from_row(row))?;
        rows.collect()
    }

    pub fn get_collection_stats(&self) -> SqlResult<Vec<CollectionStats>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT collection_id,
                    COUNT(*) as track_count,
                    SUM(CASE WHEN lower(format) IN ('mp4','m4v','mov','webm') THEN 1 ELSE 0 END) as video_count,
                    COALESCE(SUM(file_size), 0) as total_size,
                    COALESCE(SUM(duration_secs), 0.0) as total_duration
             FROM tracks
             WHERE collection_id IS NOT NULL
             GROUP BY collection_id"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(CollectionStats {
                collection_id: row.get(0)?,
                track_count: row.get(1)?,
                video_count: row.get(2)?,
                total_size: row.get(3)?,
                total_duration: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_collection_by_id(&self, collection_id: i64) -> SqlResult<Collection> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, kind, name, path, url, username, last_synced_at, auto_update, auto_update_interval_mins, enabled, last_sync_duration_secs, last_sync_error FROM collections WHERE id = ?1",
            params![collection_id],
            |row| collection_from_row(row),
        )
    }

    pub fn get_collection_credentials(&self, collection_id: i64) -> SqlResult<CollectionCredentials> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT url, username, password_token, salt, auth_method FROM collections WHERE id = ?1",
            params![collection_id],
            |row| {
                Ok(CollectionCredentials {
                    url: row.get(0)?,
                    username: row.get(1)?,
                    password_token: row.get(2)?,
                    salt: row.get(3)?,
                    auth_method: row.get::<_, Option<String>>(4)?.unwrap_or_else(|| "token".to_string()),
                })
            },
        )
    }

    pub fn update_collection(
        &self,
        collection_id: i64,
        name: &str,
        auto_update: bool,
        auto_update_interval_mins: i64,
        enabled: bool,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE collections SET name = ?2, auto_update = ?3, auto_update_interval_mins = ?4, enabled = ?5 WHERE id = ?1",
            params![collection_id, name, auto_update as i32, auto_update_interval_mins, enabled as i32],
        )?;
        Ok(())
    }

    pub fn update_collection_synced(&self, collection_id: i64, duration_secs: f64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE collections SET last_synced_at = strftime('%s', 'now'), last_sync_duration_secs = ?2, last_sync_error = NULL WHERE id = ?1",
            params![collection_id, duration_secs],
        )?;
        Ok(())
    }

    pub fn update_collection_sync_error(&self, collection_id: i64, error: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE collections SET last_sync_error = ?2, last_synced_at = strftime('%s', 'now') WHERE id = ?1",
            params![collection_id, error],
        )?;
        Ok(())
    }

    pub fn clear_collection_sync_error(&self, collection_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE collections SET last_sync_error = NULL WHERE id = ?1",
            params![collection_id],
        )?;
        Ok(())
    }

    pub fn get_track_paths_for_collection(&self, collection_id: i64) -> SqlResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT path FROM tracks WHERE collection_id = ?1")?;
        let rows = stmt.query_map(params![collection_id], |row| row.get(0))?;
        rows.collect()
    }

    pub fn delete_tracks_by_paths_in_collection(&self, collection_id: i64, paths: &[String]) -> SqlResult<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        for chunk in paths.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "DELETE FROM tracks WHERE collection_id = ?1 AND path IN ({})",
                placeholders
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut params: Vec<&dyn rusqlite::types::ToSql> = Vec::with_capacity(chunk.len() + 1);
            params.push(&collection_id);
            params.extend(chunk.iter().map(|p| p as &dyn rusqlite::types::ToSql));
            stmt.execute(params.as_slice())?;
        }
        Ok(())
    }

    pub fn delete_tracks_by_ids(&self, ids: &[i64]) -> SqlResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        for chunk in ids.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("DELETE FROM tracks WHERE id IN ({})", placeholders);
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::types::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
            stmt.execute(params.as_slice())?;
        }
        Ok(())
    }

    /// Bulk update metadata fields on multiple tracks in a single transaction.
    /// Returns Vec of (track_id, path, collection_id) for file writing.
    pub fn bulk_update_tracks(
        &self,
        track_ids: &[i64],
        artist_name: Option<&str>,
        album_title: Option<&str>,
        year: Option<i32>,
        title: Option<&str>,
        track_number: Option<i32>,
        tag_names: Option<&[String]>,
        tag_mode: TagMode,
    ) -> SqlResult<Vec<(i64, String, Option<i64>)>> {
        if track_ids.is_empty() {
            return Ok(vec![]);
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let result = {
            let conn = self.conn.lock().unwrap();
            conn.execute_batch("BEGIN")?;

            let inner = (|| -> SqlResult<Vec<(i64, String, Option<i64>)>> {
                // Step 1: Artist
                let new_artist_id: Option<i64> = if let Some(name) = artist_name {
                    let existing: Option<i64> = conn.query_row(
                        "SELECT id FROM artists WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1))",
                        params![name],
                        |row| row.get(0),
                    ).optional()?;
                    let aid = match existing {
                        Some(id) => id,
                        None => {
                            conn.execute("INSERT INTO artists (name) VALUES (?1)", params![name])?;
                            conn.last_insert_rowid()
                        }
                    };
                    for chunk in track_ids.chunks(500) {
                        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                        let sql = format!("UPDATE tracks SET artist_id = ?1 WHERE id IN ({})", placeholders);
                        let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(aid)];
                        all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                        let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                        conn.execute(&sql, param_refs.as_slice())?;
                    }

                    // When artist changed but album title NOT changed, reassign each
                    // track's album to one under the new artist (find or create).
                    if album_title.is_none() {
                        // Collect (track_id, album_title, album_year) for tracks that have albums
                        let mut track_albums: Vec<(i64, String, Option<i32>)> = Vec::new();
                        for chunk in track_ids.chunks(500) {
                            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                            let sql = format!(
                                "SELECT t.id, al.title, al.year FROM tracks t \
                                 JOIN albums al ON t.album_id = al.id \
                                 WHERE t.id IN ({})", placeholders
                            );
                            let mut stmt = conn.prepare(&sql)?;
                            let params: Vec<&dyn rusqlite::types::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
                            let rows = stmt.query_map(params.as_slice(), |row| {
                                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i32>>(2)?))
                            })?;
                            for row in rows {
                                track_albums.push(row?);
                            }
                        }
                        // Group by album title to avoid redundant lookups
                        let mut album_cache: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
                        for (tid, title, album_year) in &track_albums {
                            let album_id = if let Some(&cached_id) = album_cache.get(title) {
                                cached_id
                            } else {
                                let existing: Option<i64> = conn.query_row(
                                    "SELECT id FROM albums WHERE strip_diacritics(unicode_lower(title)) = strip_diacritics(unicode_lower(?1)) \
                                     AND artist_id = ?2",
                                    params![title, aid],
                                    |row| row.get(0),
                                ).optional()?;
                                let id = match existing {
                                    Some(id) => id,
                                    None => {
                                        conn.execute(
                                            "INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)",
                                            params![title, aid, album_year],
                                        )?;
                                        conn.last_insert_rowid()
                                    }
                                };
                                album_cache.insert(title.clone(), id);
                                id
                            };
                            conn.execute(
                                "UPDATE tracks SET album_id = ?1 WHERE id = ?2",
                                params![album_id, tid],
                            )?;
                        }
                    }

                    Some(aid)
                } else {
                    None
                };

                // Step 2: Album
                if let Some(title) = album_title {
                    if let Some(aid) = new_artist_id {
                        // All tracks share the new artist — create one album
                        let album_year = year.or_else(|| {
                            // Try to get year from first track's current album
                            conn.query_row(
                                "SELECT al.year FROM tracks t JOIN albums al ON t.album_id = al.id WHERE t.id = ?1 AND al.year IS NOT NULL",
                                params![track_ids[0]],
                                |row| row.get(0),
                            ).optional().ok().flatten()
                        });
                        let existing_album: Option<i64> = conn.query_row(
                            "SELECT id FROM albums WHERE strip_diacritics(unicode_lower(title)) = strip_diacritics(unicode_lower(?1)) \
                             AND (artist_id = ?2 OR (?2 IS NULL AND artist_id IS NULL))",
                            params![title, aid],
                            |row| row.get(0),
                        ).optional()?;
                        let album_id = match existing_album {
                            Some(id) => id,
                            None => {
                                conn.execute(
                                    "INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)",
                                    params![title, aid, album_year],
                                )?;
                                conn.last_insert_rowid()
                            }
                        };
                        for chunk in track_ids.chunks(500) {
                            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                            let sql = format!("UPDATE tracks SET album_id = ?1 WHERE id IN ({})", placeholders);
                            let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(album_id)];
                            all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                            let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                            conn.execute(&sql, param_refs.as_slice())?;
                        }
                    } else {
                        // Artist was NOT changed — group tracks by their current artist_id
                        let mut artist_groups: std::collections::HashMap<Option<i64>, Vec<i64>> = std::collections::HashMap::new();
                        for chunk in track_ids.chunks(500) {
                            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                            let sql = format!("SELECT id, artist_id FROM tracks WHERE id IN ({})", placeholders);
                            let mut stmt = conn.prepare(&sql)?;
                            let params: Vec<&dyn rusqlite::types::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
                            let rows = stmt.query_map(params.as_slice(), |row| {
                                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?))
                            })?;
                            for row in rows {
                                let (tid, aid) = row?;
                                artist_groups.entry(aid).or_default().push(tid);
                            }
                        }
                        for (aid, tids) in &artist_groups {
                            let album_year = year.or_else(|| {
                                conn.query_row(
                                    "SELECT al.year FROM tracks t JOIN albums al ON t.album_id = al.id WHERE t.id = ?1 AND al.year IS NOT NULL",
                                    params![tids[0]],
                                    |row| row.get(0),
                                ).optional().ok().flatten()
                            });
                            let existing_album: Option<i64> = conn.query_row(
                                "SELECT id FROM albums WHERE strip_diacritics(unicode_lower(title)) = strip_diacritics(unicode_lower(?1)) \
                                 AND (artist_id = ?2 OR (?2 IS NULL AND artist_id IS NULL))",
                                params![title, *aid],
                                |row| row.get(0),
                            ).optional()?;
                            let album_id = match existing_album {
                                Some(id) => id,
                                None => {
                                    conn.execute(
                                        "INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)",
                                        params![title, *aid, album_year],
                                    )?;
                                    conn.last_insert_rowid()
                                }
                            };
                            for chunk in tids.chunks(500) {
                                let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                                let sql = format!("UPDATE tracks SET album_id = ?1 WHERE id IN ({})", placeholders);
                                let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(album_id)];
                                all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                                let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                                conn.execute(&sql, param_refs.as_slice())?;
                            }
                        }
                    }
                }

                // Step 3: Year
                if let Some(y) = year {
                    for chunk in track_ids.chunks(500) {
                        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                        let sql = format!("UPDATE tracks SET year = ?1 WHERE id IN ({})", placeholders);
                        let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(y)];
                        all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                        let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                        conn.execute(&sql, param_refs.as_slice())?;
                    }
                }

                // Step 3b: Title (single-value, applied to all given ids)
                if let Some(t) = title {
                    for chunk in track_ids.chunks(500) {
                        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                        let sql = format!("UPDATE tracks SET title = ?1 WHERE id IN ({})", placeholders);
                        let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(t.to_string())];
                        all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                        let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                        conn.execute(&sql, param_refs.as_slice())?;
                    }
                }

                // Step 3c: Track number
                if let Some(n) = track_number {
                    for chunk in track_ids.chunks(500) {
                        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                        let sql = format!("UPDATE tracks SET track_number = ?1 WHERE id IN ({})", placeholders);
                        let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(n)];
                        all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                        let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                        conn.execute(&sql, param_refs.as_slice())?;
                    }
                }

                // Step 4: Tags (replace / add / remove)
                if let Some(tags) = tag_names {
                    // Pre-resolve/create all tag IDs (needed for replace + add).
                    let mut tag_ids: Vec<i64> = Vec::with_capacity(tags.len());
                    for name in tags {
                        let tag_id: i64 = match conn.query_row(
                            "SELECT id FROM tags WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1))",
                            params![name],
                            |row| row.get(0),
                        ).optional()? {
                            Some(id) => id,
                            None => {
                                conn.execute("INSERT INTO tags (name) VALUES (?1)", params![name])?;
                                conn.last_insert_rowid()
                            }
                        };
                        tag_ids.push(tag_id);
                    }

                    match tag_mode {
                        TagMode::Replace => {
                            for &tid in track_ids {
                                conn.execute("DELETE FROM track_tags WHERE track_id = ?1", params![tid])?;
                                for &tag_id in &tag_ids {
                                    conn.execute(
                                        "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)",
                                        params![tid, tag_id],
                                    )?;
                                }
                            }
                        }
                        TagMode::Add => {
                            for &tid in track_ids {
                                for &tag_id in &tag_ids {
                                    conn.execute(
                                        "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)",
                                        params![tid, tag_id],
                                    )?;
                                }
                            }
                        }
                        TagMode::Remove => {
                            for &tid in track_ids {
                                for &tag_id in &tag_ids {
                                    conn.execute(
                                        "DELETE FROM track_tags WHERE track_id = ?1 AND tag_id = ?2",
                                        params![tid, tag_id],
                                    )?;
                                }
                            }
                        }
                    }
                }

                // Step 5: Update modified_at
                for chunk in track_ids.chunks(500) {
                    let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                    let sql = format!("UPDATE tracks SET modified_at = ?1 WHERE id IN ({})", placeholders);
                    let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now)];
                    all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                    let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                    conn.execute(&sql, param_refs.as_slice())?;
                }

                // Step 6: Collect track info for file writing (reconstruct full URI)
                let mut results: Vec<(i64, String, Option<i64>)> = Vec::new();
                for chunk in track_ids.chunks(500) {
                    let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                    let sql = format!(
                        "SELECT t.id, {}, t.collection_id \
                         FROM tracks t LEFT JOIN collections co ON t.collection_id = co.id \
                         WHERE t.id IN ({})",
                        PATH_EXPR, placeholders
                    );
                    let mut stmt = conn.prepare(&sql)?;
                    let params: Vec<&dyn rusqlite::types::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
                    let rows = stmt.query_map(params.as_slice(), |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                        ))
                    })?;
                    for row in rows {
                        results.push(row?);
                    }
                }

                // Step 7: Commit
                conn.execute_batch("COMMIT")?;
                Ok(results)
            })();

            match inner {
                Ok(results) => Ok(results),
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(e)
                }
            }
        }; // lock dropped here

        // Step 7 continued: recompute counts and rebuild FTS after lock is released
        if result.is_ok() {
            self.recompute_counts()?;
            self.rebuild_fts()?;
        }

        result
    }
    pub fn find_track_in_collection(
        &self,
        collection_id: i64,
        title: &str,
        artist_name: &str,
    ) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{TRACK_SELECT} WHERE t.collection_id = ?1 \
             AND strip_diacritics(unicode_lower(t.title)) = strip_diacritics(unicode_lower(?2)) \
             AND ar.name IS NOT NULL AND strip_diacritics(unicode_lower(ar.name)) = strip_diacritics(unicode_lower(?3)) \
             LIMIT 1"
        );
        conn.query_row(&sql, params![collection_id, title, artist_name], |row| {
            track_from_row(row)
        }).optional()
    }
}
