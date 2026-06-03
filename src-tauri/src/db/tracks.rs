// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

impl Database {

    // --- Tracks ---

    pub fn get_track_count(&self) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT COUNT(*) FROM tracks t WHERE 1=1 {}", ENABLED_COLLECTION_FILTER_STANDALONE),
            [],
            |row| row.get(0),
        )
    }

    pub fn get_track_count_for_collection(&self, collection_id: i64) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM tracks WHERE collection_id = ?1",
            params![collection_id],
            |row| row.get(0),
        )
    }

    pub fn upsert_track(
        &self,
        path: &str,
        title: &str,
        artist_id: Option<i64>,
        album_id: Option<i64>,
        track_number: Option<i32>,
        duration_secs: Option<f64>,
        format: Option<&str>,
        file_size: Option<i64>,
        modified_at: Option<i64>,
        collection_id: Option<i64>,
        year: Option<i32>,
    ) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tracks (path, title, artist_id, album_id, track_number, duration_secs, format, file_size, modified_at, collection_id, year)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(collection_id, path) DO UPDATE SET
                title=excluded.title, artist_id=excluded.artist_id, album_id=excluded.album_id,
                track_number=excluded.track_number,
                duration_secs=excluded.duration_secs, format=excluded.format,
                file_size=excluded.file_size, modified_at=excluded.modified_at,
                year=excluded.year",
            params![path, title, artist_id, album_id, track_number, duration_secs, format, file_size, modified_at, collection_id, year],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM tracks WHERE collection_id IS ?1 AND path = ?2",
            params![collection_id, path],
            |row| row.get(0),
        )?;
        Ok(id)
    }


    #[cfg(any(debug_assertions, test))]
    pub fn clear_database(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM track_tags;
             DELETE FROM tracks;
             DELETE FROM albums;
             DELETE FROM artists;
             DELETE FROM tags;
             DELETE FROM history_plays;
             DELETE FROM history_tracks;
             DELETE FROM history_artists;
             DELETE FROM collections;
             DROP TABLE IF EXISTS tracks_fts;
             CREATE VIRTUAL TABLE tracks_fts USING fts5(
                 title,
                 artist_name,
                 album_title,
                 tag_names,
                 content='',
                 contentless_delete=1,
                 tokenize='unicode61 remove_diacritics 2'
             );"
        )?;
        Ok(())
    }

    /// Refresh the FTS row for a single track without rebuilding the entire
    /// `tracks_fts` table. Cheap to call after per-track edits (tag changes,
    /// metadata updates).
    pub fn update_fts_for_track(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        Self::update_fts_for_track_inner(&conn, track_id)
    }

    fn update_fts_for_track_inner(conn: &Connection, track_id: i64) -> SqlResult<()> {
        conn.execute("DELETE FROM tracks_fts WHERE rowid = ?1", params![track_id])?;
        conn.execute(
            "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, path)
             SELECT t.id,
                    strip_diacritics(t.title),
                    strip_diacritics(COALESCE(ar.name, '')),
                    strip_diacritics(COALESCE(al.title, '')),
                    strip_diacritics(COALESCE((SELECT GROUP_CONCAT(tg.name, ' ') FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.track_id = t.id), '')),
                    strip_diacritics(COALESCE(t.path, ''))
             FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
             WHERE t.id = ?1",
            params![track_id],
        )?;
        Ok(())
    }

    /// Apply tag names to many tracks in a single locked transaction.
    /// Creates tags as needed (case/diacritic-insensitive match), inserts
    /// `track_tags` rows with `INSERT OR IGNORE`, and updates the FTS row for
    /// each touched track. One lock acquisition for the entire batch.
    pub fn apply_tags_bulk(&self, assignments: &[(i64, Vec<String>)]) -> SqlResult<()> {
        if assignments.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for (track_id, tag_names) in assignments {
            for name in tag_names {
                let tag_id: i64 = match tx.query_row(
                    "SELECT id FROM tags WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1))",
                    params![name],
                    |row| row.get(0),
                ).optional()? {
                    Some(id) => id,
                    None => {
                        tx.execute("INSERT INTO tags (name) VALUES (?1)", params![name])?;
                        tx.last_insert_rowid()
                    }
                };
                tx.execute(
                    "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)",
                    params![track_id, tag_id],
                )?;
            }
            Self::update_fts_for_track_inner(&tx, *track_id)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn rebuild_fts(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DROP TABLE IF EXISTS tracks_fts;
             CREATE VIRTUAL TABLE tracks_fts USING fts5(
                 title,
                 artist_name,
                 album_title,
                 tag_names,
                 path,
                 content='',
                 contentless_delete=1,
                 tokenize='unicode61 remove_diacritics 2'
             );"
        )?;
        conn.execute_batch(
            &format!(
                "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, path)
                 SELECT t.id, strip_diacritics(t.title), strip_diacritics(COALESCE(ar.name, '')), strip_diacritics(COALESCE(al.title, '')),
                        strip_diacritics(COALESCE((SELECT GROUP_CONCAT(tg.name, ' ') FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.track_id = t.id), '')),
                        strip_diacritics(COALESCE(t.path, ''))
                 FROM tracks t
                 LEFT JOIN artists ar ON t.artist_id = ar.id
                 LEFT JOIN albums al ON t.album_id = al.id
                 WHERE 1=1 {};",
                ENABLED_COLLECTION_FILTER_STANDALONE
            ),
        )?;
        Ok(())
    }

    pub fn recompute_counts(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        // Clean up orphaned entities before recomputing counts
        conn.execute_batch(
            "DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL);
             DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL)
                                   AND id NOT IN (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL);
             DELETE FROM track_tags WHERE tag_id NOT IN (SELECT id FROM tags);
             DELETE FROM track_tags WHERE track_id NOT IN (SELECT id FROM tracks);
             DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM track_tags);"
        )?;
        conn.execute_batch(
            &format!(
                "UPDATE artists SET track_count = (
                   SELECT COUNT(*) FROM tracks t
                   WHERE t.artist_id = artists.id {cf}
                 );
                 UPDATE albums SET track_count = (
                   SELECT COUNT(*) FROM tracks t
                   WHERE t.album_id = albums.id {cf}
                 );
                 UPDATE tags SET track_count = (
                   SELECT COUNT(*) FROM track_tags tt
                   JOIN tracks t ON t.id = tt.track_id
                   WHERE tt.tag_id = tags.id {cf}
                 );",
                cf = ENABLED_COLLECTION_FILTER_STANDALONE
            )
        )
    }

    pub fn get_tracks(&self, opts: &TrackQuery) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();

        // If query is present and non-empty, use FTS path
        if let Some(ref query) = opts.query {
            if !query.trim().is_empty() {
                return self.search_tracks_inner(&conn, opts, query);
            }
        }

        // Album-scoped: return all tracks for album, ordered by track_number
        if let Some(aid) = opts.album_id {
            let sql = format!("{} WHERE t.album_id = ?1 {} ORDER BY t.track_number, t.title", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![aid], |row| track_from_row(row))?;
            return rows.collect();
        }

        // Artist-scoped: return all tracks for artist, ordered by album then track_number
        if let Some(aid) = opts.artist_id {
            let sql = format!("{} WHERE t.artist_id = ?1 {} ORDER BY al.title, t.track_number, t.title", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![aid], |row| track_from_row(row))?;
            return rows.collect();
        }

        // Tag-scoped: return all tracks with tag, ordered by artist/album/track
        if let Some(tid) = opts.tag_id {
            let sql = format!(
                "{} JOIN track_tags tt ON tt.track_id = t.id WHERE tt.tag_id = ?1 {} ORDER BY ar.name, al.title, t.track_number, t.title",
                TRACK_SELECT, ENABLED_COLLECTION_FILTER
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![tid], |row| track_from_row(row))?;
            return rows.collect();
        }

        // Default paginated path
        let order_by = if let Some(col) = sort_column_sql(opts.sort_field.as_deref()) {
            let dir = match opts.sort_dir.as_deref() {
                Some("desc") => "DESC",
                _ => "ASC",
            };
            format!("ORDER BY {} {}, t.id", col, dir)
        } else {
            "ORDER BY ar.name, al.title, t.track_number, t.title, t.id".to_string()
        };

        let youtube_filter = if opts.has_youtube_url { "AND t.youtube_url IS NOT NULL AND t.youtube_url != ''" } else { "" };
        let media_type_filter = match opts.media_type.as_deref() {
            Some("audio") => "AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))",
            Some("video") => "AND LOWER(t.format) IN ('mp4','m4v','mov','webm')",
            _ => "",
        };
        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);
        let sql = format!("{} WHERE 1=1 {} {} {} {} LIMIT ?1 OFFSET ?2", TRACK_SELECT, ENABLED_COLLECTION_FILTER, youtube_filter, media_type_filter, order_by);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit, offset], |row| track_from_row(row))?;
        rows.collect()
    }

    pub fn get_tracks_by_artist(&self, artist_id: i64) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE t.artist_id = ?1 {} ORDER BY al.title, t.track_number, t.title", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![artist_id], |row| track_from_row(row))?;
        rows.collect()
    }

    pub fn get_track_by_id(&self, track_id: i64) -> SqlResult<Track> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE t.id = ?1", TRACK_SELECT);
        conn.query_row(&sql, params![track_id], |row| track_from_row(row))
    }

    /// Find a track by metadata (title, artist, album) with diacritic-insensitive matching.
    /// Matching cascade: title+artist+album → title+artist → title only.
    /// When multiple matches exist, prefers local > subsonic > other.
    pub fn find_track_by_metadata(
        &self,
        title: &str,
        artist_name: Option<&str>,
        album_name: Option<&str>,
    ) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();

        // Source preference: local files first, then subsonic, then other sources (by path prefix)
        let order_clause = "ORDER BY CASE \
            WHEN co.kind = 'local' THEN 0 \
            WHEN co.kind = 'subsonic' THEN 1 \
            ELSE 2 \
        END LIMIT 1";

        let enabled_filter = ENABLED_COLLECTION_FILTER;

        if let Some(artist) = artist_name {
            // Try title + artist + album first
            if let Some(album) = album_name {
                let sql = format!(
                    "{} WHERE strip_diacritics(unicode_lower(t.title)) = strip_diacritics(unicode_lower(?1)) \
                     AND ar.name IS NOT NULL AND strip_diacritics(unicode_lower(ar.name)) = strip_diacritics(unicode_lower(?2)) \
                     AND al.title IS NOT NULL AND strip_diacritics(unicode_lower(al.title)) = strip_diacritics(unicode_lower(?3)) \
                     {} {}",
                    TRACK_SELECT, enabled_filter, order_clause
                );
                let result: Option<Track> = conn
                    .query_row(&sql, params![title, artist, album], |row| track_from_row(row))
                    .optional()?;
                if result.is_some() {
                    return Ok(result);
                }
            }

            // Fall back to title + artist
            let sql = format!(
                "{} WHERE strip_diacritics(unicode_lower(t.title)) = strip_diacritics(unicode_lower(?1)) \
                 AND ar.name IS NOT NULL AND strip_diacritics(unicode_lower(ar.name)) = strip_diacritics(unicode_lower(?2)) \
                 {} {}",
                TRACK_SELECT, enabled_filter, order_clause
            );
            let result: Option<Track> = conn
                .query_row(&sql, params![title, artist], |row| track_from_row(row))
                .optional()?;
            if result.is_some() {
                return Ok(result);
            }
        }

        // Last resort: title only
        let sql = format!(
            "{} WHERE strip_diacritics(unicode_lower(t.title)) = strip_diacritics(unicode_lower(?1)) \
             {} {}",
            TRACK_SELECT, enabled_filter, order_clause
        );
        conn.query_row(&sql, params![title], |row| track_from_row(row))
            .optional()
    }

    pub fn find_track_id_by_path(&self, full_path: &str) -> SqlResult<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        let sql = "SELECT t.id FROM tracks t \
            LEFT JOIN collections co ON t.collection_id = co.id \
            WHERE CASE \
              WHEN co.kind = 'local' AND co.path IS NOT NULL \
                THEN 'file://' || co.path || '/' || t.path \
              WHEN co.kind = 'subsonic' AND co.url IS NOT NULL \
                THEN 'subsonic://' || REPLACE(REPLACE(RTRIM(co.url, '/'), 'https://', ''), 'http://', '') || '/' || t.path \
              ELSE t.path \
            END = ?1 \
            AND (t.collection_id IS NULL OR co.enabled = 1) \
            LIMIT 1";
        conn.query_row(sql, params![full_path], |row| row.get(0)).optional()
    }

    /// Returns the stored source format (file suffix, e.g. "mp3"/"flac") for a
    /// remote track identified by its collection and remote id (`t.path`).
    /// `None` if the track isn't found or has no recorded format.
    pub fn get_track_format_by_remote(
        &self,
        collection_id: i64,
        remote_track_id: &str,
    ) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT format FROM tracks WHERE collection_id = ?1 AND path = ?2 LIMIT 1",
            params![collection_id, remote_track_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|opt| opt.flatten())
    }

    pub(super) fn search_tracks_inner(&self, conn: &rusqlite::Connection, opts: &TrackQuery, query: &str) -> SqlResult<Vec<Track>> {
        let normalized = strip_diacritics(query);
        let words = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect::<Vec<_>>();

        if words.is_empty() {
            return Ok(vec![]);
        }

        let fts_query = format!("{{title artist_name album_title tag_names path}}:{}", words.join(" AND "));

        let mut sql = TRACK_SELECT.to_string();
        sql.push_str(" JOIN tracks_fts ON tracks_fts.rowid = t.id");

        if opts.tag_id.is_some() {
            sql.push_str(" JOIN track_tags tt ON tt.track_id = t.id");
        }

        sql.push_str(" WHERE tracks_fts MATCH ?1");
        let mut param_idx = 2;
        sql.push_str(&format!(" {}", ENABLED_COLLECTION_FILTER));

        if opts.artist_id.is_some() {
            sql.push_str(&format!(" AND t.artist_id = ?{}", param_idx));
            param_idx += 1;
        }
        if opts.album_id.is_some() {
            sql.push_str(&format!(" AND t.album_id = ?{}", param_idx));
            param_idx += 1;
        }
        if opts.tag_id.is_some() {
            sql.push_str(&format!(" AND tt.tag_id = ?{}", param_idx));
            param_idx += 1;
        }
        if opts.liked_only {
            sql.push_str(" AND t.liked = 1");
        }
        if opts.has_youtube_url {
            sql.push_str(" AND t.youtube_url IS NOT NULL AND t.youtube_url != ''");
        }
        match opts.media_type.as_deref() {
            Some("audio") => sql.push_str(" AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))"),
            Some("video") => sql.push_str(" AND LOWER(t.format) IN ('mp4','m4v','mov','webm')"),
            _ => {}
        }

        let liked_fallback = opts.liked_only && opts.sort_chain.as_ref().map_or(true, |c| c.is_empty());
        let order = build_order_by(
            &opts.sort_chain, opts.sort_field.as_deref(), opts.sort_dir.as_deref(),
            liked_fallback, "t.liked", ", t.id",
            |f| sort_column_sql(Some(f)),
            "t.id",
        );
        sql.push_str(&format!(" {}", order));

        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);
        sql.push_str(&format!(" LIMIT ?{} OFFSET ?{}", param_idx, param_idx + 1));

        let mut stmt = conn.prepare(&sql)?;

        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        params_vec.push(Box::new(fts_query));
        if let Some(aid) = opts.artist_id {
            params_vec.push(Box::new(aid));
        }
        if let Some(alid) = opts.album_id {
            params_vec.push(Box::new(alid));
        }
        if let Some(tid) = opts.tag_id {
            params_vec.push(Box::new(tid));
        }
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| track_from_row(row))?;
        rows.collect()
    }

    pub fn get_tracks_by_ids(&self, ids: &[i64]) -> SqlResult<Vec<Track>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("{} WHERE t.id IN ({})", TRACK_SELECT, placeholders);
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
        let rows = stmt.query_map(params.as_slice(), |row| track_from_row(row))?;
        let track_map: std::collections::HashMap<i64, Track> = rows.filter_map(|r| r.ok()).map(|t| (t.id, t)).collect();
        // Return in input order, skipping missing ids
        Ok(ids.iter().filter_map(|id| track_map.get(id).cloned()).collect())
    }

    /// Looks up tracks by full URI (e.g. file:///music/song.mp3).
    /// Uses the path reconstruction expression to match against the stored relative paths.
    pub fn get_tracks_by_paths(&self, uris: &[String]) -> SqlResult<Vec<Track>> {
        if uris.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = uris.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        // Filter on the reconstructed full URI (same CASE expression as TRACK_SELECT)
        let sql = format!(
            "{} WHERE {} IN ({})",
            TRACK_SELECT, PATH_EXPR, placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> = uris.iter().map(|p| p as &dyn rusqlite::types::ToSql).collect();
        let rows = stmt.query_map(params.as_slice(), |row| track_from_row(row))?;
        let track_map: std::collections::HashMap<String, Track> = rows.filter_map(|r| r.ok()).map(|t| (t.path.clone(), t)).collect();
        // Return in input order, skipping missing paths
        Ok(uris.iter().filter_map(|p| track_map.get(p).cloned()).collect())
    }

    pub fn get_track_modified_at_by_path(&self, path: &str, collection_id: Option<i64>) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT modified_at FROM tracks WHERE path = ?1 AND collection_id IS ?2",
            params![path, collection_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn get_local_track_paths_for_collection(&self, collection_id: i64) -> SqlResult<Vec<String>> {
        self.get_track_paths_for_collection(collection_id)
    }

    pub fn remove_track_by_id(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tracks WHERE id = ?1", params![track_id])?;
        Ok(())
    }

    // --- Liked tracks ---

    pub fn set_track_youtube_url(&self, track_id: i64, url: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET youtube_url = ?2 WHERE id = ?1",
            params![track_id, url],
        )?;
        Ok(())
    }

    pub fn clear_track_youtube_url(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET youtube_url = NULL WHERE id = ?1",
            params![track_id],
        )?;
        Ok(())
    }

    pub fn toggle_liked(&self, table: &str, id: i64, liked: i32) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            &format!("UPDATE {} SET liked = ?2 WHERE id = ?1", table),
            params![id, liked],
        )?;
        Ok(())
    }

    pub fn get_liked_tracks(&self) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE t.liked = 1 {} ORDER BY ar.name, al.title, t.track_number, t.title", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| track_from_row(row))?;
        rows.collect()
    }

    // --- Image helpers ---

    /// Returns the full filesystem path for a local track in the given album.
    /// Used for extracting embedded cover art.
    pub fn get_track_path_for_album(
        &self,
        album_title: &str,
        artist_name: Option<&str>,
    ) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match artist_name {
            Some(artist) => conn.query_row(
                "SELECT co.path || '/' || t.path FROM tracks t \
                 JOIN albums a ON t.album_id = a.id \
                 LEFT JOIN artists ar ON t.artist_id = ar.id \
                 LEFT JOIN collections co ON t.collection_id = co.id \
                 WHERE a.title = ?1 AND ar.name = ?2 AND co.kind = 'local' LIMIT 1",
                params![album_title, artist],
                |row| row.get(0),
            ),
            None => conn.query_row(
                "SELECT co.path || '/' || t.path FROM tracks t \
                 JOIN albums a ON t.album_id = a.id \
                 LEFT JOIN collections co ON t.collection_id = co.id \
                 WHERE a.title = ?1 AND co.kind = 'local' LIMIT 1",
                params![album_title],
                |row| row.get(0),
            ),
        }
        .optional()
    }
}
