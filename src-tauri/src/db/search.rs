// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

/// Build an FTS5 MATCH expression requiring every word to match the row (any
/// column) and at least one word to match inside the `cols` column set:
/// `({cols}:w1 OR {cols}:w2 …) AND w1 AND w2 …`. An FTS5 column filter binds
/// only to the immediately-following phrase, so the naive `{cols}:w1 AND w2`
/// scopes just the first word — making matches depend on word order (e.g.
/// "rage rare" missing an album that "rare rage" finds). This form is
/// order-independent and never drops a row the naive form could match under
/// some word ordering.
fn fts_colset_query(cols: &str, words: &[String]) -> String {
    let scoped: Vec<String> = words.iter().map(|w| format!("{{{cols}}}:{w}")).collect();
    format!("({}) AND {}", scoped.join(" OR "), words.join(" AND "))
}

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

        // --- Artists: use FTS on artist_name to find matching artist IDs ---
        let artists = {
            let fts_query = fts_colset_query("artist_name", &words);
            let mut stmt = conn.prepare(
                "SELECT DISTINCT a.id, a.name, a.track_count, a.liked \
                 FROM artists a \
                 WHERE a.track_count > 0 \
                 AND a.id IN ( \
                   SELECT t.artist_id FROM tracks t \
                   JOIN tracks_fts ON tracks_fts.rowid = t.id \
                   WHERE tracks_fts MATCH ?1 AND t.artist_id IS NOT NULL \
                 ) \
                 ORDER BY COALESCE(a.liked, 0) DESC, a.name LIMIT ?2"
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

        // --- Albums: FTS on album_title + artist_name to find matching album IDs ---
        let albums = {
            let fts_query = fts_colset_query("album_title artist_name", &words);
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
                 ORDER BY COALESCE(al.liked, 0) DESC, al.title LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![fts_query, album_limit], |row| album_from_row(row))?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };

        // --- Tracks (reuse FTS) ---
        // Liked tracks rank first (and disliked last — `liked` is -1/0/1);
        // the `, t.id` tiebreaker keeps the default insertion order within
        // each like state.
        let track_opts = TrackQuery {
            limit: Some(track_limit),
            sort_chain: Some(vec![SortKey { field: "liked".into(), dir: "desc".into() }]),
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
        // Parenthesized so every word is scoped to these columns — the colset
        // deliberately excludes `path`, and without parens FTS5 would scope
        // only the first word, letting the rest match on local file paths.
        let fts_query = format!("{{title artist_name album_title tag_names}}:({})", words.join(" AND "));
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
                match opts.media_type.as_deref() {
                    Some("audio") => count_sql.push_str(" AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))"),
                    Some("video") => count_sql.push_str(" AND LOWER(t.format) IN ('mp4','m4v','mov','webm')"),
                    _ => {}
                }
                let total: i64 = conn.query_row(&count_sql, params![fts_query], |row| row.get(0))?;

                Ok(SearchEntityResult { tracks: Some(tracks), albums: None, artists: None, tags: None, total })
            }
            "artists" => {
                let fts_query = fts_colset_query("artist_name", &words);
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
                let fts_query = fts_colset_query("album_title artist_name", &words);
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
                let fts_query = fts_colset_query("tag_names", &words);
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

    /// Substring-search the values cached in `information_values` across ANY info
    /// type (lyrics, bios, reviews, similar lists, …) and return the matches.
    ///
    /// Filters (all optional, AND-combined): `type_id` (e.g. "lyrics"),
    /// `display_kind` (e.g. "rich_text"), `entity` ("artist"/"album"/"track"/"tag").
    /// `json_path` restricts matching to one JSON field of the stored value
    /// (e.g. "$.text" for lyrics, "$.summary" for bios); when None, the whole
    /// stored JSON is searched. Matching is case/diacritic-insensitive to mirror
    /// the rest of search, and LIKE metacharacters in the query are escaped.
    ///
    /// When `resolve_tracks` is set, `track`-entity matches are resolved back to
    /// the library `Track` (by reconstructing the un-normalized `track:{artist}:
    /// {title}` key the TS `buildEntityKey` writes) so the caller can play them.
    /// Backs `api.informationTypes.searchValues` — plugins can't read stored info
    /// values directly.
    pub fn search_information_values(
        &self,
        query: &str,
        type_id: Option<&str>,
        display_kind: Option<&str>,
        entity: Option<&str>,
        json_path: Option<&str>,
        resolve_tracks: bool,
        limit: i64,
    ) -> SqlResult<Vec<InfoValueMatch>> {
        let norm = strip_diacritics(&query.trim().to_lowercase());
        if norm.is_empty() {
            return Ok(vec![]);
        }
        // Escape LIKE metacharacters so a literal `%`/`_`/`\` in the query isn't
        // treated as a wildcard (paired with `ESCAPE '\'` in the SQL below).
        let q_like = norm.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let conn = self.conn.lock().unwrap();

        // The text we match (and excerpt) on: a single JSON field when json_path
        // is given, else the whole stored value. Bind the path as ?1 (reused) so
        // it can't be injected.
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let searched = if let Some(path) = json_path {
            params.push(Box::new(path.to_string())); // ?1
            "json_extract(iv.value, ?1)".to_string()
        } else {
            "iv.value".to_string()
        };

        let mut sql = format!(
            "SELECT it.type_id, it.plugin_id, it.entity, it.display_kind, iv.entity_key, \
                    iv.value, iv.status, iv.fetched_at, {searched} AS searched_text \
             FROM information_values iv \
             JOIN information_types it ON it.id = iv.information_type_id \
             WHERE iv.status = 'ok'"
        );
        let mut next = params.len() + 1;
        if let Some(t) = type_id {
            sql.push_str(&format!(" AND it.type_id = ?{next}"));
            params.push(Box::new(t.to_string()));
            next += 1;
        }
        if let Some(d) = display_kind {
            sql.push_str(&format!(" AND it.display_kind = ?{next}"));
            params.push(Box::new(d.to_string()));
            next += 1;
        }
        if let Some(e) = entity {
            sql.push_str(&format!(" AND it.entity = ?{next}"));
            params.push(Box::new(e.to_string()));
            next += 1;
        }
        sql.push_str(&format!(
            " AND {searched} IS NOT NULL \
              AND strip_diacritics(unicode_lower({searched})) LIKE '%' || ?{next} || '%' ESCAPE '\\'"
        ));
        params.push(Box::new(q_like));
        next += 1;
        sql.push_str(&format!(" ORDER BY iv.fetched_at DESC LIMIT ?{next}"));
        params.push(Box::new(limit));

        let mut matches: Vec<InfoValueMatch> = {
            let mut stmt = conn.prepare(&sql)?;
            let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(refs.as_slice(), |row| {
                let searched_text: String = row.get(8)?;
                Ok(InfoValueMatch {
                    type_id: row.get(0)?,
                    plugin_id: row.get(1)?,
                    entity: row.get(2)?,
                    display_kind: row.get(3)?,
                    entity_key: row.get(4)?,
                    value: row.get(5)?,
                    status: row.get(6)?,
                    fetched_at: row.get(7)?,
                    snippet: value_snippet(&searched_text, &norm),
                    track: None,
                })
            })?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };

        // Resolve track-entity matches to playable library tracks. Reuse
        // TRACK_SELECT and reconstruct the same un-normalized key per row so the
        // IN-list is an exact (BINARY) match to what was stored.
        if resolve_tracks {
            let mut keys: Vec<&String> = matches
                .iter()
                .filter(|m| m.entity == "track")
                .map(|m| &m.entity_key)
                .collect();
            keys.sort();
            keys.dedup();
            if !keys.is_empty() {
                let placeholders: Vec<String> =
                    (0..keys.len()).map(|i| format!("?{}", i + 1)).collect();
                let tsql = format!(
                    "{} WHERE ('track:' || COALESCE(ar.name, '') || ':' || t.title) IN ({}) {}",
                    TRACK_SELECT,
                    placeholders.join(", "),
                    ENABLED_COLLECTION_FILTER,
                );
                let mut stmt = conn.prepare(&tsql)?;
                let refs: Vec<&dyn rusqlite::types::ToSql> =
                    keys.iter().map(|k| *k as &dyn rusqlite::types::ToSql).collect();
                let rows = stmt.query_map(refs.as_slice(), |row| track_from_row(row))?;
                let mut by_key: std::collections::HashMap<String, Track> =
                    std::collections::HashMap::new();
                for tr in rows {
                    let track = tr?;
                    let key = format!(
                        "track:{}:{}",
                        track.artist_name.as_deref().unwrap_or(""),
                        track.title
                    );
                    by_key.entry(key).or_insert(track);
                }
                for m in matches.iter_mut() {
                    if m.entity == "track" {
                        m.track = by_key.get(&m.entity_key).cloned();
                    }
                }
            }
        }

        Ok(matches)
    }
}

/// Pull a short, human-readable snippet from `text` for a search hit: the first
/// line that contains `norm_query` (matched case/diacritic-insensitively), else
/// the first non-empty line. Leading LRC-style timestamps are stripped so synced
/// lyrics read cleanly; harmless for other content.
fn value_snippet(text: &str, norm_query: &str) -> String {
    const MAX: usize = 140;
    let mut fallback: Option<&str> = None;
    for raw in text.lines() {
        let line = strip_leading_timestamp(raw).trim();
        if line.is_empty() {
            continue;
        }
        if fallback.is_none() {
            fallback = Some(line);
        }
        if strip_diacritics(&line.to_lowercase()).contains(norm_query) {
            return truncate_chars(line, MAX);
        }
    }
    fallback.map(|f| truncate_chars(f, MAX)).unwrap_or_default()
}

/// Drop a leading LRC timestamp like `[00:12.34]` from a synced-lyrics line.
fn strip_leading_timestamp(line: &str) -> &str {
    let t = line.trim_start();
    if t.starts_with('[') {
        if let Some(end) = t.find(']') {
            return t[end + 1..].trim_start();
        }
    }
    t
}

/// Truncate to `max` chars (not bytes), appending an ellipsis when cut.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seed one track with its artist + album, FTS-indexed. Returns the track id.
    fn seed_track(db: &Database, col_id: i64, path: &str, title: &str, artist: &str, album: &str) -> i64 {
        let artist_id = db.get_or_create_artist(artist).unwrap();
        let album_id = db.get_or_create_album(album, Some(artist_id), None).unwrap();
        let id = db
            .upsert_track(
                path, title, Some(artist_id), Some(album_id), None,
                Some(200.0), Some("mp3"), None, None, Some(col_id), None,
            )
            .unwrap();
        db.update_fts_for_track(id).unwrap();
        id
    }

    #[test]
    fn test_search_all_matches_across_fields_in_any_word_order() {
        let db = Database::new_in_memory().unwrap();
        let col = db
            .add_collection("local", "Music", Some("/music"), None, None, None, None, None)
            .unwrap();
        seed_track(&db, col.id, "ratm/live-and-rare/01.mp3", "Bombtrack", "Rage Against The Machine", "Live & Rare");
        seed_track(&db, col.id, "ratm/ratm/02.mp3", "Killing in the Name", "Rage Against The Machine", "Rage Against The Machine");
        db.recompute_counts().unwrap();

        // An album must be findable by artist word + album word, in either order
        // ("rage" only exists in the artist name, "rare" only in the album title).
        for q in ["rage rare", "rare rage"] {
            let res = db.search_all(q, 10, 10, 10).unwrap();
            assert!(
                res.albums.iter().any(|a| a.title == "Live & Rare"),
                "query {q:?} should return the album, got: {:?}",
                res.albums.iter().map(|a| &a.title).collect::<Vec<_>>()
            );
            // The artist section keeps matching artist word + non-artist word.
            assert!(
                res.artists.iter().any(|a| a.name == "Rage Against The Machine"),
                "query {q:?} should return the artist"
            );
        }

        // Album-title word + track-title word still matches (the self-titled
        // album is found via its track "Killing in the Name").
        let res = db.search_all("rage killing", 10, 10, 10).unwrap();
        assert!(
            res.albums.iter().any(|a| a.title == "Rage Against The Machine"),
            "album-title + track-title words should still match the album"
        );
    }

    #[test]
    fn test_search_all_ranks_liked_results_first() {
        let db = Database::new_in_memory().unwrap();
        let col = db
            .add_collection("local", "Music", Some("/music"), None, None, None, None, None)
            .unwrap();
        // Both rows match "aurora"; the liked artist/album/track sorts LAST by
        // the default name/insertion order, so a first-place assertion proves
        // like-priority rather than the default ordering.
        seed_track(&db, col.id, "a/one.mp3", "Aurora Dawn", "Aurora Band", "Aurora One");
        let liked_track = seed_track(&db, col.id, "b/two.mp3", "Aurora Dusk", "Aurora Zebra", "Aurora Zwei");
        db.recompute_counts().unwrap();

        let liked_artist = db.get_or_create_artist("Aurora Zebra").unwrap();
        let liked_album = db.get_or_create_album("Aurora Zwei", Some(liked_artist), None).unwrap();
        db.toggle_liked("artists", liked_artist, 1).unwrap();
        db.toggle_liked("albums", liked_album, 1).unwrap();
        db.toggle_liked("tracks", liked_track, 1).unwrap();

        let res = db.search_all("aurora", 10, 10, 10).unwrap();
        assert_eq!(res.artists.first().map(|a| a.name.as_str()), Some("Aurora Zebra"));
        assert_eq!(res.albums.first().map(|a| a.title.as_str()), Some("Aurora Zwei"));
        assert_eq!(res.tracks.first().map(|t| t.title.as_str()), Some("Aurora Dusk"));
        // Unliked rows still present, just ranked after.
        assert_eq!(res.artists.len(), 2);
        assert_eq!(res.albums.len(), 2);
        assert_eq!(res.tracks.len(), 2);
    }

    fn lyrics_type_id(db: &Database) -> i64 {
        // Register a lyrics-kind information type (mirrors a plugin manifest) and
        // return its row id so we can upsert cached lyrics values against it.
        db.info_sync_types(&[(
            "lyrics".into(),
            "Lyrics".into(),
            "track".into(),
            "lyrics".into(),
            "lrclib".into(),
            7_776_000,
            0,
            500,
            "Song lyrics".into(),
        )])
        .unwrap();
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT id FROM information_types WHERE type_id = 'lyrics' AND plugin_id = 'lrclib'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn test_search_information_values_lyrics_with_track_resolution() {
        let db = Database::new_in_memory().unwrap();
        let col = db
            .add_collection("local", "Music", Some("/music"), None, None, None, None, None)
            .unwrap();
        let artist = db.get_or_create_artist("Radiohead").unwrap();
        db.upsert_track(
            "karma.mp3", "Karma Police", Some(artist), None, None,
            Some(240.0), Some("mp3"), None, None, Some(col.id), None,
        )
        .unwrap();

        let type_id = lyrics_type_id(&db);
        db.info_upsert_value(
            type_id,
            "track:Radiohead:Karma Police",
            "{\"text\":\"This is what you'll get\\nKarma police, arrest this man\",\"kind\":\"plain\"}",
            "ok",
        )
        .unwrap();

        // Filter to the lyrics type, search only the `$.text` field, resolve the
        // playable track. Matching is case/diacritic-insensitive.
        let hits = db
            .search_information_values("ARREST", Some("lyrics"), None, None, Some("$.text"), true, 50)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].type_id, "lyrics");
        assert_eq!(hits[0].entity, "track");
        assert!(hits[0].snippet.to_lowercase().contains("arrest"));
        let track = hits[0].track.as_ref().expect("track resolved");
        assert_eq!(track.title, "Karma Police");
        assert_eq!(track.artist_name.as_deref(), Some("Radiohead"));

        // The `$.kind` field is searchable too (whole-value search would also
        // catch it) — but a `$.text`-scoped search for "plain" must NOT match.
        assert!(db
            .search_information_values("plain", Some("lyrics"), None, None, Some("$.text"), false, 50)
            .unwrap()
            .is_empty());

        // No match / blank query are no-ops.
        assert!(db
            .search_information_values("zzzznotpresent", None, None, None, None, false, 50)
            .unwrap()
            .is_empty());
        assert!(db
            .search_information_values("   ", None, None, None, None, false, 50)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_search_information_values_unresolved_track_is_null() {
        let db = Database::new_in_memory().unwrap();
        let type_id = lyrics_type_id(&db);
        // A cached lyric whose track isn't in the library still matches, but
        // resolves to track: None (the caller filters unplayable hits).
        db.info_upsert_value(
            type_id,
            "track:Ghost Artist:Ghost Song",
            "{\"text\":\"floating words with no track\",\"kind\":\"plain\"}",
            "ok",
        )
        .unwrap();
        let hits = db
            .search_information_values("floating", None, None, None, Some("$.text"), true, 50)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].track.is_none());
    }
}
