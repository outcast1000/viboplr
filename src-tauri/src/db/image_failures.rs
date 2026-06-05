// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

/// How long a recorded image-fetch failure suppresses retries. After this
/// window elapses, `is_image_failed` reports the entry as expired so the
/// download worker re-attempts the fetch automatically. `record_image_failure`
/// uses INSERT OR REPLACE, so a fetch that keeps failing refreshes its
/// timestamp and stays suppressed for one more window after each attempt —
/// genuinely-missing art is retried at most once per window, not hammered.
/// 24h mirrors the Home-shelf refresh cadence used elsewhere in the app.
pub const IMAGE_FAILURE_TTL_SECS: i64 = 24 * 60 * 60;

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
            "SELECT COUNT(*) FROM image_fetch_failures \
             WHERE kind = ?1 AND slug = ?2 \
             AND failed_at > strftime('%s', 'now') - ?3",
            params![kind, slug, IMAGE_FAILURE_TTL_SECS],
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        Database::new_in_memory().unwrap()
    }

    /// Backdate an existing failure's timestamp by `age_secs` so we can simulate
    /// failures recorded in the past without waiting real time.
    fn backdate_failure(db: &Database, kind: &str, slug: &str, age_secs: i64) {
        let conn = db.conn.lock().unwrap();
        let rows = conn
            .execute(
                "UPDATE image_fetch_failures SET failed_at = strftime('%s','now') - ?3 \
                 WHERE kind = ?1 AND slug = ?2",
                params![kind, slug, age_secs],
            )
            .unwrap();
        assert_eq!(rows, 1, "expected to backdate exactly one failure row");
    }

    #[test]
    fn test_fresh_failure_is_reported() {
        let db = test_db();
        db.record_image_failure("album", "marley - stony hill").unwrap();
        assert!(db
            .is_image_failed("album", "marley - stony hill")
            .unwrap());
    }

    #[test]
    fn test_unrecorded_slug_is_not_failed() {
        let db = test_db();
        assert!(!db.is_image_failed("album", "never - seen").unwrap());
    }

    #[test]
    fn test_failure_within_ttl_still_suppresses() {
        let db = test_db();
        db.record_image_failure("album", "a - b").unwrap();
        backdate_failure(&db, "album", "a - b", IMAGE_FAILURE_TTL_SECS - 60);
        assert!(
            db.is_image_failed("album", "a - b").unwrap(),
            "a failure just under the TTL must still suppress retries"
        );
    }

    #[test]
    fn test_failure_past_ttl_is_expired() {
        let db = test_db();
        db.record_image_failure("album", "a - b").unwrap();
        backdate_failure(&db, "album", "a - b", IMAGE_FAILURE_TTL_SECS + 60);
        assert!(
            !db.is_image_failed("album", "a - b").unwrap(),
            "a failure older than the TTL must be reported as expired so it can retry"
        );
    }

    #[test]
    fn test_re_recording_refreshes_window() {
        let db = test_db();
        db.record_image_failure("album", "a - b").unwrap();
        backdate_failure(&db, "album", "a - b", IMAGE_FAILURE_TTL_SECS + 60);
        assert!(!db.is_image_failed("album", "a - b").unwrap());
        // A fresh failure (INSERT OR REPLACE) resets the timestamp.
        db.record_image_failure("album", "a - b").unwrap();
        assert!(
            db.is_image_failed("album", "a - b").unwrap(),
            "re-recording an expired failure must suppress retries again"
        );
    }

    #[test]
    fn test_clear_single_failure() {
        let db = test_db();
        db.record_image_failure("artist", "marley").unwrap();
        db.clear_image_failure("artist", "marley").unwrap();
        assert!(!db.is_image_failed("artist", "marley").unwrap());
    }

    #[test]
    fn test_ttl_is_scoped_per_kind_and_slug() {
        let db = test_db();
        db.record_image_failure("album", "a - b").unwrap();
        db.record_image_failure("artist", "a - b").unwrap();
        backdate_failure(&db, "album", "a - b", IMAGE_FAILURE_TTL_SECS + 60);
        // Only the album entry was backdated; the artist entry stays fresh.
        assert!(!db.is_image_failed("album", "a - b").unwrap());
        assert!(db.is_image_failed("artist", "a - b").unwrap());
    }
}
