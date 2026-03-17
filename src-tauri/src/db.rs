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


const TRACK_SELECT: &str =
    "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, al.year, \
     t.track_number, t.duration_secs, t.format, t.file_size, t.collection_id, co.name, t.subsonic_id, t.liked, t.deleted \
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
        subsonic_id: row.get(14)?,
        liked: row.get::<_, i32>(15).unwrap_or(0) != 0,
        deleted: row.get::<_, i32>(16).unwrap_or(0) != 0,
    })
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(app_dir: &Path) -> SqlResult<Self> {
        let timer = crate::timing::timer();

        timer.time("db: create_app_dir", || std::fs::create_dir_all(app_dir).ok());

        let db_path = app_dir.join("fastplayer.db");
        let conn = timer.time("db: open_connection", || Connection::open(db_path))?;

        timer.time("db: register_sql_functions", || -> SqlResult<()> {
            // Register custom SQL function to extract filename from path
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

            // Register custom SQL function to strip diacritics for FTS indexing
            conn.create_scalar_function(
                "strip_diacritics",
                1,
                FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
                |ctx| {
                    let s: String = ctx.get(0)?;
                    Ok(strip_diacritics(&s))
                },
            )?;

            // Register custom SQL function for Unicode-aware lowercase (handles Greek, Cyrillic, etc.)
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
        })?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        timer.time("db: init_tables", || db.init_tables())?;
        timer.time("db: run_migrations", || db.run_migrations())?;
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
                track_count INTEGER NOT NULL DEFAULT 0
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
                path          TEXT NOT NULL UNIQUE,
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
                subsonic_id   TEXT,
                liked         INTEGER NOT NULL DEFAULT 0,
                deleted       INTEGER NOT NULL DEFAULT 0
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
                filename,
                content='',
                tokenize='unicode61 remove_diacritics 2'
            );

            CREATE TABLE IF NOT EXISTS play_history (
                id        INTEGER PRIMARY KEY,
                track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
                played_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_play_history_track ON play_history(track_id);
            CREATE INDEX IF NOT EXISTS idx_play_history_time  ON play_history(played_at);

            CREATE TABLE IF NOT EXISTS image_fetch_failures (
                kind       TEXT NOT NULL,
                item_id    INTEGER NOT NULL,
                failed_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                UNIQUE(kind, item_id)
            );

            CREATE TABLE IF NOT EXISTS db_version (
                version INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO db_version (rowid, version) VALUES (1, 1);

            CREATE INDEX IF NOT EXISTS idx_tracks_artist_id ON tracks(artist_id);
            CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id);
            CREATE INDEX IF NOT EXISTS idx_tracks_collection_id ON tracks(collection_id);
            CREATE INDEX IF NOT EXISTS idx_tracks_deleted ON tracks(deleted);
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

        drop(conn);
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
                liked: row.get::<_, i32>(3).unwrap_or(0) != 0,
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
            let rows = stmt.query_map(params![aid], |row| {
                Ok(Album { id: row.get(0)?, title: row.get(1)?, artist_id: row.get(2)?, artist_name: row.get(3)?, year: row.get(4)?, track_count: row.get(5)?, liked: row.get::<_, i32>(6).unwrap_or(0) != 0 })
            })?;
            rows.collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, a.track_count, a.liked
                 FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id
                 WHERE a.track_count > 0
                 ORDER BY a.title"
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(Album { id: row.get(0)?, title: row.get(1)?, artist_id: row.get(2)?, artist_name: row.get(3)?, year: row.get(4)?, track_count: row.get(5)?, liked: row.get::<_, i32>(6).unwrap_or(0) != 0 })
            })?;
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

    pub fn get_tags(&self) -> SqlResult<Vec<Tag>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, track_count FROM tags WHERE track_count > 0 ORDER BY name"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_tags_for_track(&self, track_id: i64) -> SqlResult<Vec<Tag>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT tg.id, tg.name, COUNT(t2.id)
             FROM tags tg
             JOIN track_tags tt ON tt.tag_id = tg.id
             LEFT JOIN track_tags tt2 ON tt2.tag_id = tg.id
             LEFT JOIN tracks t2 ON t2.id = tt2.track_id AND t2.deleted = 0
             WHERE tt.track_id = ?1
             GROUP BY tg.id
             ORDER BY tg.name"
        )?;
        let rows = stmt.query_map(params![track_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_tracks_by_tag(&self, tag_id: i64) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{} JOIN track_tags tt ON tt.track_id = t.id WHERE tt.tag_id = ?1 AND t.deleted = 0 {} ORDER BY ar.name, al.title, t.track_number, t.title",
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
            &format!("SELECT COUNT(*) FROM tracks t WHERE t.deleted = 0 {}", ENABLED_COLLECTION_FILTER),
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
        subsonic_id: Option<&str>,
    ) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tracks (path, title, artist_id, album_id, track_number, duration_secs, format, file_size, modified_at, collection_id, subsonic_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(path) DO UPDATE SET
                title=excluded.title, artist_id=excluded.artist_id, album_id=excluded.album_id,
                track_number=excluded.track_number,
                duration_secs=excluded.duration_secs, format=excluded.format,
                file_size=excluded.file_size, modified_at=excluded.modified_at,
                collection_id=excluded.collection_id, subsonic_id=excluded.subsonic_id,
                deleted=0",
            params![path, title, artist_id, album_id, track_number, duration_secs, format, file_size, modified_at, collection_id, subsonic_id],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM tracks WHERE path = ?1",
            params![path],
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
             DELETE FROM play_history;
             DELETE FROM collections;
             DROP TABLE IF EXISTS tracks_fts;
             CREATE VIRTUAL TABLE tracks_fts USING fts5(
                 title,
                 artist_name,
                 album_title,
                 tag_names,
                 filename,
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
                 filename,
                 content='',
                 tokenize='unicode61 remove_diacritics 2'
             );"
        )?;
        conn.execute_batch(
            &format!(
                "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, filename)
                 SELECT t.id, strip_diacritics(t.title), strip_diacritics(COALESCE(ar.name, '')), strip_diacritics(COALESCE(al.title, '')),
                        strip_diacritics(COALESCE((SELECT GROUP_CONCAT(tg.name, ' ') FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.track_id = t.id), '')),
                        strip_diacritics(filename_from_path(t.path))
                 FROM tracks t
                 LEFT JOIN artists ar ON t.artist_id = ar.id
                 LEFT JOIN albums al ON t.album_id = al.id
                 WHERE t.deleted = 0 {};",
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
                   WHERE t.artist_id = artists.id AND t.deleted = 0 {cf}
                 );
                 UPDATE albums SET track_count = (
                   SELECT COUNT(*) FROM tracks t
                   WHERE t.album_id = albums.id AND t.deleted = 0 {cf}
                 );
                 UPDATE tags SET track_count = (
                   SELECT COUNT(*) FROM track_tags tt
                   JOIN tracks t ON t.id = tt.track_id
                   WHERE tt.tag_id = tags.id AND t.deleted = 0 {cf}
                 );",
                cf = ENABLED_COLLECTION_FILTER
            )
        )
    }

    pub fn get_tracks(&self, album_id: Option<i64>) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        if let Some(aid) = album_id {
            let sql = format!("{} WHERE t.album_id = ?1 AND t.deleted = 0 {} ORDER BY t.track_number, t.title", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![aid], |row| track_from_row(row))?;
            rows.collect()
        } else {
            let sql = format!("{} WHERE t.deleted = 0 {} ORDER BY ar.name, al.title, t.track_number, t.title LIMIT 100", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([], |row| track_from_row(row))?;
            rows.collect()
        }
    }

    pub fn get_tracks_by_artist(&self, artist_id: i64) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE t.artist_id = ?1 AND t.deleted = 0 {} ORDER BY al.title, t.track_number, t.title", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![artist_id], |row| track_from_row(row))?;
        rows.collect()
    }

    pub fn get_track_by_id(&self, track_id: i64) -> SqlResult<Track> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE t.id = ?1", TRACK_SELECT);
        conn.query_row(&sql, params![track_id], |row| track_from_row(row))
    }

    pub fn search_tracks(
        &self,
        query: &str,
        artist_id: Option<i64>,
        album_id: Option<i64>,
        tag_id: Option<i64>,
        liked_only: bool,
    ) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let normalized = strip_diacritics(query);
        let fts_query = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" AND ");

        let mut sql = String::from(
            "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, al.year, \
             t.track_number, t.duration_secs, t.format, t.file_size, t.collection_id, co.name, t.subsonic_id, t.liked \
             FROM tracks_fts fts \
             JOIN tracks t ON fts.rowid = t.id \
             LEFT JOIN artists ar ON t.artist_id = ar.id \
             LEFT JOIN albums al ON t.album_id = al.id \
             LEFT JOIN collections co ON t.collection_id = co.id"
        );

        if tag_id.is_some() {
            sql.push_str(" JOIN track_tags tt ON tt.track_id = t.id");
        }

        sql.push_str(" WHERE tracks_fts MATCH ?1 AND t.deleted = 0");
        sql.push_str(&format!(" {}", ENABLED_COLLECTION_FILTER));

        let mut param_idx = 2;
        if artist_id.is_some() {
            sql.push_str(&format!(" AND t.artist_id = ?{}", param_idx));
            param_idx += 1;
        }
        if album_id.is_some() {
            sql.push_str(&format!(" AND t.album_id = ?{}", param_idx));
            param_idx += 1;
        }
        if tag_id.is_some() {
            sql.push_str(&format!(" AND tt.tag_id = ?{}", param_idx));
        }
        if liked_only {
            sql.push_str(" AND t.liked = 1");
        }

        sql.push_str(" LIMIT 100");

        let mut stmt = conn.prepare(&sql)?;

        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        params_vec.push(Box::new(fts_query));
        if let Some(aid) = artist_id {
            params_vec.push(Box::new(aid));
        }
        if let Some(alid) = album_id {
            params_vec.push(Box::new(alid));
        }
        if let Some(tid) = tag_id {
            params_vec.push(Box::new(tid));
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| track_from_row(row))?;
        rows.collect()
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
            "SELECT id, kind, name, path, url, username, last_synced_at, auto_update, auto_update_interval_mins, enabled, last_sync_duration_secs FROM collections ORDER BY name"
        )?;
        let rows = stmt.query_map([], |row| {
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
            })
        })?;
        rows.collect()
    }

    pub fn get_collection_by_id(&self, collection_id: i64) -> SqlResult<Collection> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, kind, name, path, url, username, last_synced_at, auto_update, auto_update_interval_mins, enabled, last_sync_duration_secs FROM collections WHERE id = ?1",
            params![collection_id],
            |row| {
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
                })
            },
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
            "UPDATE collections SET last_synced_at = strftime('%s', 'now'), last_sync_duration_secs = ?2 WHERE id = ?1",
            params![collection_id, duration_secs],
        )?;
        Ok(())
    }

    pub fn delete_tracks_by_collection(&self, collection_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM tracks WHERE collection_id = ?1",
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

    pub fn mark_tracks_deleted_by_paths(&self, paths: &[String]) -> SqlResult<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        for chunk in paths.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("UPDATE tracks SET deleted = 1 WHERE path IN ({})", placeholders);
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::types::ToSql> = chunk.iter().map(|p| p as &dyn rusqlite::types::ToSql).collect();
            stmt.execute(params.as_slice())?;
        }
        Ok(())
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

    pub fn get_tracks_by_paths(&self, paths: &[String]) -> SqlResult<Vec<Track>> {
        if paths.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = paths.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("{} WHERE t.path IN ({})", TRACK_SELECT, placeholders);
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> = paths.iter().map(|p| p as &dyn rusqlite::types::ToSql).collect();
        let rows = stmt.query_map(params.as_slice(), |row| track_from_row(row))?;
        let track_map: std::collections::HashMap<String, Track> = rows.filter_map(|r| r.ok()).map(|t| (t.path.clone(), t)).collect();
        // Return in input order, skipping missing paths
        Ok(paths.iter().filter_map(|p| track_map.get(p).cloned()).collect())
    }

    pub fn track_exists_by_path(&self, path: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM tracks WHERE path = ?1",
            params![path],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
    }

    pub fn remove_track_by_path(&self, path: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tracks WHERE path = ?1", params![path])?;
        Ok(())
    }

    // --- Liked tracks ---

    pub fn toggle_track_liked(&self, track_id: i64, liked: bool) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET liked = ?2 WHERE id = ?1",
            params![track_id, liked as i32],
        )?;
        Ok(())
    }

    pub fn toggle_artist_liked(&self, artist_id: i64, liked: bool) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE artists SET liked = ?2 WHERE id = ?1",
            params![artist_id, liked as i32],
        )?;
        Ok(())
    }

    pub fn toggle_album_liked(&self, album_id: i64, liked: bool) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE albums SET liked = ?2 WHERE id = ?1",
            params![album_id, liked as i32],
        )?;
        Ok(())
    }

    pub fn get_liked_tracks(&self) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE t.liked = 1 AND t.deleted = 0 {} ORDER BY ar.name, al.title, t.track_number, t.title", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
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

    pub fn clear_image_failures(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM image_fetch_failures", [])?;
        Ok(())
    }

    // --- Image helpers ---

    pub fn get_track_path_for_album(
        &self,
        album_title: &str,
        artist_name: Option<&str>,
    ) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match artist_name {
            Some(artist) => conn.query_row(
                "SELECT t.path FROM tracks t \
                 JOIN albums a ON t.album_id = a.id \
                 LEFT JOIN artists ar ON t.artist_id = ar.id \
                 WHERE a.title = ?1 AND ar.name = ?2 AND t.subsonic_id IS NULL AND t.deleted = 0 LIMIT 1",
                params![album_title, artist],
                |row| row.get(0),
            ),
            None => conn.query_row(
                "SELECT t.path FROM tracks t \
                 JOIN albums a ON t.album_id = a.id \
                 WHERE a.title = ?1 AND t.subsonic_id IS NULL AND t.deleted = 0 LIMIT 1",
                params![album_title],
                |row| row.get(0),
            ),
        }
        .optional()
    }

    // --- Play history ---

    pub fn record_play(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO play_history (track_id) VALUES (?1)",
            params![track_id],
        )?;
        Ok(())
    }

    pub fn get_recent_plays(&self, limit: i64) -> SqlResult<Vec<PlayHistoryEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ph.id, ph.track_id, ph.played_at, t.title, ar.name, al.title, t.duration_secs
             FROM play_history ph
             JOIN tracks t ON t.id = ph.track_id
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
             WHERE t.deleted = 0
             ORDER BY ph.played_at DESC
             LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(PlayHistoryEntry {
                id: row.get(0)?,
                track_id: row.get(1)?,
                played_at: row.get(2)?,
                track_title: row.get(3)?,
                artist_name: row.get(4)?,
                album_title: row.get(5)?,
                duration_secs: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_most_played(&self, limit: i64) -> SqlResult<Vec<MostPlayedTrack>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ph.track_id, COUNT(*) as play_count, t.title, ar.name, al.title, t.duration_secs
             FROM play_history ph
             JOIN tracks t ON t.id = ph.track_id
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
             WHERE t.deleted = 0
             GROUP BY ph.track_id
             ORDER BY play_count DESC
             LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(MostPlayedTrack {
                track_id: row.get(0)?,
                play_count: row.get(1)?,
                track_title: row.get(2)?,
                artist_name: row.get(3)?,
                album_title: row.get(4)?,
                duration_secs: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_auto_continue_track(&self, strategy: &str, current_track_id: i64) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();
        match strategy {
            "random" => {
                let sql = format!("{} WHERE t.id != ?1 AND t.deleted = 0 {} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
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
                        let sql = format!("{} WHERE t.id != ?1 AND t.artist_id = ?2 AND t.deleted = 0 {} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
                        conn.query_row(&sql, params![current_track_id, aid], |row| track_from_row(row)).optional()
                    }
                    None => Ok(None),
                }
            }
            "same_tag" => {
                let sql = format!(
                    "{} WHERE t.id != ?1 AND t.deleted = 0 {} AND t.id IN (\
                        SELECT tt2.track_id FROM track_tags tt1 \
                        JOIN track_tags tt2 ON tt1.tag_id = tt2.tag_id \
                        WHERE tt1.track_id = ?1 AND tt2.track_id != ?1\
                    ) ORDER BY RANDOM() LIMIT 1",
                    TRACK_SELECT, ENABLED_COLLECTION_FILTER
                );
                conn.query_row(&sql, params![current_track_id], |row| track_from_row(row)).optional()
            }
            "most_played" => {
                let sql = format!(
                    "{} WHERE t.id != ?1 AND t.deleted = 0 {} AND t.id IN (\
                        SELECT track_id FROM play_history \
                        GROUP BY track_id ORDER BY COUNT(*) DESC LIMIT 50\
                    ) ORDER BY RANDOM() LIMIT 1",
                    TRACK_SELECT, ENABLED_COLLECTION_FILTER
                );
                conn.query_row(&sql, params![current_track_id], |row| track_from_row(row)).optional()
            }
            "liked" => {
                let sql = format!("{} WHERE t.id != ?1 AND t.liked = 1 AND t.deleted = 0 {} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
                conn.query_row(&sql, params![current_track_id], |row| track_from_row(row)).optional()
            }
            _ => Ok(None),
        }
    }

    pub fn get_most_played_since(&self, since_ts: i64, limit: i64) -> SqlResult<Vec<MostPlayedTrack>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ph.track_id, COUNT(*) as play_count, t.title, ar.name, al.title, t.duration_secs
             FROM play_history ph
             JOIN tracks t ON t.id = ph.track_id
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
             WHERE ph.played_at >= ?1 AND t.deleted = 0
             GROUP BY ph.track_id
             ORDER BY play_count DESC
             LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![since_ts, limit], |row| {
            Ok(MostPlayedTrack {
                track_id: row.get(0)?,
                play_count: row.get(1)?,
                track_title: row.get(2)?,
                artist_name: row.get(3)?,
                album_title: row.get(4)?,
                duration_secs: row.get(5)?,
            })
        })?;
        rows.collect()
    }
}
