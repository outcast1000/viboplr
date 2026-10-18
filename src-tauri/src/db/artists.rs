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

/// Give artist `id` — found by its folded name, so it differs from `name`
/// in case or accents at most ("mogwai" → "Mogwai", "Ηταν" → "Ήταν") — the
/// spelling `name`, for an explicit user edit. Without it such an edit
/// reached the file but never the library, and no rescan could fix it, since
/// a rescan matches the same row. Returns the id the caller should use: a
/// row already spelled exactly `name` (two rows that fold alike, left by
/// older builds) wins over renaming this one into a UNIQUE conflict.
///
/// Scanning and syncing never call this: files tagged with both spellings
/// would flip the row on every scan.
pub(crate) fn respell_artist_conn(conn: &Connection, id: i64, name: &str) -> SqlResult<i64> {
    let stored: String = conn.prepare_cached("SELECT name FROM artists WHERE id = ?1")?
        .query_row(params![id], |row| row.get(0))?;
    if stored == name {
        return Ok(id);
    }
    if let Some(exact) = conn.prepare_cached("SELECT id FROM artists WHERE name = ?1")?
        .query_row(params![name], |row| row.get::<_, i64>(0)).optional()?
    {
        return Ok(exact);
    }
    conn.prepare_cached("UPDATE artists SET name = ?1 WHERE id = ?2")?.execute(params![name, id])?;
    // The info cache keys on the exact name (`buildEntityKey`), so the
    // artist's cached bio etc. and its albums' and tracks' entries move too.
    rekey_information_values(conn, &format!("artist:{stored}"), &format!("artist:{name}"), false)?;
    rekey_information_values(conn, &format!("album:{stored}:"), &format!("album:{name}:"), true)?;
    rekey_information_values(conn, &format!("track:{stored}:"), &format!("track:{name}:"), true)?;
    Ok(id)
}

/// `get_or_create_artist_conn`, then `respell_artist_conn`: the lookup for a
/// name the user typed.
pub(crate) fn find_or_create_artist_respelled_conn(conn: &Connection, name: &str) -> SqlResult<i64> {
    let id = get_or_create_artist_conn(conn, name)?;
    respell_artist_conn(conn, id, name)
}

/// Move cached information values from `old` to `new`: the exact key, or
/// every key starting with it when `prefix`. A value already cached under
/// the new key wins, and the old copy is dropped. Compared with `substr`
/// rather than LIKE so a name holding `%` or `_` matches only itself.
pub(crate) fn rekey_information_values(conn: &Connection, old: &str, new: &str, prefix: bool) -> SqlResult<()> {
    if prefix {
        conn.prepare_cached(
            "UPDATE OR IGNORE information_values SET entity_key = ?2 || substr(entity_key, length(?1) + 1) \
             WHERE substr(entity_key, 1, length(?1)) = ?1",
        )?.execute(params![old, new])?;
        conn.prepare_cached("DELETE FROM information_values WHERE substr(entity_key, 1, length(?1)) = ?1")?
            .execute(params![old])?;
    } else {
        conn.prepare_cached("UPDATE OR IGNORE information_values SET entity_key = ?2 WHERE entity_key = ?1")?
            .execute(params![old, new])?;
        conn.prepare_cached("DELETE FROM information_values WHERE entity_key = ?1")?.execute(params![old])?;
    }
    Ok(())
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
