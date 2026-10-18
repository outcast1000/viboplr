// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

/// Connection-level find-or-create so in-transaction callers (the scanner's
/// batched ingest) share one implementation with the locked `&self` method.
/// The WHERE expression matches `idx_artists_name_norm` verbatim (see
/// created in `init_tables`); statements are prepare_cached for the per-file loop.
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

/// `get_or_create_artist_conn` for an explicit user edit: when the name
/// matches an existing row that is spelled differently (case or accents
/// only — "mogwai" → "Mogwai", "Ηταν" → "Ήταν"), the row takes the new
/// spelling. Without it such an edit reached the file but never the library,
/// and a rescan can't fix it either, since it matches the same row.
///
/// Scanning and syncing deliberately keep the plain lookup: files tagged
/// with both spellings would otherwise flip the row on every scan.
pub(crate) fn find_or_create_artist_respelled_conn(conn: &Connection, name: &str) -> SqlResult<i64> {
    // An exact match first, so a pair of rows that differ only in spelling
    // (left by older builds) resolves to the one already spelled this way
    // instead of renaming the other into a UNIQUE conflict.
    let existing: Option<(i64, String)> = conn.prepare_cached(
        "SELECT id, name FROM artists WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1)) \
         ORDER BY name = ?1 DESC LIMIT 1",
    )?.query_row(params![name], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
    match existing {
        Some((id, stored)) => {
            if stored != name {
                conn.prepare_cached("UPDATE artists SET name = ?1 WHERE id = ?2")?.execute(params![name, id])?;
            }
            Ok(id)
        }
        None => {
            conn.prepare_cached("INSERT INTO artists (name) VALUES (?1)")?.execute(params![name])?;
            Ok(conn.last_insert_rowid())
        }
    }
}

impl Database {

    // --- Artists ---

    pub fn get_or_create_artist(&self, name: &str) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        get_or_create_artist_conn(&conn, name)
    }

    pub fn get_artist_by_id(&self, artist_id: i64) -> SqlResult<Option<Artist>> {
        let conn = self.reader();
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
        let conn = self.reader();
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
        let conn = self.reader();
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
