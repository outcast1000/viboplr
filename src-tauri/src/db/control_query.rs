// Ad-hoc read-only SQL for the control API (`POST /v1/query`).
//
// The caller is a local AI assistant holding the bearer token, so this is
// hygiene, not a security boundary (same philosophy as the plugin sandbox):
// the server is loopback-only and the token already gates it. Three
// fail-closed checks keep the verb inside the API's written-down rules:
//
// 1. **Read-only is SQLite's own verdict** — `sqlite3_stmt_readonly` on the
//    prepared statement, not SQL parsing. A statement that would write (or a
//    writing PRAGMA) is refused before it runs.
// 2. **One statement per request** — rusqlite's `prepare` rejects trailing
//    statements (`Error::MultipleStatement`), pinned by test.
// 3. **The credential tables are off-limits** — `collections` (subsonic
//    username/password) and `plugin_storage` (plugin-held secrets: sessions,
//    service passwords). "Credentials never leave the app" is an invariant
//    the hand-mapped `GET /v1/collections` already pins; ad-hoc SQL must not
//    be the way around it. The check is a case-insensitive substring scan,
//    which cannot miss a real reference (a quoted identifier still contains
//    the verbatim name; `"coll""ections"` names a *different* table) and may
//    only over-refuse — e.g. a string literal containing the word — which the
//    error message explains.
//
// The query runs on the app's shared connection (holding its mutex), so a
// progress-handler deadline bounds how long a runaway scan can stall the app.
use super::*;
use serde_json::{json, Value as JsonValue};

/// Tables ad-hoc SQL must never read. Keep this in step with what actually
/// stores credentials — everything else in the schema is library metadata the
/// API already serves through typed endpoints.
const QUERY_BLOCKED_TABLES: [&str; 2] = ["collections", "plugin_storage"];

/// Longest a query may hold the shared connection.
const QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// First blocked table the SQL mentions, if any. Substring on the lowercased
/// SQL: fail-closed (see module doc).
pub fn query_blocked_table(sql: &str) -> Option<&'static str> {
    let lower = sql.to_lowercase();
    QUERY_BLOCKED_TABLES.iter().copied().find(|t| lower.contains(t))
}

/// The semantics raw DDL can't teach. `GET /v1/query/schema` returns these
/// beside the CREATE statements so an assistant's first query joins the right
/// way — the classic silent mistake is `history_tracks.canonical_title =
/// tracks.title`, which runs fine and matches nothing accented.
const SCHEMA_NOTES: [&str; 8] = [
    "History is name-keyed and deliberately decoupled from library ids: history_plays -> history_tracks (canonical_title) -> history_artists (canonical_name). canonical_* = strip_diacritics(unicode_lower(text)); join history to library rows through that expression, never by id and never by raw title equality.",
    "tracks.path is RELATIVE to its collection's root, and the collections table is off-limits here — full playable URIs are not derivable via SQL; use the typed endpoints (/v1/tracks/{id}, /v1/status) for locations.",
    "entity_likes is the authoritative like store, keyed by normalized names: 'track:{artist}:{title}', 'artist:{name}', 'album:{album artist}:{title}', 'tag:{name}' — each segment strip_diacritics(lowercased). liked is 1 (like) or -1 (dislike); a 0 state is an absent row. tracks.liked is a mirror kept for list rendering.",
    "albums.artist_id is the ALBUM artist (ALBUMARTIST tag, falling back to the track artist) — a compilation is one album owned by 'Various Artists' while each track keeps its own artist_id.",
    "All timestamps (added_at, played_at, updated_at, first/last_played_at) are unix epoch seconds.",
    "Genres are tags: the tags table plus the track_tags join table. There is no genre column.",
    "For accent/case-insensitive matching use strip_diacritics(unicode_lower(col)) — that exact expression is also what the normalized indexes serve, so it stays fast.",
    "tracks_fts is an FTS5 table over tracks (MATCH syntax) — usually LIKE on the normalized expression is simpler.",
];

#[derive(serde::Serialize, Debug)]
pub struct ControlQuerySchema {
    pub tables: Vec<SchemaTable>,
    pub notes: Vec<&'static str>,
}

#[derive(serde::Serialize, Debug)]
pub struct SchemaTable {
    pub name: String,
    pub sql: String,
}

#[derive(serde::Serialize, Debug)]
pub struct ControlQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<JsonValue>>,
    #[serde(rename = "rowCount")]
    pub row_count: usize,
    pub truncated: bool,
}

fn json_param_to_sql(v: &JsonValue) -> Result<rusqlite::types::Value, String> {
    use rusqlite::types::Value;
    match v {
        JsonValue::Null => Ok(Value::Null),
        JsonValue::Bool(b) => Ok(Value::Integer(*b as i64)),
        JsonValue::Number(n) => n
            .as_i64()
            .map(Value::Integer)
            .or_else(|| n.as_f64().map(Value::Real))
            .ok_or_else(|| format!("unsupported numeric parameter: {}", n)),
        JsonValue::String(s) => Ok(Value::Text(s.clone())),
        _ => Err("array/object parameters are not supported — bind scalars".to_string()),
    }
}

