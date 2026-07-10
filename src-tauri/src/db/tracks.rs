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

    /// Store the JSON catch-all of file tags that have no dedicated column
    /// (ReplayGain values among them). Called by the scanner / sync after upsert.
    /// `json` is a serialized JSON object, or None to clear it.
    pub fn set_track_extra_tags(&self, track_id: i64, json: Option<&str>) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET extra_tags = ?1 WHERE id = ?2",
            params![json, track_id],
        )?;
        Ok(())
    }

    /// Read ReplayGain values for a track by its full scheme-prefixed path
    /// (`file://…`, `subsonic://…`), parsed from the `extra_tags` JSON. Matches the
    /// same computed-path expression as `find_track_id_by_path` (the stored
    /// `t.path` is relative for local / a remote id, not the full URI). Returns
    /// None when no row matches, the row has no `extra_tags`, or it carries no RG.
    pub fn get_replaygain_by_path(&self, full_path: &str) -> SqlResult<Option<crate::models::ReplayGain>> {
        let conn = self.conn.lock().unwrap();
        let sql = "SELECT t.extra_tags FROM tracks t \
            LEFT JOIN collections co ON t.collection_id = co.id \
            WHERE CASE \
              WHEN co.kind = 'local' AND co.path IS NOT NULL \
                THEN 'file://' || co.path || '/' || t.path \
              WHEN co.kind = 'subsonic' AND co.url IS NOT NULL \
                THEN 'subsonic://' || REPLACE(REPLACE(RTRIM(co.url, '/'), 'https://', ''), 'http://', '') || '/' || t.path \
              ELSE t.path \
            END = ?1 \
            AND t.extra_tags IS NOT NULL \
            AND (t.collection_id IS NULL OR co.enabled = 1) \
            LIMIT 1";
        let json: Option<String> = conn
            .query_row(sql, params![full_path], |row| row.get(0))
            .optional()?;
        Ok(json.and_then(|j| crate::models::ReplayGain::from_extra_tags_json(&j)))
    }

    /// Raw `extra_tags` JSON string for a library track by id (the catch-all of
    /// file/Subsonic tag keys with no dedicated column). None if the track has none.
    pub fn get_extra_tags(&self, track_id: i64) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT extra_tags FROM tracks WHERE id = ?1",
            params![track_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|opt| opt.flatten())
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

    pub(super) fn update_fts_for_track_inner(conn: &Connection, track_id: i64) -> SqlResult<()> {
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

        let media_type_filter = match opts.media_type.as_deref() {
            Some("audio") => "AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))",
            Some("video") => "AND LOWER(t.format) IN ('mp4','m4v','mov','webm')",
            _ => "",
        };
        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);
        let sql = format!("{} WHERE 1=1 {} {} {} LIMIT ?1 OFFSET ?2", TRACK_SELECT, ENABLED_COLLECTION_FILTER, media_type_filter, order_by);
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

        let sql = fts_search_sql(opts);
        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);

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

    /// (modified_at, whether `extra_tags` has been populated) for a track by path,
    /// in one query — backs the scanner's incremental mtime skip *and* the
    /// extra_tags backfill (re-read audio rows whose `extra_tags` is still NULL).
    pub fn get_track_scan_state_by_path(&self, path: &str, collection_id: Option<i64>) -> Option<(Option<i64>, bool)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT modified_at, extra_tags IS NOT NULL FROM tracks WHERE path = ?1 AND collection_id IS ?2",
            params![path, collection_id],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, bool>(1)?)),
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

    /// Group tracks that look like the same song into duplicate sets.
    ///
    /// Tracks are first bucketed by a diacritic-insensitive normalized
    /// `title` + `artist` key — computed with the same registered
    /// `strip_diacritics(unicode_lower(...))` SQL functions the rest of the
    /// metadata-matching code uses (so "Björk" and "Bjork" land together).
    /// Each bucket is then optionally subdivided so that copies only count as
    /// duplicates when their duration and/or file size also agree within the
    /// given tolerance (a track with a missing value is treated leniently — it
    /// never forces a split). Buckets with fewer than two surviving copies are
    /// dropped.
    ///
    /// Each returned inner `Vec` is one duplicate set (length >= 2), ordered
    /// with the recommended keeper (highest quality copy) first so callers can
    /// offer a "keep best, delete the rest" action without re-deriving it.
    pub fn find_duplicate_groups(
        &self,
        match_duration: bool,
        duration_tolerance_secs: f64,
        match_size: bool,
        size_tolerance_pct: f64,
        local_only: bool,
    ) -> SqlResult<Vec<Vec<Track>>> {
        let conn = self.conn.lock().unwrap();

        // Pull every candidate track ordered by its diacritic-normalized
        // (title, artist) key so same-song copies are adjacent and can be
        // bucketed in a single linear pass. The Rust key below
        // (`duplicate_norm_key`) reproduces this exact ORDER BY because both
        // call the same `strip_diacritics` Rust fn and `unicode_lower` is just
        // `to_lowercase`, so adjacency and bucketing always agree.
        let local_filter = if local_only { "AND co.kind = 'local'" } else { "" };
        let sql = format!(
            "{select} WHERE TRIM(t.title) != '' {enabled} {local} \
             ORDER BY strip_diacritics(unicode_lower(TRIM(t.title))), \
                      strip_diacritics(unicode_lower(TRIM(COALESCE(ar.name, '')))), t.id",
            select = TRACK_SELECT,
            enabled = ENABLED_COLLECTION_FILTER,
            local = local_filter,
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            let track = track_from_row(row)?;
            let key = duplicate_norm_key(&track);
            Ok((key, track))
        })?;

        let mut buckets: Vec<Vec<Track>> = Vec::new();
        let mut cur_key: Option<String> = None;
        let mut cur: Vec<Track> = Vec::new();
        for row in rows {
            let (key, track) = row?;
            if cur_key.as_deref() == Some(key.as_str()) {
                cur.push(track);
            } else {
                if cur.len() >= 2 {
                    buckets.push(std::mem::take(&mut cur));
                } else {
                    cur.clear();
                }
                cur_key = Some(key);
                cur.push(track);
            }
        }
        if cur.len() >= 2 {
            buckets.push(cur);
        }

        let mut groups: Vec<Vec<Track>> = Vec::new();
        for bucket in buckets {
            for mut group in subdivide_duplicate_bucket(
                bucket,
                match_duration,
                duration_tolerance_secs,
                match_size,
                size_tolerance_pct,
            ) {
                if group.len() < 2 {
                    continue;
                }
                // Keeper-first: best quality copy at index 0.
                group.sort_by(|a, b| duplicate_quality_key(b).cmp(&duplicate_quality_key(a)));
                groups.push(group);
            }
        }
        // Most copies first — the worst offenders surface at the top.
        groups.sort_by(|a, b| b.len().cmp(&a.len()));
        Ok(groups)
    }
}

