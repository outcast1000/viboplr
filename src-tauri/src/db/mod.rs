use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use rusqlite::functions::FunctionFlags;
use std::path::Path;
use std::sync::Mutex;
use unicode_normalization::UnicodeNormalization;

use crate::models::*;

/// Strip all Unicode diacritics/combining marks from a string (works for any script).
pub fn strip_diacritics(s: &str) -> String {
    s.nfd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect()
}



/// SQL expression that reconstructs the full URI from the relative path stored in
/// `tracks.path` and the parent collection's root (path or url).
///
/// Local collections:   file://{collection.path}/{track.path}
/// Subsonic collections: subsonic://{host}/{track.path}
/// Fallback:            track.path as-is
const PATH_EXPR: &str =
    "CASE \
       WHEN co.kind = 'local' AND co.path IS NOT NULL \
         THEN 'file://' || co.path || '/' || t.path \
       WHEN co.kind = 'subsonic' AND co.url IS NOT NULL \
         THEN 'subsonic://' || REPLACE(REPLACE(RTRIM(co.url, '/'), 'https://', ''), 'http://', '') || '/' || t.path \
       ELSE t.path \
     END";

const TRACK_SELECT: &str =
    "SELECT t.id, \
     CASE \
       WHEN co.kind = 'local' AND co.path IS NOT NULL \
         THEN 'file://' || co.path || '/' || t.path \
       WHEN co.kind = 'subsonic' AND co.url IS NOT NULL \
         THEN 'subsonic://' || REPLACE(REPLACE(RTRIM(co.url, '/'), 'https://', ''), 'http://', '') || '/' || t.path \
       ELSE t.path \
     END, \
     t.title, t.artist_id, ar.name, t.album_id, al.title, COALESCE(t.year, al.year), \
     t.track_number, t.duration_secs, t.format, t.file_size, t.collection_id, co.name, t.liked, t.youtube_url, \
     t.added_at, t.modified_at \
     FROM tracks t LEFT JOIN artists ar ON t.artist_id = ar.id LEFT JOIN albums al ON t.album_id = al.id \
     LEFT JOIN collections co ON t.collection_id = co.id";

const ENABLED_COLLECTION_FILTER: &str =
    "AND (t.collection_id IS NULL OR co.enabled = 1)";

const ENABLED_COLLECTION_FILTER_STANDALONE: &str =
    "AND (t.collection_id IS NULL OR EXISTS (SELECT 1 FROM collections c WHERE c.id = t.collection_id AND c.enabled = 1))";

fn track_from_row(row: &rusqlite::Row) -> rusqlite::Result<Track> {
    let id: i64 = row.get(0)?;
    Ok(Track {
        id,
        key: format!("lib:{}", id),
        path: row.get(1)?,
        title: row.get(2)?,
        artist_id: row.get(3)?,
        artist_name: row.get(4)?,
        album_id: row.get(5)?,
        album_title: row.get(6)?,
        year: row.get(7)?,
        track_number: row.get(8)?,
        duration_secs: row.get(9)?,
        format: row.get(10)?,
        file_size: row.get(11)?,
        collection_id: row.get(12)?,
        collection_name: row.get(13)?,
        liked: row.get::<_, i32>(14).unwrap_or(0),
        youtube_url: row.get(15)?,
        added_at: row.get(16)?,
        modified_at: row.get(17)?,
    })
}

fn collection_from_row(row: &rusqlite::Row) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: row.get(0)?,
        kind: row.get(1)?,
        name: row.get(2)?,
        path: row.get(3)?,
        url: row.get(4)?,
        username: row.get(5)?,
        last_synced_at: row.get(6)?,
        auto_update: row.get::<_, i32>(7).unwrap_or(0) != 0,
        auto_update_interval_mins: row.get::<_, i64>(8).unwrap_or(60),
        enabled: row.get::<_, i32>(9).unwrap_or(1) != 0,
        last_sync_duration_secs: row.get(10)?,
        last_sync_error: row.get(11)?,
    })
}

fn album_from_row(row: &rusqlite::Row) -> rusqlite::Result<Album> {
    Ok(Album {
        id: row.get(0)?,
        title: row.get(1)?,
        artist_id: row.get(2)?,
        artist_name: row.get(3)?,
        year: row.get(4)?,
        track_count: row.get(5)?,
        liked: row.get::<_, i32>(6).unwrap_or(0),
    })
}

/// Maps sort field names to SQL expressions
fn sort_column_sql(field: Option<&str>) -> Option<String> {
    match field {
        Some("title") => Some("t.title".to_string()),
        Some("artist") => Some("COALESCE(ar.name, '')".to_string()),
        Some("album") => Some("COALESCE(al.title, '')".to_string()),
        Some("duration") => Some("COALESCE(t.duration_secs, 0)".to_string()),
        Some("num") => Some("COALESCE(t.track_number, 0)".to_string()),
        Some("path") => Some("t.path".to_string()),
        Some("year") => Some("COALESCE(t.year, al.year, 0)".to_string()),
        Some("quality") => Some("(CASE WHEN t.duration_secs > 0 AND t.file_size > 0 THEN t.file_size * 8.0 / t.duration_secs / 1000.0 ELSE 0 END)".to_string()),
        Some("size") => Some("COALESCE(t.file_size, 0)".to_string()),
        Some("collection") => Some("COALESCE(co.name, '')".to_string()),
        Some("added") => Some("COALESCE(t.added_at, 0)".to_string()),
        Some("modified") => Some("COALESCE(t.modified_at, 0)".to_string()),
        Some("random") => Some("RANDOM()".to_string()),
        Some("liked") => Some("COALESCE(t.liked, 0)".to_string()),
        _ => None,
    }
}

fn build_order_by(
    chain: &Option<Vec<SortKey>>,
    legacy_field: Option<&str>,
    legacy_dir: Option<&str>,
    liked_only_fallback: bool,
    liked_col: &str,
    tiebreaker: &str,
    column_resolver: impl Fn(&str) -> Option<String>,
    default_clause: &str,
) -> String {
    let dir_str = |d: &str| if d.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };

    if let Some(keys) = chain {
        if !keys.is_empty() {
            let parts: Vec<String> = keys.iter()
                .filter_map(|k| column_resolver(&k.field).map(|col| {
                    if col == "RANDOM()" { col } else { format!("{} {}", col, dir_str(&k.dir)) }
                }))
                .collect();
            if !parts.is_empty() {
                return format!("ORDER BY {}{}", parts.join(", "), tiebreaker);
            }
        }
    }

    let liked_prefix = if liked_only_fallback { format!("{} DESC, ", liked_col) } else { String::new() };

    if let Some(col) = column_resolver(legacy_field.unwrap_or("")) {
        let d = dir_str(legacy_dir.unwrap_or("asc"));
        return format!("ORDER BY {}{} {}{}", liked_prefix, col, d, tiebreaker);
    }

    if liked_only_fallback {
        return format!("ORDER BY {}{}", liked_prefix, default_clause);
    }

    format!("ORDER BY {}{}", default_clause, tiebreaker)
}

pub struct Database {
    conn: Mutex<Connection>,
}

// --- db submodules (split out of this file; inherent impl Database methods) ---
mod albums;
mod artists;
mod collections;
mod history;
mod image_failures;
pub mod likes;
mod playlists;
mod plugin_storage;
mod providers;
mod search;
mod tags;
mod tracks;

impl Database {
    fn register_sql_functions(conn: &Connection) -> SqlResult<()> {
        conn.create_scalar_function(
            "filename_from_path",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |ctx| {
                let path_str: String = ctx.get(0)?;
                let path = std::path::Path::new(&path_str);
                let filename = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                Ok(filename)
            },
        )?;

        conn.create_scalar_function(
            "strip_diacritics",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |ctx| {
                let s: String = ctx.get(0)?;
                Ok(strip_diacritics(&s))
            },
        )?;

        conn.create_scalar_function(
            "unicode_lower",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |ctx| {
                let s: String = ctx.get(0)?;
                Ok(s.to_lowercase())
            },
        )?;

        Ok(())
    }

    pub fn new(app_dir: &Path) -> SqlResult<Self> {
        let timer = crate::timing::timer();

        timer.time("db: create_app_dir", || std::fs::create_dir_all(app_dir).ok());

        let db_path = app_dir.join("viboplr.db");
        let conn = timer.time("db: open_connection", || Connection::open(db_path))?;

        timer.time("db: register_sql_functions", || Self::register_sql_functions(&conn))?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        timer.time("db: init_tables", || db.init_tables())?;
        timer.time("db: run_migrations", || db.run_migrations())?;
        // Crash safety: keep denormalized counts consistent on every startup.
        timer.time("db: recompute_counts", || db.recompute_counts())?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn new_in_memory() -> SqlResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::register_sql_functions(&conn)?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_tables()?;
        db.run_migrations()?;
        Ok(db)
    }

    fn init_tables(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
        conn.execute_batch("PRAGMA cache_size=-8000;")?;
        conn.execute_batch("PRAGMA mmap_size=268435456;")?;
        conn.execute_batch("PRAGMA temp_store=MEMORY;")?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS artists (
                id          INTEGER PRIMARY KEY,
                name        TEXT NOT NULL UNIQUE,
                liked       INTEGER NOT NULL DEFAULT 0,
                track_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS albums (
                id          INTEGER PRIMARY KEY,
                title       TEXT NOT NULL,
                artist_id   INTEGER REFERENCES artists(id),
                year        INTEGER,
                liked       INTEGER NOT NULL DEFAULT 0,
                track_count INTEGER NOT NULL DEFAULT 0,
                UNIQUE(title, artist_id)
            );

            CREATE TABLE IF NOT EXISTS tags (
                id          INTEGER PRIMARY KEY,
                name        TEXT NOT NULL UNIQUE,
                track_count INTEGER NOT NULL DEFAULT 0,
                liked       INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS collections (
                id                        INTEGER PRIMARY KEY,
                kind                      TEXT NOT NULL,
                name                      TEXT NOT NULL,
                path                      TEXT,
                url                       TEXT,
                username                  TEXT,
                password_token            TEXT,
                salt                      TEXT,
                auth_method               TEXT DEFAULT 'token',
                last_synced_at            INTEGER,
                auto_update               INTEGER NOT NULL DEFAULT 0,
                auto_update_interval_mins INTEGER NOT NULL DEFAULT 60,
                enabled                   INTEGER NOT NULL DEFAULT 1,
                last_sync_duration_secs   REAL,
                last_sync_error           TEXT
            );

            CREATE TABLE IF NOT EXISTS tracks (
                id            INTEGER PRIMARY KEY,
                path          TEXT NOT NULL,
                title         TEXT NOT NULL,
                artist_id     INTEGER REFERENCES artists(id),
                album_id      INTEGER REFERENCES albums(id),
                track_number  INTEGER,
                duration_secs REAL,
                format        TEXT,
                file_size     INTEGER,
                modified_at   INTEGER,
                added_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                collection_id INTEGER REFERENCES collections(id),
                liked         INTEGER NOT NULL DEFAULT 0,
                year          INTEGER,
                youtube_url   TEXT,
                UNIQUE(collection_id, path)
            );

            CREATE TABLE IF NOT EXISTS track_tags (
                track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
                tag_id   INTEGER REFERENCES tags(id) ON DELETE CASCADE,
                UNIQUE(track_id, tag_id)
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
                title,
                artist_name,
                album_title,
                tag_names,
                path,
                content='',
                contentless_delete=1,
                tokenize='unicode61 remove_diacritics 2'
            );

            CREATE TABLE IF NOT EXISTS history_artists (
                id              INTEGER PRIMARY KEY,
                canonical_name  TEXT NOT NULL UNIQUE,
                display_name    TEXT,
                first_played_at INTEGER,
                last_played_at  INTEGER,
                play_count      INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS history_tracks (
                id                INTEGER PRIMARY KEY,
                history_artist_id INTEGER NOT NULL REFERENCES history_artists(id),
                canonical_title   TEXT NOT NULL,
                display_title     TEXT,
                first_played_at   INTEGER,
                last_played_at    INTEGER,
                play_count        INTEGER NOT NULL DEFAULT 0,
                UNIQUE(history_artist_id, canonical_title)
            );

            CREATE TABLE IF NOT EXISTS history_plays (
                id               INTEGER PRIMARY KEY,
                history_track_id INTEGER NOT NULL REFERENCES history_tracks(id),
                played_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_history_plays_track ON history_plays(history_track_id);
            CREATE INDEX IF NOT EXISTS idx_history_plays_time  ON history_plays(played_at);

            CREATE TABLE IF NOT EXISTS image_fetch_failures (
                kind       TEXT NOT NULL,
                slug       TEXT NOT NULL,
                failed_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                UNIQUE(kind, slug)
            );

            CREATE TABLE IF NOT EXISTS plugin_storage (
                plugin_id  TEXT NOT NULL,
                key        TEXT NOT NULL,
                value      TEXT NOT NULL,
                PRIMARY KEY (plugin_id, key)
            );

            CREATE TABLE IF NOT EXISTS information_types (
                id           INTEGER PRIMARY KEY,
                type_id      TEXT NOT NULL,
                name         TEXT NOT NULL,
                entity       TEXT NOT NULL,
                display_kind TEXT NOT NULL,
                plugin_id    TEXT NOT NULL,
                ttl          INTEGER NOT NULL,
                sort_order   INTEGER NOT NULL DEFAULT 500,
                priority     INTEGER NOT NULL DEFAULT 500,
                active       INTEGER NOT NULL DEFAULT 1,
                description  TEXT NOT NULL DEFAULT '',
                UNIQUE (type_id, plugin_id)
            );

            CREATE TABLE IF NOT EXISTS information_values (
                information_type_id INTEGER NOT NULL REFERENCES information_types(id),
                entity_key          TEXT NOT NULL,
                value               TEXT NOT NULL,
                status              TEXT NOT NULL DEFAULT 'ok',
                fetched_at          INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                PRIMARY KEY (information_type_id, entity_key)
            );

            CREATE INDEX IF NOT EXISTS idx_info_values_entity ON information_values(entity_key);

            CREATE TABLE IF NOT EXISTS image_providers (
                id          INTEGER PRIMARY KEY,
                plugin_id   TEXT NOT NULL,
                entity      TEXT NOT NULL,
                priority    INTEGER NOT NULL DEFAULT 500,
                active      INTEGER NOT NULL DEFAULT 1,
                UNIQUE (plugin_id, entity)
            );

            CREATE TABLE IF NOT EXISTS download_providers (
                plugin_id   TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                name        TEXT NOT NULL,
                priority    INTEGER NOT NULL DEFAULT 500,
                active      INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (plugin_id, provider_id)
            );

            CREATE TABLE IF NOT EXISTS playlists (
                id          INTEGER PRIMARY KEY,
                name        TEXT NOT NULL,
                source      TEXT,
                saved_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                image_path  TEXT,
                description TEXT,
                metadata    TEXT,
                system_kind TEXT
            );
            -- The partial unique index on system_kind is created in run_migrations,
            -- NOT here: on an existing pre-feature DB the playlists table already
            -- exists without system_kind, so CREATE TABLE IF NOT EXISTS is a no-op
            -- and indexing system_kind here would fail before run_migrations adds
            -- the column.

            CREATE TABLE IF NOT EXISTS playlist_tracks (
                id            INTEGER PRIMARY KEY,
                playlist_id   INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                position      INTEGER NOT NULL,
                title         TEXT NOT NULL,
                artist_name   TEXT,
                album_name    TEXT,
                duration_secs REAL,
                source        TEXT,
                image_path    TEXT,
                UNIQUE(playlist_id, position)
            );

            CREATE TABLE IF NOT EXISTS entity_likes (
                kind        TEXT NOT NULL,
                entity_key  TEXT NOT NULL,
                liked       INTEGER NOT NULL,
                metadata    TEXT,
                updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                PRIMARY KEY (kind, entity_key)
            );
            CREATE INDEX IF NOT EXISTS idx_entity_likes_kind_liked
                ON entity_likes(kind, liked);

            CREATE TABLE IF NOT EXISTS plugin_schedules (
                plugin_id  TEXT NOT NULL,
                task_id    TEXT NOT NULL,
                interval_ms INTEGER NOT NULL,
                last_run   INTEGER,
                PRIMARY KEY (plugin_id, task_id)
            );

            CREATE TABLE IF NOT EXISTS db_version (
                version INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO db_version (rowid, version) VALUES (1, 1);

            CREATE INDEX IF NOT EXISTS idx_tracks_artist_id ON tracks(artist_id);
            CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id);
            CREATE INDEX IF NOT EXISTS idx_tracks_collection_id ON tracks(collection_id);
            CREATE INDEX IF NOT EXISTS idx_albums_artist_id ON albums(artist_id);
            CREATE INDEX IF NOT EXISTS idx_track_tags_tag_id ON track_tags(tag_id);
            CREATE INDEX IF NOT EXISTS idx_track_tags_track_id ON track_tags(track_id);
            ",
        )?;
        Ok(())
    }

    /// Schema migrations for upgrading existing databases.
    ///
    /// The PoC migration history was squashed into `init_tables`, and real
    /// pre-squash DBs carry inflated `db_version` values (e.g. 35) that no longer
    /// map to a meaningful schema generation. New migrations therefore must NOT
    /// gate on `db_version < N` — detect the needed change by schema presence
    /// (idempotent) and guard one-time data operations with an explicit marker.
    /// `recompute_counts()` runs separately at startup.
    fn run_migrations(&self) -> SqlResult<()> {
        // Universal Likes upgrade.
        //
        // This is intentionally NOT gated on a numeric `db_version < N` comparison.
        // The PoC migration history was squashed, so fresh DBs start at db_version 1
        // while real pre-squash DBs are stamped at high versions (e.g. 35). A numeric
        // gate would skip the upgrade on those legacy DBs, leaving `playlists.system_kind`
        // missing and `get_playlists` crashing. Instead we detect what's needed by
        // schema presence (idempotent) and guard the one-time backfill with a marker.

        // 1. Add playlists.system_kind if missing (fresh DBs already have it via init_tables;
        //    pre-feature DBs whose playlists table predates the column need it added here).
        let has_system_kind: bool = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('playlists') WHERE name = 'system_kind'",
                [], |r| r.get::<_, i64>(0),
            )? > 0
        };
        if !has_system_kind {
            let conn = self.conn.lock().unwrap();
            conn.execute("ALTER TABLE playlists ADD COLUMN system_kind TEXT", [])?;
        }

        // 2. Partial unique index + system playlists. Both idempotent; ensure_system_playlists
        //    runs every startup so the system playlists self-heal if deleted.
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_system_kind
                 ON playlists(system_kind) WHERE system_kind IS NOT NULL", [],
            )?;
        }
        self.ensure_system_playlists()?;