impl Database {
    /// Run one read-only SQL statement with positional `?` parameters,
    /// returning up to `max_rows` rows (truncation flagged, never an error).
    /// Blob cells are summarized (`<blob N bytes>`), not returned.
    pub fn control_read_query(
        &self,
        sql: &str,
        params: &[JsonValue],
        max_rows: usize,
    ) -> Result<ControlQueryResult, String> {
        if sql.trim().is_empty() {
            return Err("sql must be a non-empty SELECT statement".to_string());
        }
        if let Some(t) = query_blocked_table(sql) {
            return Err(format!(
                "the query mentions \"{}\", which can carry credentials and is off-limits \
                 to the control API (GET /v1/collections serves the credential-free view). \
                 If the word only appeared in a string literal, rephrase the query.",
                t
            ));
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Deadline: checked every N VDBE ops; returning true interrupts the
        // statement, which surfaces as a rusqlite error mapped below.
        let deadline = std::time::Instant::now() + QUERY_TIMEOUT;
        // A handler that fails to install only costs the deadline, not the query.
        if let Err(e) = conn.progress_handler(10_000, Some(move || std::time::Instant::now() > deadline)) {
            log::warn!("control query: progress handler not installed: {}", e);
        }
        let result = Self::run_read_query(&conn, sql, params, max_rows);
        if let Err(e) = conn.progress_handler(0, None::<fn() -> bool>) {
            log::warn!("control query: progress handler not cleared: {}", e);
        }
        result.map_err(|e| {
            if e.contains("interrupted") {
                format!("query timed out after {}s", QUERY_TIMEOUT.as_secs())
            } else {
                e
            }
        })
    }

    /// The queryable schema: every table's DDL except the blocked pair (no
    /// point advertising what a query can't touch), SQLite internals and the
    /// FTS shadow tables — plus the semantic notes above.
    pub fn control_query_schema(&self) -> Result<ControlQuerySchema, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT name, sql FROM sqlite_master \
                 WHERE type = 'table' AND sql IS NOT NULL \
                   AND name NOT LIKE 'sqlite_%' \
                   AND name NOT LIKE 'tracks_fts_%' \
                   AND name NOT IN ('collections', 'plugin_storage') \
                 ORDER BY name",
            )
            .map_err(|e| e.to_string())?;
        let tables = stmt
            .query_map([], |row| {
                Ok(SchemaTable { name: row.get(0)?, sql: row.get(1)? })
            })
            .map_err(|e| e.to_string())?
            .collect::<SqlResult<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        Ok(ControlQuerySchema { tables, notes: SCHEMA_NOTES.to_vec() })
    }

    fn run_read_query(
        conn: &Connection,
        sql: &str,
        params: &[JsonValue],
        max_rows: usize,
    ) -> Result<ControlQueryResult, String> {
        // rusqlite's prepare rejects a second statement (MultipleStatement).
        let mut stmt = conn.prepare(sql).map_err(|e| format!("SQL error: {}", e))?;
        if !stmt.readonly() {
            return Err("only read-only statements are allowed".to_string());
        }
        let expected = stmt.parameter_count();
        if expected != params.len() {
            return Err(format!(
                "the statement takes {} parameter(s), {} given",
                expected,
                params.len()
            ));
        }
        let bound = params
            .iter()
            .map(json_param_to_sql)
            .collect::<Result<Vec<_>, String>>()?;
        let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let ncols = columns.len();

        let mut rows_out: Vec<Vec<JsonValue>> = Vec::new();
        let mut truncated = false;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(bound))
            .map_err(|e| format!("SQL error: {}", e))?;
        while let Some(row) = rows.next().map_err(|e| format!("query failed: {}", e))? {
            if rows_out.len() >= max_rows {
                truncated = true;
                break;
            }
            let mut out = Vec::with_capacity(ncols);
            for i in 0..ncols {
                let cell = match row.get_ref(i).map_err(|e| e.to_string())? {
                    rusqlite::types::ValueRef::Null => JsonValue::Null,
                    rusqlite::types::ValueRef::Integer(n) => json!(n),
                    rusqlite::types::ValueRef::Real(f) => json!(f),
                    rusqlite::types::ValueRef::Text(t) => {
                        JsonValue::String(String::from_utf8_lossy(t).into_owned())
                    }
                    rusqlite::types::ValueRef::Blob(b) => {
                        JsonValue::String(format!("<blob {} bytes>", b.len()))
                    }
                };
                out.push(cell);
            }
            rows_out.push(out);
        }
        Ok(ControlQueryResult {
            columns,
            row_count: rows_out.len(),
            rows: rows_out,
            truncated,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        let db = Database::new_in_memory().expect("in-memory db");
        let artist = db.get_or_create_artist("Björk").unwrap();
        let col = db
            .add_collection("local", "Test", Some("/test"), None, None, None, None, None)
            .unwrap();
        for (path, title) in [("a.mp3", "Jóga"), ("b.mp3", "Hyperballad"), ("c.mp3", "Army of Me")] {
            db.upsert_track(
                path, title, Some(artist), None, None,
                Some(200.0), Some("mp3"), None, None, Some(col.id), None,
            )
            .unwrap();
        }
        db
    }

    #[test]
    fn test_select_with_params_and_udfs() {
        let db = test_db();
        // The shared connection's UDFs are available, so the diacritic-
        // normalized lookups work exactly as the app's own queries do.
        let res = db
            .control_read_query(
                "SELECT title FROM tracks WHERE strip_diacritics(unicode_lower(title)) = ? ORDER BY title",
                &[serde_json::json!("joga")],
                10,
            )
            .unwrap();
        assert_eq!(res.columns, vec!["title"]);
        assert_eq!(res.rows, vec![vec![serde_json::json!("Jóga")]]);
        assert!(!res.truncated);
    }

    #[test]
    fn test_row_cap_reports_truncation_not_an_error() {
        let db = test_db();
        let res = db
            .control_read_query("SELECT id FROM tracks", &[], 2)
            .unwrap();
        assert_eq!(res.row_count, 2);
        assert!(res.truncated);
    }

    #[test]
    fn test_writes_are_refused_by_sqlites_own_verdict() {
        let db = test_db();
        for sql in [
            "DELETE FROM tracks",
            "UPDATE tracks SET title = 'x'",
            "INSERT INTO tags (name) VALUES ('x')",
            "DROP TABLE tracks",
            "CREATE TABLE x (id INTEGER)",
        ] {
            let err = db.control_read_query(sql, &[], 10).unwrap_err();
            assert!(
                err.contains("read-only"),
                "{:?} should be refused as non-read-only, got: {}",
                sql,
                err
            );
        }
    }

    #[test]
    fn test_credential_tables_are_refused_whatever_the_quoting() {
        let db = test_db();
        for sql in [
            "SELECT * FROM collections",
            "select username, password from COLLECTIONS",
            "SELECT * FROM \"collections\"",
            "SELECT * FROM [plugin_storage]",
            "SELECT t.title FROM tracks t JOIN collections c ON c.id = t.collection_id",
        ] {
            let err = db.control_read_query(sql, &[], 10).unwrap_err();
            assert!(err.contains("off-limits"), "{:?} should be blocked, got: {}", sql, err);
        }
        // Fail-closed means over-refusal is possible and accepted: the word in
        // a string literal still blocks, and the message says how to rephrase.
        assert!(db
            .control_read_query("SELECT 'my collections'", &[], 10)
            .is_err());
    }

    #[test]
    fn test_a_second_statement_is_refused() {
        let db = test_db();
        let err = db
            .control_read_query("SELECT 1; DELETE FROM tracks", &[], 10)
            .unwrap_err();
        assert!(err.contains("SQL error"), "got: {}", err);
        // And the write half must not have run.
        let count = db.control_read_query("SELECT COUNT(*) FROM tracks", &[], 1).unwrap();
        assert_eq!(count.rows[0][0], serde_json::json!(3));
    }

    #[test]
    fn test_parameter_arity_and_shape_are_checked() {
        let db = test_db();
        let err = db
            .control_read_query("SELECT * FROM tracks WHERE id = ?", &[], 10)
            .unwrap_err();
        assert!(err.contains("parameter"), "got: {}", err);
        let err = db
            .control_read_query(
                "SELECT * FROM tracks WHERE id = ?",
                &[serde_json::json!([1, 2])],
                10,
            )
            .unwrap_err();
        assert!(err.contains("scalars"), "got: {}", err);
    }

    #[test]
    fn test_schema_endpoint_lists_tables_but_never_the_blocked_or_shadow_ones() {
        let db = test_db();
        let schema = db.control_query_schema().unwrap();
        let names: Vec<&str> = schema.tables.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"tracks"));
        assert!(names.contains(&"history_plays"));
        assert!(!names.contains(&"collections"));
        assert!(!names.contains(&"plugin_storage"));
        assert!(!names.iter().any(|n| n.starts_with("tracks_fts_")));
        assert!(!schema.notes.is_empty());
    }

    #[test]
    fn test_schema_discovery_via_sqlite_master_works() {
        let db = test_db();
        let res = db
            .control_read_query(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tracks'",
                &[],
                10,
            )
            .unwrap();
        assert_eq!(res.rows.len(), 1);
    }
}
