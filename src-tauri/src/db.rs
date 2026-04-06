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

/// Strip LRC timestamps like [01:23.45] from synced lyrics text.
pub fn strip_lrc_timestamps(text: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\[\d{2}:\d{2}[.:]\d{2,3}\]").unwrap());
    re.replace_all(text, "").trim().to_string()
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
     t.added_at, t.modified_at, t.path \
     FROM tracks t LEFT JOIN artists ar ON t.artist_id = ar.id LEFT JOIN albums al ON t.album_id = al.id \
     LEFT JOIN collections co ON t.collection_id = co.id";

const ENABLED_COLLECTION_FILTER: &str =
    "AND (t.collection_id IS NULL OR EXISTS (SELECT 1 FROM collections c WHERE c.id = t.collection_id AND c.enabled = 1))";

fn track_from_row(row: &rusqlite::Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get(0)?,
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
        relative_path: row.get(18)?,
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
        _ => None,
    }
}

pub struct Database {
    conn: Mutex<Connection>,
}

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
                last_sync_duration_secs   REAL
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
                path_normalized TEXT,
                UNIQUE(collection_id, path)
            );

            CREATE TABLE IF NOT EXISTS track_tags (
                track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
                tag_id   INTEGER REFERENCES tags(id) ON DELETE CASCADE,
                UNIQUE(track_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS lyrics (
                track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
                text        TEXT NOT NULL,
                kind        TEXT NOT NULL,
                provider    TEXT NOT NULL,
                fetched_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
                title,
                artist_name,
                album_title,
                tag_names,
                lyrics_text,
                content='',
                tokenize='unicode61 remove_diacritics 2'
            );

            CREATE TABLE IF NOT EXISTS history_artists (
                id              INTEGER PRIMARY KEY,
                canonical_name  TEXT NOT NULL UNIQUE,
                display_name    TEXT,
                first_played_at INTEGER,
                last_played_at  INTEGER,
                play_count      INTEGER NOT NULL DEFAULT 0,
                library_artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS history_tracks (
                id                INTEGER PRIMARY KEY,
                history_artist_id INTEGER NOT NULL REFERENCES history_artists(id),
                canonical_title   TEXT NOT NULL,
                display_title     TEXT,
                first_played_at   INTEGER,
                last_played_at    INTEGER,
                play_count        INTEGER NOT NULL DEFAULT 0,
                library_track_id  INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
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
                item_id    INTEGER NOT NULL,
                failed_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                UNIQUE(kind, item_id)
            );

            CREATE TABLE IF NOT EXISTS lastfm_cache (
                cache_key  TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                cached_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );

            CREATE TABLE IF NOT EXISTS plugin_storage (
                plugin_id  TEXT NOT NULL,
                key        TEXT NOT NULL,
                value      TEXT NOT NULL,
                PRIMARY KEY (plugin_id, key)
            );

            CREATE TABLE IF NOT EXISTS information_types (
                id              TEXT NOT NULL,
                name            TEXT NOT NULL,
                entity          TEXT NOT NULL,
                display_kind    TEXT NOT NULL,
                plugin_id       TEXT NOT NULL,
                ttl             INTEGER NOT NULL,
                sort_order      INTEGER NOT NULL DEFAULT 500,
                priority        INTEGER NOT NULL DEFAULT 500,
                PRIMARY KEY (id, plugin_id)
            );

            CREATE TABLE IF NOT EXISTS information_values (
                information_type_id  TEXT NOT NULL,
                entity_key           TEXT NOT NULL,
                value                TEXT NOT NULL,
                status               TEXT NOT NULL DEFAULT 'ok',
                fetched_at           INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                PRIMARY KEY (information_type_id, entity_key)
            );

            CREATE INDEX IF NOT EXISTS idx_info_values_entity ON information_values(entity_key);

            CREATE TABLE IF NOT EXISTS information_type_providers (
                information_type_id  TEXT NOT NULL,
                plugin_id            TEXT NOT NULL,
                user_priority        INTEGER NOT NULL,
                enabled              INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (information_type_id, plugin_id)
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

    fn run_migrations(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let version: i64 = conn.query_row(
            "SELECT version FROM db_version WHERE rowid = 1", [], |row| row.get(0),
        ).unwrap_or(1);

        let mut migrated = false;

        if version < 2 {
            // Add track_count columns (ignored if already present via fresh CREATE TABLE)
            let _ = conn.execute_batch("ALTER TABLE artists ADD COLUMN track_count INTEGER NOT NULL DEFAULT 0");
            let _ = conn.execute_batch("ALTER TABLE albums ADD COLUMN track_count INTEGER NOT NULL DEFAULT 0");
            let _ = conn.execute_batch("ALTER TABLE tags ADD COLUMN track_count INTEGER NOT NULL DEFAULT 0");
            conn.execute("UPDATE db_version SET version = 2 WHERE rowid = 1", [])?;
            migrated = true;
        }

        if version < 3 {
            let _ = conn.execute_batch("ALTER TABLE tracks ADD COLUMN youtube_url TEXT");
            conn.execute("UPDATE db_version SET version = 3 WHERE rowid = 1", [])?;
        }

        if version < 4 {
            let _ = conn.execute_batch("ALTER TABLE collections ADD COLUMN last_sync_error TEXT");
            conn.execute("UPDATE db_version SET version = 4 WHERE rowid = 1", [])?;
        }

        if version < 5 {
            let _ = conn.execute_batch("ALTER TABLE tags ADD COLUMN liked INTEGER NOT NULL DEFAULT 0");
            conn.execute("UPDATE db_version SET version = 5 WHERE rowid = 1", [])?;
        }

        if version < 6 {
            // Migrate existing play_history into decoupled history tables.
            // play_history may not exist on fresh databases (table removed in later version).
            let has_play_history: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='play_history')",
                [], |row| row.get(0),
            ).unwrap_or(false);
            if has_play_history {
                // Step 1: Extract unique artists
                conn.execute_batch(
                    "INSERT OR IGNORE INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
                     SELECT
                       strip_diacritics(unicode_lower(COALESCE(ar.name, ''))),
                       ar.name,
                       MIN(ph.played_at),
                       MAX(ph.played_at),
                       COUNT(*)
                     FROM play_history ph
                     JOIN tracks t ON t.id = ph.track_id
                     LEFT JOIN artists ar ON t.artist_id = ar.id
                     GROUP BY strip_diacritics(unicode_lower(COALESCE(ar.name, '')))"
                )?;
                // Step 2: Extract unique tracks grouped by (artist, title)
                conn.execute_batch(
                    "INSERT OR IGNORE INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count)
                     SELECT
                       ha.id,
                       strip_diacritics(unicode_lower(t.title)),
                       t.title,
                       MIN(ph.played_at),
                       MAX(ph.played_at),
                       COUNT(*)
                     FROM play_history ph
                     JOIN tracks t ON t.id = ph.track_id
                     LEFT JOIN artists ar ON t.artist_id = ar.id
                     JOIN history_artists ha ON ha.canonical_name = strip_diacritics(unicode_lower(COALESCE(ar.name, '')))
                     GROUP BY ha.id, strip_diacritics(unicode_lower(t.title))"
                )?;
                // Step 3: Copy individual play records
                conn.execute_batch(
                    "INSERT INTO history_plays (history_track_id, played_at)
                     SELECT ht.id, ph.played_at
                     FROM play_history ph
                     JOIN tracks t ON t.id = ph.track_id
                     LEFT JOIN artists ar ON t.artist_id = ar.id
                     JOIN history_artists ha ON ha.canonical_name = strip_diacritics(unicode_lower(COALESCE(ar.name, '')))
                     JOIN history_tracks ht ON ht.history_artist_id = ha.id
                       AND ht.canonical_title = strip_diacritics(unicode_lower(t.title))"
                )?;
            }
            conn.execute("UPDATE db_version SET version = 6 WHERE rowid = 1", [])?;
        }

        if version < 7 {
            // Switch from soft delete to hard delete: remove soft-deleted tracks, drop column.
            // Use let _ = to gracefully handle fresh databases where the column doesn't exist.
            let _ = conn.execute_batch("DELETE FROM tracks WHERE deleted = 1");
            let _ = conn.execute_batch("ALTER TABLE tracks DROP COLUMN deleted");
            conn.execute("UPDATE db_version SET version = 7 WHERE rowid = 1", [])?;
        }

        if version < 8 {
            // Drop legacy play_history table — fully replaced by decoupled history_plays.
            let _ = conn.execute_batch("DROP TABLE IF EXISTS play_history");
            conn.execute("UPDATE db_version SET version = 8 WHERE rowid = 1", [])?;
        }

        if version < 9 {
            // Cache library IDs on history tables to avoid correlated subqueries.
            let _ = conn.execute_batch("ALTER TABLE history_artists ADD COLUMN library_artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL");
            let _ = conn.execute_batch("ALTER TABLE history_tracks ADD COLUMN library_track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL");
            // Backfill from current library
            let _ = conn.execute_batch(
                "UPDATE history_artists SET library_artist_id = (
                    SELECT a.id FROM artists a
                    WHERE strip_diacritics(unicode_lower(a.name)) = history_artists.canonical_name
                    LIMIT 1
                )"
            );
            let _ = conn.execute_batch(
                "UPDATE history_tracks SET library_track_id = (
                    SELECT t.id FROM tracks t
                    LEFT JOIN artists ar ON t.artist_id = ar.id
                    JOIN history_artists ha ON ha.id = history_tracks.history_artist_id
                    WHERE strip_diacritics(unicode_lower(t.title)) = history_tracks.canonical_title
                    AND strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) = ha.canonical_name
                    LIMIT 1
                )"
            );
            conn.execute("UPDATE db_version SET version = 9 WHERE rowid = 1", [])?;
        }

        if version < 10 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS lastfm_cache (
                    cache_key  TEXT PRIMARY KEY,
                    value      TEXT NOT NULL,
                    cached_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                )"
            )?;
            conn.execute("UPDATE db_version SET version = 10 WHERE rowid = 1", [])?;
        }

        if version < 11 {
            let _ = conn.execute_batch("ALTER TABLE tracks ADD COLUMN year INTEGER");
            conn.execute("UPDATE db_version SET version = 11 WHERE rowid = 1", [])?;
        }

        if version < 12 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS lyrics (
                    track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
                    text        TEXT NOT NULL,
                    kind        TEXT NOT NULL,
                    provider    TEXT NOT NULL,
                    fetched_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                )"
            )?;
            conn.execute("UPDATE db_version SET version = 12 WHERE rowid = 1", [])?;
        }

        if version < 13 {
            let _ = conn.execute_batch("ALTER TABLE tracks DROP COLUMN subsonic_id");
            conn.execute("UPDATE db_version SET version = 13 WHERE rowid = 1", [])?;
        }

        if version < 14 {
            // Store all local paths as file:// URIs for consistency with subsonic:// paths
            conn.execute_batch(
                "UPDATE tracks SET path = 'file://' || path WHERE path NOT LIKE '%://%'"
            )?;
            conn.execute("UPDATE db_version SET version = 14 WHERE rowid = 1", [])?;
        }

        if version < 15 {
            // Switch to relative paths: strip collection root from track paths.
            // Local tracks: file:///Users/alex/Music/Artist/track.mp3 → Artist/track.mp3
            // Subsonic tracks: subsonic://host/trackId → trackId

            // Table-swap FIRST to change UNIQUE(path) → UNIQUE(collection_id, path).
            // Path stripping can cause collisions under the old single-column constraint
            // (e.g. two collections with the same relative path), so the new composite
            // constraint must be in place before we modify paths.
            conn.execute_batch(
                "CREATE TABLE tracks_new ( \
                    id            INTEGER PRIMARY KEY, \
                    path          TEXT NOT NULL, \
                    title         TEXT NOT NULL, \
                    artist_id     INTEGER REFERENCES artists(id), \
                    album_id      INTEGER REFERENCES albums(id), \
                    track_number  INTEGER, \
                    duration_secs REAL, \
                    format        TEXT, \
                    file_size     INTEGER, \
                    modified_at   INTEGER, \
                    added_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')), \
                    collection_id INTEGER REFERENCES collections(id), \
                    liked         INTEGER NOT NULL DEFAULT 0, \
                    year          INTEGER, \
                    youtube_url   TEXT, \
                    path_normalized TEXT, \
                    UNIQUE(collection_id, path) \
                 ); \
                 INSERT INTO tracks_new SELECT * FROM tracks; \
                 DROP TABLE tracks; \
                 ALTER TABLE tracks_new RENAME TO tracks; \
                 CREATE INDEX IF NOT EXISTS idx_tracks_artist_id ON tracks(artist_id); \
                 CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id); \
                 CREATE INDEX IF NOT EXISTS idx_tracks_collection_id ON tracks(collection_id)"
            )?;

            // Now strip file:// prefix + collection.path + '/' from local tracks
            conn.execute_batch(
                "UPDATE tracks SET path = SUBSTR(tracks.path, LENGTH('file://' || co.path || '/') + 1) \
                 FROM collections co \
                 WHERE tracks.collection_id = co.id \
                   AND tracks.path LIKE 'file://%' \
                   AND co.path IS NOT NULL"
            )?;

            // Strip subsonic://host/ prefix from subsonic tracks.
            conn.execute_batch(
                "UPDATE tracks SET path = SUBSTR(tracks.path, LENGTH('subsonic://' || \
                 REPLACE(REPLACE(RTRIM(co.url, '/'), 'https://', ''), 'http://', '') || '/') + 1) \
                 FROM collections co \
                 WHERE tracks.collection_id = co.id \
                   AND tracks.path LIKE 'subsonic://%' \
                   AND co.url IS NOT NULL"
            )?;

            conn.execute("UPDATE db_version SET version = 15 WHERE rowid = 1", [])?;
            migrated = true;
        }

        if version < 16 {
            // Column may already exist from init_tables on fresh databases
            let _ = conn.execute("ALTER TABLE tracks ADD COLUMN path_normalized TEXT", []);
            conn.execute_batch(
                "UPDATE tracks SET path_normalized = strip_diacritics(unicode_lower(path)) WHERE path_normalized IS NULL"
            )?;
            conn.execute("UPDATE db_version SET version = 16 WHERE rowid = 1", [])?;
            migrated = true;
        }

        if version < 17 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS information_types (
                    id              TEXT NOT NULL,
                    name            TEXT NOT NULL,
                    entity          TEXT NOT NULL,
                    display_kind    TEXT NOT NULL,
                    plugin_id       TEXT NOT NULL,
                    ttl             INTEGER NOT NULL,
                    sort_order      INTEGER NOT NULL DEFAULT 500,
                    priority        INTEGER NOT NULL DEFAULT 500,
                    PRIMARY KEY (id, plugin_id)
                );
                CREATE TABLE IF NOT EXISTS information_values (
                    information_type_id  TEXT NOT NULL,
                    entity_key           TEXT NOT NULL,
                    value                TEXT NOT NULL,
                    status               TEXT NOT NULL DEFAULT 'ok',
                    fetched_at           INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                    PRIMARY KEY (information_type_id, entity_key)
                );
                CREATE INDEX IF NOT EXISTS idx_info_values_entity ON information_values(entity_key);
                CREATE TABLE IF NOT EXISTS information_type_providers (
                    information_type_id  TEXT NOT NULL,
                    plugin_id            TEXT NOT NULL,
                    user_priority        INTEGER NOT NULL,
                    enabled              INTEGER NOT NULL DEFAULT 1,
                    PRIMARY KEY (information_type_id, plugin_id)
                );"
            )?;
            conn.execute("UPDATE db_version SET version = 17 WHERE rowid = 1", [])?;
            migrated = true;
        }

        drop(conn);
        if version < 12 || version < 16 {
            crate::timing::timer().time("db: rebuild_fts", || self.rebuild_fts())?;
        }
        if migrated {
            crate::timing::timer().time("db: recompute_counts", || self.recompute_counts())?;
        }
        Ok(())
    }

    // --- Artists ---

    pub fn get_or_create_artist(&self, name: &str) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<i64> = conn.query_row(
            "SELECT id FROM artists WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1))",
            params![name],
            |row| row.get(0),
        ).optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
        conn.execute("INSERT INTO artists (name) VALUES (?1)", params![name])?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_artists(&self) -> SqlResult<Vec<Artist>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, track_count, liked FROM artists WHERE track_count > 0 ORDER BY name"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Artist {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
                liked: row.get::<_, i32>(3).unwrap_or(0),
            })
        })?;
        rows.collect()
    }

    // --- Albums ---

    pub fn get_or_create_album(
        &self,
        title: &str,
        artist_id: Option<i64>,
        year: Option<i32>,
    ) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<i64> = conn.query_row(
            "SELECT id FROM albums WHERE strip_diacritics(unicode_lower(title)) = strip_diacritics(unicode_lower(?1)) \
             AND (artist_id = ?2 OR (?2 IS NULL AND artist_id IS NULL))",
            params![title, artist_id],
            |row| row.get(0),
        ).optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
        conn.execute(
            "INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)",
            params![title, artist_id, year],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_albums(&self, artist_id: Option<i64>) -> SqlResult<Vec<Album>> {
        let conn = self.conn.lock().unwrap();
        if let Some(aid) = artist_id {
            let mut stmt = conn.prepare(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked
                 FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id
                 WHERE a.artist_id = ?1 AND a.track_count > 0
                 ORDER BY a.year, a.title"
            )?;
            let rows = stmt.query_map(params![aid], |row| album_from_row(row))?;
            rows.collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked
                 FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id
                 WHERE a.track_count > 0
                 ORDER BY a.title"
            )?;
            let rows = stmt.query_map([], |row| album_from_row(row))?;
            rows.collect()
        }
    }

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

    pub fn get_top_artists_for_tag(&self, tag_id: i64, limit: usize) -> SqlResult<Vec<(i64, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ar.id, ar.name, COUNT(DISTINCT t.id) as cnt
             FROM track_tags tt
             JOIN tracks t ON t.id = tt.track_id
             JOIN artists ar ON ar.id = t.artist_id
             WHERE tt.tag_id = ?1 AND t.artist_id IS NOT NULL
             GROUP BY ar.id
             ORDER BY cnt DESC
             LIMIT ?2"
        )?;
        let rows = stmt.query_map(rusqlite::params![tag_id, limit as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
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

    // --- Tracks ---

    pub fn get_track_count(&self) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT COUNT(*) FROM tracks t WHERE 1=1 {}", ENABLED_COLLECTION_FILTER),
            [],
            |row| row.get(0),
        )
    }

    pub fn upsert_track(
        &self,
        path: &str,
        title: &str,
        artist_id: Option<i64>,
        album_id: Option<i64>,
        track_number: Option<i32>,
        duration_secs: Option<f64>,
        format: Option<&str>,
        file_size: Option<i64>,
        modified_at: Option<i64>,
        collection_id: Option<i64>,
        year: Option<i32>,
    ) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tracks (path, path_normalized, title, artist_id, album_id, track_number, duration_secs, format, file_size, modified_at, collection_id, year)
             VALUES (?1, strip_diacritics(unicode_lower(?1)), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(collection_id, path) DO UPDATE SET
                title=excluded.title, artist_id=excluded.artist_id, album_id=excluded.album_id,
                track_number=excluded.track_number,
                duration_secs=excluded.duration_secs, format=excluded.format,
                file_size=excluded.file_size, modified_at=excluded.modified_at,
                year=excluded.year, path_normalized=excluded.path_normalized",
            params![path, title, artist_id, album_id, track_number, duration_secs, format, file_size, modified_at, collection_id, year],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM tracks WHERE collection_id IS ?1 AND path = ?2",
            params![collection_id, path],
            |row| row.get(0),
        )?;
        Ok(id)
    }


    pub fn clear_database(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM track_tags;
             DELETE FROM lyrics;
             DELETE FROM tracks;
             DELETE FROM albums;
             DELETE FROM artists;
             DELETE FROM tags;
             DELETE FROM history_plays;
             DELETE FROM history_tracks;
             DELETE FROM history_artists;
             DELETE FROM collections;
             DROP TABLE IF EXISTS tracks_fts;
             CREATE VIRTUAL TABLE tracks_fts USING fts5(
                 title,
                 artist_name,
                 album_title,
                 tag_names,
                 lyrics_text,
                 content='',
                 tokenize='unicode61 remove_diacritics 2'
             );"
        )?;
        Ok(())
    }

    pub fn rebuild_fts(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DROP TABLE IF EXISTS tracks_fts;
             CREATE VIRTUAL TABLE tracks_fts USING fts5(
                 title,
                 artist_name,
                 album_title,
                 tag_names,
                 lyrics_text,
                 content='',
                 tokenize='unicode61 remove_diacritics 2'
             );"
        )?;
        conn.execute_batch(
            &format!(
                "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, lyrics_text)
                 SELECT t.id, strip_diacritics(t.title), strip_diacritics(COALESCE(ar.name, '')), strip_diacritics(COALESCE(al.title, '')),
                        strip_diacritics(COALESCE((SELECT GROUP_CONCAT(tg.name, ' ') FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.track_id = t.id), '')),
                        strip_diacritics(COALESCE(ly.text, ''))
                 FROM tracks t
                 LEFT JOIN artists ar ON t.artist_id = ar.id
                 LEFT JOIN albums al ON t.album_id = al.id
                 LEFT JOIN lyrics ly ON ly.track_id = t.id
                 WHERE 1=1 {};",
                ENABLED_COLLECTION_FILTER
            ),
        )?;
        Ok(())
    }

    pub fn recompute_counts(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            &format!(
                "UPDATE artists SET track_count = (
                   SELECT COUNT(*) FROM tracks t
                   WHERE t.artist_id = artists.id {cf}
                 );
                 UPDATE albums SET track_count = (
                   SELECT COUNT(*) FROM tracks t
                   WHERE t.album_id = albums.id {cf}
                 );
                 UPDATE tags SET track_count = (
                   SELECT COUNT(*) FROM track_tags tt
                   JOIN tracks t ON t.id = tt.track_id
                   WHERE tt.tag_id = tags.id {cf}
                 );",
                cf = ENABLED_COLLECTION_FILTER
            )
        )
    }

    pub fn get_tracks(&self, opts: &TrackQuery) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();

        // If query is present and non-empty, use FTS path
        if let Some(ref query) = opts.query {
            if !query.trim().is_empty() {
                return self.search_tracks_inner(&conn, opts, query);
            }
        }

        // Album-scoped: return all tracks for album, ordered by track_number
        if let Some(aid) = opts.album_id {
            let sql = format!("{} WHERE t.album_id = ?1 {} ORDER BY t.track_number, t.title", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![aid], |row| track_from_row(row))?;
            return rows.collect();
        }

        // Default paginated path
        let order_by = if let Some(col) = sort_column_sql(opts.sort_field.as_deref()) {
            let dir = match opts.sort_dir.as_deref() {
                Some("desc") => "DESC",
                _ => "ASC",
            };
            format!("ORDER BY {} {}, t.id", col, dir)
        } else {
            "ORDER BY ar.name, al.title, t.track_number, t.title, t.id".to_string()
        };

        let youtube_filter = if opts.has_youtube_url { "AND t.youtube_url IS NOT NULL AND t.youtube_url != ''" } else { "" };
        let media_type_filter = match opts.media_type.as_deref() {
            Some("audio") => "AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))",
            Some("video") => "AND LOWER(t.format) IN ('mp4','m4v','mov','webm')",
            _ => "",
        };
        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);
        let sql = format!("{} WHERE 1=1 {} {} {} {} LIMIT ?1 OFFSET ?2", TRACK_SELECT, ENABLED_COLLECTION_FILTER, youtube_filter, media_type_filter, order_by);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit, offset], |row| track_from_row(row))?;
        rows.collect()
    }

    pub fn get_tracks_by_artist(&self, artist_id: i64) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE t.artist_id = ?1 {} ORDER BY al.title, t.track_number, t.title", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![artist_id], |row| track_from_row(row))?;
        rows.collect()
    }

    pub fn get_track_by_id(&self, track_id: i64) -> SqlResult<Track> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE t.id = ?1", TRACK_SELECT);
        conn.query_row(&sql, params![track_id], |row| track_from_row(row))
    }

    fn search_tracks_inner(&self, conn: &rusqlite::Connection, opts: &TrackQuery, query: &str) -> SqlResult<Vec<Track>> {
        let normalized = strip_diacritics(query);
        let words = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" AND ");
        let has_fts_words = !words.is_empty();

        let fts_query = if has_fts_words {
            if opts.include_lyrics {
                words
            } else {
                format!("{{title artist_name album_title tag_names}}:{}", words)
            }
        } else {
            String::new()
        };

        // LIKE parameter for exact substring match on pre-computed normalized path
        let normalized_lower = normalized.to_lowercase();
        let like_param = format!(
            "%{}%",
            normalized_lower.replace('%', "\\%").replace('_', "\\_")
        );

        let mut sql = TRACK_SELECT.to_string();

        if opts.tag_id.is_some() {
            sql.push_str(" JOIN track_tags tt ON tt.track_id = t.id");
        }

        // Match either FTS (for title/artist/album/tags) OR LIKE (for path substring)
        let mut param_idx;
        if has_fts_words {
            sql.push_str(
                " WHERE (EXISTS (SELECT 1 FROM tracks_fts WHERE tracks_fts MATCH ?1 AND rowid = t.id) \
                 OR t.path_normalized LIKE ?2 ESCAPE '\\')"
            );
            param_idx = 3;
        } else {
            sql.push_str(" WHERE t.path_normalized LIKE ?1 ESCAPE '\\'");
            param_idx = 2;
        }
        sql.push_str(&format!(" {}", ENABLED_COLLECTION_FILTER));

        if opts.artist_id.is_some() {
            sql.push_str(&format!(" AND t.artist_id = ?{}", param_idx));
            param_idx += 1;
        }
        if opts.album_id.is_some() {
            sql.push_str(&format!(" AND t.album_id = ?{}", param_idx));
            param_idx += 1;
        }
        if opts.tag_id.is_some() {
            sql.push_str(&format!(" AND tt.tag_id = ?{}", param_idx));
            param_idx += 1;
        }
        if opts.liked_only {
            sql.push_str(" AND t.liked = 1");
        }
        if opts.has_youtube_url {
            sql.push_str(" AND t.youtube_url IS NOT NULL AND t.youtube_url != ''");
        }
        match opts.media_type.as_deref() {
            Some("audio") => sql.push_str(" AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))"),
            Some("video") => sql.push_str(" AND LOWER(t.format) IN ('mp4','m4v','mov','webm')"),
            _ => {}
        }

        if let Some(col) = sort_column_sql(opts.sort_field.as_deref()) {
            let dir = match opts.sort_dir.as_deref() {
                Some("desc") => "DESC",
                _ => "ASC",
            };
            sql.push_str(&format!(" ORDER BY {} {}, t.id", col, dir));
        }

        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);
        sql.push_str(&format!(" LIMIT ?{} OFFSET ?{}", param_idx, param_idx + 1));

        let mut stmt = conn.prepare(&sql)?;

        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        if has_fts_words {
            params_vec.push(Box::new(fts_query));
        }
        params_vec.push(Box::new(like_param));
        if let Some(aid) = opts.artist_id {
            params_vec.push(Box::new(aid));
        }
        if let Some(alid) = opts.album_id {
            params_vec.push(Box::new(alid));
        }
        if let Some(tid) = opts.tag_id {
            params_vec.push(Box::new(tid));
        }
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| track_from_row(row))?;
        rows.collect()
    }

    pub fn search_all(&self, query: &str, artist_limit: i64, album_limit: i64, track_limit: i64) -> SqlResult<SearchAllResults> {
        let conn = self.conn.lock().unwrap();
        let normalized = strip_diacritics(query).to_lowercase();
        let like_param = format!(
            "%{}%",
            normalized.replace('%', "\\%").replace('_', "\\_")
        );

        // --- Artists ---
        let artists = {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT a.id, a.name, a.track_count, a.liked \
                 FROM artists a \
                 JOIN tracks t ON t.artist_id = a.id \
                 WHERE strip_diacritics(unicode_lower(a.name)) LIKE ?1 ESCAPE '\\' \
                 AND a.track_count > 0 \
                 AND (t.collection_id IS NULL OR EXISTS (SELECT 1 FROM collections c WHERE c.id = t.collection_id AND c.enabled = 1)) \
                 ORDER BY a.name LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![like_param, artist_limit], |row| {
                Ok(Artist {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    track_count: row.get(2)?,
                    liked: row.get::<_, i32>(3).unwrap_or(0),
                })
            })?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };

        // --- Albums ---
        let albums = {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT al.id, al.title, al.artist_id, ar.name, al.year, al.track_count, al.liked \
                 FROM albums al \
                 LEFT JOIN artists ar ON al.artist_id = ar.id \
                 JOIN tracks t ON t.album_id = al.id \
                 WHERE strip_diacritics(unicode_lower(al.title)) LIKE ?1 ESCAPE '\\' \
                 AND al.track_count > 0 \
                 AND (t.collection_id IS NULL OR EXISTS (SELECT 1 FROM collections c WHERE c.id = t.collection_id AND c.enabled = 1)) \
                 ORDER BY al.title LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![like_param, album_limit], |row| album_from_row(row))?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };

        // --- Tracks (reuse FTS) ---
        let track_opts = TrackQuery {
            limit: Some(track_limit),
            include_lyrics: true,
            ..Default::default()
        };
        let tracks = self.search_tracks_inner(&conn, &track_opts, query)?;

        Ok(SearchAllResults { artists, albums, tracks })
    }

    // --- Collections ---

    pub fn add_collection(
        &self,
        kind: &str,
        name: &str,
        path: Option<&str>,
        url: Option<&str>,
        username: Option<&str>,
        password_token: Option<&str>,
        salt: Option<&str>,
        auth_method: Option<&str>,
    ) -> SqlResult<Collection> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO collections (kind, name, path, url, username, password_token, salt, auth_method)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![kind, name, path, url, username, password_token, salt, auth_method.unwrap_or("token")],
        )?;
        let id = conn.last_insert_rowid();
        Ok(Collection {
            id,
            kind: kind.to_string(),
            name: name.to_string(),
            path: path.map(|s| s.to_string()),
            url: url.map(|s| s.to_string()),
            username: username.map(|s| s.to_string()),
            last_synced_at: None,
            auto_update: false,
            auto_update_interval_mins: 60,
            enabled: true,
            last_sync_duration_secs: None,
            last_sync_error: None,
        })
    }

    pub fn remove_collection(&self, collection_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM tracks WHERE collection_id = ?1",
            params![collection_id],
        )?;
        conn.execute(
            "DELETE FROM collections WHERE id = ?1",
            params![collection_id],
        )?;
        // Clean up orphaned artists, albums, tags
        conn.execute_batch(
            "DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL);
             DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL)
                                   AND id NOT IN (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL);
             DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM track_tags);",
        )?;
        Ok(())
    }

    pub fn get_collections(&self) -> SqlResult<Vec<Collection>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, kind, name, path, url, username, last_synced_at, auto_update, auto_update_interval_mins, enabled, last_sync_duration_secs, last_sync_error FROM collections ORDER BY name"
        )?;
        let rows = stmt.query_map([], |row| collection_from_row(row))?;
        rows.collect()
    }

    pub fn get_collection_stats(&self) -> SqlResult<Vec<CollectionStats>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT collection_id,
                    COUNT(*) as track_count,
                    SUM(CASE WHEN lower(format) IN ('mp4','m4v','mov','webm') THEN 1 ELSE 0 END) as video_count,
                    COALESCE(SUM(file_size), 0) as total_size,
                    COALESCE(SUM(duration_secs), 0.0) as total_duration
             FROM tracks
             WHERE collection_id IS NOT NULL
             GROUP BY collection_id"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(CollectionStats {
                collection_id: row.get(0)?,
                track_count: row.get(1)?,
                video_count: row.get(2)?,
                total_size: row.get(3)?,
                total_duration: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_collection_by_id(&self, collection_id: i64) -> SqlResult<Collection> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, kind, name, path, url, username, last_synced_at, auto_update, auto_update_interval_mins, enabled, last_sync_duration_secs, last_sync_error FROM collections WHERE id = ?1",
            params![collection_id],
            |row| collection_from_row(row),
        )
    }

    pub fn get_collection_credentials(&self, collection_id: i64) -> SqlResult<CollectionCredentials> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT url, username, password_token, salt, auth_method FROM collections WHERE id = ?1",
            params![collection_id],
            |row| {
                Ok(CollectionCredentials {
                    url: row.get(0)?,
                    username: row.get(1)?,
                    password_token: row.get(2)?,
                    salt: row.get(3)?,
                    auth_method: row.get::<_, Option<String>>(4)?.unwrap_or_else(|| "token".to_string()),
                })
            },
        )
    }

    pub fn update_collection(
        &self,
        collection_id: i64,
        name: &str,
        auto_update: bool,
        auto_update_interval_mins: i64,
        enabled: bool,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE collections SET name = ?2, auto_update = ?3, auto_update_interval_mins = ?4, enabled = ?5 WHERE id = ?1",
            params![collection_id, name, auto_update as i32, auto_update_interval_mins, enabled as i32],
        )?;
        Ok(())
    }

    pub fn update_collection_synced(&self, collection_id: i64, duration_secs: f64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE collections SET last_synced_at = strftime('%s', 'now'), last_sync_duration_secs = ?2, last_sync_error = NULL WHERE id = ?1",
            params![collection_id, duration_secs],
        )?;
        Ok(())
    }

    pub fn update_collection_sync_error(&self, collection_id: i64, error: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE collections SET last_sync_error = ?2 WHERE id = ?1",
            params![collection_id, error],
        )?;
        Ok(())
    }

    pub fn clear_collection_sync_error(&self, collection_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE collections SET last_sync_error = NULL WHERE id = ?1",
            params![collection_id],
        )?;
        Ok(())
    }

    pub fn get_track_paths_for_collection(&self, collection_id: i64) -> SqlResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT path FROM tracks WHERE collection_id = ?1")?;
        let rows = stmt.query_map(params![collection_id], |row| row.get(0))?;
        rows.collect()
    }

    pub fn delete_tracks_by_paths_in_collection(&self, collection_id: i64, paths: &[String]) -> SqlResult<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        for chunk in paths.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "DELETE FROM tracks WHERE collection_id = ?1 AND path IN ({})",
                placeholders
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut params: Vec<&dyn rusqlite::types::ToSql> = Vec::with_capacity(chunk.len() + 1);
            params.push(&collection_id);
            params.extend(chunk.iter().map(|p| p as &dyn rusqlite::types::ToSql));
            stmt.execute(params.as_slice())?;
        }
        Ok(())
    }

    pub fn delete_tracks_by_ids(&self, ids: &[i64]) -> SqlResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        for chunk in ids.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("DELETE FROM tracks WHERE id IN ({})", placeholders);
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::types::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
            stmt.execute(params.as_slice())?;
        }
        Ok(())
    }

    /// Bulk update metadata fields on multiple tracks in a single transaction.
    /// Returns Vec of (track_id, path, collection_id) for file writing.
    pub fn bulk_update_tracks(
        &self,
        track_ids: &[i64],
        artist_name: Option<&str>,
        album_title: Option<&str>,
        year: Option<i32>,
        tag_names: Option<&[String]>,
    ) -> SqlResult<Vec<(i64, String, Option<i64>)>> {
        if track_ids.is_empty() {
            return Ok(vec![]);
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let result = {
            let conn = self.conn.lock().unwrap();
            conn.execute_batch("BEGIN")?;

            let inner = (|| -> SqlResult<Vec<(i64, String, Option<i64>)>> {
                // Step 1: Artist
                let new_artist_id: Option<i64> = if let Some(name) = artist_name {
                    let existing: Option<i64> = conn.query_row(
                        "SELECT id FROM artists WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1))",
                        params![name],
                        |row| row.get(0),
                    ).optional()?;
                    let aid = match existing {
                        Some(id) => id,
                        None => {
                            conn.execute("INSERT INTO artists (name) VALUES (?1)", params![name])?;
                            conn.last_insert_rowid()
                        }
                    };
                    for chunk in track_ids.chunks(500) {
                        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                        let sql = format!("UPDATE tracks SET artist_id = ?1 WHERE id IN ({})", placeholders);
                        let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(aid)];
                        all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                        let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                        conn.execute(&sql, param_refs.as_slice())?;
                    }
                    Some(aid)
                } else {
                    None
                };

                // Step 2: Album
                if let Some(title) = album_title {
                    if let Some(aid) = new_artist_id {
                        // All tracks share the new artist — create one album
                        let album_year = year.or_else(|| {
                            // Try to get year from first track's current album
                            conn.query_row(
                                "SELECT al.year FROM tracks t JOIN albums al ON t.album_id = al.id WHERE t.id = ?1 AND al.year IS NOT NULL",
                                params![track_ids[0]],
                                |row| row.get(0),
                            ).optional().ok().flatten()
                        });
                        let existing_album: Option<i64> = conn.query_row(
                            "SELECT id FROM albums WHERE strip_diacritics(unicode_lower(title)) = strip_diacritics(unicode_lower(?1)) \
                             AND (artist_id = ?2 OR (?2 IS NULL AND artist_id IS NULL))",
                            params![title, aid],
                            |row| row.get(0),
                        ).optional()?;
                        let album_id = match existing_album {
                            Some(id) => id,
                            None => {
                                conn.execute(
                                    "INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)",
                                    params![title, aid, album_year],
                                )?;
                                conn.last_insert_rowid()
                            }
                        };
                        for chunk in track_ids.chunks(500) {
                            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                            let sql = format!("UPDATE tracks SET album_id = ?1 WHERE id IN ({})", placeholders);
                            let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(album_id)];
                            all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                            let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                            conn.execute(&sql, param_refs.as_slice())?;
                        }
                    } else {
                        // Artist was NOT changed — group tracks by their current artist_id
                        let mut artist_groups: std::collections::HashMap<Option<i64>, Vec<i64>> = std::collections::HashMap::new();
                        for chunk in track_ids.chunks(500) {
                            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                            let sql = format!("SELECT id, artist_id FROM tracks WHERE id IN ({})", placeholders);
                            let mut stmt = conn.prepare(&sql)?;
                            let params: Vec<&dyn rusqlite::types::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
                            let rows = stmt.query_map(params.as_slice(), |row| {
                                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?))
                            })?;
                            for row in rows {
                                let (tid, aid) = row?;
                                artist_groups.entry(aid).or_default().push(tid);
                            }
                        }
                        for (aid, tids) in &artist_groups {
                            let album_year = year.or_else(|| {
                                conn.query_row(
                                    "SELECT al.year FROM tracks t JOIN albums al ON t.album_id = al.id WHERE t.id = ?1 AND al.year IS NOT NULL",
                                    params![tids[0]],
                                    |row| row.get(0),
                                ).optional().ok().flatten()
                            });
                            let existing_album: Option<i64> = conn.query_row(
                                "SELECT id FROM albums WHERE strip_diacritics(unicode_lower(title)) = strip_diacritics(unicode_lower(?1)) \
                                 AND (artist_id = ?2 OR (?2 IS NULL AND artist_id IS NULL))",
                                params![title, *aid],
                                |row| row.get(0),
                            ).optional()?;
                            let album_id = match existing_album {
                                Some(id) => id,
                                None => {
                                    conn.execute(
                                        "INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)",
                                        params![title, *aid, album_year],
                                    )?;
                                    conn.last_insert_rowid()
                                }
                            };
                            for chunk in tids.chunks(500) {
                                let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                                let sql = format!("UPDATE tracks SET album_id = ?1 WHERE id IN ({})", placeholders);
                                let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(album_id)];
                                all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                                let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                                conn.execute(&sql, param_refs.as_slice())?;
                            }
                        }
                    }
                }

                // Step 3: Year
                if let Some(y) = year {
                    for chunk in track_ids.chunks(500) {
                        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                        let sql = format!("UPDATE tracks SET year = ?1 WHERE id IN ({})", placeholders);
                        let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(y)];
                        all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                        let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                        conn.execute(&sql, param_refs.as_slice())?;
                    }
                }

                // Step 4: Tags
                if let Some(tags) = tag_names {
                    // Pre-resolve/create all tag IDs
                    let mut tag_ids: Vec<i64> = Vec::with_capacity(tags.len());
                    for name in tags {
                        let tag_id: i64 = match conn.query_row(
                            "SELECT id FROM tags WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1))",
                            params![name],
                            |row| row.get(0),
                        ).optional()? {
                            Some(id) => id,
                            None => {
                                conn.execute("INSERT INTO tags (name) VALUES (?1)", params![name])?;
                                conn.last_insert_rowid()
                            }
                        };
                        tag_ids.push(tag_id);
                    }

                    for &tid in track_ids {
                        conn.execute("DELETE FROM track_tags WHERE track_id = ?1", params![tid])?;
                        for &tag_id in &tag_ids {
                            conn.execute(
                                "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)",
                                params![tid, tag_id],
                            )?;
                        }
                    }
                }

                // Step 5: Update modified_at
                for chunk in track_ids.chunks(500) {
                    let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                    let sql = format!("UPDATE tracks SET modified_at = ?1 WHERE id IN ({})", placeholders);
                    let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now)];
                    all_params.extend(chunk.iter().map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>));
                    let param_refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|p| p.as_ref()).collect();
                    conn.execute(&sql, param_refs.as_slice())?;
                }

                // Step 6: Collect track info for file writing (reconstruct full URI)
                let mut results: Vec<(i64, String, Option<i64>)> = Vec::new();
                for chunk in track_ids.chunks(500) {
                    let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                    let sql = format!(
                        "SELECT t.id, {}, t.collection_id \
                         FROM tracks t LEFT JOIN collections co ON t.collection_id = co.id \
                         WHERE t.id IN ({})",
                        PATH_EXPR, placeholders
                    );
                    let mut stmt = conn.prepare(&sql)?;
                    let params: Vec<&dyn rusqlite::types::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
                    let rows = stmt.query_map(params.as_slice(), |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                        ))
                    })?;
                    for row in rows {
                        results.push(row?);
                    }
                }

                // Step 7: Commit
                conn.execute_batch("COMMIT")?;
                Ok(results)
            })();

            match inner {
                Ok(results) => Ok(results),
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(e)
                }
            }
        }; // lock dropped here

        // Step 7 continued: recompute counts and rebuild FTS after lock is released
        if result.is_ok() {
            self.recompute_counts()?;
            self.rebuild_fts()?;
        }

        result
    }

    pub fn get_track_by_remote_id(
        &self,
        remote_id: &str,
        collection_id: i64,
    ) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "{} WHERE t.path = ?1 AND t.collection_id = ?2",
            TRACK_SELECT
        ))?;
        let track = stmt
            .query_map(params![remote_id, collection_id], |row| {
                track_from_row(row)
            })?
            .filter_map(|r| r.ok())
            .next();
        Ok(track)
    }

    pub fn get_tracks_by_ids(&self, ids: &[i64]) -> SqlResult<Vec<Track>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("{} WHERE t.id IN ({})", TRACK_SELECT, placeholders);
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
        let rows = stmt.query_map(params.as_slice(), |row| track_from_row(row))?;
        let track_map: std::collections::HashMap<i64, Track> = rows.filter_map(|r| r.ok()).map(|t| (t.id, t)).collect();
        // Return in input order, skipping missing ids
        Ok(ids.iter().filter_map(|id| track_map.get(id).cloned()).collect())
    }

    /// Looks up tracks by full URI (e.g. file:///music/song.mp3).
    /// Uses the path reconstruction expression to match against the stored relative paths.
    pub fn get_tracks_by_paths(&self, uris: &[String]) -> SqlResult<Vec<Track>> {
        if uris.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = uris.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        // Filter on the reconstructed full URI (same CASE expression as TRACK_SELECT)
        let sql = format!(
            "{} WHERE {} IN ({})",
            TRACK_SELECT, PATH_EXPR, placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> = uris.iter().map(|p| p as &dyn rusqlite::types::ToSql).collect();
        let rows = stmt.query_map(params.as_slice(), |row| track_from_row(row))?;
        let track_map: std::collections::HashMap<String, Track> = rows.filter_map(|r| r.ok()).map(|t| (t.path.clone(), t)).collect();
        // Return in input order, skipping missing paths
        Ok(uris.iter().filter_map(|p| track_map.get(p).cloned()).collect())
    }

    pub fn get_track_modified_at_by_path(&self, path: &str, collection_id: Option<i64>) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT modified_at FROM tracks WHERE path = ?1 AND collection_id IS ?2",
            params![path, collection_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn get_local_track_paths_for_collection(&self, collection_id: i64) -> SqlResult<Vec<String>> {
        self.get_track_paths_for_collection(collection_id)
    }

    pub fn remove_track_by_id(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tracks WHERE id = ?1", params![track_id])?;
        Ok(())
    }

    // --- Liked tracks ---

    pub fn set_track_youtube_url(&self, track_id: i64, url: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET youtube_url = ?2 WHERE id = ?1",
            params![track_id, url],
        )?;
        Ok(())
    }

    pub fn clear_track_youtube_url(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET youtube_url = NULL WHERE id = ?1",
            params![track_id],
        )?;
        Ok(())
    }

    pub fn toggle_liked(&self, table: &str, id: i64, liked: i32) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            &format!("UPDATE {} SET liked = ?2 WHERE id = ?1", table),
            params![id, liked],
        )?;
        Ok(())
    }

    pub fn get_liked_tracks(&self) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE t.liked = 1 {} ORDER BY ar.name, al.title, t.track_number, t.title", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| track_from_row(row))?;
        rows.collect()
    }

    // --- Image fetch failures ---

    pub fn record_image_failure(&self, kind: &str, item_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO image_fetch_failures (kind, item_id) VALUES (?1, ?2)",
            params![kind, item_id],
        )?;
        Ok(())
    }

    pub fn is_image_failed(&self, kind: &str, item_id: i64) -> SqlResult<bool> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM image_fetch_failures WHERE kind = ?1 AND item_id = ?2",
            params![kind, item_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn clear_image_failure(&self, kind: &str, item_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM image_fetch_failures WHERE kind = ?1 AND item_id = ?2",
            params![kind, item_id],
        )?;
        Ok(())
    }

    pub fn clear_image_failures(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM image_fetch_failures", [])?;
        Ok(())
    }

    // --- Lyrics ---

    pub fn get_lyrics(&self, track_id: i64) -> SqlResult<Option<crate::models::Lyrics>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT track_id, text, kind, provider, fetched_at FROM lyrics WHERE track_id = ?1"
        )?;
        let result = stmt.query_row(params![track_id], |row| {
            Ok(crate::models::Lyrics {
                track_id: row.get(0)?,
                text: row.get(1)?,
                kind: row.get(2)?,
                provider: row.get(3)?,
                fetched_at: row.get(4)?,
            })
        });
        match result {
            Ok(lyrics) => Ok(Some(lyrics)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn save_lyrics(&self, track_id: i64, text: &str, kind: &str, provider: &str) -> SqlResult<crate::models::Lyrics> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO lyrics (track_id, text, kind, provider, fetched_at) VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))",
            params![track_id, text, kind, provider],
        )?;
        let fetched_at: i64 = conn.query_row(
            "SELECT fetched_at FROM lyrics WHERE track_id = ?1",
            params![track_id],
            |row| row.get(0),
        )?;
        Ok(crate::models::Lyrics {
            track_id,
            text: text.to_string(),
            kind: kind.to_string(),
            provider: provider.to_string(),
            fetched_at,
        })
    }

    pub fn delete_lyrics(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM lyrics WHERE track_id = ?1", params![track_id])?;
        Ok(())
    }

    /// Update the FTS index for a single track after lyrics change.
    pub fn update_fts_for_track(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?1)",
            params![track_id],
            |row| row.get(0),
        )?;
        if !exists { return Ok(()); }

        // Get lyrics text for FTS, stripping timestamps if synced
        let lyrics_for_fts: String = {
            let lyrics_text: Option<(String, String)> = conn.query_row(
                "SELECT text, kind FROM lyrics WHERE track_id = ?1",
                params![track_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).ok();
            match lyrics_text {
                Some((text, kind)) if kind == "synced" => strip_lrc_timestamps(&text),
                Some((text, _)) => text,
                None => String::new(),
            }
        };

        conn.execute(
            &format!(
                "INSERT OR REPLACE INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, lyrics_text)
                 SELECT t.id, strip_diacritics(t.title), strip_diacritics(COALESCE(ar.name, '')), strip_diacritics(COALESCE(al.title, '')),
                        strip_diacritics(COALESCE((SELECT GROUP_CONCAT(tg.name, ' ') FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.track_id = t.id), '')),
                        strip_diacritics(COALESCE(?2, ''))
                 FROM tracks t
                 LEFT JOIN artists ar ON t.artist_id = ar.id
                 LEFT JOIN albums al ON t.album_id = al.id
                 WHERE t.id = ?1 {}",
                ENABLED_COLLECTION_FILTER
            ),
            params![track_id, lyrics_for_fts],
        )?;
        Ok(())
    }

    /// Check which track IDs from a list have lyrics matching the given search query.
    pub fn check_lyrics_match(&self, track_ids: &[i64], query: &str) -> SqlResult<Vec<i64>> {
        if track_ids.is_empty() || query.trim().is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let normalized = strip_diacritics(query);
        let fts_query = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" AND ");

        let placeholders: Vec<String> = track_ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 2)).collect();
        let column_query = format!("lyrics_text:{}", fts_query);
        let sql = format!(
            "SELECT fts.rowid FROM tracks_fts fts WHERE tracks_fts MATCH ?1 AND fts.rowid IN ({})",
            placeholders.join(",")
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(column_query)];
        for id in track_ids {
            params_vec.push(Box::new(*id));
        }
        let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

        let rows = stmt.query_map(params_refs.as_slice(), |row| row.get::<_, i64>(0))?;
        rows.collect()
    }

    // --- Image helpers ---

    /// Look up the entity name (and artist name for albums) by kind and id.
    pub fn get_entity_image_name(&self, kind: &str, id: i64) -> SqlResult<(String, Option<String>)> {
        let conn = self.conn.lock().unwrap();
        match kind {
            "artist" => {
                let name: String = conn.query_row(
                    "SELECT COALESCE(name, '') FROM artists WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                Ok((name, None))
            }
            "album" => {
                let (title, artist_name): (String, Option<String>) = conn.query_row(
                    "SELECT COALESCE(a.title, ''), ar.name FROM albums a \
                     LEFT JOIN artists ar ON a.artist_id = ar.id WHERE a.id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                Ok((title, artist_name))
            }
            "tag" => {
                let name: String = conn.query_row(
                    "SELECT COALESCE(name, '') FROM tags WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                Ok((name, None))
            }
            _ => Ok(("_unknown".to_string(), None))
        }
    }

    /// Returns the full filesystem path for a local track in the given album.
    /// Used for extracting embedded cover art.
    pub fn get_track_path_for_album(
        &self,
        album_title: &str,
        artist_name: Option<&str>,
    ) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match artist_name {
            Some(artist) => conn.query_row(
                "SELECT co.path || '/' || t.path FROM tracks t \
                 JOIN albums a ON t.album_id = a.id \
                 LEFT JOIN artists ar ON t.artist_id = ar.id \
                 LEFT JOIN collections co ON t.collection_id = co.id \
                 WHERE a.title = ?1 AND ar.name = ?2 AND co.kind = 'local' LIMIT 1",
                params![album_title, artist],
                |row| row.get(0),
            ),
            None => conn.query_row(
                "SELECT co.path || '/' || t.path FROM tracks t \
                 JOIN albums a ON t.album_id = a.id \
                 LEFT JOIN collections co ON t.collection_id = co.id \
                 WHERE a.title = ?1 AND co.kind = 'local' LIMIT 1",
                params![album_title],
                |row| row.get(0),
            ),
        }
        .optional()
    }

    // --- Play history ---

    pub fn record_play(&self, track_id: i64) -> SqlResult<()> {
        self.record_history_play(track_id)
    }

    pub fn get_auto_continue_track(&self, strategy: &str, current_track_id: i64, format_filter: Option<&str>, exclude_ids: &[i64]) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();

        let format_clause = match format_filter {
            Some("video") => " AND LOWER(t.format) IN ('mp4','m4v','mov','webm')",
            Some("audio") => " AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))",
            _ => "",
        };

        let dislike_clause = " AND t.liked != -1";

        // Safe to inline i64 values directly — no injection risk from integer types
        let exclude_clause = if exclude_ids.is_empty() {
            String::new()
        } else {
            let ids: Vec<String> = exclude_ids.iter().map(|id| id.to_string()).collect();
            format!(" AND t.id NOT IN ({})", ids.join(","))
        };

        match strategy {
            "random" => {
                let sql = format!("{} WHERE t.id != ?1 {}{}{}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause);
                conn.query_row(&sql, params![current_track_id], |row| track_from_row(row)).optional()
            }
            "same_artist" => {
                let artist_id: Option<i64> = conn.query_row(
                    "SELECT artist_id FROM tracks WHERE id = ?1",
                    params![current_track_id],
                    |row| row.get(0),
                ).optional()?.flatten();
                match artist_id {
                    Some(aid) => {
                        let sql = format!("{} WHERE t.id != ?1 AND t.artist_id = ?2 {}{}{}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause);
                        conn.query_row(&sql, params![current_track_id, aid], |row| track_from_row(row)).optional()
                    }
                    None => Ok(None),
                }
            }
            "same_tag" => {
                let sql = format!(
                    "{} WHERE t.id != ?1 {}{}{}{} AND t.id IN (\
                        SELECT tt2.track_id FROM track_tags tt1 \
                        JOIN track_tags tt2 ON tt1.tag_id = tt2.tag_id \
                        WHERE tt1.track_id = ?1 AND tt2.track_id != ?1\
                    ) ORDER BY RANDOM() LIMIT 1",
                    TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause
                );
                conn.query_row(&sql, params![current_track_id], |row| track_from_row(row)).optional()
            }
            "most_played" => {
                let sql = format!(
                    "{} WHERE t.id != ?1 {}{}{}{} AND t.id IN (\
                        SELECT ht.library_track_id FROM history_tracks ht \
                        WHERE ht.library_track_id IS NOT NULL \
                        ORDER BY ht.play_count DESC LIMIT 50\
                    ) ORDER BY RANDOM() LIMIT 1",
                    TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause
                );
                conn.query_row(&sql, params![current_track_id], |row| track_from_row(row)).optional()
            }
            "liked" => {
                let sql = format!("{} WHERE t.id != ?1 AND t.liked = 1 {}{}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause, exclude_clause);
                conn.query_row(&sql, params![current_track_id], |row| track_from_row(row)).optional()
            }
            _ => Ok(None),
        }
    }

    // --- Decoupled history ---

    pub fn record_history_play(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        // Fetch track metadata
        let (title, artist_name, artist_id): (String, Option<String>, Option<i64>) = conn.query_row(
            "SELECT t.title, ar.name, t.artist_id FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             WHERE t.id = ?1",
            params![track_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;

        let canonical_artist = strip_diacritics(&artist_name.as_deref().unwrap_or("").to_lowercase());
        let canonical_title = strip_diacritics(&title.to_lowercase());

        // Always upsert history_artists/tracks to keep library IDs current (reconnection)
        conn.execute(
            "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count, library_artist_id)
             VALUES (?1, ?2, strftime('%s', 'now'), strftime('%s', 'now'), 0, ?3)
             ON CONFLICT(canonical_name) DO UPDATE SET
               display_name = excluded.display_name,
               library_artist_id = excluded.library_artist_id",
            params![canonical_artist, artist_name, artist_id],
        )?;
        let history_artist_id: i64 = conn.query_row(
            "SELECT id FROM history_artists WHERE canonical_name = ?1",
            params![canonical_artist],
            |row| row.get(0),
        )?;

        conn.execute(
            "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count, library_track_id)
             VALUES (?1, ?2, ?3, strftime('%s', 'now'), strftime('%s', 'now'), 0, ?4)
             ON CONFLICT(history_artist_id, canonical_title) DO UPDATE SET
               display_title = excluded.display_title,
               library_track_id = excluded.library_track_id",
            params![history_artist_id, canonical_title, title, track_id],
        )?;
        let history_track_id: i64 = conn.query_row(
            "SELECT id FROM history_tracks WHERE history_artist_id = ?1 AND canonical_title = ?2",
            params![history_artist_id, canonical_title],
            |row| row.get(0),
        )?;

        // Dedup: skip play record + count update if same track played within 30 seconds
        let dominated: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM history_plays hp
                WHERE hp.history_track_id = ?1
                AND hp.played_at > strftime('%s', 'now') - 30
            )",
            params![history_track_id],
            |row| row.get(0),
        )?;
        if dominated {
            return Ok(());
        }

        // Insert play record
        conn.execute(
            "INSERT INTO history_plays (history_track_id) VALUES (?1)",
            params![history_track_id],
        )?;

        // Update denormalized counts
        conn.execute(
            "UPDATE history_tracks SET play_count = play_count + 1, last_played_at = strftime('%s', 'now') WHERE id = ?1",
            params![history_track_id],
        )?;
        conn.execute(
            "UPDATE history_artists SET play_count = play_count + 1, last_played_at = strftime('%s', 'now') WHERE id = ?1",
            params![history_artist_id],
        )?;

        Ok(())
    }

    /// Batch-insert history plays from Last.fm import.
    /// Each entry is (artist_name, track_title, played_at_unix).
    /// Returns (imported, skipped) counts.
    pub fn record_history_plays_batch(&self, plays: &[(String, String, i64)]) -> SqlResult<(u64, u64)> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let mut imported: u64 = 0;
        let mut skipped: u64 = 0;

        for (artist_name, track_title, played_at) in plays {
            let canonical_artist = strip_diacritics(&artist_name.to_lowercase());
            let canonical_title = strip_diacritics(&track_title.to_lowercase());

            // Upsert history_artists with MIN/MAX for timestamps
            tx.execute(
                "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count, library_artist_id)
                 VALUES (?1, ?2, ?3, ?3, 0, NULL)
                 ON CONFLICT(canonical_name) DO UPDATE SET
                   first_played_at = MIN(history_artists.first_played_at, excluded.first_played_at),
                   last_played_at = MAX(history_artists.last_played_at, excluded.last_played_at)",
                params![canonical_artist, artist_name, played_at],
            )?;
            let history_artist_id: i64 = tx.query_row(
                "SELECT id FROM history_artists WHERE canonical_name = ?1",
                params![canonical_artist],
                |row| row.get(0),
            )?;

            // Upsert history_tracks with MIN/MAX for timestamps
            tx.execute(
                "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count, library_track_id)
                 VALUES (?1, ?2, ?3, ?4, ?4, 0, NULL)
                 ON CONFLICT(history_artist_id, canonical_title) DO UPDATE SET
                   first_played_at = MIN(history_tracks.first_played_at, excluded.first_played_at),
                   last_played_at = MAX(history_tracks.last_played_at, excluded.last_played_at)",
                params![history_artist_id, canonical_title, track_title, played_at],
            )?;
            let history_track_id: i64 = tx.query_row(
                "SELECT id FROM history_tracks WHERE history_artist_id = ?1 AND canonical_title = ?2",
                params![history_artist_id, canonical_title],
                |row| row.get(0),
            )?;

            // Exact-timestamp dedup: skip if this exact play already exists
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM history_plays WHERE history_track_id = ?1 AND played_at = ?2)",
                params![history_track_id, played_at],
                |row| row.get(0),
            )?;
            if exists {
                skipped += 1;
                continue;
            }

            // Insert play record with explicit timestamp
            tx.execute(
                "INSERT INTO history_plays (history_track_id, played_at) VALUES (?1, ?2)",
                params![history_track_id, played_at],
            )?;

            // Update denormalized counts
            tx.execute(
                "UPDATE history_tracks SET play_count = play_count + 1, last_played_at = MAX(last_played_at, ?2) WHERE id = ?1",
                params![history_track_id, played_at],
            )?;
            tx.execute(
                "UPDATE history_artists SET play_count = play_count + 1, last_played_at = MAX(last_played_at, ?2) WHERE id = ?1",
                params![history_artist_id, played_at],
            )?;

            imported += 1;
        }

        tx.commit()?;
        Ok((imported, skipped))
    }

    pub fn get_history_recent(&self, limit: i64) -> SqlResult<Vec<HistoryEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT hp.id, ht.id, hp.played_at, ht.display_title, ha.display_name,
                    ht.play_count, ht.library_track_id
             FROM history_plays hp
             JOIN history_tracks ht ON ht.id = hp.history_track_id
             JOIN history_artists ha ON ha.id = ht.history_artist_id
             ORDER BY hp.played_at DESC
             LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(HistoryEntry {
                id: row.get(0)?,
                history_track_id: row.get(1)?,
                played_at: row.get(2)?,
                display_title: row.get(3)?,
                display_artist: row.get(4)?,
                play_count: row.get(5)?,
                library_track_id: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_history_most_played(&self, limit: i64) -> SqlResult<Vec<HistoryMostPlayed>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ht.id, ht.play_count, ht.display_title, ha.display_name, ht.library_track_id,
                    (SELECT COUNT(*) + 1 FROM history_tracks ht2 WHERE ht2.play_count > ht.play_count) as rank
             FROM history_tracks ht
             JOIN history_artists ha ON ha.id = ht.history_artist_id
             WHERE ht.play_count > 0
             ORDER BY ht.play_count DESC
             LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(HistoryMostPlayed {
                history_track_id: row.get(0)?,
                play_count: row.get(1)?,
                display_title: row.get(2)?,
                display_artist: row.get(3)?,
                library_track_id: row.get(4)?,
                rank: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_history_most_played_since(&self, since_ts: i64, limit: i64) -> SqlResult<Vec<HistoryMostPlayed>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ht.id, COUNT(*) as cnt, ht.display_title, ha.display_name, ht.library_track_id,
                    (SELECT COUNT(*) + 1 FROM history_tracks ht2 WHERE ht2.play_count > ht.play_count) as rank
             FROM history_plays hp
             JOIN history_tracks ht ON ht.id = hp.history_track_id
             JOIN history_artists ha ON ha.id = ht.history_artist_id
             WHERE hp.played_at >= ?1
             GROUP BY ht.id
             ORDER BY cnt DESC
             LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![since_ts, limit], |row| {
            Ok(HistoryMostPlayed {
                history_track_id: row.get(0)?,
                play_count: row.get(1)?,
                display_title: row.get(2)?,
                display_artist: row.get(3)?,
                library_track_id: row.get(4)?,
                rank: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn search_history_tracks(&self, query: &str, limit: i64) -> SqlResult<Vec<HistoryMostPlayed>> {
        let conn = self.conn.lock().unwrap();
        let canonical_query = strip_diacritics(&query.to_lowercase());
        let pattern = format!("%{}%", canonical_query);
        let mut stmt = conn.prepare(
            "SELECT ht.id, ht.play_count, ht.display_title, ha.display_name, ht.library_track_id,
                    (SELECT COUNT(*) + 1 FROM history_tracks ht2 WHERE ht2.play_count > ht.play_count) as rank
             FROM history_tracks ht
             JOIN history_artists ha ON ha.id = ht.history_artist_id
             WHERE ht.play_count > 0
               AND (ht.canonical_title LIKE ?1 OR ha.canonical_name LIKE ?1)
             ORDER BY ht.play_count DESC
             LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![pattern, limit], |row| {
            Ok(HistoryMostPlayed {
                history_track_id: row.get(0)?,
                play_count: row.get(1)?,
                display_title: row.get(2)?,
                display_artist: row.get(3)?,
                library_track_id: row.get(4)?,
                rank: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_history_most_played_artists(&self, limit: i64) -> SqlResult<Vec<HistoryArtistStats>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ha.id, ha.play_count,
                    (SELECT COUNT(*) FROM history_tracks ht WHERE ht.history_artist_id = ha.id) as track_count,
                    ha.display_name, ha.library_artist_id,
                    (SELECT COUNT(*) + 1 FROM history_artists ha2 WHERE ha2.play_count > ha.play_count) as rank
             FROM history_artists ha
             WHERE ha.play_count > 0 AND ha.canonical_name != ''
             ORDER BY ha.play_count DESC
             LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(HistoryArtistStats {
                history_artist_id: row.get(0)?,
                play_count: row.get(1)?,
                track_count: row.get(2)?,
                display_name: row.get(3)?,
                library_artist_id: row.get(4)?,
                rank: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn search_history_artists(&self, query: &str, limit: i64) -> SqlResult<Vec<HistoryArtistStats>> {
        let conn = self.conn.lock().unwrap();
        let canonical_query = strip_diacritics(&query.to_lowercase());
        let pattern = format!("%{}%", canonical_query);
        let mut stmt = conn.prepare(
            "SELECT ha.id, ha.play_count,
                    (SELECT COUNT(*) FROM history_tracks ht WHERE ht.history_artist_id = ha.id) as track_count,
                    ha.display_name, ha.library_artist_id,
                    (SELECT COUNT(*) + 1 FROM history_artists ha2 WHERE ha2.play_count > ha.play_count) as rank
             FROM history_artists ha
             WHERE ha.play_count > 0 AND ha.canonical_name LIKE ?1
             ORDER BY ha.play_count DESC
             LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![pattern, limit], |row| {
            Ok(HistoryArtistStats {
                history_artist_id: row.get(0)?,
                play_count: row.get(1)?,
                track_count: row.get(2)?,
                display_name: row.get(3)?,
                library_artist_id: row.get(4)?,
                rank: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_track_rank(&self, track_id: i64) -> SqlResult<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT (SELECT COUNT(*) + 1 FROM history_tracks ht2 WHERE ht2.play_count > ht.play_count) as rank
             FROM history_tracks ht
             WHERE ht.library_track_id = ?1 AND ht.play_count > 0",
            params![track_id],
            |row| row.get(0),
        ).optional()
    }

    pub fn get_artist_rank(&self, artist_id: i64) -> SqlResult<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT (SELECT COUNT(*) + 1 FROM history_artists ha2 WHERE ha2.play_count > ha.play_count) as rank
             FROM history_artists ha
             WHERE ha.library_artist_id = ?1 AND ha.play_count > 0",
            params![artist_id],
            |row| row.get(0),
        ).optional()
    }

    pub fn get_track_play_history(&self, track_id: i64, limit: i64) -> SqlResult<Vec<TrackPlayEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT hp.played_at
             FROM history_plays hp
             JOIN history_tracks ht ON ht.id = hp.history_track_id
             WHERE ht.library_track_id = ?1
             ORDER BY hp.played_at DESC
             LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![track_id, limit], |row| {
            Ok(TrackPlayEntry {
                played_at: row.get(0)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_track_play_stats(&self, track_id: i64) -> SqlResult<Option<TrackPlayStats>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT ht.play_count, ht.first_played_at, ht.last_played_at
             FROM history_tracks ht
             WHERE ht.library_track_id = ?1",
            params![track_id],
            |row| Ok(TrackPlayStats {
                play_count: row.get(0)?,
                first_played_at: row.get(1)?,
                last_played_at: row.get(2)?,
            }),
        ).optional()
    }

    /// Attempt to reconnect a ghost history track to a library track by canonical title+artist match.
    /// Returns the matched Track if found, or None if no match exists.
    pub fn reconnect_history_track(&self, history_track_id: i64) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();

        // Look up the history track's canonical info
        let (canonical_title, history_artist_id): (String, i64) = conn.query_row(
            "SELECT canonical_title, history_artist_id FROM history_tracks WHERE id = ?1",
            params![history_track_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let canonical_name: String = conn.query_row(
            "SELECT canonical_name FROM history_artists WHERE id = ?1",
            params![history_artist_id],
            |row| row.get(0),
        )?;

        // Search for a matching library track
        let maybe_track_id: Option<i64> = conn.query_row(
            "SELECT t.id FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             WHERE strip_diacritics(unicode_lower(t.title)) = ?1
             AND strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) = ?2
             LIMIT 1",
            params![canonical_title, canonical_name],
            |row| row.get(0),
        ).optional()?;

        let track_id = match maybe_track_id {
            Some(id) => id,
            None => return Ok(None),
        };

        // Reconnect: update library_track_id
        conn.execute(
            "UPDATE history_tracks SET library_track_id = ?1 WHERE id = ?2",
            params![track_id, history_track_id],
        )?;

        // Also reconnect the artist
        let artist_id: Option<i64> = conn.query_row(
            "SELECT artist_id FROM tracks WHERE id = ?1",
            params![track_id],
            |row| row.get(0),
        )?;
        if let Some(aid) = artist_id {
            conn.execute(
                "UPDATE history_artists SET library_artist_id = ?1 WHERE id = ?2",
                params![aid, history_artist_id],
            )?;
        }

        // Return the full track
        let sql = format!("{} WHERE t.id = ?1", TRACK_SELECT);
        let track = conn.query_row(&sql, params![track_id], |row| track_from_row(row))?;
        Ok(Some(track))
    }

    /// Attempt to reconnect a ghost history artist to a library artist by canonical name match.
    /// Returns the library artist_id if found, or None.
    pub fn reconnect_history_artist(&self, history_artist_id: i64) -> SqlResult<Option<i64>> {
        let conn = self.conn.lock().unwrap();

        let canonical_name: String = conn.query_row(
            "SELECT canonical_name FROM history_artists WHERE id = ?1",
            params![history_artist_id],
            |row| row.get(0),
        )?;

        let maybe_artist_id: Option<i64> = conn.query_row(
            "SELECT id FROM artists
             WHERE strip_diacritics(unicode_lower(name)) = ?1
             LIMIT 1",
            params![canonical_name],
            |row| row.get(0),
        ).optional()?;

        if let Some(artist_id) = maybe_artist_id {
            conn.execute(
                "UPDATE history_artists SET library_artist_id = ?1 WHERE id = ?2",
                params![artist_id, history_artist_id],
            )?;
            Ok(Some(artist_id))
        } else {
            Ok(None)
        }
    }

    // --- Last.fm cache ---

    const LASTFM_CACHE_TTL_SECS: i64 = 90 * 24 * 60 * 60; // ~3 months

    pub fn lastfm_cache_get(&self, key: &str) -> SqlResult<Option<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        let cutoff = now - Self::LASTFM_CACHE_TTL_SECS;
        let mut stmt = conn.prepare(
            "SELECT value FROM lastfm_cache WHERE cache_key = ?1 AND cached_at > ?2"
        )?;
        let result = stmt.query_row(params![key, cutoff], |row| {
            let json_str: String = row.get(0)?;
            Ok(json_str)
        });
        match result {
            Ok(json_str) => Ok(serde_json::from_str(&json_str).ok()),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn lastfm_cache_delete(&self, key_prefix: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM lastfm_cache WHERE cache_key LIKE ?1",
            params![format!("{}%", key_prefix)],
        )?;
        Ok(())
    }

    pub fn lastfm_cache_set(&self, key: &str, value: &serde_json::Value) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let json_str = serde_json::to_string(value).unwrap_or_default();
        conn.execute(
            "INSERT OR REPLACE INTO lastfm_cache (cache_key, value, cached_at) VALUES (?1, ?2, strftime('%s', 'now'))",
            params![key, json_str],
        )?;
        Ok(())
    }

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

    // ── Information Types ────────────────────────────────────────

    /// Rebuild the information_types table from plugin manifests.
    /// Called on startup after plugins are loaded.
    pub fn info_rebuild_types(&self, types: &[(String, String, String, String, String, i64, i64, i64)]) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM information_types", [])?;
        let mut stmt = conn.prepare(
            "INSERT INTO information_types (id, name, entity, display_kind, plugin_id, ttl, sort_order, priority)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        )?;
        for t in types {
            stmt.execute(rusqlite::params![t.0, t.1, t.2, t.3, t.4, t.5, t.6, t.7])?;
        }
        Ok(())
    }

    /// Get all registered info types for an entity kind, ordered by sort_order.
    pub fn info_get_types_for_entity(&self, entity: &str) -> SqlResult<Vec<(String, String, String, String, i64, i64, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, display_kind, plugin_id, ttl, sort_order, priority
             FROM information_types WHERE entity = ?1 ORDER BY sort_order, id"
        )?;
        let rows = stmt.query_map([entity], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
        })?.collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// Get a single cached info value.
    /// Returns (value, status, fetched_at) or None.
    pub fn info_get_value(&self, type_id: &str, entity_key: &str) -> SqlResult<Option<(String, String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT value, status, fetched_at FROM information_values
             WHERE information_type_id = ?1 AND entity_key = ?2"
        )?;
        let result = stmt.query_row(rusqlite::params![type_id, entity_key], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        });
        match result {
            Ok(r) => Ok(Some(r)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Get all cached info values for an entity key.
    /// Returns vec of (information_type_id, value, status, fetched_at).
    pub fn info_get_values_for_entity(&self, entity_key: &str) -> SqlResult<Vec<(String, String, String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT information_type_id, value, status, fetched_at FROM information_values
             WHERE entity_key = ?1"
        )?;
        let rows = stmt.query_map([entity_key], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?.collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// Upsert an info value (insert or update).
    pub fn info_upsert_value(&self, type_id: &str, entity_key: &str, value: &str, status: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO information_values (information_type_id, entity_key, value, status, fetched_at)
             VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))
             ON CONFLICT(information_type_id, entity_key)
             DO UPDATE SET value = excluded.value, status = excluded.status, fetched_at = excluded.fetched_at",
            rusqlite::params![type_id, entity_key, value, status],
        )?;
        Ok(())
    }

    /// Delete a cached info value.
    pub fn info_delete_value(&self, type_id: &str, entity_key: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM information_values WHERE information_type_id = ?1 AND entity_key = ?2",
            rusqlite::params![type_id, entity_key],
        )?;
        Ok(())
    }

    /// Delete all cached values for an entity.
    pub fn info_delete_all_for_entity(&self, entity_key: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM information_values WHERE entity_key = ?1",
            [entity_key],
        )?;
        Ok(())
    }

    /// Cleanup orphaned values whose information_type_id has no matching registration.
    pub fn info_cleanup_orphaned_values(&self) -> SqlResult<usize> {
        let conn = self.conn.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM information_values
             WHERE information_type_id NOT IN (SELECT DISTINCT id FROM information_types)",
            [],
        )?;
        Ok(count)
    }

    /// Get provider ordering for an info type.
    /// Returns vec of (plugin_id, user_priority, enabled).
    pub fn info_get_providers(&self, type_id: &str) -> SqlResult<Vec<(String, i64, bool)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT plugin_id, user_priority, enabled FROM information_type_providers
             WHERE information_type_id = ?1 ORDER BY user_priority"
        )?;
        let rows = stmt.query_map([type_id], |row| {
            Ok((row.get(0)?, row.get::<_, i64>(1)?, row.get::<_, bool>(2)?))
        })?.collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// Set user-configured provider ordering for an info type.
    pub fn info_set_provider(&self, type_id: &str, plugin_id: &str, priority: i64, enabled: bool) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO information_type_providers (information_type_id, plugin_id, user_priority, enabled)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(information_type_id, plugin_id)
             DO UPDATE SET user_priority = excluded.user_priority, enabled = excluded.enabled",
            rusqlite::params![type_id, plugin_id, priority, enabled as i32],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        Database::new_in_memory().expect("Failed to create in-memory database")
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
        assert_eq!(recent[0].library_track_id, Some(track_id));
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
        assert!(recent[0].library_track_id.is_none(), "should be ghost after deletion");
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
        assert!(recent[0].library_track_id.is_none());

        // Re-add with same artist+title but different path
        let artist_id2 = db.get_or_create_artist("Björk").unwrap();
        let track_id2 = insert_track(&db, "new_music/army.mp3", "Army of Me", Some(artist_id2), None);

        // Reconnection happens when the track is played again (upsert updates library_track_id)
        db.record_history_play(track_id2).unwrap();
        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent[0].library_track_id, Some(track_id2));
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
        let recent = db.get_history_recent(10).unwrap();
        assert!(recent[0].library_track_id.is_none());

        // Re-add same song with different path
        let artist_id2 = db.get_or_create_artist("Radiohead").unwrap();
        let track_id2 = insert_track(&db, "new/creep.flac", "Creep", Some(artist_id2), None);

        // Dynamic reconnection
        let result = db.reconnect_history_track(ht_id).unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().id, track_id2);

        // Verify DB was updated
        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent[0].library_track_id, Some(track_id2));
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
        assert!(artists[0].library_artist_id.is_some());

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
        let t1 = insert_track(&db, "music/around.mp3", "Around the World", Some(artist_id), None);
        let t2 = insert_track(&db, "music/harder.mp3", "Harder Better Faster", Some(artist_id), None);

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
        let t1 = insert_track(&db, "music/t1.mp3", "Track 1", Some(a1), None);
        let t2 = insert_track(&db, "music/t2.mp3", "Track 2", Some(a1), None);
        let t3 = insert_track(&db, "music/t3.mp3", "Track 3", Some(a2), None);

        // Record via SQL to bypass dedup
        {
            let conn = db.conn.lock().unwrap();
            for (canonical_artist, display, artist_id, canonical_title, disp_title, track_id, count) in [
                ("artist a", "Artist A", a1, "track 1", "Track 1", t1, 5),
                ("artist a", "Artist A", a1, "track 2", "Track 2", t2, 3),
                ("artist b", "Artist B", a2, "track 3", "Track 3", t3, 2),
            ] {
                conn.execute(
                    "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count, library_artist_id)
                     VALUES (?1, ?2, 1000, 1000, 0, ?3) ON CONFLICT(canonical_name) DO NOTHING",
                    params![canonical_artist, display, artist_id],
                ).unwrap();
                let ha_id: i64 = conn.query_row(
                    "SELECT id FROM history_artists WHERE canonical_name = ?1", params![canonical_artist], |r| r.get(0),
                ).unwrap();
                conn.execute(
                    "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count, library_track_id)
                     VALUES (?1, ?2, ?3, 1000, 1000, ?4, ?5) ON CONFLICT(history_artist_id, canonical_title) DO NOTHING",
                    params![ha_id, canonical_title, disp_title, count, track_id],
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
        assert!(artists[0].library_artist_id.is_some());
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
        let t1 = insert_track(&db, "music/r1.mp3", "Top Track", Some(a1), None);
        let t2 = insert_track(&db, "music/r2.mp3", "Mid Track", Some(a1), None);
        let t3 = insert_track(&db, "music/r3.mp3", "Low Track", Some(a1), None);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count, library_artist_id)
                 VALUES ('artist a', 'Artist A', 1000, 1000, 15, ?1)",
                params![a1],
            ).unwrap();
            let ha_id: i64 = conn.query_row(
                "SELECT id FROM history_artists WHERE canonical_name = 'artist a'", [], |r| r.get(0),
            ).unwrap();
            for (title, track_id, count) in [
                ("top track", t1, 10),
                ("mid track", t2, 5),
                ("low track", t3, 2),
            ] {
                conn.execute(
                    "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count, library_track_id)
                     VALUES (?1, ?2, ?3, 1000, 1000, ?4, ?5)",
                    params![ha_id, title, title, count, track_id],
                ).unwrap();
            }
        }

        assert_eq!(db.get_track_rank(t1).unwrap(), Some(1));
        assert_eq!(db.get_track_rank(t2).unwrap(), Some(2));
        assert_eq!(db.get_track_rank(t3).unwrap(), Some(3));
    }

    #[test]
    fn test_track_rank_no_history() {
        let db = test_db();
        let a1 = db.get_or_create_artist("Artist A").unwrap();
        let t1 = insert_track(&db, "music/norank.mp3", "No History", Some(a1), None);

        assert_eq!(db.get_track_rank(t1).unwrap(), None);
    }

    #[test]
    fn test_artist_rank() {
        let db = test_db();
        let a1 = db.get_or_create_artist("Top Artist").unwrap();
        let a2 = db.get_or_create_artist("Low Artist").unwrap();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count, library_artist_id)
                 VALUES ('top artist', 'Top Artist', 1000, 1000, 20, ?1)",
                params![a1],
            ).unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count, library_artist_id)
                 VALUES ('low artist', 'Low Artist', 1000, 1000, 5, ?1)",
                params![a2],
            ).unwrap();
        }

        assert_eq!(db.get_artist_rank(a1).unwrap(), Some(1));
        assert_eq!(db.get_artist_rank(a2).unwrap(), Some(2));

        // No history artist
        let a3 = db.get_or_create_artist("New Artist").unwrap();
        assert_eq!(db.get_artist_rank(a3).unwrap(), None);
    }

    #[test]
    fn test_lyrics_table_exists() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Test Artist").unwrap();
        let track_id = insert_track(&db, "test/lyrics.mp3", "Test Song", Some(artist_id), None);
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO lyrics (track_id, text, kind, provider) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![track_id, "Hello world", "plain", "manual"],
        ).expect("lyrics insert should work");
        let text: String = conn.query_row(
            "SELECT text FROM lyrics WHERE track_id = ?1",
            rusqlite::params![track_id],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(text, "Hello world");
    }

    #[test]
    fn test_save_and_get_lyrics() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Artist").unwrap();
        let track_id = insert_track(&db, "test/song.mp3", "Song", Some(artist_id), None);

        assert!(db.get_lyrics(track_id).unwrap().is_none());

        let lyrics = db.save_lyrics(track_id, "Line one\nLine two", "plain", "lrclib").unwrap();
        assert_eq!(lyrics.text, "Line one\nLine two");
        assert_eq!(lyrics.kind, "plain");
        assert_eq!(lyrics.provider, "lrclib");

        let fetched = db.get_lyrics(track_id).unwrap().unwrap();
        assert_eq!(fetched.text, lyrics.text);
    }

    #[test]
    fn test_save_lyrics_upsert() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Artist").unwrap();
        let track_id = insert_track(&db, "test/song.mp3", "Song", Some(artist_id), None);

        db.save_lyrics(track_id, "V1", "plain", "lrclib").unwrap();
        db.save_lyrics(track_id, "[00:01.00]V2", "synced", "lrclib").unwrap();

        let lyrics = db.get_lyrics(track_id).unwrap().unwrap();
        assert_eq!(lyrics.text, "[00:01.00]V2");
        assert_eq!(lyrics.kind, "synced");
    }

    #[test]
    fn test_delete_lyrics() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Artist").unwrap();
        let track_id = insert_track(&db, "test/song.mp3", "Song", Some(artist_id), None);

        db.save_lyrics(track_id, "Text", "plain", "manual").unwrap();
        assert!(db.get_lyrics(track_id).unwrap().is_some());

        db.delete_lyrics(track_id).unwrap();
        assert!(db.get_lyrics(track_id).unwrap().is_none());
    }

    #[test]
    fn test_lyrics_cascade_on_track_delete() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Artist").unwrap();
        let track_id = insert_track(&db, "test/song.mp3", "Song", Some(artist_id), None);

        db.save_lyrics(track_id, "Text", "plain", "lrclib").unwrap();
        db.delete_tracks_by_ids(&[track_id]).unwrap();
        assert!(db.get_lyrics(track_id).unwrap().is_none());
    }

    #[test]
    fn test_strip_lrc_timestamps() {
        assert_eq!(
            strip_lrc_timestamps("[00:12.34]Hello world"),
            "Hello world"
        );
        assert_eq!(
            strip_lrc_timestamps("[01:23.45]Line one\n[01:30.00]Line two"),
            "Line one\nLine two"
        );
        assert_eq!(
            strip_lrc_timestamps("Plain text no timestamps"),
            "Plain text no timestamps"
        );
    }

    #[test]
    fn test_lyrics_in_fts_search() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Artist").unwrap();
        let track_id = insert_track(&db, "test/song.mp3", "Song Title", Some(artist_id), None);

        db.save_lyrics(track_id, "unique_lyric_word in a song", "plain", "lrclib").unwrap();
        db.rebuild_fts().unwrap();

        let opts = crate::models::TrackQuery { query: Some("unique_lyric_word".to_string()), include_lyrics: true, ..Default::default() };
        let results = db.get_tracks(&opts).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, track_id);

        // With include_lyrics=false, same query should not match lyrics
        let opts_no_lyrics = crate::models::TrackQuery { query: Some("unique_lyric_word".to_string()), include_lyrics: false, ..Default::default() };
        let results_no_lyrics = db.get_tracks(&opts_no_lyrics).unwrap();
        assert_eq!(results_no_lyrics.len(), 0);
    }

    #[test]
    fn test_info_upsert_and_get() {
        let db = test_db();
        // No value yet
        assert!(db.info_get_value("artist_bio", "artist:1").unwrap().is_none());

        // Insert
        db.info_upsert_value("artist_bio", "artist:1", r#"{"summary":"bio"}"#, "ok").unwrap();
        let row = db.info_get_value("artist_bio", "artist:1").unwrap().unwrap();
        assert_eq!(row.0, r#"{"summary":"bio"}"#); // value
        assert_eq!(row.1, "ok"); // status
        assert!(row.2 > 0); // fetched_at

        // Upsert overwrites
        db.info_upsert_value("artist_bio", "artist:1", "{}", "not_found").unwrap();
        let row = db.info_get_value("artist_bio", "artist:1").unwrap().unwrap();
        assert_eq!(row.1, "not_found");
    }

    #[test]
    fn test_info_get_values_for_entity() {
        let db = test_db();
        db.info_upsert_value("artist_bio", "artist:1", r#"{"summary":"bio"}"#, "ok").unwrap();
        db.info_upsert_value("similar_artists", "artist:1", r#"{"items":[]}"#, "ok").unwrap();
        db.info_upsert_value("artist_bio", "artist:2", r#"{"summary":"other"}"#, "ok").unwrap();

        let rows = db.info_get_values_for_entity("artist:1").unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn test_info_delete_value() {
        let db = test_db();
        db.info_upsert_value("artist_bio", "artist:1", r#"{"summary":"bio"}"#, "ok").unwrap();
        db.info_delete_value("artist_bio", "artist:1").unwrap();
        assert!(db.info_get_value("artist_bio", "artist:1").unwrap().is_none());
    }

    #[test]
    fn test_info_cleanup_orphans() {
        let db = test_db();
        // Insert a value with no matching info_type registration
        db.info_upsert_value("orphan_type", "artist:1", "{}", "ok").unwrap();
        assert!(db.info_get_value("orphan_type", "artist:1").unwrap().is_some());

        // Cleanup should remove it (no rows in information_types)
        db.info_cleanup_orphaned_values().unwrap();
        assert!(db.info_get_value("orphan_type", "artist:1").unwrap().is_none());
    }

    #[test]
    fn test_info_cleanup_preserves_registered_types() {
        let db = test_db();
        // Register an info type
        db.info_rebuild_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm-info".into(), 7776000, 200, 100),
        ]).unwrap();
        // Insert values: one for registered type, one orphan
        db.info_upsert_value("artist_bio", "artist:1", r#"{"summary":"bio"}"#, "ok").unwrap();
        db.info_upsert_value("orphan_type", "artist:1", "{}", "ok").unwrap();

        db.info_cleanup_orphaned_values().unwrap();

        // Registered type preserved, orphan deleted
        assert!(db.info_get_value("artist_bio", "artist:1").unwrap().is_some());
        assert!(db.info_get_value("orphan_type", "artist:1").unwrap().is_none());
    }
}
