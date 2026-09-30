// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

/// Connection-level find-or-create so in-transaction callers (the scanner's
/// batched ingest) share one implementation with the locked `&self` method.
/// The WHERE expression matches `idx_artists_name_norm` verbatim (see
/// run_migrations #8); statements are prepare_cached for the per-file loop.
pub(crate) fn get_or_create_artist_conn(conn: &Connection, name: &str) -> SqlResult<i64> {
    let existing: Option<i64> = conn.prepare_cached(
        "SELECT id FROM artists WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1))",
    )?.query_row(params![name], |row| row.get(0)).optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    conn.prepare_cached("INSERT INTO artists (name) VALUES (?1)")?.execute(params![name])?;
    Ok(conn.last_insert_rowid())
}

impl Database {

    // --- Artists ---

    pub fn get_or_create_artist(&self, name: &str) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        get_or_create_artist_conn(&conn, name)
    }

    pub fn get_artist_by_id(&self, artist_id: i64) -> SqlResult<Option<Artist>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT id, name, track_count, liked, {} FROM artists WHERE id = ?1",
                artist_album_count_sql("artists")
            ),
            params![artist_id],
            |row| Ok(Artist {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
                liked: row.get::<_, i32>(3).unwrap_or(0),
                album_count: row.get(4)?,
            }),
        ).optional()
    }

    pub fn get_artists_filtered(
        &self,
        liked_only: bool,
        sort: Option<&str>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> SqlResult<Vec<Artist>> {
        let conn = self.conn.lock().unwrap();
        let visible = artist_visible_clause("artists");
        let albums = artist_album_count_sql("artists");
        let liked_clause = if liked_only { " AND liked = 1" } else { "" };
        // "random" = a fresh shuffle per call (the Home "Liked artists" shelf);
        // anything else keeps the alphabetical order paging consumers rely on.
        let order = if sort == Some("random") { "RANDOM()" } else { "name" };
        let base = format!(
            "SELECT id, name, track_count, liked, {} FROM artists \
             WHERE {}{} ORDER BY {}",
            albums, visible, liked_clause, order
        );
        // Pagination is DB-side so a paging consumer (the plugin API's
        // getArtists) doesn't pull the whole table across IPC per page.
        let sql = format!("{}{}", base, limit_offset_clause(limit, offset));
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            Ok(Artist {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
                liked: row.get::<_, i32>(3).unwrap_or(0),
                album_count: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn find_artist_by_name(&self, name: &str) -> SqlResult<Option<Artist>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT id, name, track_count, liked, {} FROM artists \
                 WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1)) \
                 AND {}",
                artist_album_count_sql("artists"),
                artist_visible_clause("artists")
            ),
            params![name],
            |row| Ok(Artist {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
                liked: row.get::<_, i32>(3).unwrap_or(0),
                album_count: row.get(4)?,
            }),
        ).optional()
    }
}
