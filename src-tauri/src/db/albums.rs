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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
             FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
             WHERE a.id = ?1",
            params![album_id],
            |row| album_from_row(row),
        ).optional()
    }

    pub fn get_albums_sorted(
        &self,
        artist_id: Option<i64>,
        sort: Option<&str>,
        liked_only: bool,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> SqlResult<Vec<Album>> {
        let conn = self.conn.lock().unwrap();
        if let Some(aid) = artist_id {
            let liked_clause = if liked_only { " AND a.liked = 1" } else { "" };
            let sql = format!(
                "SELECT DISTINCT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
                 FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
                 WHERE a.track_count > 0{} \
                   AND (a.artist_id = ?1 OR a.id IN (SELECT album_id FROM tracks WHERE artist_id = ?1)) \
                 ORDER BY a.year, a.title{}",
                liked_clause,
                limit_offset_clause(limit, offset),
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![aid], |row| album_from_row(row))?;
            return rows.collect();
        }

        let order_clause = match sort {
            Some("added_desc") =>
                "ORDER BY (SELECT MAX(t.added_at) FROM tracks t WHERE t.album_id = a.id) DESC, a.title",
            _ => "ORDER BY a.title",
        };
        let liked_clause = if liked_only { " AND a.liked = 1" } else { "" };
        // Optional LIMIT/OFFSET so bounded consumers (the Home shelves show 20
        // cards; the plugin API's getAlbums pages) don't pull the whole album
        // table across the IPC bridge.
        let limit_clause = limit_offset_clause(limit, offset);
        let sql = format!(
            "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked
             FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id
             WHERE a.track_count > 0{}
             {}{}",
            liked_clause, order_clause, limit_clause,
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| album_from_row(row))?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::db::{Database, ScannedFileMeta};

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
            .get_artists_filtered(false, None, None)
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
}
