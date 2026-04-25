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
                entity      TEXT NOT NULL CHECK(entity IN ('artist', 'album')),
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
                id         INTEGER PRIMARY KEY,
                name       TEXT NOT NULL,
                source     TEXT,
                saved_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                image_path TEXT
            );

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
            INSERT OR IGNORE INTO db_version (rowid, version) VALUES (1, 29);

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
        ).unwrap_or(25);

        if version < 26 {
            // Drop path_normalized column if it exists (moved into FTS)
            let has_col: bool = conn
                .prepare("SELECT 1 FROM pragma_table_info('tracks') WHERE name = 'path_normalized'")?
                .exists([])?;
            if has_col {
                conn.execute_batch("ALTER TABLE tracks DROP COLUMN path_normalized")?;
            }
            conn.execute("UPDATE db_version SET version = 26 WHERE rowid = 1", [])?;
        }

        if version < 27 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS plugin_schedules (
                    plugin_id  TEXT NOT NULL,
                    task_id    TEXT NOT NULL,
                    interval_ms INTEGER NOT NULL,
                    last_run   INTEGER,
                    PRIMARY KEY (plugin_id, task_id)
                );
                UPDATE db_version SET version = 27 WHERE rowid = 1;"
            )?;
        }

        if version < 28 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS download_providers (
                    plugin_id   TEXT NOT NULL,
                    provider_id TEXT NOT NULL,
                    name        TEXT NOT NULL,
                    priority    INTEGER NOT NULL DEFAULT 500,
                    active      INTEGER NOT NULL DEFAULT 1,
                    PRIMARY KEY (plugin_id, provider_id)
                );
                UPDATE db_version SET version = 28 WHERE rowid = 1;"
            )?;
        }

        if version < 29 {
            conn.execute_batch(
                "UPDATE db_version SET version = 29 WHERE rowid = 1;"
            )?;
        }

        let needs_fts_rebuild = version < 26;
        drop(conn);

        if needs_fts_rebuild {
            self.rebuild_fts()?;
            self.recompute_counts()?;
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

    pub fn find_artist_by_name(&self, name: &str) -> SqlResult<Option<Artist>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, track_count, liked FROM artists \
             WHERE strip_diacritics(unicode_lower(name)) = strip_diacritics(unicode_lower(?1)) \
             AND track_count > 0",
            params![name],
            |row| Ok(Artist {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
                liked: row.get::<_, i32>(3).unwrap_or(0),
            }),
        ).optional()
    }

    // --- Albums ---

    pub fn find_album_by_name(&self, title: &str, artist_name: Option<&str>) -> SqlResult<Option<Album>> {
        let conn = self.conn.lock().unwrap();
        if let Some(artist) = artist_name {
            conn.query_row(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
                 FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
                 WHERE strip_diacritics(unicode_lower(a.title)) = strip_diacritics(unicode_lower(?1)) \
                 AND ar.name IS NOT NULL AND strip_diacritics(unicode_lower(ar.name)) = strip_diacritics(unicode_lower(?2)) \
                 AND a.track_count > 0 \
                 LIMIT 1",
                params![title, artist],
                |row| album_from_row(row),
            ).optional()
        } else {
            conn.query_row(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
                 FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
                 WHERE strip_diacritics(unicode_lower(a.title)) = strip_diacritics(unicode_lower(?1)) \
                 AND a.track_count > 0 \
                 LIMIT 1",
                params![title],
                |row| album_from_row(row),
            ).optional()
        }
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
            &format!("SELECT COUNT(*) FROM tracks t WHERE 1=1 {}", ENABLED_COLLECTION_FILTER_STANDALONE),
            [],
            |row| row.get(0),
        )
    }

    pub fn get_track_count_for_collection(&self, collection_id: i64) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM tracks WHERE collection_id = ?1",
            params![collection_id],
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
            "INSERT INTO tracks (path, title, artist_id, album_id, track_number, duration_secs, format, file_size, modified_at, collection_id, year)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(collection_id, path) DO UPDATE SET
                title=excluded.title, artist_id=excluded.artist_id, album_id=excluded.album_id,
                track_number=excluded.track_number,
                duration_secs=excluded.duration_secs, format=excluded.format,
                file_size=excluded.file_size, modified_at=excluded.modified_at,
                year=excluded.year",
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
                 path,
                 content='',
                 tokenize='unicode61 remove_diacritics 2'
             );"
        )?;
        conn.execute_batch(
            &format!(
                "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, path)
                 SELECT t.id, strip_diacritics(t.title), strip_diacritics(COALESCE(ar.name, '')), strip_diacritics(COALESCE(al.title, '')),
                        strip_diacritics(COALESCE((SELECT GROUP_CONCAT(tg.name, ' ') FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.track_id = t.id), '')),
                        strip_diacritics(COALESCE(t.path, ''))
                 FROM tracks t
                 LEFT JOIN artists ar ON t.artist_id = ar.id
                 LEFT JOIN albums al ON t.album_id = al.id
                 WHERE 1=1 {};",
                ENABLED_COLLECTION_FILTER_STANDALONE
            ),
        )?;
        Ok(())
    }

    pub fn recompute_counts(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        // Clean up orphaned entities before recomputing counts
        conn.execute_batch(
            "DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL);
             DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL)
                                   AND id NOT IN (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL);
             DELETE FROM track_tags WHERE tag_id NOT IN (SELECT id FROM tags);
             DELETE FROM track_tags WHERE track_id NOT IN (SELECT id FROM tracks);
             DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM track_tags);"
        )?;
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
                cf = ENABLED_COLLECTION_FILTER_STANDALONE
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

    /// Find a track by metadata (title, artist, album) with diacritic-insensitive matching.
    /// Matching cascade: title+artist+album → title+artist → title only.
    /// When multiple matches exist, prefers local > subsonic > tidal.
    pub fn find_track_by_metadata(
        &self,
        title: &str,
        artist_name: Option<&str>,
        album_name: Option<&str>,
    ) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();

        // Source preference: local files first, then subsonic, then tidal (by path prefix)
        let order_clause = "ORDER BY CASE \
            WHEN co.kind = 'local' THEN 0 \
            WHEN co.kind = 'subsonic' THEN 1 \
            ELSE 2 \
        END LIMIT 1";

        let enabled_filter = ENABLED_COLLECTION_FILTER;

        if let Some(artist) = artist_name {
            // Try title + artist + album first
            if let Some(album) = album_name {
                let sql = format!(
                    "{} WHERE strip_diacritics(unicode_lower(t.title)) = strip_diacritics(unicode_lower(?1)) \
                     AND ar.name IS NOT NULL AND strip_diacritics(unicode_lower(ar.name)) = strip_diacritics(unicode_lower(?2)) \
                     AND al.title IS NOT NULL AND strip_diacritics(unicode_lower(al.title)) = strip_diacritics(unicode_lower(?3)) \
                     {} {}",
                    TRACK_SELECT, enabled_filter, order_clause
                );
                let result: Option<Track> = conn
                    .query_row(&sql, params![title, artist, album], |row| track_from_row(row))
                    .optional()?;
                if result.is_some() {
                    return Ok(result);
                }
            }

            // Fall back to title + artist
            let sql = format!(
                "{} WHERE strip_diacritics(unicode_lower(t.title)) = strip_diacritics(unicode_lower(?1)) \
                 AND ar.name IS NOT NULL AND strip_diacritics(unicode_lower(ar.name)) = strip_diacritics(unicode_lower(?2)) \
                 {} {}",
                TRACK_SELECT, enabled_filter, order_clause
            );
            let result: Option<Track> = conn
                .query_row(&sql, params![title, artist], |row| track_from_row(row))
                .optional()?;
            if result.is_some() {
                return Ok(result);
            }
        }

        // Last resort: title only
        let sql = format!(
            "{} WHERE strip_diacritics(unicode_lower(t.title)) = strip_diacritics(unicode_lower(?1)) \
             {} {}",
            TRACK_SELECT, enabled_filter, order_clause
        );
        conn.query_row(&sql, params![title], |row| track_from_row(row))
            .optional()
    }

    fn search_tracks_inner(&self, conn: &rusqlite::Connection, opts: &TrackQuery, query: &str) -> SqlResult<Vec<Track>> {
        let normalized = strip_diacritics(query);
        let words = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect::<Vec<_>>();

        if words.is_empty() {
            return Ok(vec![]);
        }

        let fts_query = format!("{{title artist_name album_title tag_names path}}:{}", words.join(" AND "));

        let mut sql = TRACK_SELECT.to_string();
        sql.push_str(" JOIN tracks_fts ON tracks_fts.rowid = t.id");

        if opts.tag_id.is_some() {
            sql.push_str(" JOIN track_tags tt ON tt.track_id = t.id");
        }

        sql.push_str(" WHERE tracks_fts MATCH ?1");
        let mut param_idx = 2;
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

        let liked_prefix = if opts.liked_only { "t.liked DESC, " } else { "" };
        if let Some(col) = sort_column_sql(opts.sort_field.as_deref()) {
            let dir = match opts.sort_dir.as_deref() {
                Some("desc") => "DESC",
                _ => "ASC",
            };
            sql.push_str(&format!(" ORDER BY {}{} {}, t.id", liked_prefix, col, dir));
        } else if opts.liked_only {
            sql.push_str(" ORDER BY t.liked DESC, t.id");
        }

        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);
        sql.push_str(&format!(" LIMIT ?{} OFFSET ?{}", param_idx, param_idx + 1));

        let mut stmt = conn.prepare(&sql)?;

        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        params_vec.push(Box::new(fts_query));
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

        let normalized = strip_diacritics(query);
        let words: Vec<String> = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect();

        if words.is_empty() {
            return Ok(SearchAllResults { artists: vec![], albums: vec![], tracks: vec![] });
        }

        let fts_terms = words.join(" AND ");

        // --- Artists: use FTS on artist_name to find matching artist IDs ---
        let artists = {
            let fts_query = format!("{{artist_name}}:{}", fts_terms);
            let mut stmt = conn.prepare(
                "SELECT DISTINCT a.id, a.name, a.track_count, a.liked \
                 FROM artists a \
                 WHERE a.track_count > 0 \
                 AND a.id IN ( \
                   SELECT t.artist_id FROM tracks t \
                   JOIN tracks_fts ON tracks_fts.rowid = t.id \
                   WHERE tracks_fts MATCH ?1 AND t.artist_id IS NOT NULL \
                 ) \
                 ORDER BY a.name LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![fts_query, artist_limit], |row| {
                Ok(Artist {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    track_count: row.get(2)?,
                    liked: row.get::<_, i32>(3).unwrap_or(0),
                })
            })?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };

        // --- Albums: use FTS on album_title to find matching album IDs ---
        let albums = {
            let fts_query = format!("{{album_title}}:{}", fts_terms);
            let mut stmt = conn.prepare(
                "SELECT DISTINCT al.id, al.title, al.artist_id, ar.name, al.year, al.track_count, al.liked \
                 FROM albums al \
                 LEFT JOIN artists ar ON al.artist_id = ar.id \
                 WHERE al.track_count > 0 \
                 AND al.id IN ( \
                   SELECT t.album_id FROM tracks t \
                   JOIN tracks_fts ON tracks_fts.rowid = t.id \
                   WHERE tracks_fts MATCH ?1 AND t.album_id IS NOT NULL \
                 ) \
                 ORDER BY al.title LIMIT ?2"
            )?;
            let rows = stmt.query_map(params![fts_query, album_limit], |row| album_from_row(row))?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };

        // --- Tracks (reuse FTS) ---
        let track_opts = TrackQuery {
            limit: Some(track_limit),
            ..Default::default()
        };
        let tracks = self.search_tracks_inner(&conn, &track_opts, query)?;

        Ok(SearchAllResults { artists, albums, tracks })
    }

    fn list_entity(&self, conn: &rusqlite::Connection, entity: &str, opts: &TrackQuery) -> SqlResult<SearchEntityResult> {
        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);
        match entity {
            "tracks" => {
                let mut where_clauses = format!("WHERE 1=1 {}", ENABLED_COLLECTION_FILTER);
                let mut count_clauses = format!("WHERE 1=1 {}", ENABLED_COLLECTION_FILTER_STANDALONE);
                if opts.has_youtube_url {
                    where_clauses.push_str(" AND t.youtube_url IS NOT NULL AND t.youtube_url != ''");
                    count_clauses.push_str(" AND t.youtube_url IS NOT NULL AND t.youtube_url != ''");
                }
                match opts.media_type.as_deref() {
                    Some("audio") => {
                        let f = " AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))";
                        where_clauses.push_str(f);
                        count_clauses.push_str(f);
                    }
                    Some("video") => {
                        let f = " AND LOWER(t.format) IN ('mp4','m4v','mov','webm')";
                        where_clauses.push_str(f);
                        count_clauses.push_str(f);
                    }
                    _ => {}
                }

                let total: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM tracks t {}", count_clauses),
                    [], |row| row.get(0),
                )?;

                let liked_prefix = if opts.liked_only { "t.liked DESC, " } else { "" };
                let order = if let Some(col) = sort_column_sql(opts.sort_field.as_deref()) {
                    let dir = match opts.sort_dir.as_deref() { Some("desc") => "DESC", _ => "ASC" };
                    format!("ORDER BY {}{} {}, t.id", liked_prefix, col, dir)
                } else {
                    format!("ORDER BY {}t.title", liked_prefix)
                };

                let sql = format!("{} {} {} LIMIT ?1 OFFSET ?2", TRACK_SELECT, where_clauses, order);
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![limit, offset], |row| track_from_row(row))?;
                let tracks = rows.collect::<SqlResult<Vec<_>>>()?;
                Ok(SearchEntityResult { tracks: Some(tracks), albums: None, artists: None, tags: None, total })
            }
            "artists" => {
                let where_clause = "WHERE a.track_count > 0";
                let total: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM artists a {}", where_clause), [], |row| row.get(0),
                )?;
                let liked_prefix = if opts.liked_only { "a.liked DESC, " } else { "" };
                let order = match opts.sort_field.as_deref() {
                    Some("name") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}a.name {}", liked_prefix, d) }
                    Some("tracks") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}a.track_count {}", liked_prefix, d) }
                    Some("random") => format!("ORDER BY {}RANDOM()", liked_prefix),
                    _ => format!("ORDER BY {}a.name", liked_prefix),
                };
                let sql = format!("SELECT a.id, a.name, a.track_count, a.liked FROM artists a {} {} LIMIT ?1 OFFSET ?2", where_clause, order);
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![limit, offset], |row| {
                    Ok(Artist { id: row.get(0)?, name: row.get(1)?, track_count: row.get(2)?, liked: row.get::<_, i32>(3).unwrap_or(0) })
                })?;
                let artists = rows.collect::<SqlResult<Vec<_>>>()?;
                Ok(SearchEntityResult { tracks: None, albums: None, artists: Some(artists), tags: None, total })
            }
            "albums" => {
                let where_clause = "WHERE a.track_count > 0";
                let total: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM albums a {}", where_clause), [], |row| row.get(0),
                )?;
                let liked_prefix = if opts.liked_only { "a.liked DESC, " } else { "" };
                let order = match opts.sort_field.as_deref() {
                    Some("name") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}a.title {}", liked_prefix, d) }
                    Some("artist") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}ar.name {}", liked_prefix, d) }
                    Some("year") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}a.year {}", liked_prefix, d) }
                    Some("tracks") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}a.track_count {}", liked_prefix, d) }
                    Some("random") => format!("ORDER BY {}RANDOM()", liked_prefix),
                    _ => format!("ORDER BY {}a.title", liked_prefix),
                };
                let sql = format!(
                    "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked \
                     FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id \
                     {} {} LIMIT ?1 OFFSET ?2", where_clause, order
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![limit, offset], |row| album_from_row(row))?;
                let albums = rows.collect::<SqlResult<Vec<_>>>()?;
                Ok(SearchEntityResult { tracks: None, albums: Some(albums), artists: None, tags: None, total })
            }
            "tags" => {
                let total: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM tags WHERE track_count > 0", [], |row| row.get(0),
                )?;
                let liked_prefix = if opts.liked_only { "liked DESC, " } else { "" };
                let order = match opts.sort_field.as_deref() {
                    Some("name") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}name {}", liked_prefix, d) }
                    Some("tracks") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}track_count {}", liked_prefix, d) }
                    Some("random") => format!("ORDER BY {}RANDOM()", liked_prefix),
                    _ => format!("ORDER BY {}name", liked_prefix),
                };
                let sql = format!("SELECT id, name, track_count, liked FROM tags WHERE track_count > 0 {} LIMIT ?1 OFFSET ?2", order);
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![limit, offset], |row| {
                    Ok(Tag { id: row.get(0)?, name: row.get(1)?, track_count: row.get(2)?, liked: row.get::<_, i32>(3).unwrap_or(0) })
                })?;
                let tags = rows.collect::<SqlResult<Vec<_>>>()?;
                Ok(SearchEntityResult { tracks: None, albums: None, artists: None, tags: Some(tags), total })
            }
            _ => Ok(SearchEntityResult { tracks: None, albums: None, artists: None, tags: None, total: 0 }),
        }
    }

    pub fn search_entity(&self, query: &str, entity: &str, opts: &TrackQuery) -> SqlResult<SearchEntityResult> {
        let conn = self.conn.lock().unwrap();

        let normalized = strip_diacritics(query);
        let words: Vec<String> = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect();

        if words.is_empty() {
            return self.list_entity(&conn, entity, opts);
        }

        let limit = opts.limit.unwrap_or(100);
        let offset = opts.offset.unwrap_or(0);
        let fts_terms = words.join(" AND ");

        match entity {
            "tracks" => {
                let tracks = self.search_tracks_inner(&conn, opts, query)?;

                let fts_query = format!("{{title artist_name album_title tag_names path}}:{}", fts_terms);
                let mut count_sql = "SELECT COUNT(*) FROM tracks t \
                         JOIN tracks_fts ON tracks_fts.rowid = t.id \
                         WHERE tracks_fts MATCH ?1 \
                         AND t.collection_id IN (SELECT id FROM collections WHERE enabled = 1)".to_string();
                if opts.has_youtube_url { count_sql.push_str(" AND t.youtube_url IS NOT NULL AND t.youtube_url != ''"); }
                match opts.media_type.as_deref() {
                    Some("audio") => count_sql.push_str(" AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))"),
                    Some("video") => count_sql.push_str(" AND LOWER(t.format) IN ('mp4','m4v','mov','webm')"),
                    _ => {}
                }
                let total: i64 = conn.query_row(&count_sql, params![fts_query], |row| row.get(0))?;

                Ok(SearchEntityResult { tracks: Some(tracks), albums: None, artists: None, tags: None, total })
            }
            "artists" => {
                let fts_query = format!("{{artist_name}}:{}", fts_terms);
                let total: i64 = conn.query_row(
                    "SELECT COUNT(DISTINCT a.id) FROM artists a \
                     WHERE a.track_count > 0 \
                     AND a.id IN ( \
                       SELECT t.artist_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 AND t.artist_id IS NOT NULL \
                     )",
                    params![fts_query],
                    |row| row.get(0),
                )?;

                let liked_prefix = if opts.liked_only { "a.liked DESC, " } else { "" };
                let order = match opts.sort_field.as_deref() {
                    Some("name") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}a.name {}", liked_prefix, d) }
                    Some("tracks") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}a.track_count {}", liked_prefix, d) }
                    Some("random") => format!("ORDER BY {}RANDOM()", liked_prefix),
                    _ => format!("ORDER BY {}a.name", liked_prefix),
                };
                let mut stmt = conn.prepare(
                    &format!("SELECT DISTINCT a.id, a.name, a.track_count, a.liked \
                     FROM artists a \
                     WHERE a.track_count > 0 \
                     AND a.id IN ( \
                       SELECT t.artist_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 AND t.artist_id IS NOT NULL \
                     ) \
                     {} LIMIT ?2 OFFSET ?3", order)
                )?;
                let rows = stmt.query_map(params![fts_query, limit, offset], |row| {
                    Ok(Artist {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        track_count: row.get(2)?,
                        liked: row.get::<_, i32>(3).unwrap_or(0),
                    })
                })?;
                let artists = rows.collect::<SqlResult<Vec<_>>>()?;

                Ok(SearchEntityResult { tracks: None, albums: None, artists: Some(artists), tags: None, total })
            }
            "albums" => {
                let fts_query = format!("{{album_title artist_name}}:{}", fts_terms);
                let total: i64 = conn.query_row(
                    "SELECT COUNT(DISTINCT al.id) FROM albums al \
                     WHERE al.track_count > 0 \
                     AND al.id IN ( \
                       SELECT t.album_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 AND t.album_id IS NOT NULL \
                     )",
                    params![fts_query],
                    |row| row.get(0),
                )?;

                let liked_prefix = if opts.liked_only { "al.liked DESC, " } else { "" };
                let order = match opts.sort_field.as_deref() {
                    Some("name") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}al.title {}", liked_prefix, d) }
                    Some("artist") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}ar.name {}", liked_prefix, d) }
                    Some("year") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}al.year {}", liked_prefix, d) }
                    Some("tracks") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}al.track_count {}", liked_prefix, d) }
                    Some("random") => format!("ORDER BY {}RANDOM()", liked_prefix),
                    _ => format!("ORDER BY {}al.title", liked_prefix),
                };
                let mut stmt = conn.prepare(
                    &format!("SELECT DISTINCT al.id, al.title, al.artist_id, ar.name, al.year, al.track_count, al.liked \
                     FROM albums al \
                     LEFT JOIN artists ar ON al.artist_id = ar.id \
                     WHERE al.track_count > 0 \
                     AND al.id IN ( \
                       SELECT t.album_id FROM tracks t \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 AND t.album_id IS NOT NULL \
                     ) \
                     {} LIMIT ?2 OFFSET ?3", order)
                )?;
                let rows = stmt.query_map(params![fts_query, limit, offset], |row| album_from_row(row))?;
                let albums = rows.collect::<SqlResult<Vec<_>>>()?;

                Ok(SearchEntityResult { tracks: None, albums: Some(albums), artists: None, tags: None, total })
            }
            "tags" => {
                let fts_query = format!("{{tag_names}}:{}", fts_terms);
                let total: i64 = conn.query_row(
                    "SELECT COUNT(DISTINCT tg.id) FROM tags tg \
                     WHERE tg.track_count > 0 \
                     AND tg.id IN ( \
                       SELECT tt.tag_id FROM track_tags tt \
                       JOIN tracks t ON tt.track_id = t.id \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 \
                     )",
                    params![fts_query],
                    |row| row.get(0),
                )?;

                let liked_prefix = if opts.liked_only { "tg.liked DESC, " } else { "" };
                let order = match opts.sort_field.as_deref() {
                    Some("name") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}tg.name {}", liked_prefix, d) }
                    Some("tracks") => { let d = if opts.sort_dir.as_deref() == Some("desc") { "DESC" } else { "ASC" }; format!("ORDER BY {}tg.track_count {}", liked_prefix, d) }
                    Some("random") => format!("ORDER BY {}RANDOM()", liked_prefix),
                    _ => format!("ORDER BY {}tg.name", liked_prefix),
                };
                let mut stmt = conn.prepare(
                    &format!("SELECT DISTINCT tg.id, tg.name, tg.track_count, tg.liked \
                     FROM tags tg \
                     WHERE tg.track_count > 0 \
                     AND tg.id IN ( \
                       SELECT tt.tag_id FROM track_tags tt \
                       JOIN tracks t ON tt.track_id = t.id \
                       JOIN tracks_fts ON tracks_fts.rowid = t.id \
                       WHERE tracks_fts MATCH ?1 \
                     ) \
                     {} LIMIT ?2 OFFSET ?3", order)
                )?;
                let rows = stmt.query_map(params![fts_query, limit, offset], |row| {
                    Ok(Tag { id: row.get(0)?, name: row.get(1)?, track_count: row.get(2)?, liked: row.get::<_, i32>(3).unwrap_or(0) })
                })?;
                let tags = rows.collect::<SqlResult<Vec<_>>>()?;

                Ok(SearchEntityResult { tracks: None, albums: None, artists: None, tags: Some(tags), total })
            }
            _ => Ok(SearchEntityResult { tracks: None, albums: None, artists: None, tags: None, total: 0 }),
        }
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
            "UPDATE collections SET last_sync_error = ?2, last_synced_at = strftime('%s', 'now') WHERE id = ?1",
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

                    // When artist changed but album title NOT changed, reassign each
                    // track's album to one under the new artist (find or create).
                    if album_title.is_none() {
                        // Collect (track_id, album_title, album_year) for tracks that have albums
                        let mut track_albums: Vec<(i64, String, Option<i32>)> = Vec::new();
                        for chunk in track_ids.chunks(500) {
                            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                            let sql = format!(
                                "SELECT t.id, al.title, al.year FROM tracks t \
                                 JOIN albums al ON t.album_id = al.id \
                                 WHERE t.id IN ({})", placeholders
                            );
                            let mut stmt = conn.prepare(&sql)?;
                            let params: Vec<&dyn rusqlite::types::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
                            let rows = stmt.query_map(params.as_slice(), |row| {
                                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i32>>(2)?))
                            })?;
                            for row in rows {
                                track_albums.push(row?);
                            }
                        }
                        // Group by album title to avoid redundant lookups
                        let mut album_cache: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
                        for (tid, title, album_year) in &track_albums {
                            let album_id = if let Some(&cached_id) = album_cache.get(title) {
                                cached_id
                            } else {
                                let existing: Option<i64> = conn.query_row(
                                    "SELECT id FROM albums WHERE strip_diacritics(unicode_lower(title)) = strip_diacritics(unicode_lower(?1)) \
                                     AND artist_id = ?2",
                                    params![title, aid],
                                    |row| row.get(0),
                                ).optional()?;
                                let id = match existing {
                                    Some(id) => id,
                                    None => {
                                        conn.execute(
                                            "INSERT INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)",
                                            params![title, aid, album_year],
                                        )?;
                                        conn.last_insert_rowid()
                                    }
                                };
                                album_cache.insert(title.clone(), id);
                                id
                            };
                            conn.execute(
                                "UPDATE tracks SET album_id = ?1 WHERE id = ?2",
                                params![album_id, tid],
                            )?;
                        }
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

    // --- Playlists ---

    pub fn save_playlist(&self, name: &str, source: Option<&str>, image_path: Option<&str>) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO playlists (name, source, image_path) VALUES (?1, ?2, ?3)",
            params![name, source, image_path],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn save_playlist_tracks(
        &self,
        playlist_id: i64,
        tracks: &[(&str, Option<&str>, Option<&str>, Option<f64>, Option<&str>, Option<&str>)],
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "INSERT INTO playlist_tracks (playlist_id, position, title, artist_name, album_name, duration_secs, source, image_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        )?;
        for (i, (title, artist, album, duration, source, image)) in tracks.iter().enumerate() {
            stmt.execute(params![playlist_id, i as i64, title, artist, album, duration, source, image])?;
        }
        Ok(())
    }

    pub fn get_playlists(&self) -> SqlResult<Vec<Playlist>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT p.id, p.name, p.source, p.saved_at, p.image_path,
                    (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) as track_count
             FROM playlists p ORDER BY p.saved_at DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Playlist {
                id: row.get(0)?,
                name: row.get(1)?,
                source: row.get(2)?,
                saved_at: row.get(3)?,
                image_path: row.get(4)?,
                track_count: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_playlist_tracks(&self, playlist_id: i64) -> SqlResult<Vec<PlaylistTrack>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, playlist_id, position, title, artist_name, album_name, duration_secs, source, image_path
             FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position"
        )?;
        let rows = stmt.query_map(params![playlist_id], |row| {
            Ok(PlaylistTrack {
                id: row.get(0)?,
                playlist_id: row.get(1)?,
                position: row.get(2)?,
                title: row.get(3)?,
                artist_name: row.get(4)?,
                album_name: row.get(5)?,
                duration_secs: row.get(6)?,
                source: row.get(7)?,
                image_path: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_playlist(&self, playlist_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM playlists WHERE id = ?1", params![playlist_id])?;
        Ok(())
    }

    pub fn update_playlist_image(&self, playlist_id: i64, image_path: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlists SET image_path = ?1 WHERE id = ?2",
            params![image_path, playlist_id],
        )?;
        Ok(())
    }

    pub fn update_playlist_track_image(&self, track_id: i64, image_path: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlist_tracks SET image_path = ?1 WHERE id = ?2",
            params![image_path, track_id],
        )?;
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

    pub fn get_auto_continue_track(&self, strategy: &str, current_title: &str, current_artist: Option<&str>, format_filter: Option<&str>, exclude_ids: &[i64]) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();

        let format_clause = match format_filter {
            Some("video") => " AND LOWER(t.format) IN ('mp4','m4v','mov','webm')",
            Some("audio") => " AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))",
            _ => "",
        };

        let dislike_clause = " AND t.liked != -1";

        let exclude_clause = if exclude_ids.is_empty() {
            String::new()
        } else {
            let ids: Vec<String> = exclude_ids.iter().map(|id| id.to_string()).collect();
            format!(" AND t.id NOT IN ({})", ids.join(","))
        };

        let canonical_title = strip_diacritics(&current_title.to_lowercase());
        let exclude_self = " AND strip_diacritics(unicode_lower(t.title)) != ?1";

        match strategy {
            "random" => {
                let sql = format!("{} WHERE 1=1 {}{}{}{}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, exclude_self, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause);
                conn.query_row(&sql, params![canonical_title], |row| track_from_row(row)).optional()
            }
            "same_artist" => {
                let artist = current_artist.unwrap_or("");
                let canonical_artist = strip_diacritics(&artist.to_lowercase());
                let artist_id: Option<i64> = conn.query_row(
                    "SELECT id FROM artists WHERE strip_diacritics(unicode_lower(name)) = ?1",
                    params![canonical_artist],
                    |row| row.get(0),
                ).optional()?;
                match artist_id {
                    Some(aid) => {
                        let sql = format!("{} WHERE t.artist_id = ?2 {}{}{}{}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, exclude_self, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause);
                        conn.query_row(&sql, params![canonical_title, aid], |row| track_from_row(row)).optional()
                    }
                    None => Ok(None),
                }
            }
            "same_tag" => {
                let artist = current_artist.unwrap_or("");
                let canonical_artist = strip_diacritics(&artist.to_lowercase());
                let track_id: Option<i64> = conn.query_row(
                    "SELECT t.id FROM tracks t \
                     LEFT JOIN artists ar ON t.artist_id = ar.id \
                     WHERE strip_diacritics(unicode_lower(t.title)) = ?1 \
                     AND strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) = ?2 \
                     LIMIT 1",
                    params![canonical_title, canonical_artist],
                    |row| row.get(0),
                ).optional()?;
                match track_id {
                    Some(tid) => {
                        let sql = format!(
                            "{} WHERE t.id != ?1 {}{}{}{} AND t.id IN (\
                                SELECT tt2.track_id FROM track_tags tt1 \
                                JOIN track_tags tt2 ON tt1.tag_id = tt2.tag_id \
                                WHERE tt1.track_id = ?1 AND tt2.track_id != ?1\
                            ) ORDER BY RANDOM() LIMIT 1",
                            TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause
                        );
                        conn.query_row(&sql, params![tid], |row| track_from_row(row)).optional()
                    }
                    None => Ok(None),
                }
            }
            "most_played" => {
                let sql = format!(
                    "{} WHERE 1=1 {}{}{}{}{} AND t.id IN (\
                        SELECT ht.library_track_id FROM history_tracks ht \
                        WHERE ht.library_track_id IS NOT NULL \
                        ORDER BY ht.play_count DESC LIMIT 50\
                    ) ORDER BY RANDOM() LIMIT 1",
                    TRACK_SELECT, exclude_self, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause
                );
                conn.query_row(&sql, params![canonical_title], |row| track_from_row(row)).optional()
            }
            "liked" => {
                let sql = format!("{} WHERE t.liked = 1 {}{}{}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, exclude_self, ENABLED_COLLECTION_FILTER, format_clause, exclude_clause);
                conn.query_row(&sql, params![canonical_title], |row| track_from_row(row)).optional()
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

    pub fn record_play_by_metadata(&self, title: &str, artist_name: Option<&str>, library_track_id: Option<i64>) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let artist = artist_name.unwrap_or("");
        let canonical_artist = strip_diacritics(&artist.to_lowercase());
        let canonical_title = strip_diacritics(&title.to_lowercase());

        let library_artist_id: Option<i64> = library_track_id.and_then(|tid| {
            conn.query_row("SELECT artist_id FROM tracks WHERE id = ?1", params![tid], |row| row.get(0)).optional().ok().flatten()
        });

        conn.execute(
            "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count, library_artist_id)
             VALUES (?1, ?2, strftime('%s', 'now'), strftime('%s', 'now'), 0, ?3)
             ON CONFLICT(canonical_name) DO UPDATE SET
               display_name = excluded.display_name,
               library_artist_id = COALESCE(excluded.library_artist_id, history_artists.library_artist_id)",
            params![canonical_artist, artist, library_artist_id],
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
               library_track_id = COALESCE(excluded.library_track_id, history_tracks.library_track_id)",
            params![history_artist_id, canonical_title, title, library_track_id],
        )?;
        let history_track_id: i64 = conn.query_row(
            "SELECT id FROM history_tracks WHERE history_artist_id = ?1 AND canonical_title = ?2",
            params![history_artist_id, canonical_title],
            |row| row.get(0),
        )?;

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

        conn.execute(
            "INSERT INTO history_plays (history_track_id) VALUES (?1)",
            params![history_track_id],
        )?;
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
            "SELECT id, play_count, display_title, display_name, library_track_id, rank FROM ( \
               SELECT ht.id, ht.play_count, ht.display_title, ha.display_name, ht.library_track_id, \
                      RANK() OVER (ORDER BY ht.play_count DESC) as rank \
               FROM history_tracks ht \
               JOIN history_artists ha ON ha.id = ht.history_artist_id \
               WHERE ht.play_count > 0 \
             ) ORDER BY play_count DESC LIMIT ?1"
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
            "SELECT id, cnt, display_title, display_name, library_track_id, rank FROM ( \
               SELECT ht.id, COUNT(*) as cnt, ht.display_title, ha.display_name, ht.library_track_id, \
                      RANK() OVER (ORDER BY COUNT(*) DESC) as rank \
               FROM history_plays hp \
               JOIN history_tracks ht ON ht.id = hp.history_track_id \
               JOIN history_artists ha ON ha.id = ht.history_artist_id \
               WHERE hp.played_at >= ?1 \
               GROUP BY ht.id \
             ) ORDER BY cnt DESC LIMIT ?2"
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
            "SELECT id, play_count, display_title, display_name, library_track_id, rank FROM ( \
               SELECT ht.id, ht.play_count, ht.display_title, ha.display_name, ht.library_track_id, \
                      RANK() OVER (ORDER BY ht.play_count DESC) as rank \
               FROM history_tracks ht \
               JOIN history_artists ha ON ha.id = ht.history_artist_id \
               WHERE ht.play_count > 0 \
                 AND (ht.canonical_title LIKE ?1 OR ha.canonical_name LIKE ?1) \
             ) ORDER BY play_count DESC LIMIT ?2"
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
            "SELECT id, play_count, track_count, display_name, library_artist_id, rank FROM ( \
               SELECT ha.id, ha.play_count, \
                      (SELECT COUNT(*) FROM history_tracks ht WHERE ht.history_artist_id = ha.id) as track_count, \
                      ha.display_name, ha.library_artist_id, \
                      RANK() OVER (ORDER BY ha.play_count DESC) as rank \
               FROM history_artists ha \
               WHERE ha.play_count > 0 AND ha.canonical_name != '' \
             ) ORDER BY play_count DESC LIMIT ?1"
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
            "SELECT id, play_count, track_count, display_name, library_artist_id, rank FROM ( \
               SELECT ha.id, ha.play_count, \
                      (SELECT COUNT(*) FROM history_tracks ht WHERE ht.history_artist_id = ha.id) as track_count, \
                      ha.display_name, ha.library_artist_id, \
                      RANK() OVER (ORDER BY ha.play_count DESC) as rank \
               FROM history_artists ha \
               WHERE ha.play_count > 0 AND ha.canonical_name LIKE ?1 \
             ) ORDER BY play_count DESC LIMIT ?2"
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

    pub fn get_track_rank(&self, title: &str, artist_name: Option<&str>) -> SqlResult<Option<i64>> {
        let canonical_title = strip_diacritics(&title.to_lowercase());
        let canonical_artist = strip_diacritics(&artist_name.unwrap_or("").to_lowercase());
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT rank FROM ( \
               SELECT ht.id, RANK() OVER (ORDER BY ht.play_count DESC) as rank \
               FROM history_tracks ht WHERE ht.play_count > 0 \
             ) ranked \
             JOIN history_tracks ht2 ON ht2.id = ranked.id \
             JOIN history_artists ha ON ha.id = ht2.history_artist_id \
             WHERE ht2.canonical_title = ?1 AND ha.canonical_name = ?2",
            params![canonical_title, canonical_artist],
            |row| row.get(0),
        ).optional()
    }

    pub fn get_artist_rank(&self, artist_id: i64) -> SqlResult<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT rank FROM ( \
               SELECT library_artist_id, RANK() OVER (ORDER BY play_count DESC) as rank \
               FROM history_artists WHERE play_count > 0 \
             ) WHERE library_artist_id = ?1",
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

    // ── Information Types ────────────────────────────────────────

    /// Sync the information_types table from plugin manifests.
    /// Deactivates all types, then upserts incoming types as active.
    /// Types from missing plugins remain with active = 0.
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
                           sort_order = excluded.sort_order,
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

    /// Delete all cached values for a given type_id string (across all providers and entities).
    pub fn info_delete_values_for_type(&self, type_id: &str) -> SqlResult<usize> {
        let conn = self.conn.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM information_values
             WHERE information_type_id IN (SELECT id FROM information_types WHERE type_id = ?1)",
            [type_id],
        )?;
        Ok(count)
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

    /// Reset provider priorities to defaults.
    /// image_defaults: vec of (plugin_id, entity, default_priority) for image_providers.
    /// info_defaults: vec of (type_id, plugin_id, default_priority) for information_types.
    pub fn reset_provider_priorities(&self, image_defaults: &[(String, String, i64)], info_defaults: &[(String, String, i64)]) -> SqlResult<()> {
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
                "UPDATE information_types SET priority = ?1 WHERE type_id = ?2 AND plugin_id = ?3"
            )?;
            for d in info_defaults {
                stmt.execute(rusqlite::params![d.2, d.0, d.1])?;
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
    pub fn find_track_in_collection(
        &self,
        collection_id: i64,
        title: &str,
        artist_name: &str,
    ) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{TRACK_SELECT} WHERE t.collection_id = ?1 \
             AND strip_diacritics(unicode_lower(t.title)) = strip_diacritics(unicode_lower(?2)) \
             AND ar.name IS NOT NULL AND strip_diacritics(unicode_lower(ar.name)) = strip_diacritics(unicode_lower(?3)) \
             LIMIT 1"
        );
        conn.query_row(&sql, params![collection_id, title, artist_name], |row| {
            track_from_row(row)
        }).optional()
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
    fn test_info_delete_values_for_type_by_string() {
        let db = test_db();

        db.info_sync_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm".into(), 7776000, 200, 100, String::new()),
        ]).unwrap();
        let types = db.info_get_types_for_entity("artist").unwrap();
        let int_id = types[0].5[0].1;

        db.info_upsert_value(int_id, "artist:Daft Punk", r#"{"summary":"bio"}"#, "ok").unwrap();
        db.info_upsert_value(int_id, "artist:Radiohead", r#"{"summary":"bio2"}"#, "ok").unwrap();

        let count = db.info_delete_values_for_type("artist_bio").unwrap();
        assert_eq!(count, 2);
        assert!(db.info_get_value(int_id, "artist:Daft Punk").unwrap().is_none());
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
        let id = db.save_playlist("Discover Weekly 15 Apr 2026", Some("spotify-playlist://abc123"), None).unwrap();
        assert!(id > 0);

        let playlists = db.get_playlists().unwrap();
        assert_eq!(playlists.len(), 1);
        assert_eq!(playlists[0].name, "Discover Weekly 15 Apr 2026");
        assert_eq!(playlists[0].source.as_deref(), Some("spotify-playlist://abc123"));
        assert_eq!(playlists[0].track_count, 0);
    }

    #[test]
    fn test_save_playlist_tracks() {
        let db = test_db();
        let playlist_id = db.save_playlist("Test Playlist", None, None).unwrap();

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
    fn test_delete_playlist_cascades() {
        let db = test_db();
        let playlist_id = db.save_playlist("To Delete", None, None).unwrap();
        db.save_playlist_tracks(playlist_id, &[
            ("Song", None, None, None, None, None),
        ]).unwrap();
        assert_eq!(db.get_playlist_tracks(playlist_id).unwrap().len(), 1);

        db.delete_playlist(playlist_id).unwrap();
        assert_eq!(db.get_playlists().unwrap().len(), 0);
        assert_eq!(db.get_playlist_tracks(playlist_id).unwrap().len(), 0);
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
        let t1 = insert_track(&db, "music/t1.mp3", "Track A", Some(a), None);
        let t2 = insert_track(&db, "music/t2.mp3", "Track B", Some(a), None);
        let t3 = insert_track(&db, "music/t3.mp3", "Track C", Some(a), None);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, play_count, library_artist_id) VALUES ('artist', 'Artist', 15, ?1)",
                params![a],
            ).unwrap();
            let ha: i64 = conn.query_row("SELECT id FROM history_artists WHERE canonical_name = 'artist'", [], |r| r.get(0)).unwrap();
            for (title, tid, count) in [("track a", t1, 10), ("track b", t2, 10), ("track c", t3, 5)] {
                conn.execute(
                    "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, play_count, library_track_id) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![ha, title, title, count, tid],
                ).unwrap();
            }
        }

        // Tied tracks should have the same rank
        assert_eq!(db.get_track_rank(t1).unwrap(), Some(1));
        assert_eq!(db.get_track_rank(t2).unwrap(), Some(1));
        assert_eq!(db.get_track_rank(t3).unwrap(), Some(3)); // RANK() skips to 3

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
        let t1 = insert_track(&db, "music/teardrop.mp3", "Teardrop", Some(a), None);
        let t2 = insert_track(&db, "music/angel.mp3", "Angel", Some(a), None);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, play_count, library_artist_id) VALUES ('massive attack', 'Massive Attack', 7, ?1)",
                params![a],
            ).unwrap();
            let ha: i64 = conn.query_row("SELECT id FROM history_artists WHERE canonical_name = 'massive attack'", [], |r| r.get(0)).unwrap();
            conn.execute(
                "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, play_count, library_track_id) VALUES (?1, 'teardrop', 'Teardrop', 5, ?2)",
                params![ha, t1],
            ).unwrap();
            conn.execute(
                "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, play_count, library_track_id) VALUES (?1, 'angel', 'Angel', 2, ?2)",
                params![ha, t2],
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
        let a1 = db.get_or_create_artist("Portishead").unwrap();
        let a2 = db.get_or_create_artist("Radiohead").unwrap();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, play_count, library_artist_id) VALUES ('portishead', 'Portishead', 10, ?1)",
                params![a1],
            ).unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, play_count, library_artist_id) VALUES ('radiohead', 'Radiohead', 20, ?1)",
                params![a2],
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
        let t1 = insert_track(&db, "music/old.mp3", "Old Song", Some(a), None);
        let t2 = insert_track(&db, "music/new.mp3", "New Song", Some(a), None);

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO history_artists (canonical_name, display_name, play_count, library_artist_id) VALUES ('artist', 'Artist', 5, ?1)",
                params![a],
            ).unwrap();
            let ha: i64 = conn.query_row("SELECT id FROM history_artists WHERE canonical_name = 'artist'", [], |r| r.get(0)).unwrap();
            conn.execute(
                "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, play_count, library_track_id) VALUES (?1, 'old song', 'Old Song', 3, ?2)",
                params![ha, t1],
            ).unwrap();
            conn.execute(
                "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, play_count, library_track_id) VALUES (?1, 'new song', 'New Song', 2, ?2)",
                params![ha, t2],
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
                    "INSERT OR IGNORE INTO history_artists (canonical_name, display_name, play_count, library_artist_id) \
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        format!("artist {i:04}"),
                        format!("Artist {i:04}"),
                        (num_history / ha_count) as i64,
                        artist_ids[i]
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
                    "INSERT OR IGNORE INTO history_tracks (history_artist_id, canonical_title, display_title, play_count, library_track_id) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        ha_id,
                        format!("track {i:05} title"),
                        format!("Track {i:05} Title"),
                        (num_history / ht_count) as i64,
                        track_ids[i]
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
            let _ = db.get_track_rank(1).unwrap();
        }));

        results.push(bench("get_artist_rank", 50, || {
            let _ = db.get_artist_rank(1).unwrap();
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
}
