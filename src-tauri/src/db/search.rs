// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

/// Build an FTS5 MATCH expression requiring every word to match inside the
/// `cols` column set: `{cols}:w1 AND {cols}:w2 …`. Each word carries its own
/// column filter because an FTS5 filter binds only to the immediately-following
/// phrase — the naive `{cols}:w1 AND w2` scopes just the first word and lets
/// the rest match any indexed column, path included.
///
/// Every word must land in the entity's own fields. The looser "one word in
/// the colset, the rest anywhere in the row" form this replaced filled the
/// artist/album sections with junk on common-word queries: "the sound"
/// returned every artist with "the" in the name whose tracks mentioned
/// "sound" somewhere (a title, a folder name), while the artist actually
/// named The Sound was pushed out of the trimmed dropdown section.
fn fts_colset_query(cols: &str, words: &[String]) -> String {
    words
        .iter()
        .map(|w| format!("{{{cols}}}:{w}"))
        .collect::<Vec<_>>()
        .join(" AND ")
}

impl Database {

    pub fn search_all(&self, query: &str, artist_limit: i64, album_limit: i64, track_limit: i64) -> SqlResult<SearchAllResults> {
        let conn = self.reader();

        let normalized = strip_diacritics(query);
        let words: Vec<String> = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect();

        if words.is_empty() {
            return Ok(SearchAllResults { artists: vec![], albums: vec![], tracks: vec![] });
        }

        // --- Artists: FTS on artist_name (mapped via the track's artist) OR
        // album_artist (mapped via the track's ALBUM's artist) — the second arm
        // is what finds "Various Artists" and any album-artist-only artist,
        // whom no track row carries. Visibility must be artist_visible_clause,
        // not track_count > 0, for the same reason. ---
        let artists = {
            let fts_query = fts_colset_query("artist_name", &words);
            let fts_album_artist_query = fts_colset_query("album_artist", &words);
            let mut stmt = conn.prepare(
                &format!(
                    "SELECT DISTINCT a.id, a.name, a.track_count, a.liked, {} \
                     FROM artists a \
                     WHERE {} \
                     AND (a.id IN ( \
                       SELECT t.artist_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 AND t.artist_id IS NOT NULL \
                     ) OR a.id IN ( \
                       SELECT al.artist_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       JOIN albums al ON t.album_id = al.id \
                       WHERE tracks_fts MATCH ?2 AND al.artist_id IS NOT NULL \
                     )) \
                     ORDER BY COALESCE(a.liked, 0) DESC, a.name LIMIT ?3",
                    artist_album_count_sql("a"),
                    artist_visible_clause("a")
                )
            )?;
            let rows = stmt.query_map(params![fts_query, fts_album_artist_query, artist_limit], |row| {
                Ok(Artist {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    track_count: row.get(2)?,
                    liked: row.get::<_, i32>(3).unwrap_or(0),
                    album_count: row.get(4)?,
                })
            })?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };

        // --- Albums: FTS on album_title + artist_name + album_artist to find
        // matching album IDs (album_artist is what matches a compilation
        // searched by "various artists" — no track row carries that name) ---
        let albums = {
            let fts_query = fts_colset_query("album_title artist_name album_artist", &words);
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

    fn list_entity(&self, conn: &rusqlite::Connection, entity: &str, opts: &TrackQuery) -> SqlResult<SearchEntityResult> {
        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);
        match entity {
            "tracks" => {
                let mut where_clauses = format!("WHERE 1=1 {}", ENABLED_COLLECTION_FILTER);
                let mut count_clauses = format!("WHERE 1=1 {}", ENABLED_COLLECTION_FILTER_STANDALONE);
                let media_filter = media_type_clause(opts.media_type.as_deref());
                where_clauses.push_str(media_filter);
                count_clauses.push_str(media_filter);

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
                let where_clause = format!("WHERE {}", artist_visible_clause("a"));
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
                let sql = format!(
                    "SELECT a.id, a.name, a.track_count, a.liked, {} FROM artists a {} {} LIMIT ?1 OFFSET ?2",
                    artist_album_count_sql("a"), where_clause, order
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![limit, offset], |row| {
                    Ok(Artist { id: row.get(0)?, name: row.get(1)?, track_count: row.get(2)?, liked: row.get::<_, i32>(3).unwrap_or(0), album_count: row.get(4)? })
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
                        "added" => Some(album_added_at_sql("a")),
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
        let conn = self.reader();

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
                count_sql.push_str(media_type_clause(opts.media_type.as_deref()));
                let total: i64 = conn.query_row(&count_sql, params![fts_query], |row| row.get(0))?;

                Ok(SearchEntityResult { tracks: Some(tracks), albums: None, artists: None, tags: None, total })
            }
            "artists" => {
                // Track-artist arm OR album-artist arm, same shape and reasons
                // as search_all's artists section (Various Artists has no track
                // rows, hence also artist_visible_clause over track_count).
                let fts_query = fts_colset_query("artist_name", &words);
                let fts_album_artist_query = fts_colset_query("album_artist", &words);
                let match_clause = format!(
                    "{} \
                     AND (a.id IN ( \
                       SELECT t.artist_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 AND t.artist_id IS NOT NULL \
                     ) OR a.id IN ( \
                       SELECT al.artist_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       JOIN albums al ON t.album_id = al.id \
                       WHERE tracks_fts MATCH ?2 AND al.artist_id IS NOT NULL \
                     ))",
                    artist_visible_clause("a")
                );
                let total: i64 = conn.query_row(
                    &format!("SELECT COUNT(DISTINCT a.id) FROM artists a WHERE {}", match_clause),
                    params![fts_query, fts_album_artist_query],
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
                    &format!("SELECT DISTINCT a.id, a.name, a.track_count, a.liked, {} \
                     FROM artists a \
                     WHERE {} \
                     {} LIMIT ?3 OFFSET ?4", artist_album_count_sql("a"), match_clause, order)
                )?;
                let rows = stmt.query_map(params![fts_query, fts_album_artist_query, limit, offset], |row| {
                    Ok(Artist {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        track_count: row.get(2)?,
                        liked: row.get::<_, i32>(3).unwrap_or(0),
                        album_count: row.get(4)?,
                    })
                })?;
                let artists = rows.collect::<SqlResult<Vec<_>>>()?;

                Ok(SearchEntityResult { tracks: None, albums: None, artists: Some(artists), tags: None, total })
            }
            "albums" => {
                let fts_query = fts_colset_query("album_title artist_name album_artist", &words);
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
                        "added" => Some(album_added_at_sql("al")),
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

    /// Search the values cached in `information_values` across ANY info type
    /// (lyrics, bios, reviews, similar lists, …) for a phrase and return the
    /// matches, newest first, at most one per (type, entity).
    ///
    /// Filters (all optional, AND-combined): `type_id` (e.g. "lyrics"),
    /// `display_kind` (e.g. "rich_text"), `entity` ("artist"/"album"/"track"/"tag").
    /// `json_path` restricts matching to one JSON field of the stored value
    /// (e.g. "$.text" for lyrics, "$.summary" for bios).
    ///
    /// Matching runs on the value's **readable text**, never on its raw JSON:
    /// without a `json_path`, a lyrics value contributes only its `text`, and any
    /// other value its string fields minus the plumbing ones (`_meta`, `kind`,
    /// urls, images — see `readable_strings`). Searching the raw JSON made
    /// "text", "plain" or "lrclib" match every cached lyric, and — because the
    /// stored newlines are `\n` escapes — left the snippet as the first 140
    /// chars of JSON instead of the matched line. LRC timestamps are stripped
    /// and lines are joined with a space, so a phrase that runs across a line
    /// break of a synced lyric still matches. Case/diacritic-insensitive to
    /// mirror the rest of search.
    ///
    /// SQL only pre-filters on the query's alphanumeric runs (which appear
    /// verbatim in the stored JSON — escaping never touches them); the phrase
    /// itself is checked here, row by row.
    ///
    /// Hits are ranked by `MatchTier` — the phrase as whole words inside one
    /// line, then as whole words across a line break, then inside a word
    /// ("love" in "glove") — and newest first within a tier. The scan stops
    /// early once `limit` top-tier hits are in, since nothing can outrank them.
    ///
    /// `match_mode` `AllTerms` swaps the phrase for **every term**: the query
    /// splits on whitespace into words, a `"quoted run"` stays one phrase term,
    /// and each term must start a word somewhere in the readable text **or the
    /// entity's own name** (its key minus the kind — a track's artist + title),
    /// so "bush heaven" finds Bush's songs that mention heaven. Punctuation is
    /// ignored and apostrophes dropped on both sides ("dont" finds "don't").
    /// Ranked by `terms_snippet`: the terms as a whole-word phrase in one line,
    /// across a line break, all in one line, all in the text, then hits that
    /// needed the name. `require_text` (all-terms only) drops a hit whose
    /// every term matched only in the name — the caller already lists those
    /// songs by name (Cmd+K's own track results), so they'd show twice.
    ///
    /// When `resolve_tracks` is set, `track`-entity matches are resolved back to
    /// the library `Track` (by reconstructing the un-normalized `track:{artist}:
    /// {title}` key the TS `buildEntityKey` writes) so the caller can play them.
    /// Backs `api.informationTypes.searchValues` and the control API's
    /// `/v1/info/search` — neither plugins nor assistants read stored info values
    /// directly.
    pub fn search_information_values(
        &self,
        query: &str,
        type_id: Option<&str>,
        display_kind: Option<&str>,
        entity: Option<&str>,
        json_path: Option<&str>,
        match_mode: InfoMatchMode,
        require_text: bool,
        resolve_tracks: bool,
        limit: i64,
    ) -> SqlResult<Vec<InfoValueMatch>> {
        let terms = match match_mode {
            InfoMatchMode::Phrase => Vec::new(),
            InfoMatchMode::AllTerms => parse_search_terms(query),
        };
        let needle = match match_mode {
            InfoMatchMode::Phrase => normalize_for_match(query),
            InfoMatchMode::AllTerms => terms.join(" "),
        };
        if needle.is_empty() {
            return Ok(vec![]);
        }
        let limit = limit.max(0) as usize;
        let conn = self.reader();

        // The text we pre-filter on: a single JSON field when json_path is given,
        // else the whole stored value. Bind the path as ?1 (reused) so it can't
        // be injected. `json_type` tells a string field (plain text) from an
        // object/array one (walked like a whole value).
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let (searched, searched_type) = if let Some(path) = json_path {
            params.push(Box::new(path.to_string())); // ?1
            ("json_extract(iv.value, ?1)", "json_type(iv.value, ?1)")
        } else {
            ("iv.value", "NULL")
        };

        let mut sql = format!(
            "SELECT it.type_id, it.plugin_id, it.entity, it.display_kind, iv.entity_key, \
                    iv.value, iv.status, iv.fetched_at, {searched} AS searched_text, \
                    {searched_type} AS searched_type \
             FROM information_values iv \
             JOIN information_types it ON it.id = iv.information_type_id \
             WHERE iv.status = 'ok' AND {searched} IS NOT NULL"
        );
        let mut next = params.len() + 1;
        let mut push_filter = |sql: &mut String, clause: &str, value: String| {
            sql.push_str(&format!(" AND {clause} ?{next}"));
            params.push(Box::new(value));
            next += 1;
        };
        if let Some(t) = type_id {
            push_filter(&mut sql, "it.type_id =", t.to_string());
        }
        if let Some(d) = display_kind {
            push_filter(&mut sql, "it.display_kind =", d.to_string());
        }
        if let Some(e) = entity {
            push_filter(&mut sql, "it.entity =", e.to_string());
        }
        // All-terms mode also matches the entity's name, and drops apostrophes
        // the way `normalize_words` does, so "dont" pre-filters in "don't".
        let haystack = match match_mode {
            InfoMatchMode::Phrase => searched.to_string(),
            InfoMatchMode::AllTerms => APOSTROPHES.iter().fold(
                format!("{searched} || ' ' || iv.entity_key"),
                |hay, a| {
                    let lit = if *a == '\'' { "''".to_string() } else { a.to_string() };
                    format!("replace({hay}, '{lit}', '')")
                },
            ),
        };
        // LIKE metacharacters can't occur in an alphanumeric run, so no escaping.
        for token in needle.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()) {
            let clause = format!("strip_diacritics(unicode_lower({haystack})) LIKE '%' ||");
            push_filter(&mut sql, &clause, token.to_string());
            sql.push_str(" || '%'");
        }
        sql.push_str(" ORDER BY iv.fetched_at DESC, iv.rowid DESC");

        let mut ranked: Vec<(MatchTier, InfoValueMatch)> = Vec::new();
        {
            let mut stmt = conn.prepare(&sql)?;
            let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
            let mut rows = stmt.query(refs.as_slice())?;
            let mut seen: std::collections::HashSet<(String, String)> =
                std::collections::HashSet::new();
            let mut top_tier = 0usize;
            while top_tier < limit {
                let Some(row) = rows.next()? else { break };
                let type_id: String = row.get(0)?;
                let entity_key: String = row.get(4)?;
                // Several providers can cache the same entity under one type
                // (core:local-lyrics, lrclib, lyrics-ovh): the newest stands for
                // all of them, so one song can't fill the page.
                if seen.contains(&(type_id.clone(), entity_key.clone())) {
                    continue;
                }
                let display_kind: String = row.get(3)?;
                let searched_text: String = row.get(8)?;
                let searched_type: Option<String> = row.get(9)?;
                let lines = readable_lines(
                    &searched_text,
                    searched_type.as_deref(),
                    json_path.is_some(),
                    &display_kind,
                );
                let hit = match match_mode {
                    InfoMatchMode::Phrase => phrase_snippet(&lines, &needle),
                    InfoMatchMode::AllTerms => {
                        terms_snippet(&lines, entity_name(&entity_key), &terms, require_text)
                    }
                };
                let Some((snippet, tier)) = hit else { continue };
                seen.insert((type_id.clone(), entity_key.clone()));
                if tier == MatchTier::WordsInLine {
                    top_tier += 1;
                }
                ranked.push((tier, InfoValueMatch {
                    type_id,
                    plugin_id: row.get(1)?,
                    entity: row.get(2)?,
                    display_kind,
                    entity_key,
                    value: row.get(5)?,
                    status: row.get(6)?,
                    fetched_at: row.get(7)?,
                    snippet,
                    track: None,
                }));
            }
        }
        // Stable: rows arrived newest first, so that order holds within a tier.
        ranked.sort_by_key(|(tier, _)| *tier);
        let mut matches: Vec<InfoValueMatch> =
            ranked.into_iter().take(limit).map(|(_, m)| m).collect();

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

/// Lowercase, strip diacritics and collapse whitespace runs to one space — the
/// form both sides of an info-value match are compared in.
fn normalize_for_match(s: &str) -> String {
    strip_diacritics(&s.to_lowercase())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Object keys whose values are plumbing rather than prose, per the display-kind
/// schemas in `src/types/informationTypes.ts`: provider metadata, enum tags,
/// links, images, and lyrics' `lines` (a timed duplicate of `text`).
const NON_READABLE_KEYS: &[&str] = &[
    "_meta", "kind", "itemKind", "libraryKind", "url", "image", "source", "lines", "local",
];

/// Collect the human-readable string leaves of a stored info value.
fn readable_strings(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) => {
            let lower = s.trim_start().to_ascii_lowercase();
            let is_link = ["http://", "https://", "file://", "data:"]
                .iter()
                .any(|p| lower.starts_with(p));
            if !is_link {
                out.push(s.clone());
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|x| readable_strings(x, out)),
        serde_json::Value::Object(map) => {
            for (k, x) in map {
                if !NON_READABLE_KEYS.contains(&k.as_str()) {
                    readable_strings(x, out);
                }
            }
        }
        _ => {}
    }
}

/// The readable text of one searched value, as trimmed non-empty lines with LRC
/// timestamps removed. `searched` is the stored value — or, when the caller gave
/// a `json_path`, the extracted field, with `searched_type` its `json_type`.
/// A lyrics value searched whole contributes only its `text`.
fn readable_lines(
    searched: &str,
    searched_type: Option<&str>,
    has_path: bool,
    display_kind: &str,
) -> Vec<String> {
    let mut strings = Vec::new();
    let is_structured = matches!(searched_type, Some("object") | Some("array"));
    if has_path && !is_structured {
        strings.push(searched.to_string());
    } else {
        match serde_json::from_str::<serde_json::Value>(searched) {
            Ok(v) => {
                if !has_path && display_kind == "lyrics" {
                    if let Some(text) = v.get("text").and_then(|t| t.as_str()) {
                        strings.push(text.to_string());
                    }
                }
                if strings.is_empty() {
                    readable_strings(&v, &mut strings);
                }
            }
            Err(_) => strings.push(searched.to_string()),
        }
    }
    let html = display_kind == "html";
    strings
        .iter()
        .flat_map(|s| {
            let text = if html { strip_tags(s) } else { s.clone() };
            text.lines()
                .map(|l| strip_leading_timestamps(l).trim().to_string())
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Replace `<…>` markup with a space (html display kind).
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// The snippet for a hit, or None when the phrase isn't in `lines`. The phrase
/// may sit inside one line, or run across consecutive ones (the lines of a
/// lyric); the latter reads as the lines joined with " / ".
fn phrase_snippet(lines: &[String], needle: &str) -> Option<(String, MatchTier)> {
    const MAX: usize = 140;
    let norm: Vec<String> = lines.iter().map(|l| normalize_for_match(l)).collect();
    // Whether the phrase occurs as whole words anywhere: if so, a mid-word
    // occurrence found first must not be what the hit is ranked and shown by.
    let (_, whole_somewhere) = find_phrase(&norm.join(" "), needle)?;

    // Inside one line, preferring a line where it stands as whole words.
    let mut single: Option<(usize, bool)> = None;
    for (i, n) in norm.iter().enumerate() {
        if let Some((_, whole)) = find_phrase(n, needle) {
            if whole {
                single = Some((i, true));
                break;
            }
            single.get_or_insert((i, false));
        }
    }
    if let Some((i, whole)) = single {
        if whole || !whole_somewhere {
            let tier = if whole { MatchTier::WordsInLine } else { MatchTier::InsideWord };
            return Some((snippet_window(&lines[i], needle, MAX), tier));
        }
    }

    // Across consecutive lines. A phrase of w words spans at most w lines; +1
    // for a punctuation-only line.
    let span = needle.split(' ').count() + 1;
    for i in 0..norm.len() {
        let mut acc = norm[i].clone();
        for j in (i + 1)..norm.len().min(i + span + 1) {
            acc.push(' ');
            acc.push_str(&norm[j]);
            if let Some((_, whole)) = find_phrase(&acc, needle) {
                if whole || !whole_somewhere {
                    let tier = if whole { MatchTier::WordsAcrossLines } else { MatchTier::InsideWord };
                    return Some((truncate_chars(&lines[i..=j].join(" / "), MAX), tier));
                }
            }
        }
    }
    single.map(|(i, _)| (snippet_window(&lines[i], needle, MAX), MatchTier::InsideWord))
}

/// Lowercase, strip diacritics, drop apostrophes and turn every other
/// non-alphanumeric char into a word break — the form an all-terms match
/// compares in, so punctuation never stands between a term and its text.
fn normalize_words(s: &str) -> String {
    let lowered = strip_diacritics(&s.to_lowercase());
    let spaced: String = lowered
        .chars()
        .filter(|c| !APOSTROPHES.contains(c))
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    spaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Split an all-terms query into its terms: whitespace-separated words, except
/// that a run inside double quotes (straight or curly) is one phrase term. An
/// unclosed quote runs to the end, so a query being typed still searches.
fn parse_search_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for (i, part) in query.split(['"', '\u{201C}', '\u{201D}']).enumerate() {
        let words = normalize_words(part);
        if words.is_empty() {
            continue;
        }
        let parsed: Vec<String> = if i % 2 == 1 {
            vec![words]
        } else {
            words.split(' ').map(String::from).collect()
        };
        for t in parsed {
            if !terms.contains(&t) {
                terms.push(t);
            }
        }
    }
    terms
}

/// The entity's own name from its key — `track:{artist}:{title}` →
/// `{artist}:{title}` (the colon reads as a word break once normalized).
fn entity_name(entity_key: &str) -> &str {
    entity_key.split_once(':').map_or(entity_key, |(_, rest)| rest)
}

/// Whether `term` starts a word in `hay` (both `normalize_words` form):
/// "lov" finds "love", "ove" doesn't.
fn has_word_prefix(hay: &str, term: &str) -> bool {
    hay.match_indices(term)
        .any(|(at, _)| hay[..at].chars().next_back().map_or(true, |c| !c.is_alphanumeric()))
}

/// The snippet and rank for an all-terms hit, or None when some term is in
/// neither the text nor the entity's name — or, with `require_text`, when no
/// term is in the text at all. The snippet is the line the terms
/// best match — the phrase's lines, else the line holding the most terms, else
/// (a hit only by name) the first line.
fn terms_snippet(
    lines: &[String],
    name: &str,
    terms: &[String],
    require_text: bool,
) -> Option<(String, MatchTier)> {
    const MAX: usize = 140;
    let norm: Vec<String> = lines.iter().map(|l| normalize_words(l)).collect();
    let text = norm.join(" ");
    let name = normalize_words(name);
    if !terms.iter().all(|t| has_word_prefix(&text, t) || has_word_prefix(&name, t)) {
        return None;
    }
    if require_text && !terms.iter().any(|t| has_word_prefix(&text, t)) {
        return None;
    }
    // `snippet_window` locates by the punctuated line, so aim it at one word
    // of the term — a phrase term may straddle a comma there.
    let lead = |t: &String| t.split(' ').next().unwrap_or("").to_string();

    // The terms in order, as whole words: in one line, then across lines.
    let phrase = terms.join(" ");
    if let Some(i) = norm.iter().position(|n| matches!(find_phrase(n, &phrase), Some((_, true)))) {
        return Some((snippet_window(&lines[i], &lead(&terms[0]), MAX), MatchTier::WordsInLine));
    }
    if let Some((at, true)) = find_phrase(&text, &phrase) {
        // Map the byte range in `text` back to its lines (joined by one space).
        let mut starts = Vec::with_capacity(norm.len());
        let mut off = 0;
        for n in &norm {
            starts.push(off);
            off += n.len() + 1;
        }
        let line_at = |b: usize| starts.iter().rposition(|&s| s <= b).unwrap_or(0);
        let (i, j) = (line_at(at), line_at(at + phrase.len() - 1));
        return Some((truncate_chars(&lines[i..=j].join(" / "), MAX), MatchTier::WordsAcrossLines));
    }

    let counts: Vec<usize> = norm
        .iter()
        .map(|n| terms.iter().filter(|t| has_word_prefix(n, t)).count())
        .collect();
    let tier = if counts.iter().any(|&c| c == terms.len()) {
        MatchTier::TermsInLine
    } else if terms.iter().all(|t| has_word_prefix(&text, t)) {
        MatchTier::TermsInText
    } else {
        MatchTier::TermsWithName
    };
    // The first line holding the most terms.
    let best = counts
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(&a.0)))
        .map(|(i, &c)| (i, c));
    let snippet = match best {
        Some((i, c)) if c > 0 => {
            let first = terms.iter().find(|t| has_word_prefix(&norm[i], t)).unwrap_or(&terms[0]);
            snippet_window(&lines[i], &lead(first), MAX)
        }
        _ => lines.first().map(|l| truncate_chars(l, MAX)).unwrap_or_default(),
    };
    Some((snippet, tier))
}

/// How well an info value matched a search — the rank order. A phrase search
/// yields the `Words*` tiers and `InsideWord`; an all-terms search the `Words*`
/// tiers (its terms read as a phrase) and the `Terms*` ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MatchTier {
    /// The phrase as whole words inside one line.
    WordsInLine,
    /// The phrase as whole words, running across a line break.
    WordsAcrossLines,
    /// Every term inside one line, out of order or not as whole words.
    TermsInLine,
    /// Every term somewhere in the text, not all in one line.
    TermsInText,
    /// Some term only in the entity's name (a track's artist or title).
    TermsWithName,
    /// Only inside a longer word ("love" in "glove").
    InsideWord,
}

/// Byte offset of `needle` in `hay`, preferring an occurrence that stands as
/// whole words (no alphanumeric directly before or after it); the flag says
/// whether the returned one does.
fn find_phrase(hay: &str, needle: &str) -> Option<(usize, bool)> {
    let mut first = None;
    for (at, _) in hay.match_indices(needle) {
        let before = hay[..at].chars().next_back().map_or(true, |c| !c.is_alphanumeric());
        let after = hay[at + needle.len()..].chars().next().map_or(true, |c| !c.is_alphanumeric());
        if before && after {
            return Some((at, true));
        }
        first.get_or_insert(at);
    }
    first.map(|at| (at, false))
}

/// At most `max` chars of `line`, positioned so the match is visible: a long
/// line (a bio paragraph) is cut to a window starting a little before the
/// first occurrence of `needle`, with ellipses on the cut sides.
fn snippet_window(line: &str, needle: &str, max: usize) -> String {
    const LEAD: usize = 40;
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= max {
        return line.to_string();
    }
    // Normalize char by char, remembering the source char of every byte, so a
    // byte offset in the normalized text maps back to a char offset in `line`.
    let mut norm = String::new();
    let mut origin: Vec<usize> = Vec::new();
    for (ci, c) in chars.iter().enumerate() {
        for nc in strip_diacritics(&c.to_lowercase().to_string()).chars() {
            origin.extend(std::iter::repeat(ci).take(nc.len_utf8()));
            norm.push(nc);
        }
    }
    let at = find_phrase(&norm, needle).map(|(b, _)| origin[b]).unwrap_or(0);
    let start = at.saturating_sub(LEAD).min(chars.len() - max);
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..start + max]);
    if start + max < chars.len() {
        out.push('…');
    }
    out
}

/// Drop leading LRC tags like `[00:12.34]` (repeated tags included) from a line.
fn strip_leading_timestamps(line: &str) -> &str {
    let mut t = line.trim_start();
    while t.starts_with('[') {
        match t.find(']') {
            Some(end) => t = t[end + 1..].trim_start(),
            None => break,
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

    #[test]
    fn test_fts_colset_query_single_word() {
        assert_eq!(
            fts_colset_query("artist_name", &["\"art\"*".to_string()]),
            "{artist_name}:\"art\"*"
        );
    }

    #[test]
    fn test_fts_colset_query_scopes_every_word_to_the_colset() {
        // Each word needs its own column filter: an FTS5 filter binds only to
        // the phrase right after it, so `{cols}:w1 AND w2` would let w2 match
        // any column (path included) — the "the sound" junk-results bug.
        assert_eq!(
            fts_colset_query("album_title artist_name", &["\"rage\"*".to_string(), "\"rare\"*".to_string()]),
            "{album_title artist_name}:\"rage\"* AND {album_title artist_name}:\"rare\"*"
        );
    }

    /// A merged compilation's ONLY connection to "Various Artists" is its album
    /// row — no track's artist_name carries the name — so finding it by typed
    /// search rests entirely on the album_artist FTS column and the
    /// album-artist arm of the artists queries.
    #[test]
    fn test_search_finds_a_compilation_and_its_album_artist() {
        let db = Database::new_in_memory().unwrap();
        let col = db
            .add_collection("local", "Music", Some("/music"), None, None, None, None, None)
            .unwrap();
        let va = db.get_or_create_artist("Various Artists").unwrap();
        let comp = db.get_or_create_album("Summer Hits", Some(va), None).unwrap();
        for (path, title, artist) in [("c/01.mp3", "One", "Alpha"), ("c/02.mp3", "Two", "Beta")] {
            let aid = db.get_or_create_artist(artist).unwrap();
            let id = db
                .upsert_track(path, title, Some(aid), Some(comp), None, Some(200.0), Some("mp3"), None, None, Some(col.id), None)
                .unwrap();
            db.update_fts_for_track(id).unwrap();
        }
        db.recompute_counts().unwrap();

        // Central search: the VA artist row (zero tracks of its own) and the
        // compilation album both match.
        let all = db.search_all("various", 10, 10, 10).unwrap();
        let found_va = all.artists.iter().find(|a| a.name == "Various Artists").expect("artists section finds VA");
        assert!(all.albums.iter().any(|a| a.title == "Summer Hits"), "albums section finds the compilation");
        // It performs on nothing, so album_count is the only count that
        // describes it and every artist select has to carry it — a UI rendering
        // track_count alone says "0 tracks" about a row with an album in it.
        assert_eq!(found_va.track_count, 0);
        assert_eq!(found_va.album_count, 1);

        // Library tab searches go through search_entity.
        let artists = db.search_entity("various", "artists", &TrackQuery::default()).unwrap();
        assert_eq!(artists.total, 1);
        let rows = artists.artists.unwrap();
        let row_va = rows.iter().find(|a| a.name == "Various Artists").unwrap();
        assert_eq!(row_va.album_count, 1, "the FTS-filtered artist select carries it too");

        // The unfiltered browse resolver is a separate query under a different
        // alias, so it is asserted separately.
        let browsed = db.search_entity("", "artists", &TrackQuery::default()).unwrap();
        let browsed_va = browsed.artists.unwrap().into_iter().find(|a| a.name == "Various Artists").unwrap();
        assert_eq!(browsed_va.album_count, 1);
        let albums = db.search_entity("various", "albums", &TrackQuery::default()).unwrap();
        assert!(albums.albums.unwrap().iter().any(|a| a.title == "Summer Hits"));

        // A TRACK search must not match by album artist — the track colsets
        // deliberately exclude the column, or "various artists" would flood the
        // tracks section with every song on every compilation.
        let tracks = db.search_entity("various", "tracks", &TrackQuery::default()).unwrap();
        assert!(tracks.tracks.unwrap().is_empty(), "tracks never match by album artist");
    }

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
    fn test_search_all_requires_every_word_in_the_entity_fields() {
        let db = Database::new_in_memory().unwrap();
        let col = db
            .add_collection("local", "Music", Some("/music"), None, None, None, None, None)
            .unwrap();
        seed_track(&db, col.id, "ratm/live-and-rare/01.mp3", "Bombtrack", "Rage Against The Machine", "Live & Rare");
        seed_track(&db, col.id, "ratm/ratm/02.mp3", "Killing in the Name", "Rage Against The Machine", "Rage Against The Machine");
        db.recompute_counts().unwrap();

        // Albums: every word must land in album title OR artist name, in either
        // word order ("rage" only exists in the artist name, "rare" only in the
        // album title).
        for q in ["rage rare", "rare rage"] {
            let res = db.search_all(q, 10, 10, 10).unwrap();
            assert!(
                res.albums.iter().any(|a| a.title == "Live & Rare"),
                "query {q:?} should return the album, got: {:?}",
                res.albums.iter().map(|a| &a.title).collect::<Vec<_>>()
            );
            // Artists: every word must be in the artist NAME — "rare" is not,
            // so the artist section stays clean.
            assert!(
                res.artists.is_empty(),
                "query {q:?} must not match any artist, got: {:?}",
                res.artists.iter().map(|a| &a.name).collect::<Vec<_>>()
            );
        }

        // A track-title word does not qualify an album ("killing" exists only
        // in the track title) — but the track itself still matches, since
        // tracks search all fields.
        let res = db.search_all("rage killing", 10, 10, 10).unwrap();
        assert!(
            res.albums.is_empty(),
            "a track-title word must not match the album section, got: {:?}",
            res.albums.iter().map(|a| &a.title).collect::<Vec<_>>()
        );
        assert!(
            res.tracks.iter().any(|t| t.title == "Killing in the Name"),
            "the track section keeps matching artist word + title word"
        );
    }

    #[test]
    fn test_search_all_common_word_query_does_not_flood_sections() {
        // The shape of the original bug report: searching "the sound" filled
        // Artists/Albums with rows where only ONE of the words was in the
        // entity's name ("Poison the Well", "…Soundtrack") and the other
        // matched elsewhere in the row, crowding out the artist The Sound.
        let db = Database::new_in_memory().unwrap();
        let col = db
            .add_collection("local", "Music", Some("/music"), None, None, None, None, None)
            .unwrap();
        seed_track(&db, col.id, "sound/jeopardy/01.mp3", "Heartland", "The Sound", "Jeopardy");
        seed_track(&db, col.id, "poison/01.mp3", "A Sound Beginning", "Poison the Well", "The Opposite of December");
        seed_track(&db, col.id, "bregovic/01.mp3", "In the Deathcar", "Goran Bregovic", "Arizona Dream (Original Motion Picture Soundtrack)");
        db.recompute_counts().unwrap();

        let res = db.search_all("the sound", 10, 10, 10).unwrap();
        assert_eq!(
            res.artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            vec!["The Sound"],
            "only the artist whose name carries every word matches"
        );
        assert_eq!(
            res.albums.iter().map(|a| a.title.as_str()).collect::<Vec<_>>(),
            vec!["Jeopardy"],
            "only albums whose title/artist carry every word match (\"Soundtrack\" alone is not enough)"
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
            .search_information_values("ARREST", Some("lyrics"), None, None, Some("$.text"), InfoMatchMode::Phrase, false, true, 50)
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
            .search_information_values("plain", Some("lyrics"), None, None, Some("$.text"), InfoMatchMode::Phrase, false, false, 50)
            .unwrap()
            .is_empty());

        // No match / blank query are no-ops.
        assert!(db
            .search_information_values("zzzznotpresent", None, None, None, None, InfoMatchMode::Phrase, false, false, 50)
            .unwrap()
            .is_empty());
        assert!(db
            .search_information_values("   ", None, None, None, None, InfoMatchMode::Phrase, false, false, 50)
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
            .search_information_values("floating", None, None, None, Some("$.text"), InfoMatchMode::Phrase, false, true, 50)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].track.is_none());
    }

    /// Register info types (type_id, entity, display_kind, plugin_id) in one sync
    /// and return their row ids in the same order.
    fn info_type_ids(db: &Database, types: &[(&str, &str, &str, &str)]) -> Vec<i64> {
        let rows: Vec<_> = types
            .iter()
            .map(|(t, e, d, p)| {
                (t.to_string(), t.to_string(), e.to_string(), d.to_string(), p.to_string(),
                 7_776_000, 0, 500, String::new())
            })
            .collect();
        db.info_sync_types(&rows).unwrap();
        let conn = db.conn.lock().unwrap();
        types
            .iter()
            .map(|(t, _, _, p)| {
                conn.query_row(
                    "SELECT id FROM information_types WHERE type_id = ?1 AND plugin_id = ?2",
                    [t, p],
                    |r| r.get(0),
                )
                .unwrap()
            })
            .collect()
    }

    const SYNCED: &str = "{\"text\":\"[00:01.00] Karma police, arrest this man\\n[00:04.50] He talks in maths\",\"kind\":\"synced\",\"_meta\":{\"providerName\":\"LRCLIB\",\"homepageUrl\":\"https://lrclib.net\"}}";

    #[test]
    fn test_search_information_values_matches_readable_text_not_json() {
        // The control API searches whole values (no json_path) — it must still
        // look only at the lyric text, never at keys, enum tags or provider meta.
        let db = Database::new_in_memory().unwrap();
        let lyrics = lyrics_type_id(&db);
        db.info_upsert_value(lyrics, "track:Radiohead:Karma Police", SYNCED, "ok").unwrap();

        for junk in ["text", "synced", "lrclib", "providerName", "https", "00:04"] {
            assert!(
                db.search_information_values(junk, None, None, None, None, InfoMatchMode::Phrase, false, false, 50).unwrap().is_empty(),
                "{junk} must not match the stored JSON"
            );
        }

        // The snippet is the matched line, timestamp stripped — not raw JSON.
        let hits = db
            .search_information_values("TALKS  in", None, None, None, None, InfoMatchMode::Phrase, false, false, 50)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].snippet, "He talks in maths");
    }

    #[test]
    fn test_search_information_values_phrase_across_lyric_lines() {
        let db = Database::new_in_memory().unwrap();
        let lyrics = lyrics_type_id(&db);
        db.info_upsert_value(lyrics, "track:Radiohead:Karma Police", SYNCED, "ok").unwrap();

        // Whole-value search and the plugin API's `$.text` scope both see it.
        for path in [None, Some("$.text")] {
            let hits = db
                .search_information_values("arrest this man he talks", Some("lyrics"), None, None, path, InfoMatchMode::Phrase, false, false, 50)
                .unwrap();
            assert_eq!(hits.len(), 1, "path {path:?}");
            assert_eq!(hits[0].snippet, "Karma police, arrest this man / He talks in maths");
        }
        // Words that are all present but not in that order are not the phrase.
        assert!(db
            .search_information_values("talks arrest", None, None, None, None, InfoMatchMode::Phrase, false, false, 50)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_search_information_values_one_hit_per_entity_and_type() {
        // Several providers caching the same song's lyrics count once (the
        // newest), so one song can't fill the page and starve `limit`.
        let db = Database::new_in_memory().unwrap();
        let ids = info_type_ids(&db, &[
            ("lyrics", "track", "lyrics", "lrclib"),
            ("lyrics", "track", "lyrics", "lyrics-ovh"),
        ]);
        let plain = "{\"text\":\"karma police\",\"kind\":\"plain\"}";
        db.info_upsert_value(ids[0], "track:Radiohead:Karma Police", plain, "ok").unwrap();
        db.info_upsert_value(ids[1], "track:Radiohead:Karma Police", plain, "ok").unwrap();
        db.info_upsert_value(ids[1], "track:Other:Karma Police (cover)", plain, "ok").unwrap();

        let hits = db
            .search_information_values("karma", Some("lyrics"), None, None, None, InfoMatchMode::Phrase, false, false, 50)
            .unwrap();
        let keys: Vec<&str> = hits.iter().map(|h| h.entity_key.as_str()).collect();
        assert_eq!(keys.len(), 2, "{keys:?}");
        assert!(keys.contains(&"track:Radiohead:Karma Police"));
        assert!(keys.contains(&"track:Other:Karma Police (cover)"));

        // `limit` counts distinct hits, not raw rows.
        assert_eq!(
            db.search_information_values("karma", None, None, None, None, InfoMatchMode::Phrase, false, false, 1).unwrap().len(),
            1
        );
    }

    #[test]
    fn test_search_information_values_long_text_snippet_shows_the_match() {
        // A bio is one long paragraph: the snippet must be a window around the
        // match, not the paragraph's first 140 chars. Links never match.
        let db = Database::new_in_memory().unwrap();
        let bio = info_type_ids(&db, &[("artist_bio", "artist", "rich_text", "lastfm")])[0];
        let filler = "Formed in Abingdon, the band spent years playing small venues. ".repeat(5);
        let value = serde_json::json!({
            "summary": format!("{filler}Their third album, OK Computer, was released in 1997."),
            "_meta": { "providerName": "Last.fm", "homepageUrl": "https://www.last.fm/music/Radiohead" },
        })
        .to_string();
        db.info_upsert_value(bio, "artist:Radiohead", &value, "ok").unwrap();

        let hits = db
            .search_information_values("ok computer", None, None, Some("artist"), None, InfoMatchMode::Phrase, false, false, 50)
            .unwrap();
        assert_eq!(hits.len(), 1);
        let snippet = &hits[0].snippet;
        assert!(snippet.contains("OK Computer"), "{snippet}");
        assert!(snippet.starts_with('…'), "{snippet}");
        assert!(snippet.chars().count() <= 142, "{snippet}");

        assert!(db
            .search_information_values("last.fm/music", None, None, None, None, InfoMatchMode::Phrase, false, false, 50)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_search_information_values_ranks_whole_words_before_line_breaks_and_partial_words() {
        // Inserted oldest → newest, so recency alone would list them C, B, A.
        let db = Database::new_in_memory().unwrap();
        let lyrics = lyrics_type_id(&db);
        let put = |key: &str, text: &str| {
            let value = serde_json::json!({ "text": text, "kind": "plain" }).to_string();
            db.info_upsert_value(lyrics, key, &value, "ok").unwrap();
        };
        put("track:A:Whole", "I love you so");
        put("track:B:Partial", "Put on a glove you found");
        put("track:C:Across", "All my love\nyou know");

        let hits = db
            .search_information_values("love you", None, None, None, None, InfoMatchMode::Phrase, false, false, 50)
            .unwrap();
        let keys: Vec<&str> = hits.iter().map(|h| h.entity_key.as_str()).collect();
        assert_eq!(keys, ["track:A:Whole", "track:C:Across", "track:B:Partial"]);

        // `limit` takes from the top of the ranking, not from the newest rows.
        let top = db
            .search_information_values("love you", None, None, None, None, InfoMatchMode::Phrase, false, false, 1)
            .unwrap();
        assert_eq!(top[0].entity_key, "track:A:Whole");
    }

    /// An all-terms lyrics search, the way the Lyrics Search plugin calls it.
    fn terms_search(db: &Database, query: &str) -> Vec<InfoValueMatch> {
        db.search_information_values(query, Some("lyrics"), None, None, Some("$.text"), InfoMatchMode::AllTerms, false, false, 50)
            .unwrap()
    }

    fn put_lyric(db: &Database, type_id: i64, key: &str, text: &str) {
        let value = serde_json::json!({ "text": text, "kind": "plain" }).to_string();
        db.info_upsert_value(type_id, key, &value, "ok").unwrap();
    }

    #[test]
    fn test_parse_search_terms_splits_words_and_keeps_quoted_phrases() {
        assert_eq!(parse_search_terms("Bush  HEAVEN"), ["bush", "heaven"]);
        assert_eq!(
            parse_search_terms("\"hello, darkness\" simon"),
            ["hello darkness", "simon"]
        );
        // Curly quotes, an unclosed quote, apostrophes, duplicates, bare punctuation.
        assert_eq!(parse_search_terms("\u{201C}my old\u{201D} friend"), ["my old", "friend"]);
        assert_eq!(parse_search_terms("sound \"of sil"), ["sound", "of sil"]);
        assert_eq!(parse_search_terms("Don’t don't - !"), ["dont"]);
        assert!(parse_search_terms(" \"\" ").is_empty());
    }

    #[test]
    fn test_all_terms_match_across_lyrics_title_and_artist() {
        let db = Database::new_in_memory().unwrap();
        let lyrics = lyrics_type_id(&db);
        put_lyric(&db, lyrics, "track:Bush:Glycerine", "Could have a soul of heaven\nDon't let the days go by");
        put_lyric(&db, lyrics, "track:Other:Heaven Song", "Stairway up to heaven tonight");

        // "bush" is only the artist, "heaven" only the lyrics.
        let hits = terms_search(&db, "bush heaven");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entity_key, "track:Bush:Glycerine");
        assert_eq!(hits[0].snippet, "Could have a soul of heaven");

        // A title word plus a lyric word, in any order.
        assert_eq!(terms_search(&db, "tonight song").len(), 1);
        // Apostrophes are dropped both ways; words match by prefix, not mid-word.
        assert_eq!(terms_search(&db, "dont glycer").len(), 1);
        assert!(terms_search(&db, "eaven").is_empty());
        // Every term must match somewhere.
        assert!(terms_search(&db, "bush stairway").is_empty());
        // The phrase mode keeps its contract: "bush heaven" is not a phrase.
        assert!(db
            .search_information_values("bush heaven", Some("lyrics"), None, None, Some("$.text"), InfoMatchMode::Phrase, false, false, 50)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_all_terms_quoted_phrase_must_appear_as_written() {
        let db = Database::new_in_memory().unwrap();
        let lyrics = lyrics_type_id(&db);
        put_lyric(&db, lyrics, "track:Simon & Garfunkel:The Sound of Silence", "Hello darkness, my old friend\nI've come to talk with you again");
        put_lyric(&db, lyrics, "track:X:Shuffled", "My friend, the darkness\nsays hello");

        // Unquoted, both songs hold all three words.
        assert_eq!(terms_search(&db, "hello darkness friend").len(), 2);
        // Quoted, only the one with the phrase — punctuation inside it doesn't matter.
        let hits = terms_search(&db, "\"hello darkness\" friend");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].snippet, "Hello darkness, my old friend");
        // A quoted phrase can run across a line break.
        assert_eq!(terms_search(&db, "\"old friend ive come\"").len(), 1);
        // A quoted phrase in the name counts too.
        assert_eq!(terms_search(&db, "\"sound of silence\" talk").len(), 1);
    }

    #[test]
    fn test_all_terms_ranks_phrase_then_line_then_text_then_name() {
        // Inserted oldest → newest, so recency alone would list them in reverse.
        let db = Database::new_in_memory().unwrap();
        let lyrics = lyrics_type_id(&db);
        put_lyric(&db, lyrics, "track:A:Phrase", "I love you so");
        put_lyric(&db, lyrics, "track:B:Across", "All my love\nyou know");
        put_lyric(&db, lyrics, "track:C:InLine", "You know I love");
        put_lyric(&db, lyrics, "track:D:InText", "Love is here\nand so are you");
        put_lyric(&db, lyrics, "track:E:Love", "you and me");

        let hits = terms_search(&db, "love you");
        let keys: Vec<&str> = hits.iter().map(|h| h.entity_key.as_str()).collect();
        assert_eq!(
            keys,
            ["track:A:Phrase", "track:B:Across", "track:C:InLine", "track:D:InText", "track:E:Love"]
        );
        assert_eq!(hits[1].snippet, "All my love / you know");
        // The line holding the most terms, then — for a name-only term — the
        // best line for the rest.
        assert_eq!(hits[3].snippet, "Love is here");
        assert_eq!(hits[4].snippet, "you and me");
    }

    #[test]
    fn test_all_terms_require_text_drops_name_only_hits() {
        let db = Database::new_in_memory().unwrap();
        let lyrics = lyrics_type_id(&db);
        put_lyric(&db, lyrics, "track:Bush:Glycerine", "Could have a soul of heaven");
        put_lyric(&db, lyrics, "track:Bush:Machinehead", "Breathe in, breathe out");
        let search = |q: &str| {
            db.search_information_values(q, Some("lyrics"), None, None, Some("$.text"), InfoMatchMode::AllTerms, true, false, 50)
                .unwrap()
        };
        // Every term only in the name: what Cmd+K's own track rows already show.
        assert!(search("bush").is_empty());
        assert!(search("bush glycerine").is_empty());
        // One term in the lyrics is enough; the rest may be the name.
        let hits = search("bush heaven");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entity_key, "track:Bush:Glycerine");
        // Without the flag the name-only hits come back.
        assert_eq!(terms_search(&db, "bush").len(), 2);
    }

    #[test]
    fn test_all_terms_name_only_hit_shows_the_first_line() {
        let db = Database::new_in_memory().unwrap();
        let lyrics = lyrics_type_id(&db);
        put_lyric(&db, lyrics, "track:Radiohead:Karma Police", "Karma police\narrest this man");
        let hits = terms_search(&db, "radiohead");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].snippet, "Karma police");
    }
}
