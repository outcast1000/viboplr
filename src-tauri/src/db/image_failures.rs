// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

impl Database {

    // --- Image fetch failures ---

    pub fn record_image_failure(&self, kind: &str, slug: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO image_fetch_failures (kind, slug) VALUES (?1, ?2)",
            params![kind, slug],
        )?;
        Ok(())
    }

    pub fn is_image_failed(&self, kind: &str, slug: &str) -> SqlResult<bool> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM image_fetch_failures WHERE kind = ?1 AND slug = ?2",
            params![kind, slug],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn clear_image_failure(&self, kind: &str, slug: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM image_fetch_failures WHERE kind = ?1 AND slug = ?2",
            params![kind, slug],
        )?;
        Ok(())
    }

    pub fn clear_image_failures(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM image_fetch_failures", [])?;
        Ok(())
    }
}
