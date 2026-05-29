// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

impl Database {

    // --- Albums ---

    pub fn get_or_create_album(
        &self,
        title: &str,
        artist_id: Option<i64>,
        year: Option<i32>,
    ) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<i64> = conn.query_row(
            "SELECT id FROM albums WHERE strip_diacritics(unicode_lower(title)) = strip_diacritics(unicode_lower(?1)) \
             AND (artist_id = ?2 OR (?2 IS NULL AND artist_id IS NULL))",
            params![title, artist_id],
            |row| row.get(0),
        ).optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
        conn.execute(
            "INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)",
            params![title, artist_id, year],
        )?;
        Ok(conn.last_insert_rowid())
    }

    // --- Albums ---

    pub fn find_album_by_name(&self, title: &str, artist_name: Option<&str>) -> SqlResult<Option<Album>> {
        let conn = self.conn.lock().unwrap();
        if let Some(artist) = artist_name {
            conn.query_row(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
                 FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
                 WHERE strip_diacritics(unicode_lower(a.title)) = strip_diacritics(unicode_lower(?1)) \
                 AND ar.name IS NOT NULL AND strip_diacritics(unicode_lower(ar.name)) = strip_diacritics(unicode_lower(?2)) \
                 AND a.track_count > 0 \
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

    pub fn get_albums(&self, artist_id: Option<i64>) -> SqlResult<Vec<Album>> {
        self.get_albums_sorted(artist_id, None, false)
    }

    pub fn get_albums_sorted(
        &self,
        artist_id: Option<i64>,
        sort: Option<&str>,
        liked_only: bool,
    ) -> SqlResult<Vec<Album>> {
        let conn = self.conn.lock().unwrap();
        if let Some(aid) = artist_id {
            let liked_clause = if liked_only { " AND a.liked = 1" } else { "" };
            let sql = format!(
                "SELECT DISTINCT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
                 FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
                 WHERE a.track_count > 0{} \
                   AND (a.artist_id = ?1 OR a.id IN (SELECT album_id FROM tracks WHERE artist_id = ?1)) \
                 ORDER BY a.year, a.title",
                liked_clause,
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
        let sql = format!(
            "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked
             FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id
             WHERE a.track_count > 0{}
             {}",
            liked_clause, order_clause,
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| album_from_row(row))?;
        rows.collect()
    }
}
