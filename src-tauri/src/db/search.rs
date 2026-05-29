// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

impl Database {

    pub fn search_all(&self, query: &str, artist_limit: i64, album_limit: i64, track_limit: i64) -> SqlResult<SearchAllResults> {
        let conn = self.conn.lock().unwrap();

        let normalized = strip_diacritics(query);
        let words: Vec<String> = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect();

        if words.is_empty() {
            return Ok(SearchAllResults { artists: vec![], albums: vec![], tracks: vec![] });
        }

        let fts_terms = words.join(" AND ");

        // --- Artists: use FTS on artist_name to find matching artist IDs ---
        let artists = {
            let fts_query = format!("{{artist_name}}:{}", fts_terms);
            let mut stmt = conn.prepare(
                "SELECT DISTINCT a.id, a.name, a.track_count, a.liked \
                 FROM artists a \
                 WHERE a.track_count > 0 \
                 AND a.id IN ( \
                   SELECT t.artist_id FROM tracks t \
                   JOIN tracks_fts ON tracks_fts.rowid = t.id \
                   WHERE tracks_fts MATCH ?1 AND t.artist_id IS NOT NULL \
                 ) \
                 ORDER BY a.name LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![fts_query, artist_limit], |row| {
                Ok(Artist {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    track_count: row.get(2)?,
                    liked: row.get::<_, i32>(3).unwrap_or(0),
                })
            })?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };

