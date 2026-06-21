// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;
use crate::models::FieldUpdate;

/// One track to ingest from a manifest (already resolved to metadata + URL).
pub struct ManifestIngestTrack {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_secs: Option<f64>,
    pub track_number: Option<i32>,
    pub format: Option<String>,
    pub year: Option<i32>,
    /// Direct playable URL — stored verbatim as `tracks.path`.
    pub url: String,
    pub tags: Vec<String>,
}

pub struct ManifestIngestStats {
    pub removed: u64,
}

/// Set a single `tracks` column to `value` for every id in `track_ids`,
/// chunked to stay under SQLite's bound-parameter limit. `column` is always a
/// trusted string literal at the call sites (never user input), so the
/// interpolation is safe.
fn update_track_column<T: rusqlite::types::ToSql + Copy>(
    conn: &rusqlite::Connection,
    track_ids: &[i64],
    column: &str,
    value: T,
) -> SqlResult<()> {
    for chunk in track_ids.chunks(500) {
        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("UPDATE tracks SET {} = ?1 WHERE id IN ({})", column, placeholders);
        let mut params: Vec<&dyn rusqlite::types::ToSql> = Vec::with_capacity(chunk.len() + 1);
        params.push(&value);
        for id in chunk {
            params.push(id);
        }
        conn.execute(&sql, params.as_slice())?;
    }
    Ok(())
}

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

    /// Rename a collection. Used by manifest sync to apply the manifest's own
    /// display name over the provisional name the collection was created with.
    pub fn set_collection_name(&self, collection_id: i64, name: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE collections SET name = ?2 WHERE id = ?1",
            params![collection_id, name],
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

    /// Full track rows for a collection (with reconstructed paths). Used by the
    /// publish flow to bundle a whole local collection.
    pub fn get_tracks_for_collection(&self, collection_id: i64) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE t.collection_id = ?1 ORDER BY t.title", TRACK_SELECT);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![collection_id], |row| track_from_row(row))?;
        rows.collect()
    }

    /// Read the stored HTTP ETag / Last-Modified for a manifest collection (for
    /// conditional re-fetch). Returns `(None, None)` when absent.
    pub fn get_manifest_http_cache(&self, collection_id: i64) -> SqlResult<(Option<String>, Option<String>)> {
        let conn = self.conn.lock().unwrap();
        let r = conn
            .query_row(
                "SELECT etag, last_modified FROM manifest_http_cache WHERE collection_id = ?1",
                params![collection_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        Ok(r.unwrap_or((None, None)))
    }

    pub fn set_manifest_http_cache(&self, collection_id: i64, etag: Option<&str>, last_modified: Option<&str>) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO manifest_http_cache (collection_id, etag, last_modified) VALUES (?1, ?2, ?3)
             ON CONFLICT(collection_id) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified",
            params![collection_id, etag, last_modified],
        )?;
        Ok(())
    }

    /// Transactionally ingest a manifest's tracks into `collection_id`: upsert each
    /// track (keyed by URL), replace its tags, maintain the FTS index incrementally,
    /// and prune tracks no longer present. One transaction + incremental FTS (no
    /// global rebuild) keeps a sync O(changed rows), not O(whole library). Returns
    /// the prune count.
    pub fn manifest_ingest(
        &self,
        collection_id: i64,
        items: &[ManifestIngestTrack],
        progress_callback: impl Fn(u64, u64),
    ) -> SqlResult<ManifestIngestStats> {
        let mut conn = self.conn.lock().unwrap();

        // Disabled collections are excluded from FTS (mirrors the full rebuild);
        // we still store their tracks, just not their search-index rows.
        let enabled: bool = conn
            .query_row("SELECT enabled FROM collections WHERE id = ?1", params![collection_id], |r| r.get::<_, i64>(0))
            .optional()?
            .map(|v| v != 0)
            .unwrap_or(true);

        // Existing path -> rowid for this collection (upsert-id lookup + prune diff).
        let existing: std::collections::HashMap<String, i64> = {
            let mut stmt = conn.prepare("SELECT path, id FROM tracks WHERE collection_id = ?1")?;
            let rows = stmt.query_map(params![collection_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
            rows.collect::<SqlResult<_>>()?
        };

        let tx = conn.transaction()?;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let total = items.len() as u64;
        let mut done: u64 = 0;

        {
            let get_or_create_named = |table: &str, name: &str| -> SqlResult<i64> {
                let sel = format!(
                    "SELECT id FROM {} WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1))",
                    table
                );
                if let Some(id) = tx.query_row(&sel, params![name], |r| r.get::<_, i64>(0)).optional()? {
                    return Ok(id);
                }
                tx.execute(&format!("INSERT INTO {} (name) VALUES (?1)", table), params![name])?;
                Ok(tx.last_insert_rowid())
            };
            let get_or_create_album = |title: &str, artist_id: Option<i64>, year: Option<i32>| -> SqlResult<i64> {
                if let Some(id) = tx
                    .query_row(
                        "SELECT id FROM albums WHERE strip_diacritics(unicode_lower(title)) = strip_diacritics(unicode_lower(?1)) AND (artist_id = ?2 OR (?2 IS NULL AND artist_id IS NULL))",
                        params![title, artist_id],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()?
                {
                    return Ok(id);
                }
                tx.execute("INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)", params![title, artist_id, year])?;
                Ok(tx.last_insert_rowid())
            };

            for item in items {
                done += 1;
                if item.title.trim().is_empty() || item.url.trim().is_empty() {
                    if done % 50 == 0 || done == total { progress_callback(done, total); }
                    continue;
                }

                let artist_id = match item.artist.as_deref() {
                    Some(a) if !a.is_empty() => Some(get_or_create_named("artists", a)?),
                    _ => None,
                };
                let album_id = match item.album.as_deref() {
                    Some(al) if !al.is_empty() => Some(get_or_create_album(al, artist_id, item.year)?),
                    _ => None,
                };

                tx.execute(
                    "INSERT INTO tracks (path, title, artist_id, album_id, track_number, duration_secs, format, file_size, modified_at, collection_id, year)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?9)
                     ON CONFLICT(collection_id, path) DO UPDATE SET
                        title=excluded.title, artist_id=excluded.artist_id, album_id=excluded.album_id,
                        track_number=excluded.track_number, duration_secs=excluded.duration_secs,
                        format=excluded.format, year=excluded.year",
                    params![item.url, item.title, artist_id, album_id, item.track_number, item.duration_secs, item.format, collection_id, item.year],
                )?;
                let track_id: i64 = tx.query_row(
                    "SELECT id FROM tracks WHERE collection_id IS ?1 AND path = ?2",
                    params![collection_id, item.url],
                    |r| r.get(0),
                )?;
                seen.insert(item.url.clone());

                // Replace this track's tags.
                tx.execute("DELETE FROM track_tags WHERE track_id = ?1", params![track_id])?;
                for tag in &item.tags {
                    if tag.trim().is_empty() { continue; }
                    let tag_id = get_or_create_named("tags", tag)?;
                    tx.execute("INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)", params![track_id, tag_id])?;
                }

                // Incremental FTS: refresh this row (delete + re-insert), mirroring
                // the full rebuild's columns + strip_diacritics + enabled gate.
                tx.execute("DELETE FROM tracks_fts WHERE rowid = ?1", params![track_id])?;
                if enabled {
                    let tag_names = item.tags.join(" ");
                    tx.execute(
                        "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, path)
                         VALUES (?1, strip_diacritics(?2), strip_diacritics(?3), strip_diacritics(?4), strip_diacritics(?5), strip_diacritics(?6))",
                        params![
                            track_id,
                            item.title,
                            item.artist.clone().unwrap_or_default(),
                            item.album.clone().unwrap_or_default(),
                            tag_names,
                            item.url
                        ],
                    )?;
                }

                if done % 50 == 0 || done == total { progress_callback(done, total); }
            }
        }

        // Prune tracks no longer in the manifest. A successful full JSON parse is a
        // complete snapshot, so the seen/not-seen diff is trustworthy.
        let removed_ids: Vec<i64> = existing
            .iter()
            .filter(|(p, _)| !seen.contains(p.as_str()))
            .map(|(_, id)| *id)
            .collect();
        for id in &removed_ids {
            tx.execute("DELETE FROM tracks_fts WHERE rowid = ?1", params![id])?;
            tx.execute("DELETE FROM tracks WHERE id = ?1", params![id])?; // track_tags cascade via FK
        }

        tx.commit()?;
        Ok(ManifestIngestStats { removed: removed_ids.len() as u64 })
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
        artist_name: FieldUpdate<&str>,
        album_title: FieldUpdate<&str>,
        year: FieldUpdate<i32>,
        title: Option<&str>,
        track_number: FieldUpdate<i32>,
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
                // Step 1: Artist. Set artist_id to a (found/created) artist, or
                // clear it to NULL. `ArtistOutcome::Assigned(target)` records what
                // every track's artist became (`None` = cleared); `Unchanged` means
                // the field was not touched at all.
                #[derive(Clone, Copy)]
                enum ArtistOutcome { Unchanged, Assigned(Option<i64>) }
                let artist_outcome = match artist_name {
                    FieldUpdate::Unchanged => ArtistOutcome::Unchanged,
                    FieldUpdate::Clear => {
                        update_track_column(&conn, track_ids, "artist_id", None::<i64>)?;
                        ArtistOutcome::Assigned(None)
                    }
                    FieldUpdate::Set(name) => {
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
                        update_track_column(&conn, track_ids, "artist_id", aid)?;
                        ArtistOutcome::Assigned(Some(aid))
                    }
                };

                // Step 1b: When the artist changed (set or cleared) but the album
                // title was NOT touched, move each track's album to one under the
                // new artist target (find or create). `target_aid` may be NULL.
                if let ArtistOutcome::Assigned(target_aid) = artist_outcome {
                    if matches!(album_title, FieldUpdate::Unchanged) {
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
                                     AND (artist_id = ?2 OR (?2 IS NULL AND artist_id IS NULL))",
                                    params![title, target_aid],
                                    |row| row.get(0),
                                ).optional()?;
                                let id = match existing {
                                    Some(id) => id,
                                    None => {
                                        conn.execute(
                                            "INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)",
                                            params![title, target_aid, album_year],
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
                }

                // Step 2: Album. Set to a (found/created) album, or clear to NULL.
                // The album-creation year follows the `year` field: Set → that
                // year, Clear → none, Unchanged → inherit the track's old album year.
                match album_title {
                    FieldUpdate::Unchanged => {}
                    FieldUpdate::Clear => {
                        update_track_column(&conn, track_ids, "album_id", None::<i64>)?;
                    }
                    FieldUpdate::Set(title) => match artist_outcome {
                        ArtistOutcome::Assigned(target_aid) => {
                            // All tracks now share `target_aid` (possibly NULL) — one album.
                            let album_year = match year {
                                FieldUpdate::Set(y) => Some(y),
                                FieldUpdate::Clear => None,
                                FieldUpdate::Unchanged => conn.query_row(
                                    "SELECT al.year FROM tracks t JOIN albums al ON t.album_id = al.id WHERE t.id = ?1 AND al.year IS NOT NULL",
                                    params![track_ids[0]],
                                    |row| row.get(0),
                                ).optional().ok().flatten(),
                            };
                            let existing_album: Option<i64> = conn.query_row(
                                "SELECT id FROM albums WHERE strip_diacritics(unicode_lower(title)) = strip_diacritics(unicode_lower(?1)) \
                                 AND (artist_id = ?2 OR (?2 IS NULL AND artist_id IS NULL))",
                                params![title, target_aid],
                                |row| row.get(0),
                            ).optional()?;
                            let album_id = match existing_album {
                                Some(id) => id,
                                None => {
                                    conn.execute(
                                        "INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)",
                                        params![title, target_aid, album_year],
                                    )?;
                                    conn.last_insert_rowid()
                                }
                            };
                            update_track_column(&conn, track_ids, "album_id", album_id)?;
                        }
                        ArtistOutcome::Unchanged => {
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
                                let album_year = match year {
                                    FieldUpdate::Set(y) => Some(y),
                                    FieldUpdate::Clear => None,
                                    FieldUpdate::Unchanged => conn.query_row(
                                        "SELECT al.year FROM tracks t JOIN albums al ON t.album_id = al.id WHERE t.id = ?1 AND al.year IS NOT NULL",
                                        params![tids[0]],
                                        |row| row.get(0),
                                    ).optional().ok().flatten(),
                                };
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
                                update_track_column(&conn, tids, "album_id", album_id)?;
                            }
                        }
                    },
                }

                // Step 3: Year (on the track row)
                match year {
                    FieldUpdate::Unchanged => {}
                    FieldUpdate::Clear => update_track_column(&conn, track_ids, "year", None::<i32>)?,
                    FieldUpdate::Set(y) => update_track_column(&conn, track_ids, "year", y)?,
                }

                // Step 3b: Title (single-value, applied to all given ids). Title is
                // never cleared — a track always needs one.
                if let Some(t) = title {
                    update_track_column(&conn, track_ids, "title", t)?;
                }

                // Step 3c: Track number
                match track_number {
                    FieldUpdate::Unchanged => {}
                    FieldUpdate::Clear => update_track_column(&conn, track_ids, "track_number", None::<i32>)?,
                    FieldUpdate::Set(n) => update_track_column(&conn, track_ids, "track_number", n)?,
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