        // 3. One-time backfill of existing library likes into entity_likes, guarded by a
        //    marker in plugin_storage so we don't resurrect likes the user later cleared.
        let already_backfilled: bool = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM plugin_storage WHERE plugin_id = '__core__' AND key = 'entity_likes_backfilled'",
                [], |r| r.get::<_, i64>(0),
            ).unwrap_or(0) > 0
        };
        if !already_backfilled {
            let now_ts: i64 = {
                let conn = self.conn.lock().unwrap();
                conn.query_row("SELECT strftime('%s','now')", [], |r| r.get(0)).unwrap_or(0)
            };
            self.backfill_entity_likes_from_library(now_ts)?;
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO plugin_storage (plugin_id, key, value)
                 VALUES ('__core__', 'entity_likes_backfilled', '1')", [],
            )?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        Database::new_in_memory().expect("Failed to create in-memory database")
    }

    #[test]
    fn test_existing_db_upgrades_to_system_playlists() {
        // Simulate a pre-feature DB on disk: a `playlists` table WITHOUT system_kind,
        // then open it via Database::new (init_tables → run_migrations). Regression
        // guard: the partial unique index on system_kind must not be created in
        // init_tables, or this open fails with "no such column: system_kind".
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("viboplr.db");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE playlists (
                    id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT,
                    saved_at INTEGER NOT NULL DEFAULT 0, image_path TEXT,
                    description TEXT, metadata TEXT
                 );
                 CREATE TABLE db_version (version INTEGER NOT NULL);
                 INSERT INTO db_version (rowid, version) VALUES (1, 1);",
            ).unwrap();
        }
        // This is what crashes today.
        let db = Database::new(dir.path()).expect("Database::new on existing DB should succeed");
        let pls = db.get_playlists().unwrap();
        assert!(pls.iter().any(|p| p.system_kind.as_deref() == Some("liked")));
    }

    #[test]
    fn test_legacy_high_version_db_upgrades() {
        // Real pre-squash DBs are stamped at high db_version (e.g. 35), which a
        // `version < 2` migration gate would skip — leaving system_kind missing
        // and get_playlists crashing. The upgrade must be version-independent.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("viboplr.db");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, liked INTEGER NOT NULL DEFAULT 0, track_count INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE playlists (
                    id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT,
                    saved_at INTEGER NOT NULL DEFAULT 0, image_path TEXT,
                    description TEXT, metadata TEXT
                 );
                 CREATE TABLE db_version (version INTEGER NOT NULL);
                 INSERT INTO db_version (rowid, version) VALUES (1, 35);
                 INSERT INTO artists (name, liked) VALUES ('Björk', 1);",
            ).unwrap();
        }
        let db = Database::new(dir.path()).expect("legacy high-version DB should open");
        // get_playlists must not crash and system playlists must exist.
        let pls = db.get_playlists().unwrap();
        assert!(pls.iter().any(|p| p.system_kind.as_deref() == Some("liked")));
        assert!(pls.iter().any(|p| p.system_kind.as_deref() == Some("disliked")));
        // The pre-existing library like must have been backfilled.
        assert_eq!(db.get_entity_like_state("artist", "artist:bjork").unwrap(), 1);
    }

    /// Helper: create a test collection and return its id.
    /// Uses upsert semantics so repeated calls return the same collection.
    fn test_collection(db: &Database) -> i64 {
        // Check if our test collection already exists
        let collections = db.get_collections().unwrap();
        if let Some(c) = collections.iter().find(|c| c.name == "Test") {
            return c.id;
        }
        db.add_collection("local", "Test", Some("/test"), None, None, None, None, None)
            .expect("add_collection failed")
            .id
    }

    /// Helper: insert a track and return its id
    fn insert_track(db: &Database, path: &str, title: &str, artist_id: Option<i64>, album_id: Option<i64>) -> i64 {
        let cid = test_collection(db);
        db.upsert_track(path, title, artist_id, album_id, None, Some(180.0), Some("mp3"), Some(5_000_000), None, Some(cid), None)
            .expect("upsert_track failed")
    }

    #[test]
    fn test_upsert_and_get_track() {
        let db = test_db();
        let cid = test_collection(&db);
        let artist_id = db.get_or_create_artist("Pink Floyd").unwrap();
        let album_id = db.get_or_create_album("Dark Side", Some(artist_id), Some(1973)).unwrap();
        let track_id = db.upsert_track(
            "music/time.mp3", "Time", Some(artist_id), Some(album_id),
            Some(4), Some(413.0), Some("mp3"), Some(10_000_000), None, Some(cid), None,
        ).unwrap();

        let track = db.get_track_by_id(track_id).unwrap();
        assert_eq!(track.title, "Time");
        assert_eq!(track.artist_name.as_deref(), Some("Pink Floyd"));
        assert_eq!(track.album_title.as_deref(), Some("Dark Side"));
        assert_eq!(track.track_number, Some(4));
        assert_eq!(track.duration_secs, Some(413.0));
        assert_eq!(track.format.as_deref(), Some("mp3"));
        assert_eq!(track.year, Some(1973));
        assert_eq!(track.liked, 0);
    }

    #[test]
    fn test_upsert_track_deduplication() {
        let db = test_db();
        let cid = test_collection(&db);
        let id1 = db.upsert_track(
            "music/song.mp3", "Song V1", None, None,
            None, Some(180.0), Some("mp3"), Some(5_000_000), None, Some(cid), None,
        ).unwrap();
        let id2 = db.upsert_track(
            "music/song.mp3", "Song V2", None, None,
            None, Some(200.0), Some("mp3"), None, None, Some(cid), None,
        ).unwrap();

        assert_eq!(id1, id2, "upsert should return same id for same path");
        let track = db.get_track_by_id(id1).unwrap();
        assert_eq!(track.title, "Song V2", "title should be updated");
    }

    #[test]
    fn test_artist_crud() {
        let db = test_db();
        let id1 = db.get_or_create_artist("Radiohead").unwrap();
        let id2 = db.get_or_create_artist("Radiohead").unwrap();
        assert_eq!(id1, id2, "should return existing artist");

        let id3 = db.get_or_create_artist("Björk").unwrap();
        assert_ne!(id1, id3, "different artist should get different id");
    }

    #[test]
    fn test_album_crud() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Pink Floyd").unwrap();

        let id1 = db.get_or_create_album("The Wall", Some(artist_id), Some(1979)).unwrap();
        let id2 = db.get_or_create_album("The Wall", Some(artist_id), None).unwrap();
        assert_eq!(id1, id2, "same title+artist should return existing album");

        let id3 = db.get_or_create_album("The Wall", None, None).unwrap();
        assert_ne!(id1, id3, "NULL artist_id should create separate album");
    }

    #[test]
    fn test_get_artist_by_id() {
        let db = test_db();
        let id = db.get_or_create_artist("Radiohead").unwrap();

        let found = db.get_artist_by_id(id).unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().name, "Radiohead");

        let missing = db.get_artist_by_id(99999).unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn test_get_album_by_id() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Pink Floyd").unwrap();
        let album_id = db.get_or_create_album("The Wall", Some(artist_id), Some(1979)).unwrap();

        let found = db.get_album_by_id(album_id).unwrap();
        assert!(found.is_some());
        let album = found.unwrap();
        assert_eq!(album.title, "The Wall");
        assert_eq!(album.artist_name.as_deref(), Some("Pink Floyd"));
        assert_eq!(album.year, Some(1979));

        let missing = db.get_album_by_id(99999).unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn test_get_albums_sort_added_desc() {
        let db = test_db();
        let collection_id = test_collection(&db);

        let a1 = db.get_or_create_artist("Artist A").unwrap();
        let a2 = db.get_or_create_artist("Artist B").unwrap();
        let alb1 = db.get_or_create_album("Old Album", Some(a1), None).unwrap();
        let alb2 = db.get_or_create_album("New Album", Some(a2), None).unwrap();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO tracks (path, title, artist_id, album_id, collection_id, added_at)
                 VALUES ('/old.mp3', 'Old', ?1, ?2, ?3, 1000)",
                params![a1, alb1, collection_id],
            ).unwrap();
            conn.execute(
                "INSERT INTO tracks (path, title, artist_id, album_id, collection_id, added_at)
                 VALUES ('/new.mp3', 'New', ?1, ?2, ?3, 2000)",
                params![a2, alb2, collection_id],
            ).unwrap();
        }
        db.recompute_counts().unwrap();

        let albums = db.get_albums_sorted(None, Some("added_desc"), false).unwrap();
        assert_eq!(albums.len(), 2);
        assert_eq!(albums[0].title, "New Album");
        assert_eq!(albums[1].title, "Old Album");
    }

    #[test]
    fn test_get_tag_by_id() {
        let db = test_db();
        let id = db.get_or_create_tag("Rock").unwrap();

        let found = db.get_tag_by_id(id).unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().name, "Rock");

        let missing = db.get_tag_by_id(99999).unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn test_tags_many_to_many() {
        let db = test_db();
        let track_id = insert_track(&db, "music/song.mp3", "Song", None, None);
        let tag_rock = db.get_or_create_tag("Rock").unwrap();
        let tag_alt = db.get_or_create_tag("Alternative").unwrap();

        db.add_track_tag(track_id, tag_rock).unwrap();
        db.add_track_tag(track_id, tag_alt).unwrap();
        // Duplicate should be ignored
        db.add_track_tag(track_id, tag_rock).unwrap();

        let tags = db.get_tags_for_track(track_id).unwrap();
        assert_eq!(tags.len(), 2);
        let names: Vec<&str> = tags.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"Alternative"));
        assert!(names.contains(&"Rock"));
    }

    #[test]
    fn test_apply_tags_bulk_updates_fts_per_track() {
        let db = test_db();
        let t1 = insert_track(&db, "a.mp3", "Alpha", None, None);
        let t2 = insert_track(&db, "b.mp3", "Beta", None, None);
        let t3 = insert_track(&db, "c.mp3", "Gamma", None, None);
        db.rebuild_fts().unwrap();

        db.apply_tags_bulk(&[
            (t1, vec!["Ambient".to_string(), "Electronic".to_string()]),
            (t2, vec!["Rock".to_string()]),
            // t3 intentionally untouched
        ]).unwrap();

        // Tags associated correctly
        assert_eq!(db.get_tags_for_track(t1).unwrap().len(), 2);
        assert_eq!(db.get_tags_for_track(t2).unwrap().len(), 1);
        assert_eq!(db.get_tags_for_track(t3).unwrap().len(), 0);

        // FTS reflects new tag names for both touched tracks, no rebuild needed
        let hits = db.get_tracks(&TrackQuery { query: Some("Ambient".to_string()), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, t1);

        let hits = db.get_tracks(&TrackQuery { query: Some("Rock".to_string()), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, t2);

        // Bulk with an already-tagged track + a new tag merges (INSERT OR IGNORE)
        db.apply_tags_bulk(&[(t1, vec!["Ambient".to_string(), "Chill".to_string()])]).unwrap();
        let tags = db.get_tags_for_track(t1).unwrap();
        assert_eq!(tags.len(), 3);

        // Empty input is a no-op, not an error
        db.apply_tags_bulk(&[]).unwrap();
    }

    #[test]
    fn test_update_fts_for_track_reflects_tag_changes() {
        let db = test_db();
        let track_id = insert_track(&db, "music/song.mp3", "Melody", None, None);
        db.rebuild_fts().unwrap();

        // No tag yet — searching for "Jazz" returns nothing
        let hits = db.get_tracks(&TrackQuery { query: Some("Jazz".to_string()), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(hits.len(), 0);

        let tag_id = db.get_or_create_tag("Jazz").unwrap();
        db.add_track_tag(track_id, tag_id).unwrap();
        db.update_fts_for_track(track_id).unwrap();

        let hits = db.get_tracks(&TrackQuery { query: Some("Jazz".to_string()), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, track_id);
    }

    #[test]
    fn test_search_fts() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Pink Floyd").unwrap();
        let album_id = db.get_or_create_album("Dark Side", Some(artist_id), None).unwrap();
        insert_track(&db, "music/time.mp3", "Time", Some(artist_id), Some(album_id));
        insert_track(&db, "music/money.mp3", "Money", Some(artist_id), Some(album_id));
        insert_track(&db, "music/creep.mp3", "Creep", None, None);

        db.rebuild_fts().unwrap();

        // Search by title
        let results = db.get_tracks(&TrackQuery { query: Some("Time".to_string()), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Time");

        // Search by artist
        let results = db.get_tracks(&TrackQuery { query: Some("Pink Floyd".to_string()), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 2);

        // Search by album
        let results = db.get_tracks(&TrackQuery { query: Some("Dark Side".to_string()), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_search_with_filters() {
        let db = test_db();
        let artist1 = db.get_or_create_artist("Artist A").unwrap();
        let artist2 = db.get_or_create_artist("Artist B").unwrap();
        let album1 = db.get_or_create_album("Album X", Some(artist1), None).unwrap();
        let tag_rock = db.get_or_create_tag("Rock").unwrap();

        let t1 = insert_track(&db, "a1.mp3", "Song Alpha", Some(artist1), Some(album1));
        insert_track(&db, "a2.mp3", "Song Alpha Two", Some(artist2), None);
        db.add_track_tag(t1, tag_rock).unwrap();
        db.toggle_liked("tracks", t1, 1).unwrap();

        db.rebuild_fts().unwrap();

        // Filter by artist
        let results = db.get_tracks(&TrackQuery { query: Some("Song".to_string()), artist_id: Some(artist1), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Song Alpha");

        // Filter by album
        let results = db.get_tracks(&TrackQuery { query: Some("Song".to_string()), album_id: Some(album1), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 1);

        // Filter by tag
        let results = db.get_tracks(&TrackQuery { query: Some("Song".to_string()), tag_id: Some(tag_rock), limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 1);

        // Filter liked only
        let results = db.get_tracks(&TrackQuery { query: Some("Song".to_string()), liked_only: true, limit: Some(100), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Song Alpha");
    }

    #[test]
    fn test_play_history() {
        let db = test_db();
        let t1 = insert_track(&db, "a.mp3", "Song A", None, None);
        let t2 = insert_track(&db, "b.mp3", "Song B", None, None);

        db.record_play(t1).unwrap();
        db.record_play(t1).unwrap(); // deduplicated (same track within 30s)
        db.record_play(t2).unwrap();

        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 2); // deduped: Song A once + Song B once

        let most = db.get_history_most_played(10).unwrap();
        assert_eq!(most.len(), 2);
        assert!(most.iter().all(|m| m.play_count == 1));
    }

    #[test]
    fn test_play_history_dedup() {
        let db = test_db();
        let t1 = insert_track(&db, "a.mp3", "Song A", None, None);
        let t2 = insert_track(&db, "b.mp3", "Song B", None, None);

        // Same track twice in quick succession → deduplicated
        db.record_play(t1).unwrap();
        db.record_play(t1).unwrap();
        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 1);

        // Different tracks are NOT deduplicated
        db.record_play(t2).unwrap();
        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 2);
    }

    #[test]
    fn test_collection_crud() {
        let db = test_db();
        let col = db.add_collection("local", "My Music", Some("/music"), None, None, None, None, None).unwrap();
        assert_eq!(col.kind, "local");
        assert_eq!(col.name, "My Music");
        assert_eq!(col.path.as_deref(), Some("/music"));
        assert!(col.enabled);

        let collections = db.get_collections().unwrap();
        assert_eq!(collections.len(), 1);

        db.update_collection(col.id, "Renamed", true, 30, false).unwrap();
        let updated = db.get_collection_by_id(col.id).unwrap();
        assert_eq!(updated.name, "Renamed");
        assert!(updated.auto_update);
        assert_eq!(updated.auto_update_interval_mins, 30);
        assert!(!updated.enabled);

        db.remove_collection(col.id).unwrap();
        let collections = db.get_collections().unwrap();
        assert!(collections.is_empty());
    }

    #[test]
    fn test_collection_stats() {
        let db = test_db();
        let col = db.add_collection("local", "Music", Some("/music"), None, None, None, None, None).unwrap();

        db.upsert_track("a.mp3", "Song A", None, None, None, Some(180.0), Some("mp3"), Some(5_000_000), None, Some(col.id), None).unwrap();
        db.upsert_track("b.flac", "Song B", None, None, None, Some(240.0), Some("flac"), Some(30_000_000), None, Some(col.id), None).unwrap();
        db.upsert_track("c.mp4", "Video C", None, None, None, Some(300.0), Some("mp4"), Some(100_000_000), None, Some(col.id), None).unwrap();

        let stats = db.get_collection_stats().unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].collection_id, col.id);
        assert_eq!(stats[0].track_count, 3);
        assert_eq!(stats[0].video_count, 1);
        assert_eq!(stats[0].total_size, 135_000_000);
        assert!((stats[0].total_duration - 720.0).abs() < 0.01);
    }

    #[test]
    fn test_strip_diacritics() {
        assert_eq!(strip_diacritics("café"), "cafe");
        assert_eq!(strip_diacritics("naïve"), "naive");
        assert_eq!(strip_diacritics("Björk"), "Bjork");
        assert_eq!(strip_diacritics("Sigur Rós"), "Sigur Ros");
        assert_eq!(strip_diacritics("hello"), "hello");
        assert_eq!(strip_diacritics(""), "");
    }

    #[test]
    fn test_history_record_and_query() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Radiohead").unwrap();
        let track_id = insert_track(&db, "music/creep.mp3", "Creep", Some(artist_id), None);

        db.record_history_play(track_id).unwrap();

        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].display_title, "Creep");
        assert_eq!(recent[0].display_artist.as_deref(), Some("Radiohead"));
        assert_eq!(recent[0].play_count, 1);
    }

    #[test]
    fn test_history_ghost_entries() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Nirvana").unwrap();
        let track_id = insert_track(&db, "music/smells.mp3", "Smells Like Teen Spirit", Some(artist_id), None);

        db.record_history_play(track_id).unwrap();

        // Soft-delete the track
        db.delete_tracks_by_ids(&[track_id]).unwrap();

        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].display_title, "Smells Like Teen Spirit");
    }

    #[test]
    fn test_history_reconnect() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Björk").unwrap();
        let track_id = insert_track(&db, "music/army.mp3", "Army of Me", Some(artist_id), None);

        db.record_history_play(track_id).unwrap();
        db.delete_tracks_by_ids(&[track_id]).unwrap();

        // Verify ghost
        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 1);

        // Re-add with same artist+title but different path
        let artist_id2 = db.get_or_create_artist("Björk").unwrap();
        let track_id2 = insert_track(&db, "new_music/army.mp3", "Army of Me", Some(artist_id2), None);

        // Reconnection happens when the track is played again
        db.record_history_play(track_id2).unwrap();
        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent[0].play_count, 1); // deduped within 30s, count unchanged
    }

    #[test]
    fn test_reconnect_history_track() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Radiohead").unwrap();
        let track_id = insert_track(&db, "music/creep.mp3", "Creep", Some(artist_id), None);

        db.record_history_play(track_id).unwrap();
        let recent = db.get_history_recent(10).unwrap();
        let ht_id = recent[0].history_track_id;

        // Delete track — becomes ghost
        db.delete_tracks_by_ids(&[track_id]).unwrap();

        // Re-add same song with different path
        let artist_id2 = db.get_or_create_artist("Radiohead").unwrap();
        let track_id2 = insert_track(&db, "new/creep.flac", "Creep", Some(artist_id2), None);

        // Dynamic reconnection
        let result = db.reconnect_history_track(ht_id).unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().id, track_id2);
    }

    #[test]
    fn test_reconnect_history_track_not_found() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Missing Artist").unwrap();
        let track_id = insert_track(&db, "music/gone.mp3", "Gone Song", Some(artist_id), None);

        db.record_history_play(track_id).unwrap();
        let recent = db.get_history_recent(10).unwrap();
        let ht_id = recent[0].history_track_id;

        db.delete_tracks_by_ids(&[track_id]).unwrap();

        // No matching track in library — should return None
        let result = db.reconnect_history_track(ht_id).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_reconnect_history_artist() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Portishead").unwrap();
        let track_id = insert_track(&db, "music/glory.mp3", "Glory Box", Some(artist_id), None);

        db.record_history_play(track_id).unwrap();

        // Get history artist id
        let artists = db.get_history_most_played_artists(10).unwrap();
        let ha_id = artists[0].history_artist_id;

        // Delete track (artist stays but history link breaks via ON DELETE SET NULL on track)
        db.delete_tracks_by_ids(&[track_id]).unwrap();

        // Reconnect artist — artist still exists in library
        let result = db.reconnect_history_artist(ha_id).unwrap();
        assert_eq!(result, Some(artist_id));
    }

    #[test]
    fn test_reconnect_history_artist_not_found() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Ephemeral Band").unwrap();
        let track_id = insert_track(&db, "music/temp.mp3", "Temp Song", Some(artist_id), None);

        db.record_history_play(track_id).unwrap();
        let artists = db.get_history_most_played_artists(10).unwrap();
        let ha_id = artists[0].history_artist_id;

        // Delete track and artist
        db.delete_tracks_by_ids(&[track_id]).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("DELETE FROM artists WHERE id = ?1", params![artist_id]).unwrap();
        }

        let result = db.reconnect_history_artist(ha_id).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_history_dedup() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Tool").unwrap();
        let track_id = insert_track(&db, "music/lateralus.mp3", "Lateralus", Some(artist_id), None);

        db.record_history_play(track_id).unwrap();
        // Second call within 30 seconds should be deduplicated
        db.record_history_play(track_id).unwrap();

        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].play_count, 1);
    }

    #[test]
    fn test_history_most_played() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Daft Punk").unwrap();
        let _t1 = insert_track(&db, "music/around.mp3", "Around the World", Some(artist_id), None);
        let _t2 = insert_track(&db, "music/harder.mp3", "Harder Better Faster", Some(artist_id), None);

        // Record plays with manual SQL to bypass dedup
        {
            let conn = db.conn.lock().unwrap();
            // t1: 3 plays
            for i in 0..3 {
                conn.execute(
                    "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
                     VALUES ('daft punk', 'Daft Punk', 1000, 1000, 0)
                     ON CONFLICT(canonical_name) DO NOTHING",
                    [],
                ).unwrap();
                let ha_id: i64 = conn.query_row("SELECT id FROM history_artists WHERE canonical_name = 'daft punk'", [], |r| r.get(0)).unwrap();
                conn.execute(
                    "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count)
                     VALUES (?1, 'around the world', 'Around the World', 1000, 1000, 0)
                     ON CONFLICT(history_artist_id, canonical_title) DO NOTHING",
                    params![ha_id],
                ).unwrap();
                conn.execute(
                    "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count)
                     VALUES (?1, 'harder better faster', 'Harder Better Faster', 1000, 1000, 0)
                     ON CONFLICT(history_artist_id, canonical_title) DO NOTHING",
                    params![ha_id],
                ).unwrap();
                let ht1_id: i64 = conn.query_row(
                    "SELECT id FROM history_tracks WHERE canonical_title = 'around the world'", [], |r| r.get(0),
                ).unwrap();
                let ht2_id: i64 = conn.query_row(
                    "SELECT id FROM history_tracks WHERE canonical_title = 'harder better faster'", [], |r| r.get(0),
                ).unwrap();
                conn.execute("INSERT INTO history_plays (history_track_id, played_at) VALUES (?1, ?2)", params![ht1_id, 1000 + i]).unwrap();
                if i < 1 {
                    conn.execute("INSERT INTO history_plays (history_track_id, played_at) VALUES (?1, ?2)", params![ht2_id, 2000 + i]).unwrap();
                }
            }
            // Update denormalized counts
            conn.execute_batch(
                "UPDATE history_tracks SET play_count = (SELECT COUNT(*) FROM history_plays WHERE history_track_id = history_tracks.id);
                 UPDATE history_artists SET play_count = (SELECT COALESCE(SUM(ht.play_count), 0) FROM history_tracks ht WHERE ht.history_artist_id = history_artists.id);"
            ).unwrap();
        }

        let most = db.get_history_most_played(10).unwrap();
        assert!(most.len() >= 2);
        assert_eq!(most[0].display_title, "Around the World");
        assert_eq!(most[0].play_count, 3);
        assert_eq!(most[1].display_title, "Harder Better Faster");
        assert_eq!(most[1].play_count, 1);
    }

    #[test]
    fn test_history_artist_stats() {
        let db = test_db();
        let a1 = db.get_or_create_artist("Artist A").unwrap();
        let a2 = db.get_or_create_artist("Artist B").unwrap();
        let _t1 = insert_track(&db, "music/t1.mp3", "Track 1", Some(a1), None);
        let _t2 = insert_track(&db, "music/t2.mp3", "Track 2", Some(a1), None);
        let _t3 = insert_track(&db, "music/t3.mp3", "Track 3", Some(a2), None);

        // Record via SQL to bypass dedup
        {
            let conn = db.conn.lock().unwrap();
            for (canonical_artist, display, canonical_title, disp_title, count) in [
                ("artist a", "Artist A", "track 1", "Track 1", 5),
                ("artist a", "Artist A", "track 2", "Track 2", 3),
                ("artist b", "Artist B", "track 3", "Track 3", 2),
            ] {
                conn.execute(
                    "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
                     VALUES (?1, ?2, 1000, 1000, 0) ON CONFLICT(canonical_name) DO NOTHING",
                    params![canonical_artist, display],
                ).unwrap();
                let ha_id: i64 = conn.query_row(
                    "SELECT id FROM history_artists WHERE canonical_name = ?1", params![canonical_artist], |r| r.get(0),
                ).unwrap();
                conn.execute(
                    "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count)
                     VALUES (?1, ?2, ?3, 1000, 1000, ?4) ON CONFLICT(history_artist_id, canonical_title) DO NOTHING",
                    params![ha_id, canonical_title, disp_title, count],
                ).unwrap();
            }
            conn.execute_batch(
                "UPDATE history_artists SET play_count = (SELECT COALESCE(SUM(ht.play_count), 0) FROM history_tracks ht WHERE ht.history_artist_id = history_artists.id);"
            ).unwrap();
        }

        let artists = db.get_history_most_played_artists(10).unwrap();
        assert_eq!(artists.len(), 2);
        assert_eq!(artists[0].display_name, "Artist A");
        assert_eq!(artists[0].play_count, 8); // 5 + 3
        assert_eq!(artists[0].track_count, 2);
        assert_eq!(artists[1].display_name, "Artist B");
        assert_eq!(artists[1].play_count, 2);
    }

    #[test]
    fn test_history_unicode_canonical() {
        let db = test_db();
        // Greek artist
        let a1 = db.get_or_create_artist("Σωκράτης").unwrap();
        let t1 = insert_track(&db, "music/greek.mp3", "Τραγούδι", Some(a1), None);
        db.record_history_play(t1).unwrap();

        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].display_artist.as_deref(), Some("Σωκράτης"));
        assert_eq!(recent[0].display_title, "Τραγούδι");

        // Cyrillic artist
        let a2 = db.get_or_create_artist("Кино").unwrap();
        let t2 = insert_track(&db, "music/russian.mp3", "Группа крови", Some(a2), None);
        db.record_history_play(t2).unwrap();

        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].display_artist.as_deref(), Some("Кино"));
    }

    #[test]
    fn test_track_rank() {
        let db = test_db();
        let a1 = db.get_or_create_artist("Artist A").unwrap();
        let _t1 = insert_track(&db, "music/r1.mp3", "Top Track", Some(a1), None);
        let _t2 = insert_track(&db, "music/r2.mp3", "Mid Track", Some(a1), None);
        let _t3 = insert_track(&db, "music/r3.mp3", "Low Track", Some(a1), None);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
                 VALUES ('artist a', 'Artist A', 1000, 1000, 15)",
                [],
            ).unwrap();
            let ha_id: i64 = conn.query_row(
                "SELECT id FROM history_artists WHERE canonical_name = 'artist a'", [], |r| r.get(0),
            ).unwrap();
            for (title, count) in [
                ("top track", 10),
                ("mid track", 5),
                ("low track", 2),
            ] {
                conn.execute(
                    "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count)
                     VALUES (?1, ?2, ?3, 1000, 1000, ?4)",
                    params![ha_id, title, title, count],
                ).unwrap();
            }
        }

        assert_eq!(db.get_track_rank("Top Track", Some("Artist A")).unwrap(), Some(1));
        assert_eq!(db.get_track_rank("Mid Track", Some("Artist A")).unwrap(), Some(2));
        assert_eq!(db.get_track_rank("Low Track", Some("Artist A")).unwrap(), Some(3));
    }

    #[test]
    fn test_track_rank_no_history() {
        let db = test_db();
        let a1 = db.get_or_create_artist("Artist A").unwrap();
        let _t1 = insert_track(&db, "music/norank.mp3", "No History", Some(a1), None);

        assert_eq!(db.get_track_rank("No History", Some("Artist A")).unwrap(), None);
    }

    #[test]
    fn test_artist_rank() {
        let db = test_db();
        let _a1 = db.get_or_create_artist("Top Artist").unwrap();
        let _a2 = db.get_or_create_artist("Low Artist").unwrap();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
                 VALUES ('top artist', 'Top Artist', 1000, 1000, 20)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
                 VALUES ('low artist', 'Low Artist', 1000, 1000, 5)",
                [],
            ).unwrap();
        }

        assert_eq!(db.get_artist_rank("Top Artist").unwrap(), Some(1));
        assert_eq!(db.get_artist_rank("Low Artist").unwrap(), Some(2));

        // No history artist
        let _a3 = db.get_or_create_artist("New Artist").unwrap();
        assert_eq!(db.get_artist_rank("New Artist").unwrap(), None);
    }

    #[test]
    fn test_info_upsert_and_get() {
        let db = test_db();
        db.info_sync_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 7776000, 200, 100, String::new()),
        ]).unwrap();
        let types = db.info_get_types_for_entity("artist").unwrap();
        let int_id = types[0].5[0].1;

        // No value yet
        assert!(db.info_get_value(int_id, "artist:Daft Punk").unwrap().is_none());

        // Insert
        db.info_upsert_value(int_id, "artist:Daft Punk", r#"{"summary":"bio"}"#, "ok").unwrap();
        let row = db.info_get_value(int_id, "artist:Daft Punk").unwrap().unwrap();
        assert_eq!(row.0, r#"{"summary":"bio"}"#);
        assert_eq!(row.1, "ok");
        assert!(row.2 > 0);

        // Upsert overwrites
        db.info_upsert_value(int_id, "artist:Daft Punk", "{}", "not_found").unwrap();
        let row = db.info_get_value(int_id, "artist:Daft Punk").unwrap().unwrap();
        assert_eq!(row.1, "not_found");
    }

    #[test]
    fn test_info_get_values_for_entity() {
        let db = test_db();
        db.info_sync_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 7776000, 200, 100, String::new()),
            ("similar_artists".into(), "Similar".into(), "artist".into(), "entity_list".into(),
             "lastfm".into(), 7776000, 300, 100, String::new()),
        ]).unwrap();
        let types = db.info_get_types_for_entity("artist").unwrap();
        let bio_id = types.iter().find(|t| t.0 == "artist_bio").unwrap().5[0].1;
        let similar_id = types.iter().find(|t| t.0 == "similar_artists").unwrap().5[0].1;

        db.info_upsert_value(bio_id, "artist:Daft Punk", r#"{"summary":"bio"}"#, "ok").unwrap();
        db.info_upsert_value(similar_id, "artist:Daft Punk", r#"{"items":[]}"#, "ok").unwrap();
        db.info_upsert_value(bio_id, "artist:Radiohead", r#"{"summary":"other"}"#, "ok").unwrap();

        let rows = db.info_get_values_for_entity("artist:Daft Punk").unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn test_info_delete_value() {
        let db = test_db();
        db.info_sync_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 7776000, 200, 100, String::new()),
        ]).unwrap();
        let types = db.info_get_types_for_entity("artist").unwrap();
        let int_id = types[0].5[0].1;

        db.info_upsert_value(int_id, "artist:Daft Punk", r#"{"summary":"bio"}"#, "ok").unwrap();
        db.info_delete_value(int_id, "artist:Daft Punk").unwrap();
        assert!(db.info_get_value(int_id, "artist:Daft Punk").unwrap().is_none());
    }

    #[test]
    fn test_info_sync_types_activates_and_deactivates() {
        let db = test_db();

        db.info_sync_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 7776000, 200, 100, String::new()),
            ("artist_tags".into(), "Tags".into(), "artist".into(), "tag_list".into(),
             "lastfm".into(), 7776000, 300, 100, String::new()),
        ]).unwrap();

        let types = db.info_get_types_for_entity("artist").unwrap();
        assert_eq!(types.len(), 2);

        // Sync with only one type — the other should be deactivated
        db.info_sync_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 7776000, 200, 100, String::new()),
        ]).unwrap();

        let types = db.info_get_types_for_entity("artist").unwrap();
        assert_eq!(types.len(), 1);
        assert_eq!(types[0].0, "artist_bio");
    }

    #[test]
    fn test_info_sync_updates_metadata() {
        let db = test_db();

        db.info_sync_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 7776000, 200, 100, String::new()),
        ]).unwrap();

        let types = db.info_get_types_for_entity("artist").unwrap();
        assert_eq!(types[0].1, "About");

        // Re-sync with updated name and ttl
        db.info_sync_types(&[
            ("artist_bio".into(), "Biography".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 86400, 200, 100, String::new()),
        ]).unwrap();

        let types = db.info_get_types_for_entity("artist").unwrap();
        assert_eq!(types.len(), 1);
        assert_eq!(types[0].1, "Biography");
        assert_eq!(types[0].3, 86400); // ttl updated
    }

    #[test]
    fn test_info_sync_reactivation_preserves_cached_values() {
        let db = test_db();

        db.info_sync_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 7776000, 200, 100, String::new()),
        ]).unwrap();
        let types = db.info_get_types_for_entity("artist").unwrap();
        let int_id = types[0].5[0].1;

        db.info_upsert_value(int_id, "artist:Daft Punk", r#"{"summary":"bio"}"#, "ok").unwrap();

        // Sync with empty list — type deactivated
        db.info_sync_types(&[]).unwrap();
        assert_eq!(db.info_get_types_for_entity("artist").unwrap().len(), 0);
        // Cached value still exists (query by integer id directly)
        assert!(db.info_get_value(int_id, "artist:Daft Punk").unwrap().is_some());

        // Re-sync — type reactivated, cached value still there
        db.info_sync_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 7776000, 200, 100, String::new()),
        ]).unwrap();
        let types = db.info_get_types_for_entity("artist").unwrap();
        assert_eq!(types.len(), 1);
        // Integer id is preserved across deactivation/reactivation
        assert_eq!(types[0].5[0].1, int_id);
        assert!(db.info_get_value(int_id, "artist:Daft Punk").unwrap().is_some());
    }

    #[test]
    fn test_info_provider_chain_ordering() {
        let db = test_db();

        // Two plugins provide the same type_id with different priorities
        db.info_sync_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 7776000, 200, 100, String::new()),
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "genius".into(), 7776000, 200, 200, String::new()),
        ]).unwrap();

        let types = db.info_get_types_for_entity("artist").unwrap();
        assert_eq!(types.len(), 1); // Grouped into one entry
        assert_eq!(types[0].5.len(), 2); // Two providers
        assert_eq!(types[0].5[0].0, "lastfm"); // Higher priority (lower value) first
        assert_eq!(types[0].5[1].0, "genius");
    }

    #[test]
    fn test_info_get_values_for_entity_returns_type_id() {
        let db = test_db();

        db.info_sync_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 7776000, 200, 100, String::new()),
        ]).unwrap();
        let types = db.info_get_types_for_entity("artist").unwrap();
        let int_id = types[0].5[0].1;

        db.info_upsert_value(int_id, "artist:Daft Punk", r#"{"summary":"bio"}"#, "ok").unwrap();

        let values = db.info_get_values_for_entity("artist:Daft Punk").unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].0, int_id);           // integer id
        assert_eq!(values[0].1, "artist_bio");     // string type_id
        assert_eq!(values[0].3, "ok");             // status
    }

    #[test]
    fn test_info_fk_constraint() {
        let db = test_db();
        // Inserting a value with a non-existent information_type_id should fail
        let result = db.info_upsert_value(99999, "artist:Daft Punk", "{}", "ok");
        assert!(result.is_err());
    }

    #[test]
    fn test_save_and_get_playlist() {
        let db = test_db();
        let id = db.save_playlist("Discover Weekly 15 Apr 2026", Some("spotify-playlist://abc123"), None, None, None).unwrap();
        assert!(id > 0);

        let playlists = db.get_playlists().unwrap();
        let user_playlists: Vec<_> = playlists.iter().filter(|p| p.system_kind.is_none()).collect();
        assert_eq!(user_playlists.len(), 1);
        assert_eq!(user_playlists[0].name, "Discover Weekly 15 Apr 2026");
        assert_eq!(user_playlists[0].source.as_deref(), Some("spotify-playlist://abc123"));
        assert_eq!(user_playlists[0].track_count, 0);
    }

    #[test]
    fn test_save_playlist_tracks() {
        let db = test_db();
        let playlist_id = db.save_playlist("Test Playlist", None, None, None, None).unwrap();

        db.save_playlist_tracks(playlist_id, &[
            ("Song A", Some("Artist A"), Some("Album A"), Some(210.0), Some("spotify-track://1"), None),
            ("Song B", Some("Artist B"), None, Some(180.0), Some("file:///music/b.flac"), None),
        ]).unwrap();

        let tracks = db.get_playlist_tracks(playlist_id).unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].position, 0);
        assert_eq!(tracks[0].title, "Song A");
        assert_eq!(tracks[0].artist_name.as_deref(), Some("Artist A"));
        assert_eq!(tracks[1].position, 1);
        assert_eq!(tracks[1].title, "Song B");
    }

    #[test]
    fn test_entity_likes_table_exists() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // Insert a row directly — fails if table/columns are missing.
        conn.execute(
            "INSERT INTO entity_likes (kind, entity_key, liked, metadata, updated_at)
             VALUES ('track', 'track:bjork:joga', 1, '{}', 100)",
            [],
        ).unwrap();
        let liked: i32 = conn.query_row(
            "SELECT liked FROM entity_likes WHERE kind='track' AND entity_key='track:bjork:joga'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(liked, 1);
    }

    #[test]
    fn test_playlists_system_kind_column_exists() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        // Use a distinct kind: the v2 migration already creates 'liked'/'disliked'
        // system playlists, and system_kind is UNIQUE.
        conn.execute(
            "INSERT INTO playlists (name, system_kind) VALUES ('Test System', 'test-kind')",
            [],
        ).unwrap();
        let kind: Option<String> = conn.query_row(
            "SELECT system_kind FROM playlists WHERE name='Test System'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(kind.as_deref(), Some("test-kind"));
    }

    #[test]
    fn test_delete_playlist_cascades() {
        let db = test_db();
        let playlist_id = db.save_playlist("To Delete", None, None, None, None).unwrap();
        db.save_playlist_tracks(playlist_id, &[
            ("Song", None, None, None, None, None),
        ]).unwrap();
        assert_eq!(db.get_playlist_tracks(playlist_id).unwrap().len(), 1);

        db.delete_playlist(playlist_id).unwrap();
        let user_playlists: Vec<_> = db.get_playlists().unwrap().into_iter().filter(|p| p.system_kind.is_none()).collect();
        assert_eq!(user_playlists.len(), 0);
        assert_eq!(db.get_playlist_tracks(playlist_id).unwrap().len(), 0);
    }

    #[test]
    fn test_save_playlist_description_and_metadata() {
        let db = test_db();
        let meta_json = r#"{"spotifyId":"abc123","section":"Made for You","sourceDate":"2026-05-03T10:00:00Z"}"#;
        let id = db.save_playlist(
            "Discover Weekly",
            Some("spotify://playlists/abc123"),
            None,
            Some("Your weekly mixtape of fresh music"),
            Some(meta_json),
        ).unwrap();

        let playlists = db.get_playlists().unwrap();
        let user_playlists: Vec<_> = playlists.iter().filter(|p| p.system_kind.is_none()).collect();
        assert_eq!(user_playlists.len(), 1);
        let pl = user_playlists[0];
        assert_eq!(pl.id, id);
        assert_eq!(pl.name, "Discover Weekly");
        assert_eq!(pl.source.as_deref(), Some("spotify://playlists/abc123"));
        assert_eq!(pl.description.as_deref(), Some("Your weekly mixtape of fresh music"));
        assert_eq!(pl.metadata.as_deref(), Some(meta_json));
    }

    #[test]
    fn test_save_playlist_description_and_metadata_nullable() {
        let db = test_db();
        let id = db.save_playlist("Empty Playlist", None, None, None, None).unwrap();

        let playlists = db.get_playlists().unwrap();
        let pl = playlists.iter().find(|p| p.id == id).unwrap();
        assert!(pl.description.is_none());
        assert!(pl.metadata.is_none());
    }

    #[test]
    fn test_playlist_mixtape_import_roundtrip() {
        let db = test_db();
        // Simulate what the mixtape import does: extract source/description from
        // a flat metadata map, save to DB, then verify everything is retrievable.
        let manifest_metadata: std::collections::HashMap<String, String> = [
            ("source".to_string(), "spotify://playlists/abc123".to_string()),
            ("description".to_string(), "Your weekly mixtape".to_string()),
            ("Section".to_string(), "Made for You".to_string()),
            ("sourceDate".to_string(), "2026-05-03T10:00:00Z".to_string()),
        ].into_iter().collect();

        let source = manifest_metadata.get("source").cloned();
        let description = manifest_metadata.get("description").cloned();
        let rest_meta: std::collections::HashMap<&str, &str> = manifest_metadata.iter()
            .filter(|(k, _)| k.as_str() != "source" && k.as_str() != "description")
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let metadata_json = if rest_meta.is_empty() { None } else { serde_json::to_string(&rest_meta).ok() };

        let id = db.save_playlist(
            "Discover Weekly",
            source.as_deref(),
            None,
            description.as_deref(),
            metadata_json.as_deref(),
        ).unwrap();

        let playlists = db.get_playlists().unwrap();
        let pl = playlists.iter().find(|p| p.id == id).unwrap();
        assert_eq!(pl.name, "Discover Weekly");
        assert_eq!(pl.source.as_deref(), Some("spotify://playlists/abc123"));
        assert_eq!(pl.description.as_deref(), Some("Your weekly mixtape"));

        // Verify the remaining metadata was stored as JSON with both keys
        let meta: serde_json::Value = serde_json::from_str(pl.metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["Section"], "Made for You");
        assert_eq!(meta["sourceDate"], "2026-05-03T10:00:00Z");
        // source and description should NOT be in the JSON blob
        assert!(meta.get("source").is_none());
        assert!(meta.get("description").is_none());
    }

    #[test]
    fn test_find_track_by_metadata_exact() {
        let db = test_db();
        let artist = db.get_or_create_artist("Radiohead").unwrap();
        let album = db.get_or_create_album("OK Computer", Some(artist), Some(1997)).unwrap();
        let track_id = insert_track(&db, "music/paranoid.mp3", "Paranoid Android", Some(artist), Some(album));

        // Full match: title + artist + album
        let result = db.find_track_by_metadata("Paranoid Android", Some("Radiohead"), Some("OK Computer")).unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().id, track_id);
    }

    #[test]
    fn test_find_track_by_metadata_artist_only() {
        let db = test_db();
        let artist = db.get_or_create_artist("Björk").unwrap();
        let _album = db.get_or_create_album("Homogenic", Some(artist), Some(1997)).unwrap();
        let track_id = insert_track(&db, "music/joga.mp3", "Jóga", Some(artist), None);

        // title + artist (no album match needed)
        let result = db.find_track_by_metadata("Jóga", Some("Björk"), Some("Wrong Album")).unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().id, track_id);
    }

    #[test]
    fn test_find_track_by_metadata_diacritics() {
        let db = test_db();
        let artist = db.get_or_create_artist("Björk").unwrap();
        insert_track(&db, "music/joga.mp3", "Jóga", Some(artist), None);

        // Diacritic-insensitive matching
        let result = db.find_track_by_metadata("Joga", Some("Bjork"), None).unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().title, "Jóga");
    }

    #[test]
    fn test_find_track_by_metadata_title_only() {
        let db = test_db();
        insert_track(&db, "music/creep.mp3", "Creep", None, None);

        // No artist — match on title only
        let result = db.find_track_by_metadata("Creep", None, None).unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().title, "Creep");
    }

    #[test]
    fn test_find_track_by_metadata_no_match() {
        let db = test_db();
        insert_track(&db, "music/song.mp3", "Existing Song", None, None);

        let result = db.find_track_by_metadata("Nonexistent", Some("Nobody"), None).unwrap();
        assert!(result.is_none());
    }

    // ── search_all tests ────────────────────────────────────────

    #[test]
    fn test_search_all_finds_artists_via_fts() {
        let db = test_db();
        let a1 = db.get_or_create_artist("Daft Punk").unwrap();
        let a2 = db.get_or_create_artist("Radiohead").unwrap();
        insert_track(&db, "music/around.mp3", "Around the World", Some(a1), None);
        insert_track(&db, "music/creep.mp3", "Creep", Some(a2), None);
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let results = db.search_all("Daft", 10, 10, 10).unwrap();
        assert_eq!(results.artists.len(), 1);
        assert_eq!(results.artists[0].name, "Daft Punk");
    }

    #[test]
    fn test_search_all_finds_albums_via_fts() {
        let db = test_db();
        let artist = db.get_or_create_artist("Pink Floyd").unwrap();
        let album = db.get_or_create_album("Dark Side of the Moon", Some(artist), Some(1973)).unwrap();
        insert_track(&db, "music/time.mp3", "Time", Some(artist), Some(album));
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let results = db.search_all("Dark Side", 10, 10, 10).unwrap();
        assert_eq!(results.albums.len(), 1);
        assert_eq!(results.albums[0].title, "Dark Side of the Moon");
    }

    #[test]
    fn test_search_all_finds_tracks_via_fts() {
        let db = test_db();
        let artist = db.get_or_create_artist("Radiohead").unwrap();
        insert_track(&db, "music/creep.mp3", "Creep", Some(artist), None);
        insert_track(&db, "music/karma.mp3", "Karma Police", Some(artist), None);
        db.rebuild_fts().unwrap();

        let results = db.search_all("Karma", 10, 10, 10).unwrap();
        assert_eq!(results.tracks.len(), 1);
        assert_eq!(results.tracks[0].title, "Karma Police");
    }

    #[test]
    fn test_search_all_empty_query() {
        let db = test_db();
        insert_track(&db, "music/song.mp3", "Song", None, None);
        db.rebuild_fts().unwrap();

        let results = db.search_all("", 10, 10, 10).unwrap();
        assert!(results.artists.is_empty());
        assert!(results.albums.is_empty());
        assert!(results.tracks.is_empty());
    }

    #[test]
    fn test_search_all_respects_limits() {
        let db = test_db();
        let artist = db.get_or_create_artist("Artist").unwrap();
        for i in 0..5 {
            insert_track(&db, &format!("music/s{i}.mp3"), &format!("Song {i}"), Some(artist), None);
        }
        db.rebuild_fts().unwrap();

        let results = db.search_all("Song", 10, 10, 2).unwrap();
        assert_eq!(results.tracks.len(), 2);
    }

    #[test]
    fn test_search_all_diacritics() {
        let db = test_db();
        let artist = db.get_or_create_artist("Björk").unwrap();
        insert_track(&db, "music/joga.mp3", "Jóga", Some(artist), None);
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let results = db.search_all("Bjork", 10, 10, 10).unwrap();
        assert_eq!(results.artists.len(), 1);
        assert_eq!(results.artists[0].name, "Björk");

        let results = db.search_all("Joga", 10, 10, 10).unwrap();
        assert_eq!(results.tracks.len(), 1);
        assert_eq!(results.tracks[0].title, "Jóga");
    }

    #[test]
    fn test_search_all_multi_word() {
        let db = test_db();
        let a = db.get_or_create_artist("The National").unwrap();
        insert_track(&db, "music/bloodbuzz.mp3", "Bloodbuzz Ohio", Some(a), None);
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let results = db.search_all("The National", 10, 10, 10).unwrap();
        assert_eq!(results.artists.len(), 1);

        let results = db.search_all("Bloodbuzz Ohio", 10, 10, 10).unwrap();
        assert_eq!(results.tracks.len(), 1);
    }

    // ── FTS path search ─────────────────────────────────────────

    #[test]
    fn test_search_fts_by_path() {
        let db = test_db();
        insert_track(&db, "Music/Jazz/miles_davis_so_what.flac", "So What", None, None);
        insert_track(&db, "Music/Rock/led_zep.flac", "Stairway", None, None);
        db.rebuild_fts().unwrap();

        let results = db.get_tracks(&TrackQuery {
            query: Some("miles_davis".to_string()),
            limit: Some(100),
            ..Default::default()
        }).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "So What");
    }

    #[test]
    fn test_search_fts_by_tag() {
        let db = test_db();
        let t1 = insert_track(&db, "music/a.mp3", "Alpha", None, None);
        insert_track(&db, "music/b.mp3", "Beta", None, None);
        let tag = db.get_or_create_tag("Ambient").unwrap();
        db.add_track_tag(t1, tag).unwrap();
        db.rebuild_fts().unwrap();

        let results = db.get_tracks(&TrackQuery {
            query: Some("Ambient".to_string()),
            limit: Some(100),
            ..Default::default()
        }).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Alpha");
    }

    #[test]
    fn test_search_fts_prefix_matching() {
        let db = test_db();
        insert_track(&db, "music/bohemian.mp3", "Bohemian Rhapsody", None, None);
        db.rebuild_fts().unwrap();

        let results = db.get_tracks(&TrackQuery {
            query: Some("Bohem".to_string()),
            limit: Some(100),
            ..Default::default()
        }).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Bohemian Rhapsody");
    }

    #[test]
    fn test_search_fts_empty_falls_through() {
        let db = test_db();
        insert_track(&db, "music/song.mp3", "Song", None, None);
        db.rebuild_fts().unwrap();

        // Empty query bypasses FTS and returns all tracks
        let results = db.get_tracks(&TrackQuery {
            query: Some("".to_string()),
            limit: Some(100),
            ..Default::default()
        }).unwrap();
        assert_eq!(results.len(), 1);

        let results = db.get_tracks(&TrackQuery {
            query: Some("   ".to_string()),
            limit: Some(100),
            ..Default::default()
        }).unwrap();
        assert_eq!(results.len(), 1);

        // Non-matching query returns nothing
        let results = db.get_tracks(&TrackQuery {
            query: Some("zzzzz".to_string()),
            limit: Some(100),
            ..Default::default()
        }).unwrap();
        assert!(results.is_empty());
    }

    // ── Enabled collection filter ───────────────────────────────

    #[test]
    fn test_disabled_collection_excluded_from_search() {
        let db = test_db();
        let col = db.add_collection("local", "Disabled", Some("/dis"), None, None, None, None, None).unwrap();
        let artist = db.get_or_create_artist("Hidden Artist").unwrap();
        db.upsert_track("hidden.mp3", "Hidden Song", Some(artist), None, None, Some(180.0), Some("mp3"), None, None, Some(col.id), None).unwrap();
        db.update_collection(col.id, "Disabled", false, 60, false).unwrap();
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let results = db.get_tracks(&TrackQuery {
            query: Some("Hidden".to_string()),
            limit: Some(100),
            ..Default::default()
        }).unwrap();
        assert!(results.is_empty());

        let count = db.get_track_count().unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_disabled_collection_excluded_from_search_all() {
        let db = test_db();
        let col = db.add_collection("local", "Disabled", Some("/dis"), None, None, None, None, None).unwrap();
        let artist = db.get_or_create_artist("Ghost Artist").unwrap();
        let album = db.get_or_create_album("Ghost Album", Some(artist), None).unwrap();
        db.upsert_track("ghost.mp3", "Ghost Song", Some(artist), Some(album), None, Some(180.0), Some("mp3"), None, None, Some(col.id), None).unwrap();
        db.update_collection(col.id, "Disabled", false, 60, false).unwrap();
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let results = db.search_all("Ghost", 10, 10, 10).unwrap();
        assert!(results.tracks.is_empty());
        // artist/album track_count is 0 after recompute so they shouldn't appear
        assert!(results.artists.is_empty());
        assert!(results.albums.is_empty());
    }

    // ── History rank window function tests ───────────────────────

    #[test]
    fn test_history_rank_tied_play_counts() {
        let db = test_db();
        let a = db.get_or_create_artist("Artist").unwrap();
        let _t1 = insert_track(&db, "music/t1.mp3", "Track A", Some(a), None);
        let _t2 = insert_track(&db, "music/t2.mp3", "Track B", Some(a), None);
        let _t3 = insert_track(&db, "music/t3.mp3", "Track C", Some(a), None);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, play_count) VALUES ('artist', 'Artist', 15)",
                [],
            ).unwrap();
            let ha: i64 = conn.query_row("SELECT id FROM history_artists WHERE canonical_name = 'artist'", [], |r| r.get(0)).unwrap();
            for (title, count) in [("track a", 10), ("track b", 10), ("track c", 5)] {
                conn.execute(
                    "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, play_count) VALUES (?1, ?2, ?3, ?4)",
                    params![ha, title, title, count],
                ).unwrap();
            }
        }

        // Tied tracks should have the same rank
        assert_eq!(db.get_track_rank("Track A", Some("Artist")).unwrap(), Some(1));
        assert_eq!(db.get_track_rank("Track B", Some("Artist")).unwrap(), Some(1));
        assert_eq!(db.get_track_rank("Track C", Some("Artist")).unwrap(), Some(3)); // RANK() skips to 3

        let most = db.get_history_most_played(10).unwrap();
        assert_eq!(most.len(), 3);
        assert_eq!(most[0].rank, 1);
        assert_eq!(most[1].rank, 1);
        assert_eq!(most[2].rank, 3);
    }

    #[test]
    fn test_history_search_tracks() {
        let db = test_db();
        let a = db.get_or_create_artist("Massive Attack").unwrap();
        let _t1 = insert_track(&db, "music/teardrop.mp3", "Teardrop", Some(a), None);
        let _t2 = insert_track(&db, "music/angel.mp3", "Angel", Some(a), None);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, play_count) VALUES ('massive attack', 'Massive Attack', 7)",
                [],
            ).unwrap();
            let ha: i64 = conn.query_row("SELECT id FROM history_artists WHERE canonical_name = 'massive attack'", [], |r| r.get(0)).unwrap();
            conn.execute(
                "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, play_count) VALUES (?1, 'teardrop', 'Teardrop', 5)",
                params![ha],
            ).unwrap();
            conn.execute(
                "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, play_count) VALUES (?1, 'angel', 'Angel', 2)",
                params![ha],
            ).unwrap();
        }

        // Search by track title
        let results = db.search_history_tracks("tear", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].display_title, "Teardrop");

        // Search by artist name
        let results = db.search_history_tracks("massive", 10).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_history_search_artists() {
        let db = test_db();
        let _a1 = db.get_or_create_artist("Portishead").unwrap();
        let _a2 = db.get_or_create_artist("Radiohead").unwrap();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, play_count) VALUES ('portishead', 'Portishead', 10)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, play_count) VALUES ('radiohead', 'Radiohead', 20)",
                [],
            ).unwrap();
        }

        let results = db.search_history_artists("head", 10).unwrap();
        assert_eq!(results.len(), 2);
        // Radiohead has more plays, should come first
        assert_eq!(results[0].display_name, "Radiohead");
        assert_eq!(results[1].display_name, "Portishead");
    }

    #[test]
    fn test_history_most_played_since() {
        let db = test_db();
        let a = db.get_or_create_artist("Artist").unwrap();
        let _t1 = insert_track(&db, "music/old.mp3", "Old Song", Some(a), None);
        let _t2 = insert_track(&db, "music/new.mp3", "New Song", Some(a), None);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, play_count) VALUES ('artist', 'Artist', 5)",
                [],
            ).unwrap();
            let ha: i64 = conn.query_row("SELECT id FROM history_artists WHERE canonical_name = 'artist'", [], |r| r.get(0)).unwrap();
            conn.execute(
                "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, play_count) VALUES (?1, 'old song', 'Old Song', 3)",
                params![ha],
            ).unwrap();
            conn.execute(
                "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, play_count) VALUES (?1, 'new song', 'New Song', 2)",
                params![ha],
            ).unwrap();
            let ht1: i64 = conn.query_row("SELECT id FROM history_tracks WHERE canonical_title = 'old song'", [], |r| r.get(0)).unwrap();
            let ht2: i64 = conn.query_row("SELECT id FROM history_tracks WHERE canonical_title = 'new song'", [], |r| r.get(0)).unwrap();
            // Old plays (timestamp 100)
            conn.execute("INSERT INTO history_plays (history_track_id, played_at) VALUES (?1, 100)", params![ht1]).unwrap();
            // Recent plays (timestamp 9000)
            conn.execute("INSERT INTO history_plays (history_track_id, played_at) VALUES (?1, 9000)", params![ht2]).unwrap();
            conn.execute("INSERT INTO history_plays (history_track_id, played_at) VALUES (?1, 9001)", params![ht2]).unwrap();
        }

        // Since timestamp 5000 — only "New Song" plays should count
        let results = db.get_history_most_played_since(5000, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].display_title, "New Song");
        assert_eq!(results[0].play_count, 2);
    }

    #[test]
    fn test_find_track_by_metadata_prefers_local() {
        let db = test_db();
        let artist = db.get_or_create_artist("Test Artist").unwrap();

        // Create a subsonic collection
        let sub_coll = db.add_collection("subsonic", "Server", None, Some("https://server.com"), None, None, None, None).unwrap();
        // Create a local collection
        let local_coll = db.add_collection("local", "Local", Some("/music"), None, None, None, None, None).unwrap();

        // Insert same track in both collections
        let cid_sub = sub_coll.id;
        let cid_local = local_coll.id;
        db.upsert_track("sub/song.mp3", "Same Song", Some(artist), None, None, Some(180.0), Some("mp3"), None, None, Some(cid_sub), None).unwrap();
        let local_id = db.upsert_track("local/song.mp3", "Same Song", Some(artist), None, None, Some(180.0), Some("mp3"), None, None, Some(cid_local), None).unwrap();

        let result = db.find_track_by_metadata("Same Song", Some("Test Artist"), None).unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().id, local_id, "should prefer local track");
    }

    // ── Benchmarks (run with: cargo test bench_ -- --ignored --nocapture) ───

    const BENCH_ROUNDS: u32 = 3;

    struct BenchResult {
        name: String,
        iterations: u32,
        rounds: u32,
        avg_ms: f64,
        min_ms: f64,
        max_ms: f64,
    }

    fn bench<F: FnMut()>(name: &str, iterations: u32, mut f: F) -> BenchResult {
        let mut round_avgs: Vec<f64> = Vec::with_capacity(BENCH_ROUNDS as usize);
        for _ in 0..BENCH_ROUNDS {
            let start = std::time::Instant::now();
            for _ in 0..iterations {
                f();
            }
            let total_ms = start.elapsed().as_secs_f64() * 1000.0;
            round_avgs.push(total_ms / iterations as f64);
        }
        round_avgs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let avg_ms = round_avgs.iter().sum::<f64>() / round_avgs.len() as f64;
        BenchResult {
            name: name.to_string(),
            iterations,
            rounds: BENCH_ROUNDS,
            avg_ms,
            min_ms: round_avgs[0],
            max_ms: *round_avgs.last().unwrap(),
        }
    }

    fn seed_bench_db(db: &Database, num_artists: usize, num_albums: usize, num_tracks: usize, num_history: usize) {
        let cid = test_collection(db);
        let mut artist_ids = Vec::with_capacity(num_artists);
        let mut album_ids = Vec::with_capacity(num_albums);
        let mut track_ids = Vec::with_capacity(num_tracks);

        let tag_ids: Vec<i64> = ["Rock", "Electronic", "Jazz", "Classical", "Hip-Hop",
            "Pop", "Metal", "Folk", "Blues", "Ambient"]
            .iter()
            .map(|name| db.get_or_create_tag(name).unwrap())
            .collect();

        for i in 0..num_artists {
            let id = db.get_or_create_artist(&format!("Artist {i:04}")).unwrap();
            artist_ids.push(id);
        }

        for i in 0..num_albums {
            let artist_id = artist_ids[i % num_artists];
            let id = db.get_or_create_album(
                &format!("Album {i:04}"),
                Some(artist_id),
                Some(1970 + (i % 55) as i32),
            ).unwrap();
            album_ids.push(id);
        }

        for i in 0..num_tracks {
            let artist_id = artist_ids[i % num_artists];
            let album_id = album_ids[i % num_albums];
            let track_id = db.upsert_track(
                &format!("music/artist_{:04}/album_{:04}/track_{:05}.mp3", i % num_artists, i % num_albums, i),
                &format!("Track {i:05} Title"),
                Some(artist_id),
                Some(album_id),
                Some((i % 12 + 1) as i32),
                Some(180.0 + (i % 300) as f64),
                Some("mp3"),
                Some(5_000_000 + (i * 1000) as i64),
                None,
                Some(cid),
                None,
            ).unwrap();
            track_ids.push(track_id);

            let tag_id = tag_ids[i % tag_ids.len()];
            let _ = db.add_track_tag(track_id, tag_id);
        }

        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        // Seed history
        {
            let conn = db.conn.lock().unwrap();
            let ha_count = num_artists.min(500);
            for i in 0..ha_count {
                conn.execute(
                    "INSERT OR IGNORE INTO history_artists (canonical_name, display_name, play_count) \
                     VALUES (?1, ?2, ?3)",
                    params![
                        format!("artist {i:04}"),
                        format!("Artist {i:04}"),
                        (num_history / ha_count) as i64
                    ],
                ).unwrap();
            }

            let mut ha_ids: Vec<i64> = Vec::new();
            let mut stmt = conn.prepare("SELECT id FROM history_artists ORDER BY id").unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            for r in rows { ha_ids.push(r.unwrap()); }

            let ht_count = num_tracks.min(5000);
            for i in 0..ht_count {
                let ha_id = ha_ids[i % ha_ids.len()];
                conn.execute(
                    "INSERT OR IGNORE INTO history_tracks (history_artist_id, canonical_title, display_title, play_count) \
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        ha_id,
                        format!("track {i:05} title"),
                        format!("Track {i:05} Title"),
                        (num_history / ht_count) as i64
                    ],
                ).unwrap();
            }

            let mut ht_ids: Vec<i64> = Vec::new();
            let mut stmt = conn.prepare("SELECT id FROM history_tracks ORDER BY id").unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            for r in rows { ht_ids.push(r.unwrap()); }

            for i in 0..num_history {
                let ht_id = ht_ids[i % ht_ids.len()];
                conn.execute(
                    "INSERT INTO history_plays (history_track_id, played_at) VALUES (?1, ?2)",
                    params![ht_id, 1700000000i64 + i as i64],
                ).unwrap();
            }

            conn.execute_batch(
                "UPDATE history_tracks SET play_count = (SELECT COUNT(*) FROM history_plays WHERE history_track_id = history_tracks.id); \
                 UPDATE history_artists SET play_count = (SELECT COALESCE(SUM(ht.play_count), 0) FROM history_tracks ht WHERE ht.history_artist_id = history_artists.id);"
            ).unwrap();
        }
    }

    #[test]
    fn test_search_entity_tracks() {
        let db = test_db();
        let cid = test_collection(&db);
        let queen_id = db.get_or_create_artist("Queen").unwrap();
        let other_id = db.get_or_create_artist("Other").unwrap();
        let album1 = db.get_or_create_album("A Night at the Opera", Some(queen_id), None).unwrap();
        let album2 = db.get_or_create_album("Album", Some(other_id), None).unwrap();
        db.upsert_track("file://song1.mp3", "Bohemian Rhapsody", Some(queen_id), Some(album1), None, None, None, None, None, Some(cid), None).unwrap();
        db.upsert_track("file://song2.mp3", "Bohemian Grove", Some(other_id), Some(album2), None, None, None, None, None, Some(cid), None).unwrap();
        db.upsert_track("file://song3.mp3", "Something Else", Some(queen_id), Some(album1), None, None, None, None, None, Some(cid), None).unwrap();
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let result = db.search_entity("bohemian", "tracks", &TrackQuery { limit: Some(10), ..Default::default() }).unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.tracks.as_ref().unwrap().len(), 2);
        assert!(result.albums.is_none());
        assert!(result.artists.is_none());
    }

    #[test]
    fn test_search_entity_artists() {
        let db = test_db();
        let cid = test_collection(&db);
        let queen_id = db.get_or_create_artist("Queen").unwrap();
        let qr_id = db.get_or_create_artist("Queensryche").unwrap();
        let album1 = db.get_or_create_album("Album", Some(queen_id), None).unwrap();
        let album2 = db.get_or_create_album("Album2", Some(qr_id), None).unwrap();
        db.upsert_track("file://s1.mp3", "Song", Some(queen_id), Some(album1), None, None, None, None, None, Some(cid), None).unwrap();
        db.upsert_track("file://s2.mp3", "Song2", Some(qr_id), Some(album2), None, None, None, None, None, Some(cid), None).unwrap();
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let result = db.search_entity("queen", "artists", &TrackQuery { limit: Some(10), ..Default::default() }).unwrap();
        assert_eq!(result.total, 2);
        assert!(result.artists.is_some());
        assert!(result.tracks.is_none());
    }

    #[test]
    fn test_search_entity_albums() {
        let db = test_db();
        let cid = test_collection(&db);
        let a1 = db.get_or_create_artist("Artist").unwrap();
        let a2 = db.get_or_create_artist("Artist2").unwrap();
        let alb1 = db.get_or_create_album("Dark Side", Some(a1), None).unwrap();
        let alb2 = db.get_or_create_album("Dark Night", Some(a2), None).unwrap();
        db.upsert_track("file://s1.mp3", "Song", Some(a1), Some(alb1), None, None, None, None, None, Some(cid), None).unwrap();
        db.upsert_track("file://s2.mp3", "Song2", Some(a2), Some(alb2), None, None, None, None, None, Some(cid), None).unwrap();
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let result = db.search_entity("dark", "albums", &TrackQuery { limit: Some(10), ..Default::default() }).unwrap();
        assert_eq!(result.total, 2);
        assert!(result.albums.is_some());
        assert!(result.tracks.is_none());
    }

    #[test]
    fn test_search_entity_pagination() {
        let db = test_db();
        let cid = test_collection(&db);
        let band_id = db.get_or_create_artist("Band").unwrap();
        let album_id = db.get_or_create_album("Album", Some(band_id), None).unwrap();
        for i in 0..10 {
            db.upsert_track(&format!("file://rock{}.mp3", i), &format!("Rock Song {}", i), Some(band_id), Some(album_id), None, None, None, None, None, Some(cid), None).unwrap();
        }
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let page1 = db.search_entity("rock", "tracks", &TrackQuery { limit: Some(3), ..Default::default() }).unwrap();
        assert_eq!(page1.total, 10);
        assert_eq!(page1.tracks.as_ref().unwrap().len(), 3);

        let page2 = db.search_entity("rock", "tracks", &TrackQuery { limit: Some(3), offset: Some(3), ..Default::default() }).unwrap();
        assert_eq!(page2.total, 10);
        assert_eq!(page2.tracks.as_ref().unwrap().len(), 3);

        let last_page = db.search_entity("rock", "tracks", &TrackQuery { limit: Some(3), offset: Some(9), ..Default::default() }).unwrap();
        assert_eq!(last_page.total, 10);
        assert_eq!(last_page.tracks.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn test_search_entity_sort_chain_tracks() {
        let db = test_db();
        let cid = test_collection(&db);
        let a1 = db.get_or_create_artist("Artist").unwrap();
        let album = db.get_or_create_album("Album", Some(a1), None).unwrap();
        let t1 = db.upsert_track("file://a.mp3", "Alpha", Some(a1), Some(album), None, None, None, None, None, Some(cid), None).unwrap();
        let _t2 = db.upsert_track("file://b.mp3", "Beta", Some(a1), Some(album), None, None, None, None, None, Some(cid), None).unwrap();
        let t3 = db.upsert_track("file://c.mp3", "Charlie", Some(a1), Some(album), None, None, None, None, None, Some(cid), None).unwrap();
        db.toggle_liked("tracks", t1, 1).unwrap();
        db.toggle_liked("tracks", t3, -1).unwrap();
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let result = db.search_entity("", "tracks", &TrackQuery {
            limit: Some(10),
            sort_chain: Some(vec![
                SortKey { field: "liked".to_string(), dir: "desc".to_string() },
                SortKey { field: "title".to_string(), dir: "asc".to_string() },
            ]),
            ..Default::default()
        }).unwrap();
        let tracks = result.tracks.unwrap();
        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[0].title, "Alpha");   // liked=1
        assert_eq!(tracks[1].title, "Beta");    // liked=0
        assert_eq!(tracks[2].title, "Charlie"); // liked=-1
    }

    #[test]
    fn test_search_entity_sort_chain_overrides_legacy() {
        let db = test_db();
        let cid = test_collection(&db);
        let a1 = db.get_or_create_artist("Artist").unwrap();
        let album = db.get_or_create_album("Album", Some(a1), None).unwrap();
        db.upsert_track("file://a.mp3", "Alpha", Some(a1), Some(album), None, None, None, None, None, Some(cid), None).unwrap();
        db.upsert_track("file://b.mp3", "Beta", Some(a1), Some(album), None, None, None, None, None, Some(cid), None).unwrap();
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let result = db.search_entity("", "tracks", &TrackQuery {
            limit: Some(10),
            sort_field: Some("title".to_string()),
            sort_dir: Some("asc".to_string()),
            sort_chain: Some(vec![
                SortKey { field: "title".to_string(), dir: "desc".to_string() },
            ]),
            ..Default::default()
        }).unwrap();
        let tracks = result.tracks.unwrap();
        assert_eq!(tracks[0].title, "Beta");  // desc from chain wins
        assert_eq!(tracks[1].title, "Alpha");
    }

    #[test]
    fn test_search_entity_empty_chain_falls_back() {
        let db = test_db();
        let cid = test_collection(&db);
        let a1 = db.get_or_create_artist("Artist").unwrap();
        let album = db.get_or_create_album("Album", Some(a1), None).unwrap();
        db.upsert_track("file://a.mp3", "Alpha", Some(a1), Some(album), None, None, None, None, None, Some(cid), None).unwrap();
        db.upsert_track("file://b.mp3", "Beta", Some(a1), Some(album), None, None, None, None, None, Some(cid), None).unwrap();
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let result = db.search_entity("", "tracks", &TrackQuery {
            limit: Some(10),
            sort_chain: Some(vec![]),
            sort_field: Some("title".to_string()),
            sort_dir: Some("desc".to_string()),
            ..Default::default()
        }).unwrap();
        let tracks = result.tracks.unwrap();
        assert_eq!(tracks[0].title, "Beta");  // legacy desc
        assert_eq!(tracks[1].title, "Alpha");
    }

    #[test]
    fn test_search_entity_sort_chain_unknown_field() {
        let db = test_db();
        let cid = test_collection(&db);
        let a1 = db.get_or_create_artist("Artist").unwrap();
        let album = db.get_or_create_album("Album", Some(a1), None).unwrap();
        db.upsert_track("file://a.mp3", "Alpha", Some(a1), Some(album), None, None, None, None, None, Some(cid), None).unwrap();
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let result = db.search_entity("", "tracks", &TrackQuery {
            limit: Some(10),
            sort_chain: Some(vec![
                SortKey { field: "nonexistent".to_string(), dir: "asc".to_string() },
                SortKey { field: "title".to_string(), dir: "asc".to_string() },
            ]),
            ..Default::default()
        }).unwrap();
        assert_eq!(result.tracks.unwrap().len(), 1);
    }

    #[test]
    fn test_search_tracks_inner_sort_chain() {
        let db = test_db();
        let cid = test_collection(&db);
        let a1 = db.get_or_create_artist("Artist").unwrap();
        let album = db.get_or_create_album("Album", Some(a1), None).unwrap();
        let t1 = db.upsert_track("file://a.mp3", "Rock Alpha", Some(a1), Some(album), None, None, None, None, None, Some(cid), None).unwrap();
        let _t2 = db.upsert_track("file://b.mp3", "Rock Beta", Some(a1), Some(album), None, None, None, None, None, Some(cid), None).unwrap();
        db.toggle_liked("tracks", t1, 1).unwrap();
        db.recompute_counts().unwrap();
        db.rebuild_fts().unwrap();

        let result = db.search_entity("rock", "tracks", &TrackQuery {
            limit: Some(10),
            sort_chain: Some(vec![
                SortKey { field: "liked".to_string(), dir: "desc".to_string() },
                SortKey { field: "title".to_string(), dir: "asc".to_string() },
            ]),
            ..Default::default()
        }).unwrap();
        let tracks = result.tracks.unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].title, "Rock Alpha");  // liked=1, sorted first
        assert_eq!(tracks[1].title, "Rock Beta");   // liked=0
    }

    #[test]
    fn test_list_entity_artists_sort_chain_liked() {
        let db = test_db();
        let cid = test_collection(&db);
        let a1 = db.get_or_create_artist("Alpha Artist").unwrap();
        let a2 = db.get_or_create_artist("Beta Artist").unwrap();
        let alb1 = db.get_or_create_album("Alb1", Some(a1), None).unwrap();
        let alb2 = db.get_or_create_album("Alb2", Some(a2), None).unwrap();
        db.upsert_track("file://s1.mp3", "S1", Some(a1), Some(alb1), None, None, None, None, None, Some(cid), None).unwrap();
        db.upsert_track("file://s2.mp3", "S2", Some(a2), Some(alb2), None, None, None, None, None, Some(cid), None).unwrap();
        db.toggle_liked("artists", a2, 1).unwrap();
        db.recompute_counts().unwrap();

        let result = db.search_entity("", "artists", &TrackQuery {
            limit: Some(10),
            sort_chain: Some(vec![
                SortKey { field: "liked".to_string(), dir: "desc".to_string() },
                SortKey { field: "name".to_string(), dir: "asc".to_string() },
            ]),
            ..Default::default()
        }).unwrap();
        let artists = result.artists.unwrap();
        assert_eq!(artists[0].name, "Beta Artist");  // liked=1 first
        assert_eq!(artists[1].name, "Alpha Artist"); // liked=0
    }

    #[test]
    fn test_plugin_scheduler_register_and_get() {
        let db = test_db();
        db.plugin_scheduler_register("spotify", "refresh-token", 3600000).unwrap();
        let all = db.plugin_scheduler_get_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].0, "spotify");
        assert_eq!(all[0].1, "refresh-token");
        assert_eq!(all[0].2, 3600000);
        assert_eq!(all[0].3, None);
    }

    #[test]
    fn test_plugin_scheduler_complete() {
        let db = test_db();
        db.plugin_scheduler_register("spotify", "refresh-token", 3600000).unwrap();
        let updated = db.plugin_scheduler_complete("spotify", "refresh-token").unwrap();
        assert!(updated);
        let all = db.plugin_scheduler_get_all().unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].3.is_some());
    }

    #[test]
    fn test_plugin_scheduler_complete_nonexistent() {
        let db = test_db();
        let updated = db.plugin_scheduler_complete("nonexistent", "task").unwrap();
        assert!(!updated);
    }

    #[test]
    fn test_plugin_scheduler_unregister() {
        let db = test_db();
        db.plugin_scheduler_register("spotify", "refresh-token", 3600000).unwrap();
        db.plugin_scheduler_unregister("spotify", "refresh-token").unwrap();
        let all = db.plugin_scheduler_get_all().unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn test_plugin_scheduler_unregister_all() {
        let db = test_db();
        db.plugin_scheduler_register("spotify", "refresh-token", 3600000).unwrap();
        db.plugin_scheduler_register("spotify", "sync-library", 7200000).unwrap();
        db.plugin_scheduler_register("other", "check-updates", 86400000).unwrap();
        db.plugin_scheduler_unregister_all("spotify").unwrap();
        let all = db.plugin_scheduler_get_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].0, "other");
        assert_eq!(all[0].1, "check-updates");
    }

    #[test]
    fn test_download_providers_crud() {
        let db = test_db();
        db.sync_download_providers(&[
            ("tidal-browse".to_string(), "tidal-download".to_string(), "TIDAL".to_string(), 100),
        ]).unwrap();

        let providers = db.get_download_providers().unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].0, "tidal-browse");
        assert_eq!(providers[0].1, "tidal-download");
        assert_eq!(providers[0].2, "TIDAL");
        assert_eq!(providers[0].3, 100);
        assert_eq!(providers[0].4, true);

        db.update_download_provider_priority("tidal-browse", "tidal-download", 200).unwrap();
        let providers = db.get_download_providers().unwrap();
        assert_eq!(providers[0].3, 200);

        db.update_download_provider_active("tidal-browse", "tidal-download", false).unwrap();
        let active = db.get_active_download_providers().unwrap();
        assert_eq!(active.len(), 0);

        db.reset_download_provider_priorities(&[
            ("tidal-browse".to_string(), "tidal-download".to_string(), "TIDAL".to_string(), 100),
        ]).unwrap();
        let providers = db.get_download_providers().unwrap();
        assert_eq!(providers[0].3, 100);
        assert_eq!(providers[0].4, true);
    }

    #[test]
    fn test_find_track_in_collection() {
        let db = test_db();
        let col = db.add_collection("local", "Test", Some("/tmp/test"), None, None, None, None, None).unwrap();

        let artist_id = db.get_or_create_artist("Test Artist").unwrap();
        db.upsert_track(
            "test.mp3", "Test Song", Some(artist_id), None,
            None, None, None, None, None, Some(col.id), None,
        ).unwrap();

        let found = db.find_track_in_collection(col.id, "test song", "test artist").unwrap();
        assert!(found.is_some());

        let not_found = db.find_track_in_collection(col.id, "test song", "other artist").unwrap();
        assert!(not_found.is_none());

        let col2 = db.add_collection("local", "Other", Some("/tmp/other"), None, None, None, None, None).unwrap();
        let not_found2 = db.find_track_in_collection(col2.id, "test song", "test artist").unwrap();
        assert!(not_found2.is_none());
    }

    #[test]
    fn test_sync_error_updates_last_synced_at() {
        let db = test_db();
        let col = db.add_collection("subsonic", "Test", None, Some("http://example.com"), Some("user"), Some("pass"), None, None).unwrap();

        // Initially last_synced_at is None
        let before = db.get_collection_by_id(col.id).unwrap();
        assert!(before.last_synced_at.is_none());

        // Record an error
        db.update_collection_sync_error(col.id, "connection refused").unwrap();

        // last_synced_at should now be set (so auto-update backs off)
        let after = db.get_collection_by_id(col.id).unwrap();
        assert!(after.last_synced_at.is_some());
        assert_eq!(after.last_sync_error.as_deref(), Some("connection refused"));
    }

    #[test]
    fn test_get_top_artists_for_tag_orders_by_count() {
        let db = test_db();
        let cid = test_collection(&db);

        let alpha = db.get_or_create_artist("Alpha").unwrap();
        let beta = db.get_or_create_artist("Beta").unwrap();
        let gamma = db.get_or_create_artist("Gamma").unwrap();
        let alpha_album = db.get_or_create_album("A1", Some(alpha), None).unwrap();
        let beta_album = db.get_or_create_album("B1", Some(beta), None).unwrap();
        let gamma_album = db.get_or_create_album("G1", Some(gamma), None).unwrap();

        let tag_id = {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO tags(name) VALUES(?1)", rusqlite::params!["rock"]).unwrap();
            conn.last_insert_rowid()
        };

        let tag_track = |path: &str, artist_id: i64, album_id: i64| {
            let track_id = db.upsert_track(
                path, path, Some(artist_id), Some(album_id),
                None, Some(180.0), Some("mp3"), None, None, Some(cid), None,
            ).unwrap();
            db.add_track_tag(track_id, tag_id).unwrap();
        };
        // Alpha=1, Beta=3, Gamma=2
        tag_track("/a1.mp3", alpha, alpha_album);
        tag_track("/b1.mp3", beta, beta_album);
        tag_track("/b2.mp3", beta, beta_album);
        tag_track("/b3.mp3", beta, beta_album);
        tag_track("/g1.mp3", gamma, gamma_album);
        tag_track("/g2.mp3", gamma, gamma_album);

        let top = db.get_top_artists_for_tag(tag_id, 4).unwrap();
        assert_eq!(top.len(), 3);
        assert_eq!(top[0], ("Beta".to_string(), 3));
        assert_eq!(top[1], ("Gamma".to_string(), 2));
        assert_eq!(top[2], ("Alpha".to_string(), 1));
    }

    #[test]
    fn test_get_top_artists_for_tag_respects_limit() {
        let db = test_db();
        let cid = test_collection(&db);
        let tag_id = {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO tags(name) VALUES(?1)", rusqlite::params!["rock"]).unwrap();
            conn.last_insert_rowid()
        };
        for i in 0..5 {
            let name = format!("Artist {i}");
            let aid = db.get_or_create_artist(&name).unwrap();
            let alid = db.get_or_create_album("Album", Some(aid), None).unwrap();
            let path = format!("/t{i}.mp3");
            let track_id = db.upsert_track(
                &path, &path, Some(aid), Some(alid),
                None, Some(180.0), Some("mp3"), None, None, Some(cid), None,
            ).unwrap();
            db.add_track_tag(track_id, tag_id).unwrap();
        }
        let top = db.get_top_artists_for_tag(tag_id, 3).unwrap();
        assert_eq!(top.len(), 3);
    }

    #[test]
    fn test_get_top_artists_for_tag_empty_when_no_tracks() {
        let db = test_db();
        let tag_id = {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO tags(name) VALUES(?1)", rusqlite::params!["rock"]).unwrap();
            conn.last_insert_rowid()
        };
        let top = db.get_top_artists_for_tag(tag_id, 4).unwrap();
        assert!(top.is_empty());
    }

    #[test]
    #[ignore]
    fn bench_search_performance() {
        let db = test_db();

        let seed_start = std::time::Instant::now();
        seed_bench_db(&db, 2000, 4000, 20000, 100000);
        let seed_ms = seed_start.elapsed().as_secs_f64() * 1000.0;

        let queries = &[
            "Artist 0042",
            "Track 00100",
            "Album 0300",
            "Rock",
            "Nonexistent Query XYZ",
            "Art",
            "trac title",
            "music/artist_0001",
        ];

        let mut results: Vec<BenchResult> = Vec::new();

        results.push(BenchResult {
            name: "seed_database".into(),
            iterations: 1,
            rounds: 1,
            avg_ms: seed_ms,
            min_ms: seed_ms,
            max_ms: seed_ms,
        });

        // search_all benchmarks
        for q in queries {
            let r = bench(&format!("search_all(\"{}\")", q), 50, || {
                let _ = db.search_all(q, 7, 7, 7).unwrap();
            });
            results.push(r);
        }

        // get_tracks FTS benchmarks
        for q in queries {
            let r = bench(&format!("get_tracks(\"{}\")", q), 50, || {
                let _ = db.get_tracks(&TrackQuery {
                    query: Some(q.to_string()),
                    limit: Some(100),
                    ..Default::default()
                }).unwrap();
            });
            results.push(r);
        }

        // get_tracks without query (paginated browse)
        results.push(bench("get_tracks(browse, page 1)", 50, || {
            let _ = db.get_tracks(&TrackQuery {
                limit: Some(100),
                offset: Some(0),
                ..Default::default()
            }).unwrap();
        }));

        results.push(bench("get_tracks(browse, page 100)", 50, || {
            let _ = db.get_tracks(&TrackQuery {
                limit: Some(100),
                offset: Some(10000),
                ..Default::default()
            }).unwrap();
        }));

        // History benchmarks
        results.push(bench("get_history_most_played(50)", 50, || {
            let _ = db.get_history_most_played(50).unwrap();
        }));

        results.push(bench("get_history_most_played_since(50)", 50, || {
            let _ = db.get_history_most_played_since(1700050000, 50).unwrap();
        }));

        results.push(bench("search_history_tracks(\"track\")", 50, || {
            let _ = db.search_history_tracks("track", 50).unwrap();
        }));

        results.push(bench("search_history_artists(\"artist\")", 50, || {
            let _ = db.search_history_artists("artist", 50).unwrap();
        }));

        results.push(bench("get_track_rank", 50, || {
            let _ = db.get_track_rank("track_0", Some("artist_0")).unwrap();
        }));

        results.push(bench("get_artist_rank", 50, || {
            let _ = db.get_artist_rank("Artist 0000").unwrap();
        }));

        // rebuild/recompute
        results.push(bench("rebuild_fts", 3, || {
            db.rebuild_fts().unwrap();
        }));

        results.push(bench("recompute_counts", 3, || {
            db.recompute_counts().unwrap();
        }));

        results.push(bench("get_track_count", 50, || {
            let _ = db.get_track_count().unwrap();
        }));

        // Output JSON
        let json_entries: Vec<String> = results.iter().map(|r| {
            format!(
                "    {{\"name\": \"{}\", \"iterations\": {}, \"rounds\": {}, \"avg_ms\": {:.3}, \"min_ms\": {:.3}, \"max_ms\": {:.3}}}",
                r.name, r.iterations, r.rounds, r.avg_ms, r.min_ms, r.max_ms
            )
        }).collect();

        println!("\n--- BENCH_JSON_START ---");
        println!("{{");
        println!("  \"results\": [");
        println!("{}", json_entries.join(",\n"));
        println!("  ]");
        println!("}}");
        println!("--- BENCH_JSON_END ---");

        // Human-readable summary
        println!("\n{:<50} {:>5} {:>4} {:>10} {:>10} {:>10}", "Benchmark", "Iters", "Rnd", "Avg ms", "Min ms", "Max ms");
        println!("{}", "-".repeat(93));
        for r in &results {
            println!("{:<50} {:>5} {:>4} {:>10.3} {:>10.3} {:>10.3}", r.name, r.iterations, r.rounds, r.avg_ms, r.min_ms, r.max_ms);
        }
    }

    #[test]
    fn test_build_radio_returns_seed_first() {
        let db = test_db();
        let cid = test_collection(&db);

        let aid = db.get_or_create_artist("Seed Artist").unwrap();
        let alb = db.get_or_create_album("Seed Album", Some(aid), None).unwrap();
        db.upsert_track("file://seed.mp3", "Seed Title", Some(aid), Some(alb), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();

        for i in 0..3 {
            db.upsert_track(&format!("file://artist-{}.mp3", i), &format!("Artist Track {}", i), Some(aid), Some(alb), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();
        }

        let result = db.build_radio_for_track("Seed Title", Some("Seed Artist"), 30).unwrap();
        assert!(!result.is_empty(), "expected at least the seed track");
        assert_eq!(result[0].title, "Seed Title", "seed must be at index 0");
    }

    #[test]
    fn test_build_radio_excludes_already_picked() {
        let db = test_db();
        let cid = test_collection(&db);
        let aid = db.get_or_create_artist("Solo Artist").unwrap();
        let alb = db.get_or_create_album("Album", Some(aid), None).unwrap();
        db.upsert_track("file://a.mp3", "Seed", Some(aid), Some(alb), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();
        db.upsert_track("file://b.mp3", "B", Some(aid), Some(alb), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();
        db.upsert_track("file://c.mp3", "C", Some(aid), Some(alb), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();
        db.upsert_track("file://d.mp3", "D", Some(aid), Some(alb), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();

        let result = db.build_radio_for_track("Seed", Some("Solo Artist"), 30).unwrap();
        let mut ids: Vec<i64> = result.iter().map(|t| t.id).collect();
        ids.sort();
        let mut deduped = ids.clone();
        deduped.dedup();
        assert_eq!(ids.len(), deduped.len(), "result contains duplicate track ids");
    }

    #[test]
    fn test_build_radio_returns_partial_when_pool_small() {
        let db = test_db();
        let cid = test_collection(&db);
        let aid = db.get_or_create_artist("Only").unwrap();
        let alb = db.get_or_create_album("Album", Some(aid), None).unwrap();
        db.upsert_track("file://seed.mp3", "Only Track", Some(aid), Some(alb), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();

        let result = db.build_radio_for_track("Only Track", Some("Only"), 30).unwrap();
        assert!(result.len() <= 30, "must terminate, returned {}", result.len());
        assert_eq!(result[0].title, "Only Track");
    }

    #[test]
    fn test_build_radio_uses_artist_aggregated_tag_pool() {
        // Seed track has NO tags of its own. A different track by the same artist has tag "Jazz".
        // A third artist has a track also tagged "Jazz". Radio should reach that third track via
        // the artist-aggregated tag pool, even though the seed track itself isn't tagged Jazz.
        let db = test_db();
        let cid = test_collection(&db);

        let seed_artist = db.get_or_create_artist("Seed Artist").unwrap();
        let seed_album = db.get_or_create_album("Seed Album", Some(seed_artist), None).unwrap();
        let seed_id = db.upsert_track("file://seed.mp3", "Seed Title", Some(seed_artist), Some(seed_album), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();

        // Same-artist track tagged "Jazz".
        let jazz_tag = db.get_or_create_tag("Jazz").unwrap();
        let same_artist_other = db.upsert_track("file://other.mp3", "Other Track", Some(seed_artist), Some(seed_album), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();
        db.add_track_tag(same_artist_other, jazz_tag).unwrap();

        // Different artist track tagged "Jazz".
        let other_artist = db.get_or_create_artist("Other Artist").unwrap();
        let other_album = db.get_or_create_album("Other Album", Some(other_artist), None).unwrap();
        let cross_artist_jazz = db.upsert_track("file://cross.mp3", "Cross Track", Some(other_artist), Some(other_album), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();
        db.add_track_tag(cross_artist_jazz, jazz_tag).unwrap();

        // Sanity: seed itself has no tags.
        let _ = seed_id;

        let result = db.build_radio_for_track("Seed Title", Some("Seed Artist"), 30).unwrap();
        let ids: Vec<i64> = result.iter().map(|t| t.id).collect();
        assert!(ids.contains(&cross_artist_jazz),
            "expected radio to include the cross-artist Jazz track via artist-aggregated tag pool, got ids: {:?}", ids);
    }

    #[test]
    fn test_pick_radio_seeds_empty_library() {
        let db = test_db();
        let result = db.pick_radio_seeds(5).unwrap();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_pick_radio_seeds_excludes_disliked() {
        let db = test_db();
        let cid = test_collection(&db);
        let aid = db.get_or_create_artist("A").unwrap();
        let alb = db.get_or_create_album("Album", Some(aid), None).unwrap();
        let id1 = db.upsert_track("file://ok.mp3", "OK", Some(aid), Some(alb), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();
        let id2 = db.upsert_track("file://hated.mp3", "Hated", Some(aid), Some(alb), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();
        db.toggle_liked("tracks", id2, -1).unwrap();

        let result = db.pick_radio_seeds(10).unwrap();
        let ids: Vec<i64> = result.iter().map(|t| t.id).collect();
        assert!(ids.contains(&id1), "expected the OK track");
        assert!(!ids.contains(&id2), "disliked track must not appear");
    }

    #[test]
    fn test_pick_radio_seeds_distinct_artists() {
        let db = test_db();
        let cid = test_collection(&db);
        for name in ["A1", "A2", "A3", "A4", "A5"].iter() {
            let aid = db.get_or_create_artist(name).unwrap();
            let alb = db.get_or_create_album("Album", Some(aid), None).unwrap();
            for i in 0..3 {
                db.upsert_track(&format!("file://{}-{}.mp3", name, i), &format!("{} Track {}", name, i), Some(aid), Some(alb), None, Some(180.0), Some("mp3"), Some(1024), None, Some(cid), None).unwrap();
            }
        }

        let result = db.pick_radio_seeds(5).unwrap();
        assert_eq!(result.len(), 5);
        let mut returned_artists: Vec<i64> = result.iter().filter_map(|t| t.artist_id).collect();
        returned_artists.sort();
        let mut deduped = returned_artists.clone();
        deduped.dedup();
        assert_eq!(returned_artists.len(), deduped.len(), "expected distinct artists across 5 seeds");
    }
}
