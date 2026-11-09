// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

/// Connection-level find-or-create — see get_or_create_artist_conn for why.
/// The title expression matches `idx_albums_title_norm` verbatim.
/// `artist_id` is the ALBUM artist (ALBUMARTIST tag / Subsonic album-level
/// artist, falling back to the track artist) — it keys the album's identity
/// and need not match any track's own artist_id.
pub(crate) fn get_or_create_album_conn(
    conn: &Connection,
    title: &str,
    artist_id: Option<i64>,
    year: Option<i32>,
) -> SqlResult<i64> {
    let existing: Option<i64> = conn.prepare_cached(
        "SELECT id FROM albums WHERE strip_diacritics(unicode_lower(title)) = strip_diacritics(unicode_lower(?1)) \
         AND (artist_id = ?2 OR (?2 IS NULL AND artist_id IS NULL))",
    )?.query_row(params![title, artist_id], |row| row.get(0)).optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    conn.prepare_cached("INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)")?
        .execute(params![title, artist_id, year])?;
    Ok(conn.last_insert_rowid())
}

/// `get_or_create_album_conn`, then give the album the title the user typed
/// when it differs only in case or accents. Same reasoning, and the same
/// scan exemption, as `artists::respell_artist_conn`.
pub(crate) fn find_or_create_album_respelled_conn(
    conn: &Connection,
    title: &str,
    artist_id: Option<i64>,
    year: Option<i32>,
) -> SqlResult<i64> {
    let id = get_or_create_album_conn(conn, title, artist_id, year)?;
    let stored: String = conn.prepare_cached("SELECT title FROM albums WHERE id = ?1")?
        .query_row(params![id], |row| row.get(0))?;
    if stored == title {
        return Ok(id);
    }
    // A row already titled exactly this way under the same artist wins over
    // renaming this one into the UNIQUE(title, artist_id) conflict.
    if let Some(exact) = conn.prepare_cached("SELECT id FROM albums WHERE title = ?1 AND artist_id IS ?2")?
        .query_row(params![title, artist_id], |row| row.get::<_, i64>(0)).optional()?
    {
        return Ok(exact);
    }
    conn.prepare_cached("UPDATE albums SET title = ?1 WHERE id = ?2")?.execute(params![title, id])?;
    let artist_name: String = match artist_id {
        Some(aid) => conn.prepare_cached("SELECT name FROM artists WHERE id = ?1")?
            .query_row(params![aid], |row| row.get(0)).optional()?.unwrap_or_default(),
        None => String::new(),
    };
    super::artists::rekey_information_values(
        conn,
        &format!("album:{artist_name}:{stored}"),
        &format!("album:{artist_name}:{title}"),
        false,
    )?;
    Ok(id)
}

impl Database {

    // --- Albums ---

