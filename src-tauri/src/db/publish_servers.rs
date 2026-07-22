// Publish servers (Bandstatic push targets): name + base URL + upload-scoped
// personal access token, stored following the collections-credentials
// precedent. Shared types/helpers live in db/mod.rs; these are inherent
// impl Database methods.

use serde::Serialize;

use super::*;

/// A stored publish server as exposed to the frontend. Deliberately carries
/// NO token field — tokens never cross the IPC boundary. Internal callers
/// that need the credential use `get_publish_server_token`.
#[derive(Debug, Clone, Serialize)]
pub struct PublishServer {
    pub id: i64,
    pub name: String,
    pub url: String,
    pub artist_slug: String,
    pub created_at: i64,
}

impl Database {
    /// Store a publish server and return its row id. `url` should already be
    /// normalized (no trailing slash) and `artist_slug` validated via whoami.
    pub fn add_publish_server(
        &self,
        name: &str,
        url: &str,
        token: &str,
        artist_slug: &str,
    ) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO publish_servers (name, url, token, artist_slug) VALUES (?1, ?2, ?3, ?4)",
            params![name, url, token, artist_slug],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// List stored publish servers — token excluded (see `PublishServer`).
    pub fn list_publish_servers(&self) -> SqlResult<Vec<PublishServer>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, url, artist_slug, created_at FROM publish_servers ORDER BY id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PublishServer {
                id: row.get(0)?,
                name: row.get(1)?,
                url: row.get(2)?,
                artist_slug: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Internal-only credential lookup: `(url, token, artist_slug)` for a
    /// stored server, or `None` when the id is unknown. Never surfaced to the
    /// frontend — commands that return server info use `list_publish_servers`.
    pub fn get_publish_server_token(&self, id: i64) -> SqlResult<Option<(String, String, String)>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT url, token, artist_slug FROM publish_servers WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
    }

    pub fn remove_publish_server(&self, id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM publish_servers WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        Database::new_in_memory().unwrap()
    }

    #[test]
    fn test_publish_server_crud_round_trip() {
        let db = test_db();
        let id = db
            .add_publish_server("My Server", "https://music.example.com", "bst_abc123", "maria-callas")
            .unwrap();

        let servers = db.list_publish_servers().unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].id, id);
        assert_eq!(servers[0].name, "My Server");
        assert_eq!(servers[0].url, "https://music.example.com");
        assert_eq!(servers[0].artist_slug, "maria-callas");
        assert!(servers[0].created_at > 0);

        // Listing never serializes a token: the struct has no such field, and
        // neither does its JSON form.
        let json = serde_json::to_value(&servers[0]).unwrap();
        assert!(json.get("token").is_none(), "token must never reach the frontend");

        db.remove_publish_server(id).unwrap();
        assert!(db.list_publish_servers().unwrap().is_empty());
    }

    #[test]
    fn test_get_publish_server_token_internal_lookup() {
        let db = test_db();
        let id = db
            .add_publish_server("S", "https://h.example.com", "bst_secret", "slug-x")
            .unwrap();

        let creds = db.get_publish_server_token(id).unwrap();
        assert_eq!(
            creds,
            Some((
                "https://h.example.com".to_string(),
                "bst_secret".to_string(),
                "slug-x".to_string()
            ))
        );

        // Unknown id -> None (not an error).
        assert_eq!(db.get_publish_server_token(id + 999).unwrap(), None);
    }

    #[test]
    fn test_multiple_servers_listed_in_insertion_order() {
        let db = test_db();
        let a = db.add_publish_server("A", "https://a.example.com", "bst_a", "a").unwrap();
        let b = db.add_publish_server("B", "https://b.example.com", "bst_b", "b").unwrap();
        assert_ne!(a, b);

        let servers = db.list_publish_servers().unwrap();
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "A");
        assert_eq!(servers[1].name, "B");

        // Removing one leaves the other intact.
        db.remove_publish_server(a).unwrap();
        let servers = db.list_publish_servers().unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "B");
    }
}
