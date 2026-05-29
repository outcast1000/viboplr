// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

impl Database {

    // --- Tags ---

    pub fn get_or_create_tag(&self, name: &str) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<i64> = conn.query_row(
            "SELECT id FROM tags WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1))",
            params![name],
            |row| row.get(0),
        ).optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
        conn.execute("INSERT INTO tags (name) VALUES (?1)", params![name])?;
        Ok(conn.last_insert_rowid())
    }

    pub fn add_track_tag(&self, track_id: i64, tag_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)",
            params![track_id, tag_id],
        )?;
        Ok(())
    }

    pub fn replace_track_tags(&self, track_id: i64, tag_names: &[String]) -> SqlResult<Vec<(i64, String)>> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM track_tags WHERE track_id = ?1", params![track_id])?;
        let mut result = Vec::new();
        for name in tag_names {
            let tag_id: i64 = conn.query_row(
                "SELECT id FROM tags WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1))",
                params![name],
                |row| row.get(0),
            ).optional()?.unwrap_or_else(|| {
                conn.execute("INSERT INTO tags (name) VALUES (?1)", params![name]).unwrap();
                conn.last_insert_rowid()
            });
            conn.execute(
                "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)",
                params![track_id, tag_id],
            )?;
            result.push((tag_id, name.clone()));
        }
        Ok(result)
    }

    pub fn get_tag_by_id(&self, tag_id: i64) -> SqlResult<Option<Tag>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, track_count, liked FROM tags WHERE id = ?1",
            params![tag_id],
            |row| Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
                liked: row.get::<_, i32>(3).unwrap_or(0),
            }),
        ).optional()
    }

    pub fn find_tag_by_name(&self, name: &str) -> SqlResult<Option<Tag>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, track_count, liked FROM tags WHERE name = ?1 COLLATE NOCASE LIMIT 1"
        )?;
        let result = stmt.query_row(params![name], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
                liked: row.get::<_, i32>(3).unwrap_or(0),
            })
        }).optional()?;
        Ok(result)
    }

    pub fn get_tags(&self) -> SqlResult<Vec<Tag>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, track_count, liked FROM tags WHERE track_count > 0 ORDER BY name"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
                liked: row.get::<_, i32>(3).unwrap_or(0),
            })
        })?;
        rows.collect()
    }



    pub fn get_tags_for_track(&self, track_id: i64) -> SqlResult<Vec<Tag>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT tg.id, tg.name, COUNT(t2.id), tg.liked
             FROM tags tg
             JOIN track_tags tt ON tt.tag_id = tg.id
             LEFT JOIN track_tags tt2 ON tt2.tag_id = tg.id
             LEFT JOIN tracks t2 ON t2.id = tt2.track_id
             WHERE tt.track_id = ?1
             GROUP BY tg.id
             ORDER BY tg.name"
        )?;
        let rows = stmt.query_map(params![track_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
                liked: row.get::<_, i32>(3).unwrap_or(0),
            })
        })?;
        rows.collect()
    }

    pub fn delete_tag(&self, tag_id: i64) -> SqlResult<Vec<i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT track_id FROM track_tags WHERE tag_id = ?1")?;
        let affected_track_ids: Vec<i64> = stmt.query_map(params![tag_id], |row| row.get(0))?
            .collect::<SqlResult<Vec<_>>>()?;
        conn.execute("DELETE FROM track_tags WHERE tag_id = ?1", params![tag_id])?;
        conn.execute("DELETE FROM tags WHERE id = ?1", params![tag_id])?;
        Ok(affected_track_ids)
    }

    pub fn get_tracks_by_tag(&self, tag_id: i64) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{} JOIN track_tags tt ON tt.track_id = t.id WHERE tt.tag_id = ?1 {} ORDER BY ar.name, al.title, t.track_number, t.title",
            TRACK_SELECT, ENABLED_COLLECTION_FILTER
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![tag_id], |row| track_from_row(row))?;
        rows.collect()
    }

    pub fn get_top_artists_for_tag(&self, tag_id: i64, limit: i64) -> SqlResult<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT ar.name, COUNT(*) AS cnt \
             FROM tracks t \
             JOIN artists ar ON ar.id = t.artist_id \
             JOIN track_tags tt ON tt.track_id = t.id \
             LEFT JOIN collections co ON co.id = t.collection_id \
             WHERE tt.tag_id = ?1 {} \
             GROUP BY ar.id \
             ORDER BY cnt DESC, ar.name ASC \
             LIMIT ?2",
            ENABLED_COLLECTION_FILTER
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![tag_id, limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        rows.collect()
    }
}