    pub fn get_or_create_album(
        &self,
        title: &str,
        artist_id: Option<i64>,
        year: Option<i32>,
    ) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        get_or_create_album_conn(&conn, title, artist_id, year)
    }

    /// Set (or clear, with `None`) an album's year. Durable across rescans —
    /// `get_or_create_album` only writes `year` on INSERT, never on conflict.
    pub fn set_album_year(&self, album_id: i64, year: Option<i32>) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE albums SET year = ?2 WHERE id = ?1",
            params![album_id, year],
        )?;
        Ok(())
    }

    // --- Albums ---

    pub fn find_album_by_name(&self, title: &str, artist_name: Option<&str>) -> SqlResult<Option<Album>> {
        let conn = self.reader();
        if let Some(artist) = artist_name {
            // The name matches EITHER the album's own artist (the album artist)
            // OR any track artist on the album, album-artist match first — so a
            // caller holding only a track's artist (persisted queues, the
            // now-playing album link, albumArtist= deep links minted before the
            // ALBUMARTIST re-key) still resolves a merged compilation.
            conn.query_row(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
                 FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
                 WHERE strip_diacritics(unicode_lower(a.title)) = strip_diacritics(unicode_lower(?1)) \
                 AND a.track_count > 0 \
                 AND ((ar.name IS NOT NULL AND strip_diacritics(unicode_lower(ar.name)) = strip_diacritics(unicode_lower(?2))) \
                   OR EXISTS (SELECT 1 FROM tracks t JOIN artists ta ON t.artist_id = ta.id \
                       WHERE t.album_id = a.id \
                       AND strip_diacritics(unicode_lower(ta.name)) = strip_diacritics(unicode_lower(?2)))) \
                 ORDER BY CASE WHEN ar.name IS NOT NULL \
                   AND strip_diacritics(unicode_lower(ar.name)) = strip_diacritics(unicode_lower(?2)) THEN 0 ELSE 1 END \
                 LIMIT 1",
                params![title, artist],
                |row| album_from_row(row),
            ).optional()
        } else {
            conn.query_row(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
                 FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
                 WHERE strip_diacritics(unicode_lower(a.title)) = strip_diacritics(unicode_lower(?1)) \
                 AND a.track_count > 0 \
                 LIMIT 1",
                params![title],
                |row| album_from_row(row),
            ).optional()
        }
    }

    pub fn get_album_by_id(&self, album_id: i64) -> SqlResult<Option<Album>> {
        let conn = self.reader();
        conn.query_row(
            "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
             FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
             WHERE a.id = ?1",
            params![album_id],
            |row| album_from_row(row),
        ).optional()
    }

    /// The one album listing: every non-empty album, narrowed by `filter`
    /// (its fields AND together), ordered by `sort` (`album_order_sql`).
    /// `limit` / `offset` are applied in SQL so bounded consumers (the Home
    /// shelves show 20 cards; the plugin API's getAlbums pages) don't pull the
    /// whole album table across the IPC bridge.
    pub fn get_albums(
        &self,
        filter: AlbumFilter,
        sort: Option<&str>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> SqlResult<Vec<Album>> {
        let conn = self.reader();
        let mut clauses = vec!["a.track_count > 0".to_string()];
        let mut binds: Vec<i64> = Vec::new();
        let mut bind = |v: i64| { binds.push(v); binds.len() };
        if let Some(aid) = filter.artist_id {
            let n = bind(aid);
            clauses.push(format!(
                "(a.artist_id = ?{n} OR a.id IN (SELECT album_id FROM tracks WHERE artist_id = ?{n}))"
            ));
        }
        if let Some(aid) = filter.album_artist_id {
            let n = bind(aid);
            clauses.push(format!("a.artist_id = ?{n}"));
        }
        if let Some(tid) = filter.tag_id {
            let n = bind(tid);
            clauses.push(format!(
                "a.id IN (SELECT t.album_id FROM track_tags tt \
                 JOIN tracks t ON t.id = tt.track_id \
                 LEFT JOIN collections co ON t.collection_id = co.id \
                 WHERE tt.tag_id = ?{n} {ENABLED_COLLECTION_FILTER})"
            ));
        }
        if filter.liked_only {
            clauses.push("a.liked = 1".to_string());
        }
        let sql = format!(
            "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
             FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
             WHERE {} ORDER BY {}{}",
            clauses.join(" AND "),
            album_order_sql(sort, filter.is_scoped()),
            limit_offset_clause(limit, offset),
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(binds.iter()), album_from_row)?;
        rows.collect()
    }

    /// The album artists (ALBUMARTIST, i.e. `albums.artist_id`) of albums that
    /// hold at least one track carrying `tag_id`, in enabled collections —
    /// the middle level of a Tag › Artist › Album browse. Album-artist, not
    /// track-artist, so a tagged compilation sits under "Various Artists"
    /// exactly as it does everywhere else. `track_count` / `album_count` are
    /// the artist's library-wide numbers, not tag-scoped ones. `liked_only` and
    /// `sort` mean what they do on the untagged listing (`"random"` shuffles,
    /// anything else is by name).
    pub fn get_artists_for_tag(
        &self,
        tag_id: i64,
        liked_only: bool,
        sort: Option<&str>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> SqlResult<Vec<Artist>> {
        let conn = self.reader();
        let sql = format!(
            "SELECT id, name, track_count, liked, {albums} FROM artists \
             WHERE id IN (SELECT al.artist_id FROM track_tags tt \
                 JOIN tracks t ON t.id = tt.track_id \
                 JOIN albums al ON al.id = t.album_id \
                 LEFT JOIN collections co ON t.collection_id = co.id \
                 WHERE tt.tag_id = ?1 AND al.track_count > 0 {enabled}){liked} \
             ORDER BY {order}{page}",
            albums = artist_album_count_sql("artists"),
            enabled = ENABLED_COLLECTION_FILTER,
            liked = if liked_only { " AND liked = 1" } else { "" },
            order = if sort == Some("random") { "RANDOM()" } else { "name" },
            page = limit_offset_clause(limit, offset),
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![tag_id], artist_from_row)?;
        rows.collect()
    }

}

/// What an album listing (`Database::get_albums`) is narrowed to. Every field
/// is optional and they AND together.
#[derive(Debug, Default, Clone, Copy)]
pub struct AlbumFilter {
    /// Albums this artist owns (album artist) **or performs a track on** —
    /// what an artist page lists.
    pub artist_id: Option<i64>,
    /// Albums this artist owns as album artist (ALBUMARTIST) only — what a
    /// browse by album artist lists, so a compilation stays under "Various
    /// Artists" and not under each performer.
    pub album_artist_id: Option<i64>,
    /// Albums holding at least one track with this tag, in an enabled
    /// collection.
    pub tag_id: Option<i64>,
    pub liked_only: bool,
}

impl AlbumFilter {
    /// Narrowed to an artist or a tag — a short list that reads best
    /// chronologically, so it defaults to year order.
    fn is_scoped(&self) -> bool {
        self.artist_id.is_some() || self.album_artist_id.is_some() || self.tag_id.is_some()
    }
}

/// The ORDER BY of an album listing (alias `a`). `"title"`, `"year"`
/// (undated albums first), `"added_desc"` (`album_added_at_sql`), `"random"`
/// (a fresh shuffle per call — the Home "Liked albums" shelf); anything else is
/// year order for a scoped listing, title order for the whole library.
fn album_order_sql(sort: Option<&str>, scoped: bool) -> String {
    match sort {
        Some("title") => "a.title".to_string(),
        Some("year") => "a.year, a.title".to_string(),
        Some("added_desc") => format!("{} DESC, a.title", album_added_at_sql("a")),
        Some("random") => "RANDOM()".to_string(),
        _ if scoped => "a.year, a.title".to_string(),
        _ => "a.title".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use crate::db::{AlbumFilter, Database, ScannedFileMeta};

    fn file(rel: &str, title: &str, artist: &str, album_artist: Option<&str>, album: &str) -> ScannedFileMeta {
        ScannedFileMeta {
            relative_path: rel.to_string(),
            title: title.to_string(),
            artist: Some(artist.to_string()),
            album_artist: album_artist.map(|s| s.to_string()),
            album: Some(album.to_string()),
            year: None,
            track_number: None,
            duration_secs: None,
            format: Some("flac".to_string()),
            file_size: None,
            modified_at: None,
            tag_names: Vec::new(),
            extra_tags: None,
            write_extra_tags: false,
        }
    }

    /// A tagged compilation ingests as ONE album filed under its ALBUMARTIST,
    /// with each track keeping its own artist — and the album artist (zero
    /// tracks of its own) is still a visible, findable artist.
    #[test]
    fn test_albumartist_groups_a_compilation_into_one_album() {
        let db = Database::new_in_memory().unwrap();
        db.ingest_scanned_files(
            &[
                file("comp/01.flac", "One", "Alpha", Some("Various Artists"), "Big Comp"),
                file("comp/02.flac", "Two", "Beta", Some("Various Artists"), "Big Comp"),
                file("comp/03.flac", "Three", "Gamma", Some("Various Artists"), "Big Comp"),
            ],
            None,
        )
        .unwrap();
        db.recompute_counts().unwrap();

        let album = db
            .find_album_by_name("Big Comp", Some("Various Artists"))
            .unwrap()
            .expect("compilation resolves by its album artist");
        assert_eq!(album.track_count, 3, "one album row, not one per track artist");
        assert_eq!(album.artist_name.as_deref(), Some("Various Artists"));

        // Each track kept its own artist.
        let track = db.find_track_by_metadata("Two", Some("Beta"), None).unwrap().unwrap();
        assert_eq!(track.artist_name.as_deref(), Some("Beta"));
        assert_eq!(track.album_artist_name.as_deref(), Some("Various Artists"));

        // The album artist performs on no track but owns an album → visible.
        let names: Vec<String> = db
            .get_artists_filtered(false, None, None, None)
            .unwrap()
            .into_iter()
            .map(|a| a.name)
            .collect();
        assert!(names.contains(&"Various Artists".to_string()), "album-artist-only artist is listed");
        assert!(db.find_artist_by_name("Various Artists").unwrap().is_some());
    }

    /// Without an ALBUMARTIST tag the album keys on the track artist — the
    /// pre-existing behavior, so untagged libraries are unchanged (a tagless
    /// compilation still forks per artist; fixable via Full rescan after
    /// tagging, or bulk edit).
    #[test]
    fn test_missing_albumartist_falls_back_to_track_artist() {
        let db = Database::new_in_memory().unwrap();
        db.ingest_scanned_files(
            &[
                file("x/01.flac", "One", "Alpha", None, "Untagged Comp"),
                file("x/02.flac", "Two", "Beta", None, "Untagged Comp"),
            ],
            None,
        )
        .unwrap();
        db.recompute_counts().unwrap();

        let a = db.find_album_by_name("Untagged Comp", Some("Alpha")).unwrap().unwrap();
        let b = db.find_album_by_name("Untagged Comp", Some("Beta")).unwrap().unwrap();
        assert_ne!(a.id, b.id, "no tag → per-track-artist forks, as before");
        assert_eq!(a.track_count, 1);
    }

    /// find_album_by_name matches the album artist OR any track artist, with an
    /// exact album-artist match ranked first — so a caller holding only a track
    /// artist (persisted queues, the now-playing album link) still resolves a
    /// merged compilation, and an artist's own same-titled album outranks a
    /// compilation they merely appear on.
    #[test]
    fn test_find_album_by_name_matches_either_artist_album_artist_first() {
        let db = Database::new_in_memory().unwrap();
        db.ingest_scanned_files(
            &[
                // A compilation Alpha appears on…
                file("comp/01.flac", "One", "Alpha", Some("Various Artists"), "Same Title"),
                file("comp/02.flac", "Two", "Beta", Some("Various Artists"), "Same Title"),
                // …and Alpha's own album with the same title.
                file("alpha/01.flac", "Own", "Alpha", None, "Same Title"),
            ],
            None,
        )
        .unwrap();
        db.recompute_counts().unwrap();

        // Track-artist match reaches the compilation (Beta has no own album).
        let via_track_artist = db.find_album_by_name("Same Title", Some("Beta")).unwrap().unwrap();
        assert_eq!(via_track_artist.artist_name.as_deref(), Some("Various Artists"));

        // Alpha matches both; the album-artist match (Alpha's own album) wins.
        let alphas = db.find_album_by_name("Same Title", Some("Alpha")).unwrap().unwrap();
        assert_eq!(alphas.artist_name.as_deref(), Some("Alpha"));
        assert_eq!(alphas.track_count, 1);
    }

    /// An album-artist-only artist is listed with track_count 0 — no track
    /// performs under that name — so `album_count` is the only number that
    /// describes it, and the UI names albums instead of tracks. Every artist
    /// SELECT must carry it: they are six separate queries under three aliases,
    /// so a field added to one silently does nothing in the others.
    #[test]
    fn test_album_artist_only_artist_reports_its_album_count() {
        let db = Database::new_in_memory().unwrap();
        db.ingest_scanned_files(
            &[
                file("comp/01.flac", "One", "Alpha", Some("Various Artists"), "Comp"),
                file("comp/02.flac", "Two", "Beta", Some("Various Artists"), "Comp"),
                // Alpha also has an album of its own, so it has both counts.
                file("alpha/01.flac", "Own", "Alpha", None, "Alpha Album"),
            ],
            None,
        )
        .unwrap();
        db.recompute_counts().unwrap();

        let va = db.find_artist_by_name("Various Artists").unwrap().unwrap();
        assert_eq!(va.track_count, 0, "owns the compilation, performs on nothing");
        assert_eq!(va.album_count, 1);

        // The same row through the other two non-search selects. (The three
        // search selects need FTS rows, so they are asserted in
        // `test_search_finds_a_compilation_and_its_album_artist`.)
        assert_eq!(db.get_artist_by_id(va.id).unwrap().unwrap().album_count, 1);
        let listed = db.get_artists_filtered(false, None, None, None).unwrap();
        let listed_va = listed.iter().find(|a| a.name == "Various Artists").unwrap();
        assert_eq!(listed_va.album_count, 1);

        // A performing artist keeps a real track_count; album_count rides along
        // and is simply not what the UI shows for it.
        let alpha = db.find_artist_by_name("Alpha").unwrap().unwrap();
        assert_eq!(alpha.track_count, 2, "one comp track plus its own");
        assert_eq!(alpha.album_count, 1, "owns Alpha Album, not the compilation");
    }

    /// Tag › Artist › Album browsing is album-artist keyed: a tagged track on a
    /// compilation files the compilation under its ALBUMARTIST, not under the
    /// performer, and an artist's untagged album is left out.
    #[test]
    fn test_tag_scoped_artists_and_albums_follow_the_album_artist() {
        let db = Database::new_in_memory().unwrap();
        let tagged = |rel: &str, title: &str, artist: &str, aa: Option<&str>, album: &str| {
            let mut f = file(rel, title, artist, aa, album);
            f.tag_names = vec!["Trip Hop".to_string()];
            f
        };
        db.ingest_scanned_files(
            &[
                tagged("comp/01.flac", "One", "Alpha", Some("Various Artists"), "Comp"),
                file("comp/02.flac", "Two", "Beta", Some("Various Artists"), "Comp"),
                tagged("alpha/01.flac", "Own", "Alpha", None, "Alpha Album"),
                file("alpha2/01.flac", "Other", "Alpha", None, "Untagged Album"),
                file("gamma/01.flac", "G", "Gamma", None, "Gamma Album"),
            ],
            None,
        )
        .unwrap();
        db.recompute_counts().unwrap();
        let tag = db.find_tag_by_name("Trip Hop").unwrap().expect("tag ingested");

        let artists: Vec<String> =
            db.get_artists_for_tag(tag.id, false, None, None, None).unwrap().into_iter().map(|a| a.name).collect();
        assert_eq!(artists, vec!["Alpha".to_string(), "Various Artists".to_string()]);

        let titles = |filter: AlbumFilter, sort: Option<&str>| -> Vec<String> {
            db.get_albums(filter, sort, None, None).unwrap().into_iter().map(|a| a.title).collect()
        };
        let tagged_only = AlbumFilter { tag_id: Some(tag.id), ..Default::default() };

        let all = titles(tagged_only, None);
        assert_eq!(all.len(), 2);
        assert!(all.contains(&"Comp".to_string()) && all.contains(&"Alpha Album".to_string()));

        let alpha = db.find_artist_by_name("Alpha").unwrap().unwrap();
        assert_eq!(
            titles(AlbumFilter { album_artist_id: Some(alpha.id), ..tagged_only }, None),
            vec!["Alpha Album".to_string()],
            "albumArtistId: the compilation is not Alpha's",
        );
        // artistId means what it means untagged — owns OR performs on — so
        // the compilation Alpha appears on is included.
        let performs = titles(AlbumFilter { artist_id: Some(alpha.id), ..tagged_only }, None);
        assert_eq!(performs.len(), 2, "artistId: Alpha performs on Comp");
        assert_eq!(
            titles(AlbumFilter { artist_id: Some(alpha.id), ..Default::default() }, None).len(),
            3,
            "artistId untagged: both own albums plus the compilation",
        );
        assert_eq!(
            titles(AlbumFilter { album_artist_id: Some(alpha.id), ..Default::default() }, Some("title")),
            vec!["Alpha Album".to_string(), "Untagged Album".to_string()],
            "albumArtistId untagged, and sort applies to a scoped listing",
        );

        // likedOnly and sort reach the tag-scoped reads too — a plugin asking
        // for a tag's liked albums must not get every album of the tag.
        use crate::db::likes::build_entity_key;
        db.set_entity_like("album", &build_entity_key("album", "Comp", Some("Various Artists")), 1, None, 100).unwrap();
        db.set_entity_like("artist", &build_entity_key("artist", "Alpha", None), 1, None, 100).unwrap();
        db.recompute_counts().unwrap();
        assert_eq!(titles(AlbumFilter { liked_only: true, ..tagged_only }, None), vec!["Comp".to_string()]);
        let liked_artists: Vec<String> = db
            .get_artists_for_tag(tag.id, true, None, None, None)
            .unwrap()
            .into_iter()
            .map(|a| a.name)
            .collect();
        assert_eq!(liked_artists, vec!["Alpha".to_string()]);
        assert_eq!(titles(tagged_only, Some("title")), vec!["Alpha Album".to_string(), "Comp".to_string()]);
    }
}
