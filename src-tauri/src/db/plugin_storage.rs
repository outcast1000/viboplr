// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

impl Database {

    pub fn plugin_storage_get(&self, plugin_id: &str, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT value FROM plugin_storage WHERE plugin_id = ?1 AND key = ?2",
            params![plugin_id, key],
            |row| row.get(0),
        ).optional().map_err(|e| e.to_string())
    }

    pub fn plugin_storage_set(&self, plugin_id: &str, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO plugin_storage (plugin_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value",
            params![plugin_id, key, value],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn plugin_storage_delete(&self, plugin_id: &str, key: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM plugin_storage WHERE plugin_id = ?1 AND key = ?2",
            params![plugin_id, key],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Plugin Scheduler ─────────────────────────────────────────

    pub fn plugin_scheduler_register(&self, plugin_id: &str, task_id: &str, interval_ms: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO plugin_schedules (plugin_id, task_id, interval_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT(plugin_id, task_id) DO UPDATE SET interval_ms = excluded.interval_ms",
            params![plugin_id, task_id, interval_ms],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn plugin_scheduler_unregister(&self, plugin_id: &str, task_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM plugin_schedules WHERE plugin_id = ?1 AND task_id = ?2",
            params![plugin_id, task_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn plugin_scheduler_unregister_all(&self, plugin_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM plugin_schedules WHERE plugin_id = ?1",
            params![plugin_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn plugin_scheduler_complete(&self, plugin_id: &str, task_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as i64;
        let rows = conn.execute(
            "UPDATE plugin_schedules SET last_run = ?3 WHERE plugin_id = ?1 AND task_id = ?2",
            params![plugin_id, task_id, now],
        ).map_err(|e| e.to_string())?;
        Ok(rows > 0)
    }

    pub fn plugin_scheduler_get_all(&self) -> Result<Vec<(String, String, i64, Option<i64>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT plugin_id, task_id, interval_ms, last_run FROM plugin_schedules"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        }).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| e.to_string())?);
        }
        Ok(result)
    }
}