/// Diacritic-insensitive `(title, artist)` bucket key. Matches the SQL
/// `strip_diacritics(unicode_lower(TRIM(...)))` ordering used by
/// `find_duplicate_groups` exactly: both call the same `strip_diacritics` Rust
/// fn and `unicode_lower` is `to_lowercase`, so a Rust key and the SQL sort key
/// can never disagree on which rows are adjacent.
fn duplicate_norm_key(t: &Track) -> String {
    let title = strip_diacritics(&t.title.trim().to_lowercase());
    let artist = strip_diacritics(&t.artist_name.as_deref().unwrap_or("").trim().to_lowercase());
    format!("{title}\u{1f}{artist}")
}

/// Within a single title+artist bucket, split copies into clusters that also
/// agree on duration and/or file size (greedy: a copy joins the first cluster
/// whose representative it matches, else starts its own). When neither extra
/// dimension is requested the whole bucket stays one cluster.
fn subdivide_duplicate_bucket(
    bucket: Vec<Track>,
    match_duration: bool,
    duration_tolerance_secs: f64,
    match_size: bool,
    size_tolerance_pct: f64,
) -> Vec<Vec<Track>> {
    if !match_duration && !match_size {
        return vec![bucket];
    }
    let mut clusters: Vec<Vec<Track>> = Vec::new();
    'next: for track in bucket {
        for cluster in clusters.iter_mut() {
            if duplicate_tracks_similar(
                &cluster[0],
                &track,
                match_duration,
                duration_tolerance_secs,
                match_size,
                size_tolerance_pct,
            ) {
                cluster.push(track);
                continue 'next;
            }
        }
        clusters.push(vec![track]);
    }
    clusters
}

/// Whether two same-song copies agree closely enough on the requested
/// dimensions. A missing value on either side passes that dimension (lenient,
/// so sparse metadata never over-splits a real duplicate).
fn duplicate_tracks_similar(
    a: &Track,
    b: &Track,
    match_duration: bool,
    duration_tolerance_secs: f64,
    match_size: bool,
    size_tolerance_pct: f64,
) -> bool {
    if match_duration {
        if let (Some(da), Some(db)) = (a.duration_secs, b.duration_secs) {
            if (da - db).abs() > duration_tolerance_secs {
                return false;
            }
        }
    }
    if match_size {
        if let (Some(sa), Some(sb)) = (a.file_size, b.file_size) {
            let max = sa.max(sb).max(1) as f64;
            if ((sa - sb).abs() as f64) / max > size_tolerance_pct {
                return false;
            }
        }
    }
    true
}

