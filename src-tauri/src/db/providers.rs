// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

impl Database {

    // ── Information Types ────────────────────────────────────────

    /// Sync the information_types table from plugin manifests.
    /// Deactivates all types, then upserts incoming types as active.
    /// Types from missing plugins remain with active = 0.
    /// On conflict, preserves user-customized sort_order and priority.
    pub fn info_sync_types(&self, types: &[(String, String, String, String, String, i64, i64, i64, String)]) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("BEGIN")?;
        conn.execute("UPDATE information_types SET active = 0", [])?;
        let mut stmt = conn.prepare(
            "INSERT INTO information_types (type_id, name, entity, display_kind, plugin_id, ttl, sort_order, priority, active, description)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)
             ON CONFLICT(type_id, plugin_id)
             DO UPDATE SET name = excluded.name,
                           entity = excluded.entity,
                           display_kind = excluded.display_kind,
                           ttl = excluded.ttl,
                           description = excluded.description,
                           active = 1"
        )?;
        for t in types {
            stmt.execute(rusqlite::params![t.0, t.1, t.2, t.3, t.4, t.5, t.6, t.7, t.8])?;
        }
        drop(stmt);
        conn.execute_batch("COMMIT")?;
        Ok(())
    }

    /// Get all active info types for an entity kind, grouped by type_id.
    /// Returns vec of (type_id, name, display_kind, ttl, sort_order, providers)
    /// where providers is a vec of (plugin_id, integer_id) ordered by priority.
    /// Metadata comes from the highest-priority (lowest priority value) provider.
    pub fn info_get_types_for_entity(&self, entity: &str) -> SqlResult<Vec<(String, String, String, i64, i64, Vec<(String, i64)>, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, type_id, name, display_kind, plugin_id, ttl, sort_order, priority, description
             FROM information_types
             WHERE entity = ?1 AND active = 1
             ORDER BY sort_order, type_id, priority ASC"
        )?;
        let rows = stmt.query_map([entity], |row| {
            Ok((
                row.get::<_, i64>(0)?,    // id
                row.get::<_, String>(1)?,  // type_id
                row.get::<_, String>(2)?,  // name
                row.get::<_, String>(3)?,  // display_kind
                row.get::<_, String>(4)?,  // plugin_id
                row.get::<_, i64>(5)?,     // ttl
                row.get::<_, i64>(6)?,     // sort_order
                row.get::<_, i64>(7)?,     // priority
                row.get::<_, String>(8)?,  // description
            ))
        })?.collect::<SqlResult<Vec<_>>>()?;

        // Group by type_id: first row per type_id provides metadata, all rows contribute to provider chain
        let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut result: Vec<(String, String, String, i64, i64, Vec<(String, i64)>, String)> = Vec::new();

        for (id, type_id, name, display_kind, plugin_id, ttl, sort_order, _priority, description) in rows {
            if let Some(&idx) = seen.get(&type_id) {
                // Add provider to existing entry
                result[idx].5.push((plugin_id, id));
            } else {
                // New type_id — first (highest priority) provider sets metadata
                let idx = result.len();
                seen.insert(type_id.clone(), idx);
                result.push((type_id, name, display_kind, ttl, sort_order, vec![(plugin_id, id)], description));
            }
        }

        Ok(result)
    }

    /// Get a single cached info value by integer type ID.
    /// Returns (value, status, fetched_at) or None.
    pub fn info_get_value(&self, information_type_id: i64, entity_key: &str) -> SqlResult<Option<(String, String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT value, status, fetched_at FROM information_values
             WHERE information_type_id = ?1 AND entity_key = ?2"
        )?;
        let result = stmt.query_row(rusqlite::params![information_type_id, entity_key], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        });
        match result {
            Ok(r) => Ok(Some(r)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Get all cached info values for an entity key.
    /// Returns vec of (integer_id, type_id, value, status, fetched_at).
    pub fn info_get_values_for_entity(&self, entity_key: &str) -> SqlResult<Vec<(i64, String, String, String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT iv.information_type_id, it.type_id, iv.value, iv.status, iv.fetched_at
             FROM information_values iv
             JOIN information_types it ON it.id = iv.information_type_id
             WHERE iv.entity_key = ?1"
        )?;
        let rows = stmt.query_map([entity_key], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })?.collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// Upsert an info value (insert or update) using integer type ID.
    pub fn info_upsert_value(&self, information_type_id: i64, entity_key: &str, value: &str, status: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO information_values (information_type_id, entity_key, value, status, fetched_at)
             VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))
             ON CONFLICT(information_type_id, entity_key)
             DO UPDATE SET value = excluded.value, status = excluded.status, fetched_at = excluded.fetched_at",
            rusqlite::params![information_type_id, entity_key, value, status],
        )?;
        Ok(())
    }

    /// Delete a cached info value by integer type ID.
    pub fn info_delete_value(&self, information_type_id: i64, entity_key: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM information_values WHERE information_type_id = ?1 AND entity_key = ?2",
            rusqlite::params![information_type_id, entity_key],
        )?;
        Ok(())
    }


    // ── Image Providers ─────────────────────────────────────────

    /// Sync the image_providers table from plugin manifests.
    /// Takes vec of (plugin_id, entity, priority).
    /// Deactivates all rows, upserts current providers (preserving user-customized priorities),
    /// reactivates current providers, then deletes orphaned rows.
    pub fn sync_image_providers(&self, providers: &[(String, String, i64)]) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("BEGIN")?;
        // Deactivate all
        conn.execute("UPDATE image_providers SET active = 0", [])?;
        // Insert new providers (OR IGNORE preserves existing rows with user-customized priorities)
        {
            let mut insert_stmt = conn.prepare(
                "INSERT OR IGNORE INTO image_providers (plugin_id, entity, priority) VALUES (?1, ?2, ?3)"
            )?;
            for p in providers {
                insert_stmt.execute(rusqlite::params![p.0, p.1, p.2])?;
            }
        }
        // Reactivate current providers
        {
            let mut activate_stmt = conn.prepare(
                "UPDATE image_providers SET active = 1 WHERE plugin_id = ?1 AND entity = ?2"
            )?;
            for p in providers {
                activate_stmt.execute(rusqlite::params![p.0, p.1])?;
            }
        }
        // Delete orphaned rows (plugin_id not in the provided set)
        if providers.is_empty() {
            conn.execute("DELETE FROM image_providers", [])?;
        } else {
            let placeholders: Vec<String> = providers.iter().map(|_| "?".to_string()).collect();
            let sql = format!(
                "DELETE FROM image_providers WHERE plugin_id NOT IN ({})",
                placeholders.join(", ")
            );
            let params: Vec<&dyn rusqlite::types::ToSql> = providers.iter().map(|p| &p.0 as &dyn rusqlite::types::ToSql).collect();
            conn.execute(&sql, params.as_slice())?;
        }
        conn.execute_batch("COMMIT")?;
        Ok(())
    }

    /// Get active image providers for an entity, ordered by priority ASC.
    /// Returns vec of (plugin_id, priority, id).
    pub fn get_image_providers(&self, entity: &str) -> SqlResult<Vec<(String, i64, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT plugin_id, priority, id FROM image_providers
             WHERE entity = ?1 AND active = 1
             ORDER BY priority ASC"
        )?;
        let rows = stmt.query_map([entity], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?.collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// Get all provider configuration for the Settings UI.
    /// Returns (info_types, image_providers, download_providers) where:
    /// - info_types: vec of (type_id, name, entity, display_kind, sort_order, plugin_id, priority, active)
    /// - image_providers: vec of (plugin_id, entity, priority, active, id)
    /// - download_providers: vec of (plugin_id, provider_id, name, priority, active)
    pub fn get_all_provider_config(&self) -> SqlResult<(
        Vec<(String, String, String, String, i64, String, i64, bool)>,
        Vec<(String, String, i64, bool, i64)>,
        Vec<(String, String, String, i64, bool)>,
    )> {
        let conn = self.conn.lock().unwrap();

        // All info types
        let mut info_stmt = conn.prepare(
            "SELECT type_id, name, entity, display_kind, sort_order, plugin_id, priority, active
             FROM information_types
             ORDER BY entity, sort_order, type_id, priority ASC"
        )?;
        let info_types = info_stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, bool>(7)?,
            ))
        })?.collect::<SqlResult<Vec<_>>>()?;

        // All image providers
        let mut img_stmt = conn.prepare(
            "SELECT plugin_id, entity, priority, active, id
             FROM image_providers
             ORDER BY entity, priority ASC"
        )?;
        let image_providers = img_stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?.collect::<SqlResult<Vec<_>>>()?;

        // All download providers
        let mut dl_stmt = conn.prepare(
            "SELECT plugin_id, provider_id, name, priority, active
             FROM download_providers ORDER BY priority ASC"
        )?;
        let download_providers = dl_stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })?.collect::<SqlResult<Vec<_>>>()?;

        Ok((info_types, image_providers, download_providers))
    }

    /// Update the priority of an image provider.
    pub fn update_image_provider_priority(&self, plugin_id: &str, entity: &str, priority: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE image_providers SET priority = ?1 WHERE plugin_id = ?2 AND entity = ?3",
            rusqlite::params![priority, plugin_id, entity],
        )?;
        Ok(())
    }

    /// Update the active state of an image provider.
    pub fn update_image_provider_active(&self, plugin_id: &str, entity: &str, active: bool) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE image_providers SET active = ?1 WHERE plugin_id = ?2 AND entity = ?3",
            rusqlite::params![active, plugin_id, entity],
        )?;
        Ok(())
    }

    /// Update the priority of an information type provider.
    pub fn update_info_type_priority(&self, type_id: &str, plugin_id: &str, priority: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE information_types SET priority = ?1 WHERE type_id = ?2 AND plugin_id = ?3",
            rusqlite::params![priority, type_id, plugin_id],
        )?;
        Ok(())
    }

    /// Update the active state of an information type provider.
    pub fn update_info_type_active(&self, type_id: &str, plugin_id: &str, active: bool) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE information_types SET active = ?1 WHERE type_id = ?2 AND plugin_id = ?3",
            rusqlite::params![active, type_id, plugin_id],
        )?;
        Ok(())
    }

    /// Reset provider priorities and sort orders to defaults.
    /// image_defaults: vec of (plugin_id, entity, default_priority) for image_providers.
    /// info_defaults: vec of (type_id, plugin_id, default_priority, default_sort_order) for information_types.
    pub fn reset_provider_priorities(&self, image_defaults: &[(String, String, i64)], info_defaults: &[(String, String, i64, i64)]) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("BEGIN")?;
        {
            let mut stmt = conn.prepare(
                "UPDATE image_providers SET priority = ?1 WHERE plugin_id = ?2 AND entity = ?3"
            )?;
            for d in image_defaults {
                stmt.execute(rusqlite::params![d.2, d.0, d.1])?;
            }
        }
        {
            let mut stmt = conn.prepare(
                "UPDATE information_types SET priority = ?1, sort_order = ?4 WHERE type_id = ?2 AND plugin_id = ?3"
            )?;
            for d in info_defaults {
                stmt.execute(rusqlite::params![d.2, d.0, d.1, d.3])?;
            }
        }
        conn.execute_batch("COMMIT")?;
        Ok(())
    }

    // ── Download Providers ──────────────────────────────────────

    /// Sync the download_providers table from plugin manifests.
    /// Takes vec of (plugin_id, provider_id, name, priority).
    /// Deactivates all rows, upserts current providers (preserving user-customized priorities),
    /// reactivates current providers, then deletes orphaned rows.
    pub fn sync_download_providers(&self, providers: &[(String, String, String, i64)]) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("BEGIN")?;
        // Deactivate all
        conn.execute("UPDATE download_providers SET active = 0", [])?;
        // Insert new providers (OR IGNORE preserves existing rows with user-customized priorities)
        {
            let mut insert_stmt = conn.prepare(
                "INSERT OR IGNORE INTO download_providers (plugin_id, provider_id, name, priority) VALUES (?1, ?2, ?3, ?4)"
            )?;
            for p in providers {
                insert_stmt.execute(rusqlite::params![p.0, p.1, p.2, p.3])?;
            }
        }
        // Update name for existing rows (in case the plugin renamed the provider)
        {
            let mut update_stmt = conn.prepare(
                "UPDATE download_providers SET name = ?1, active = 1 WHERE plugin_id = ?2 AND provider_id = ?3"
            )?;
            for p in providers {
                update_stmt.execute(rusqlite::params![p.2, p.0, p.1])?;
            }
        }
        // Delete orphaned rows (plugin_id not in the provided set)
        if providers.is_empty() {
            conn.execute("DELETE FROM download_providers", [])?;
        } else {
            let placeholders: Vec<String> = providers.iter().map(|_| "?".to_string()).collect();
            let sql = format!(
                "DELETE FROM download_providers WHERE plugin_id NOT IN ({})",
                placeholders.join(", ")
            );
            let params: Vec<&dyn rusqlite::types::ToSql> = providers.iter().map(|p| &p.0 as &dyn rusqlite::types::ToSql).collect();
            conn.execute(&sql, params.as_slice())?;
        }
        conn.execute_batch("COMMIT")?;
        Ok(())
    }

    /// Get all download providers ordered by priority ASC.
    /// Returns vec of (plugin_id, provider_id, name, priority, active).
    pub fn get_download_providers(&self) -> SqlResult<Vec<(String, String, String, i64, bool)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT plugin_id, provider_id, name, priority, active FROM download_providers
             ORDER BY priority ASC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })?.collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// Get active download providers ordered by priority ASC.
    /// Returns vec of (plugin_id, provider_id, name, priority).
    pub fn get_active_download_providers(&self) -> SqlResult<Vec<(String, String, String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT plugin_id, provider_id, name, priority FROM download_providers
             WHERE active = 1
             ORDER BY priority ASC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?.collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// Update the priority of a download provider.
    pub fn update_download_provider_priority(&self, plugin_id: &str, provider_id: &str, priority: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE download_providers SET priority = ?1 WHERE plugin_id = ?2 AND provider_id = ?3",
            rusqlite::params![priority, plugin_id, provider_id],
        )?;
        Ok(())
    }

    /// Update the active state of a download provider.
    pub fn update_download_provider_active(&self, plugin_id: &str, provider_id: &str, active: bool) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE download_providers SET active = ?1 WHERE plugin_id = ?2 AND provider_id = ?3",
            rusqlite::params![active, plugin_id, provider_id],
        )?;
        Ok(())
    }

    /// Reset download provider priorities to defaults.
    /// Takes vec of (plugin_id, provider_id, name, priority). Deletes all existing rows and reinserts with active=1.
    pub fn reset_download_provider_priorities(&self, defaults: &[(String, String, String, i64)]) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("BEGIN")?;
        conn.execute("DELETE FROM download_providers", [])?;
        {
            let mut stmt = conn.prepare(
                "INSERT INTO download_providers (plugin_id, provider_id, name, priority, active) VALUES (?1, ?2, ?3, ?4, 1)"
            )?;
            for d in defaults {
                stmt.execute(rusqlite::params![d.0, d.1, d.2, d.3])?;
            }
        }
        conn.execute_batch("COMMIT")?;
        Ok(())
    }
}