        // --- Albums: use FTS on album_title to find matching album IDs ---
        let albums = {
            let fts_query = format!("{{album_title}}:{}", fts_terms);
            let mut stmt = conn.prepare(
                "SELECT DISTINCT al.id, al.title, al.artist_id, ar.name, al.year, al.track_count, al.liked \
                 FROM albums al \
                 LEFT JOIN artists ar ON al.artist_id = ar.id \
                 WHERE al.track_count > 0 \
                 AND al.id IN ( \
                   SELECT t.album_id FROM tracks t \
                   JOIN tracks_fts ON tracks_fts.rowid = t.id \
                   WHERE tracks_fts MATCH ?1 AND t.album_id IS NOT NULL \
                 ) \
                 ORDER BY al.title LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![fts_query, album_limit], |row| album_from_row(row))?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };

        // --- Tracks (reuse FTS) ---
        let track_opts = TrackQuery {
            limit: Some(track_limit),
            ..Default::default()
        };
        let tracks = self.search_tracks_inner(&conn, &track_opts, query)?;

        Ok(SearchAllResults { artists, albums, tracks })
    }

    pub fn p2p_search_tracks(&self, query: &str, collection_ids: &[i64], limit: usize) -> SqlResult<Vec<Track>> {
        if collection_ids.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let normalized = strip_diacritics(query);
        let words: Vec<String> = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect();
        if words.is_empty() {
            return Ok(vec![]);
        }
        let fts_query = format!("{{title artist_name album_title tag_names}}:{}", words.join(" AND "));
        let placeholders: Vec<String> = collection_ids.iter().enumerate()
            .map(|(i, _)| format!("?{}", i + 3))
            .collect();
        let sql = format!(
            "{} JOIN tracks_fts ON tracks_fts.rowid = t.id \
             WHERE tracks_fts MATCH ?1 AND t.collection_id IN ({}) \
             ORDER BY t.title LIMIT ?2",
            TRACK_SELECT,
            placeholders.join(", ")
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        params.push(Box::new(fts_query));
        params.push(Box::new(limit as i64));
        for id in collection_ids {
            params.push(Box::new(*id));
        }
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| track_from_row(row))?;
        rows.collect()
    }

    fn list_entity(&self, conn: &rusqlite::Connection, entity: &str, opts: &TrackQuery) -> SqlResult<SearchEntityResult> {
        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);
        match entity {
            "tracks" => {
                let mut where_clauses = format!("WHERE 1=1 {}", ENABLED_COLLECTION_FILTER);
                let mut count_clauses = format!("WHERE 1=1 {}", ENABLED_COLLECTION_FILTER_STANDALONE);
                if opts.has_youtube_url {
                    where_clauses.push_str(" AND t.youtube_url IS NOT NULL AND t.youtube_url != ''");
                    count_clauses.push_str(" AND t.youtube_url IS NOT NULL AND t.youtube_url != ''");
                }
                match opts.media_type.as_deref() {
                    Some("audio") => {
                        let f = " AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))";
                        where_clauses.push_str(f);
                        count_clauses.push_str(f);
                    }
                    Some("video") => {
                        let f = " AND LOWER(t.format) IN ('mp4','m4v','mov','webm')";
                        where_clauses.push_str(f);
                        count_clauses.push_str(f);
                    }
                    _ => {}
                }

                let total: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM tracks t {}", count_clauses),
                    [], |row| row.get(0),
                )?;

                let liked_fallback = opts.liked_only && opts.sort_chain.as_ref().map_or(true, |c| c.is_empty());
                let order = build_order_by(
                    &opts.sort_chain, opts.sort_field.as_deref(), opts.sort_dir.as_deref(),
                    liked_fallback, "t.liked", ", t.id",
                    |f| sort_column_sql(Some(f)),
                    "t.title",
                );

                let sql = format!("{} {} {} LIMIT ?1 OFFSET ?2", TRACK_SELECT, where_clauses, order);
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![limit, offset], |row| track_from_row(row))?;
                let tracks = rows.collect::<SqlResult<Vec<_>>>()?;
                Ok(SearchEntityResult { tracks: Some(tracks), albums: None, artists: None, tags: None, total })
            }
            "artists" => {
                let where_clause = "WHERE a.track_count > 0";
                let total: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM artists a {}", where_clause), [], |row| row.get(0),
                )?;
                let liked_fallback = opts.liked_only && opts.sort_chain.as_ref().map_or(true, |c| c.is_empty());
                let order = build_order_by(
                    &opts.sort_chain, opts.sort_field.as_deref(), opts.sort_dir.as_deref(),
                    liked_fallback, "a.liked", "",
                    |f| match f {
                        "name" => Some("a.name".to_string()),
                        "tracks" => Some("a.track_count".to_string()),
                        "liked" => Some("COALESCE(a.liked, 0)".to_string()),
                        "random" => Some("RANDOM()".to_string()),
                        _ => None,
                    },
                    "a.name",
                );
                let sql = format!("SELECT a.id, a.name, a.track_count, a.liked FROM artists a {} {} LIMIT ?1 OFFSET ?2", where_clause, order);
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![limit, offset], |row| {
                    Ok(Artist { id: row.get(0)?, name: row.get(1)?, track_count: row.get(2)?, liked: row.get::<_, i32>(3).unwrap_or(0) })
                })?;
                let artists = rows.collect::<SqlResult<Vec<_>>>()?;
                Ok(SearchEntityResult { tracks: None, albums: None, artists: Some(artists), tags: None, total })
            }
            "albums" => {
                let where_clause = "WHERE a.track_count > 0";
                let total: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM albums a {}", where_clause), [], |row| row.get(0),
                )?;
                let liked_fallback = opts.liked_only && opts.sort_chain.as_ref().map_or(true, |c| c.is_empty());
                let order = build_order_by(
                    &opts.sort_chain, opts.sort_field.as_deref(), opts.sort_dir.as_deref(),
                    liked_fallback, "a.liked", "",
                    |f| match f {
                        "name" => Some("a.title".to_string()),
                        "artist" => Some("ar.name".to_string()),
                        "year" => Some("COALESCE(a.year, 0)".to_string()),
                        "tracks" => Some("a.track_count".to_string()),
                        "liked" => Some("COALESCE(a.liked, 0)".to_string()),
                        "random" => Some("RANDOM()".to_string()),
                        _ => None,
                    },
                    "a.title",
                );
                let sql = format!(
                    "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
                     FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
                     {} {} LIMIT ?1 OFFSET ?2", where_clause, order
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![limit, offset], |row| album_from_row(row))?;
                let albums = rows.collect::<SqlResult<Vec<_>>>()?;
                Ok(SearchEntityResult { tracks: None, albums: Some(albums), artists: None, tags: None, total })
            }
            "tags" => {
                let total: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM tags WHERE track_count > 0", [], |row| row.get(0),
                )?;
                let liked_fallback = opts.liked_only && opts.sort_chain.as_ref().map_or(true, |c| c.is_empty());
                let order = build_order_by(
                    &opts.sort_chain, opts.sort_field.as_deref(), opts.sort_dir.as_deref(),
                    liked_fallback, "liked", "",
                    |f| match f {
                        "name" => Some("name".to_string()),
                        "tracks" => Some("track_count".to_string()),
                        "liked" => Some("COALESCE(liked, 0)".to_string()),
                        "random" => Some("RANDOM()".to_string()),
                        _ => None,
                    },
                    "name",
                );
                let sql = format!("SELECT id, name, track_count, liked FROM tags WHERE track_count > 0 {} LIMIT ?1 OFFSET ?2", order);
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![limit, offset], |row| {
                    Ok(Tag { id: row.get(0)?, name: row.get(1)?, track_count: row.get(2)?, liked: row.get::<_, i32>(3).unwrap_or(0) })
                })?;
                let tags = rows.collect::<SqlResult<Vec<_>>>()?;
                Ok(SearchEntityResult { tracks: None, albums: None, artists: None, tags: Some(tags), total })
            }
            _ => Ok(SearchEntityResult { tracks: None, albums: None, artists: None, tags: None, total: 0 }),
        }
    }

    pub fn search_entity(&self, query: &str, entity: &str, opts: &TrackQuery) -> SqlResult<SearchEntityResult> {
        let conn = self.conn.lock().unwrap();

        let normalized = strip_diacritics(query);
        let words: Vec<String> = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect();

        if words.is_empty() {
            return self.list_entity(&conn, entity, opts);
        }

        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);
        let fts_terms = words.join(" AND ");

        match entity {
            "tracks" => {
                let tracks = self.search_tracks_inner(&conn, opts, query)?;

                let fts_query = format!("{{title artist_name album_title tag_names path}}:{}", fts_terms);
                let mut count_sql = "SELECT COUNT(*) FROM tracks t \
                         JOIN tracks_fts ON tracks_fts.rowid = t.id \
                         WHERE tracks_fts MATCH ?1 \
                         AND t.collection_id IN (SELECT id FROM collections WHERE enabled = 1)".to_string();
                if opts.has_youtube_url { count_sql.push_str(" AND t.youtube_url IS NOT NULL AND t.youtube_url != ''"); }
                match opts.media_type.as_deref() {
                    Some("audio") => count_sql.push_str(" AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))"),
                    Some("video") => count_sql.push_str(" AND LOWER(t.format) IN ('mp4','m4v','mov','webm')"),
                    _ => {}
                }
                let total: i64 = conn.query_row(&count_sql, params![fts_query], |row| row.get(0))?;

                Ok(SearchEntityResult { tracks: Some(tracks), albums: None, artists: None, tags: None, total })
            }
            "artists" => {
                let fts_query = format!("{{artist_name}}:{}", fts_terms);
                let total: i64 = conn.query_row(
                    "SELECT COUNT(DISTINCT a.id) FROM artists a \
                     WHERE a.track_count > 0 \
                     AND a.id IN ( \
                       SELECT t.artist_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 AND t.artist_id IS NOT NULL \
                     )",
                    params![fts_query],
                    |row| row.get(0),
                )?;

                let liked_fallback = opts.liked_only && opts.sort_chain.as_ref().map_or(true, |c| c.is_empty());
                let order = build_order_by(
                    &opts.sort_chain, opts.sort_field.as_deref(), opts.sort_dir.as_deref(),
                    liked_fallback, "a.liked", "",
                    |f| match f {
                        "name" => Some("a.name".to_string()),
                        "tracks" => Some("a.track_count".to_string()),
                        "liked" => Some("COALESCE(a.liked, 0)".to_string()),
                        "random" => Some("RANDOM()".to_string()),
                        _ => None,
                    },
                    "a.name",
                );
                let mut stmt = conn.prepare(
                    &format!("SELECT DISTINCT a.id, a.name, a.track_count, a.liked \
                     FROM artists a \
                     WHERE a.track_count > 0 \
                     AND a.id IN ( \
                       SELECT t.artist_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 AND t.artist_id IS NOT NULL \
                     ) \
                     {} LIMIT ?2 OFFSET ?3", order)
                )?;
                let rows = stmt.query_map(params![fts_query, limit, offset], |row| {
                    Ok(Artist {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        track_count: row.get(2)?,
                        liked: row.get::<_, i32>(3).unwrap_or(0),
                    })
                })?;
                let artists = rows.collect::<SqlResult<Vec<_>>>()?;

                Ok(SearchEntityResult { tracks: None, albums: None, artists: Some(artists), tags: None, total })
            }
            "albums" => {
                let fts_query = format!("{{album_title artist_name}}:{}", fts_terms);
                let total: i64 = conn.query_row(
                    "SELECT COUNT(DISTINCT al.id) FROM albums al \
                     WHERE al.track_count > 0 \
                     AND al.id IN ( \
                       SELECT t.album_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 AND t.album_id IS NOT NULL \
                     )",
                    params![fts_query],
                    |row| row.get(0),
                )?;

                let liked_fallback = opts.liked_only && opts.sort_chain.as_ref().map_or(true, |c| c.is_empty());
                let order = build_order_by(
                    &opts.sort_chain, opts.sort_field.as_deref(), opts.sort_dir.as_deref(),
                    liked_fallback, "al.liked", "",
                    |f| match f {
                        "name" => Some("al.title".to_string()),
                        "artist" => Some("ar.name".to_string()),
                        "year" => Some("COALESCE(al.year, 0)".to_string()),
                        "tracks" => Some("al.track_count".to_string()),
                        "liked" => Some("COALESCE(al.liked, 0)".to_string()),
                        "random" => Some("RANDOM()".to_string()),
                        _ => None,
                    },
                    "al.title",
                );
                let mut stmt = conn.prepare(
                    &format!("SELECT DISTINCT al.id, al.title, al.artist_id, ar.name, al.year, al.track_count, al.liked \
                     FROM albums al \
                     LEFT JOIN artists ar ON al.artist_id = ar.id \
                     WHERE al.track_count > 0 \
                     AND al.id IN ( \
                       SELECT t.album_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 AND t.album_id IS NOT NULL \
                     ) \
                     {} LIMIT ?2 OFFSET ?3", order)
                )?;
                let rows = stmt.query_map(params![fts_query, limit, offset], |row| album_from_row(row))?;
                let albums = rows.collect::<SqlResult<Vec<_>>>()?;

                Ok(SearchEntityResult { tracks: None, albums: Some(albums), artists: None, tags: None, total })
            }
            "tags" => {
                let fts_query = format!("{{tag_names}}:{}", fts_terms);
                let total: i64 = conn.query_row(
                    "SELECT COUNT(DISTINCT tg.id) FROM tags tg \
                     WHERE tg.track_count > 0 \
                     AND tg.id IN ( \
                       SELECT tt.tag_id FROM track_tags tt \
                       JOIN tracks t ON tt.track_id = t.id \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 \
                     )",
                    params![fts_query],
                    |row| row.get(0),
                )?;

                let liked_fallback = opts.liked_only && opts.sort_chain.as_ref().map_or(true, |c| c.is_empty());
                let order = build_order_by(
                    &opts.sort_chain, opts.sort_field.as_deref(), opts.sort_dir.as_deref(),
                    liked_fallback, "tg.liked", "",
                    |f| match f {
                        "name" => Some("tg.name".to_string()),
                        "tracks" => Some("tg.track_count".to_string()),
                        "liked" => Some("COALESCE(tg.liked, 0)".to_string()),
                        "random" => Some("RANDOM()".to_string()),
                        _ => None,
                    },
                    "tg.name",
                );
                let mut stmt = conn.prepare(
                    &format!("SELECT DISTINCT tg.id, tg.name, tg.track_count, tg.liked \
                     FROM tags tg \
                     WHERE tg.track_count > 0 \
                     AND tg.id IN ( \
                       SELECT tt.tag_id FROM track_tags tt \
                       JOIN tracks t ON tt.track_id = t.id \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 \
                     ) \
                     {} LIMIT ?2 OFFSET ?3", order)
                )?;
                let rows = stmt.query_map(params![fts_query, limit, offset], |row| {
                    Ok(Tag { id: row.get(0)?, name: row.get(1)?, track_count: row.get(2)?, liked: row.get::<_, i32>(3).unwrap_or(0) })
                })?;
                let tags = rows.collect::<SqlResult<Vec<_>>>()?;

                Ok(SearchEntityResult { tracks: None, albums: None, artists: None, tags: Some(tags), total })
            }
            _ => Ok(SearchEntityResult { tracks: None, albums: None, artists: None, tags: None, total: 0 }),
        }
    }
}