/// Comparable quality ranking for a copy, highest = best keeper. Prefers a
/// local file over a remote one, lossless over lossy, higher bitrate, larger
/// file, a liked copy, and finally the lower (older) id as a stable tiebreak.
fn duplicate_quality_key(t: &Track) -> (i32, i32, i64, i64, i32, std::cmp::Reverse<i64>) {
    let local = if t.path.starts_with("file://") { 1 } else { 0 };
    let lossless = match t.format.as_deref() {
        Some(f) if matches!(
            f.to_ascii_lowercase().as_str(),
            "flac" | "wav" | "alac" | "aiff" | "aif" | "ape" | "wv"
        ) => 1,
        _ => 0,
    };
    let bitrate = match (t.file_size, t.duration_secs) {
        (Some(sz), Some(d)) if d > 0.0 => ((sz as f64) * 8.0 / d / 1000.0) as i64,
        _ => 0,
    };
    let size = t.file_size.unwrap_or(0);
    let liked = if t.liked > 0 { 1 } else { 0 };
    (local, lossless, bitrate, size, liked, std::cmp::Reverse(t.id))
}

/// SQL for the FTS track search: `?1` is the MATCH expression, followed by
/// one placeholder per set entity filter, then LIMIT/OFFSET. Split from
/// `search_tracks_inner` so tests can run EXPLAIN QUERY PLAN on the exact
/// statement it executes.
fn fts_search_sql(opts: &TrackQuery) -> String {
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
    match opts.media_type.as_deref() {
        Some("audio") => sql.push_str(" AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))"),
        Some("video") => sql.push_str(" AND LOWER(t.format) IN ('mp4','m4v','mov','webm')"),
        _ => {}
    }

    // With no explicit sort, order by tracks_fts.rowid (== t.id via the join,
    // so the output order is unchanged): FTS5 satisfies it with an ordered
    // scan, letting SQLite stream matches and stop at LIMIT. Anything the
    // planner can't map onto that scan — build_order_by's `t.id, t.id`
    // fallback, or even a `, t.id` tiebreaker after the rowid — forces every
    // match through the joins into a temp-B-tree sorter first.
    let has_chain_sort = opts.sort_chain.as_ref()
        .map_or(false, |c| c.iter().any(|k| sort_column_sql(Some(&k.field)).is_some()));
    let has_legacy_sort = sort_column_sql(opts.sort_field.as_deref()).is_some();
    if !has_chain_sort && !has_legacy_sort && !opts.liked_only {
        sql.push_str(" ORDER BY tracks_fts.rowid");
    } else {
        let liked_fallback = opts.liked_only && opts.sort_chain.as_ref().map_or(true, |c| c.is_empty());
        let order = build_order_by(
            &opts.sort_chain, opts.sort_field.as_deref(), opts.sort_dir.as_deref(),
            liked_fallback, "t.liked", ", t.id",
            |f| sort_column_sql(Some(f)),
            "t.id",
        );
        sql.push_str(&format!(" {}", order));
    }

    sql.push_str(&format!(" LIMIT ?{} OFFSET ?{}", param_idx, param_idx + 1));
    sql
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_details(sql: &str) -> Vec<String> {
        let db = Database::new_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        // Placeholder values don't influence the plan, but rusqlite insists
        // they're bound — NULL for all of them.
        let nulls = vec![rusqlite::types::Value::Null; stmt.parameter_count()];
        let refs: Vec<&dyn rusqlite::types::ToSql> =
            nulls.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
        let rows = stmt.query_map(refs.as_slice(), |r| r.get::<_, String>(3)).unwrap();
        rows.collect::<SqlResult<Vec<_>>>().unwrap()
    }

    #[test]
    fn test_plain_fts_search_streams_without_sorter() {
        // No explicit sort: the plan must contain no sorter, so SQLite streams
        // FTS matches in rowid order and stops at LIMIT instead of
        // materializing every match through the joins into a temp B-tree.
        let sql = fts_search_sql(&TrackQuery {
            query: Some("art".into()),
            ..Default::default()
        });
        let details = plan_details(&sql);
        assert!(
            !details.iter().any(|d| d.contains("TEMP B-TREE")),
            "plain FTS search must stream matches, got plan: {details:?}"
        );
    }

    #[test]
    fn test_sorted_fts_search_plan_check_is_sensitive() {
        // An explicit sort legitimately needs the sorter — this proves the
        // TEMP B-TREE assertion above isn't passing vacuously (e.g. after a
        // change to EXPLAIN QUERY PLAN's wording).
        let sql = fts_search_sql(&TrackQuery {
            query: Some("art".into()),
            sort_field: Some("title".into()),
            ..Default::default()
        });
        let details = plan_details(&sql);
        assert!(
            details.iter().any(|d| d.contains("TEMP B-TREE")),
            "explicit sort should use a sorter, got plan: {details:?}"
        );
    }
}
