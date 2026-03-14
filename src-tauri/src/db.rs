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
    "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, \
     t.track_number, t.duration_secs, t.format, t.file_size, t.collection_id, t.subsonic_id, t.liked, t.deleted \
     FROM tracks t LEFT JOIN artists ar ON t.artist_id = ar.id LEFT JOIN albums al ON t.album_id = al.id";

fn track_from_row(row: &rusqlite::Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get(0)?,
        path: row.get(1)?,
        title: row.get(2)?,
        artist_id: row.get(3)?,
        artist_name: row.get(4)?,
        album_id: row.get(5)?,
        album_title: row.get(6)?,
        track_number: row.get(7)?,
        duration_secs: row.get(8)?,
        format: row.get(9)?,
        file_size: row.get(10)?,
        collection_id: row.get(11)?,
        subsonic_id: row.get(12)?,
        liked: row.get::<_, i32>(13).unwrap_or(0) != 0,
        deleted: row.get::<_, i32>(14).unwrap_or(0) != 0,
    })
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(app_dir: &Path) -> SqlResult<Self> {
        std::fs::create_dir_all(app_dir).ok();
        let db_path = app_dir.join("fastplayer.db");
        let conn = Connection::open(db_path)?;

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

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_tables()?;
        db.migrate()?;
        Ok(db)
    }

    fn init_tables(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS artists (
                id   INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS albums (
                id        INTEGER PRIMARY KEY,
                title     TEXT NOT NULL,
                artist_id INTEGER REFERENCES artists(id),
                year      INTEGER,
                UNIQUE(title, artist_id)
            );

            CREATE TABLE IF NOT EXISTS tags (
                id   INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS collections (
                id              INTEGER PRIMARY KEY,
                kind            TEXT NOT NULL,
                name            TEXT NOT NULL,
                path            TEXT,
                url             TEXT,
                username        TEXT,
                password_token  TEXT,
                salt            TEXT,
                auth_method     TEXT DEFAULT 'token',
                last_synced_at  INTEGER
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
            ",
        )?;
        Ok(())
    }

    fn migrate(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        // Migrate from old folders table if it exists
        let has_folders: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='folders'",
            [],
            |row| row.get(0),
        )?;

        if has_folders {
            // Migrate folder rows into collections
            conn.execute_batch(
                "INSERT INTO collections (kind, name, path)
                 SELECT 'local',
                        CASE
                            WHEN INSTR(path, '/') > 0 THEN SUBSTR(path, LENGTH(path) - LENGTH(REPLACE(SUBSTR(path, 1, LENGTH(path) - (CASE WHEN SUBSTR(path, LENGTH(path), 1) = '/' THEN 1 ELSE 0 END)), '/', '')) + 1)
                            ELSE path
                        END,
                        path
                 FROM folders;"
            )?;

            // Check if tracks already has collection_id column
            let has_collection_id: bool = conn.query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('tracks') WHERE name='collection_id'",
                [],
                |row| row.get(0),
            )?;

            if !has_collection_id {
                conn.execute_batch("ALTER TABLE tracks ADD COLUMN collection_id INTEGER REFERENCES collections(id);")?;
                conn.execute_batch("ALTER TABLE tracks ADD COLUMN subsonic_id TEXT;")?;
            }

            // Update existing tracks' collection_id by matching path prefix
            conn.execute_batch(
                "UPDATE tracks SET collection_id = (
                    SELECT c.id FROM collections c
                    WHERE c.kind = 'local' AND tracks.path LIKE c.path || '%'
                    LIMIT 1
                ) WHERE collection_id IS NULL;"
            )?;

            conn.execute_batch("DROP TABLE folders;")?;
        } else {
            // Ensure collection_id and subsonic_id columns exist (for fresh installs the CREATE TABLE already has them)
            let has_collection_id: bool = conn.query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('tracks') WHERE name='collection_id'",
                [],
                |row| row.get(0),
            )?;
            if !has_collection_id {
                conn.execute_batch("ALTER TABLE tracks ADD COLUMN collection_id INTEGER REFERENCES collections(id);")?;
                conn.execute_batch("ALTER TABLE tracks ADD COLUMN subsonic_id TEXT;")?;
            }
        }

        // Add liked column if missing
        let has_liked: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('tracks') WHERE name='liked'",
            [],
            |row| row.get(0),
        )?;
        if !has_liked {
            conn.execute_batch("ALTER TABLE tracks ADD COLUMN liked INTEGER NOT NULL DEFAULT 0;")?;
        }

        // Add deleted column if missing
        let has_deleted: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('tracks') WHERE name='deleted'",
            [],
            |row| row.get(0),
        )?;
        if !has_deleted {
            conn.execute_batch("ALTER TABLE tracks ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;")?;
        }

        // Add liked column to artists if missing
        let has_artist_liked: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('artists') WHERE name='liked'",
            [],
            |row| row.get(0),
        )?;
        if !has_artist_liked {
            conn.execute_batch("ALTER TABLE artists ADD COLUMN liked INTEGER NOT NULL DEFAULT 0;")?;
        }

        // Add liked column to albums if missing
        let has_album_liked: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('albums') WHERE name='liked'",
            [],
            |row| row.get(0),
        )?;
        if !has_album_liked {
            conn.execute_batch("ALTER TABLE albums ADD COLUMN liked INTEGER NOT NULL DEFAULT 0;")?;
        }

        Ok(())
    }

    // --- Artists ---

    pub fn get_or_create_artist(&self, name: &str) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO artists (name) VALUES (?1)",
            params![name],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM artists WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    pub fn get_artists(&self) -> SqlResult<Vec<Artist>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT a.id, a.name, COUNT(t.id), a.liked
             FROM artists a
             LEFT JOIN tracks t ON t.artist_id = a.id AND t.deleted = 0
             GROUP BY a.id
             ORDER BY a.name"
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
        conn.execute(
            "INSERT OR IGNORE INTO albums (title, artist_id, year) VALUES (?1, ?2, ?3)",
            params![title, artist_id, year],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM albums WHERE title = ?1 AND (artist_id = ?2 OR (?2 IS NULL AND artist_id IS NULL))",
            params![title, artist_id],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    pub fn get_albums(&self, artist_id: Option<i64>) -> SqlResult<Vec<Album>> {
        let conn = self.conn.lock().unwrap();
        if let Some(aid) = artist_id {
            let mut stmt = conn.prepare(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, COUNT(t.id), a.liked
                 FROM albums a
                 LEFT JOIN artists ar ON a.artist_id = ar.id
                 LEFT JOIN tracks t ON t.album_id = a.id AND t.deleted = 0
                 WHERE a.artist_id = ?1
                 GROUP BY a.id
                 ORDER BY a.year, a.title"
            )?;
            let rows = stmt.query_map(params![aid], |row| {
                Ok(Album { id: row.get(0)?, title: row.get(1)?, artist_id: row.get(2)?, artist_name: row.get(3)?, year: row.get(4)?, track_count: row.get(5)?, liked: row.get::<_, i32>(6).unwrap_or(0) != 0 })
            })?;
            rows.collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, COUNT(t.id), a.liked
                 FROM albums a
                 LEFT JOIN artists ar ON a.artist_id = ar.id
                 LEFT JOIN tracks t ON t.album_id = a.id AND t.deleted = 0
                 GROUP BY a.id
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
        conn.execute(
            "INSERT OR IGNORE INTO tags (name) VALUES (?1)",
            params![name],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM tags WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )?;
        Ok(id)
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
            "SELECT tg.id, tg.name, COUNT(t.id)
             FROM tags tg
             LEFT JOIN track_tags tt ON tt.tag_id = tg.id
             LEFT JOIN tracks t ON t.id = tt.track_id AND t.deleted = 0
             GROUP BY tg.id
             ORDER BY tg.name"
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
            "{} JOIN track_tags tt ON tt.track_id = t.id WHERE tt.tag_id = ?1 AND t.deleted = 0 ORDER BY ar.name, al.title, t.track_number, t.title",
            TRACK_SELECT
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![tag_id], |row| track_from_row(row))?;
        rows.collect()
    }

    // --- Tracks ---

    pub fn get_track_count(&self) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM tracks WHERE deleted = 0", [], |row| row.get(0))
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
            "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, filename)
             SELECT t.id, strip_diacritics(t.title), strip_diacritics(COALESCE(ar.name, '')), strip_diacritics(COALESCE(al.title, '')),
                    strip_diacritics(COALESCE((SELECT GROUP_CONCAT(tg.name, ' ') FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.track_id = t.id), '')),
                    strip_diacritics(filename_from_path(t.path))
             FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
             WHERE t.deleted = 0;",
        )?;
        Ok(())
    }

    pub fn get_tracks(&self, album_id: Option<i64>) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        if let Some(aid) = album_id {
            let sql = format!("{} WHERE t.album_id = ?1 AND t.deleted = 0 ORDER BY t.track_number, t.title", TRACK_SELECT);
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![aid], |row| track_from_row(row))?;
            rows.collect()
        } else {
            let sql = format!("{} WHERE t.deleted = 0 ORDER BY ar.name, al.title, t.track_number, t.title LIMIT 100", TRACK_SELECT);
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([], |row| track_from_row(row))?;
            rows.collect()
        }
    }

    pub fn get_tracks_by_artist(&self, artist_id: i64) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{} WHERE t.artist_id = ?1 AND t.deleted = 0 ORDER BY al.title, t.track_number, t.title", TRACK_SELECT);
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
            "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, \
             t.track_number, t.duration_secs, t.format, t.file_size, t.collection_id, t.subsonic_id, t.liked \
             FROM tracks_fts fts \
             JOIN tracks t ON fts.rowid = t.id \
             LEFT JOIN artists ar ON t.artist_id = ar.id \
             LEFT JOIN albums al ON t.album_id = al.id"
        );

        if tag_id.is_some() {
            sql.push_str(" JOIN track_tags tt ON tt.track_id = t.id");
        }

        sql.push_str(" WHERE tracks_fts MATCH ?1 AND t.deleted = 0");

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
            "SELECT id, kind, name, path, url, username, last_synced_at FROM collections ORDER BY name"
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
            })
        })?;
        rows.collect()
    }

    pub fn get_collection_by_id(&self, collection_id: i64) -> SqlResult<Collection> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, kind, name, path, url, username, last_synced_at FROM collections WHERE id = ?1",
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

    pub fn update_collection_synced(&self, collection_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE collections SET last_synced_at = strftime('%s', 'now') WHERE id = ?1",
            params![collection_id],
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
        let sql = format!("{} WHERE t.liked = 1 AND t.deleted = 0 ORDER BY ar.name, al.title, t.track_number, t.title", TRACK_SELECT);
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
                let sql = format!("{} WHERE t.id != ?1 AND t.deleted = 0 ORDER BY RANDOM() LIMIT 1", TRACK_SELECT);
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
                        let sql = format!("{} WHERE t.id != ?1 AND t.artist_id = ?2 AND t.deleted = 0 ORDER BY RANDOM() LIMIT 1", TRACK_SELECT);
                        conn.query_row(&sql, params![current_track_id, aid], |row| track_from_row(row)).optional()
                    }
                    None => Ok(None),
                }
            }
            "same_tag" => {
                let sql = format!(
                    "{} WHERE t.id != ?1 AND t.deleted = 0 AND t.id IN (\
                        SELECT tt2.track_id FROM track_tags tt1 \
                        JOIN track_tags tt2 ON tt1.tag_id = tt2.tag_id \
                        WHERE tt1.track_id = ?1 AND tt2.track_id != ?1\
                    ) ORDER BY RANDOM() LIMIT 1",
                    TRACK_SELECT
                );
                conn.query_row(&sql, params![current_track_id], |row| track_from_row(row)).optional()
            }
            "most_played" => {
                let sql = format!(
                    "{} WHERE t.id != ?1 AND t.deleted = 0 AND t.id IN (\
                        SELECT track_id FROM play_history \
                        GROUP BY track_id ORDER BY COUNT(*) DESC LIMIT 50\
                    ) ORDER BY RANDOM() LIMIT 1",
                    TRACK_SELECT
                );
                conn.query_row(&sql, params![current_track_id], |row| track_from_row(row)).optional()
            }
            "liked" => {
                let sql = format!("{} WHERE t.id != ?1 AND t.liked = 1 AND t.deleted = 0 ORDER BY RANDOM() LIMIT 1", TRACK_SELECT);
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
