use rusqlite::{params, Connection, Result as SqlResult};
use rusqlite::functions::FunctionFlags;
use std::path::Path;
use std::sync::Mutex;

use crate::models::*;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(app_dir: &Path) -> SqlResult<Self> {
        std::fs::create_dir_all(app_dir).ok();
        let db_path = app_dir.join("fastplayer.db");
        let mut conn = Connection::open(db_path)?;

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

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_tables()?;
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

            CREATE TABLE IF NOT EXISTS genres (
                id   INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS tracks (
                id            INTEGER PRIMARY KEY,
                path          TEXT NOT NULL UNIQUE,
                title         TEXT NOT NULL,
                artist_id     INTEGER REFERENCES artists(id),
                album_id      INTEGER REFERENCES albums(id),
                genre_id      INTEGER REFERENCES genres(id),
                track_number  INTEGER,
                duration_secs REAL,
                format        TEXT,
                file_size     INTEGER,
                modified_at   INTEGER,
                added_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );

            CREATE TABLE IF NOT EXISTS folders (
                id              INTEGER PRIMARY KEY,
                path            TEXT NOT NULL UNIQUE,
                last_scanned_at INTEGER
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
                title,
                artist_name,
                album_title,
                genre_name,
                filename,
                content='',
                tokenize='unicode61'
            );
            ",
        )?;
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
        let mut stmt = conn.prepare("SELECT id, name FROM artists ORDER BY name")?;
        let rows = stmt.query_map([], |row| {
            Ok(Artist {
                id: row.get(0)?,
                name: row.get(1)?,
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
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id WHERE a.artist_id = ?1 ORDER BY a.year, a.title"
            )?;
            let rows = stmt.query_map(params![aid], |row| {
                Ok(Album { id: row.get(0)?, title: row.get(1)?, artist_id: row.get(2)?, artist_name: row.get(3)?, year: row.get(4)? })
            })?;
            rows.collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year FROM albums a LEFT JOIN artists ar ON a.artist_id = ar.id ORDER BY a.title"
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(Album { id: row.get(0)?, title: row.get(1)?, artist_id: row.get(2)?, artist_name: row.get(3)?, year: row.get(4)? })
            })?;
            rows.collect()
        }
    }

    // --- Genres ---

    pub fn get_or_create_genre(&self, name: &str) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO genres (name) VALUES (?1)",
            params![name],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM genres WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    // --- Tracks ---

    pub fn upsert_track(
        &self,
        path: &str,
        title: &str,
        artist_id: Option<i64>,
        album_id: Option<i64>,
        genre_id: Option<i64>,
        track_number: Option<i32>,
        duration_secs: Option<f64>,
        format: Option<&str>,
        file_size: Option<i64>,
        modified_at: Option<i64>,
    ) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tracks (path, title, artist_id, album_id, genre_id, track_number, duration_secs, format, file_size, modified_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(path) DO UPDATE SET
                title=excluded.title, artist_id=excluded.artist_id, album_id=excluded.album_id,
                genre_id=excluded.genre_id, track_number=excluded.track_number,
                duration_secs=excluded.duration_secs, format=excluded.format,
                file_size=excluded.file_size, modified_at=excluded.modified_at",
            params![path, title, artist_id, album_id, genre_id, track_number, duration_secs, format, file_size, modified_at],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM tracks WHERE path = ?1",
            params![path],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    pub fn index_track_fts(
        &self,
        track_id: i64,
        title: &str,
        artist_name: &str,
        album_title: &str,
        genre_name: &str,
        filename: &str,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, genre_name, filename)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(rowid) DO UPDATE SET
                title=excluded.title, artist_name=excluded.artist_name,
                album_title=excluded.album_title, genre_name=excluded.genre_name,
                filename=excluded.filename",
            params![track_id, title, artist_name, album_title, genre_name, filename],
        )?;
        Ok(())
    }

    pub fn rebuild_fts(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM tracks_fts;")?;
        conn.execute_batch(
            "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, genre_name, filename)
             SELECT t.id, t.title, COALESCE(ar.name, ''), COALESCE(al.title, ''), COALESCE(g.name, ''),
                    filename_from_path(t.path)
             FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
             LEFT JOIN genres g ON t.genre_id = g.id;",
        )?;
        Ok(())
    }

    pub fn get_tracks(&self, album_id: Option<i64>) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        if let Some(aid) = album_id {
            let mut stmt = conn.prepare(
                "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, t.genre_id, g.name, t.track_number, t.duration_secs, t.format, t.file_size
                 FROM tracks t LEFT JOIN artists ar ON t.artist_id = ar.id LEFT JOIN albums al ON t.album_id = al.id LEFT JOIN genres g ON t.genre_id = g.id
                 WHERE t.album_id = ?1 ORDER BY t.track_number, t.title"
            )?;
            let rows = stmt.query_map(params![aid], |row| {
                Ok(Track { id: row.get(0)?, path: row.get(1)?, title: row.get(2)?, artist_id: row.get(3)?, artist_name: row.get(4)?, album_id: row.get(5)?, album_title: row.get(6)?, genre_id: row.get(7)?, genre_name: row.get(8)?, track_number: row.get(9)?, duration_secs: row.get(10)?, format: row.get(11)?, file_size: row.get(12)? })
            })?;
            rows.collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, t.genre_id, g.name, t.track_number, t.duration_secs, t.format, t.file_size
                 FROM tracks t LEFT JOIN artists ar ON t.artist_id = ar.id LEFT JOIN albums al ON t.album_id = al.id LEFT JOIN genres g ON t.genre_id = g.id
                 ORDER BY ar.name, al.title, t.track_number, t.title"
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(Track { id: row.get(0)?, path: row.get(1)?, title: row.get(2)?, artist_id: row.get(3)?, artist_name: row.get(4)?, album_id: row.get(5)?, album_title: row.get(6)?, genre_id: row.get(7)?, genre_name: row.get(8)?, track_number: row.get(9)?, duration_secs: row.get(10)?, format: row.get(11)?, file_size: row.get(12)? })
            })?;
            rows.collect()
        }
    }

    pub fn get_tracks_by_artist(&self, artist_id: i64) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, t.genre_id, g.name, t.track_number, t.duration_secs, t.format, t.file_size
             FROM tracks t LEFT JOIN artists ar ON t.artist_id = ar.id LEFT JOIN albums al ON t.album_id = al.id LEFT JOIN genres g ON t.genre_id = g.id
             WHERE t.artist_id = ?1 ORDER BY al.title, t.track_number, t.title"
        )?;
        let rows = stmt.query_map(params![artist_id], |row| {
            Ok(Track { id: row.get(0)?, path: row.get(1)?, title: row.get(2)?, artist_id: row.get(3)?, artist_name: row.get(4)?, album_id: row.get(5)?, album_title: row.get(6)?, genre_id: row.get(7)?, genre_name: row.get(8)?, track_number: row.get(9)?, duration_secs: row.get(10)?, format: row.get(11)?, file_size: row.get(12)? })
        })?;
        rows.collect()
    }

    pub fn get_track_by_id(&self, track_id: i64) -> SqlResult<Track> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, t.genre_id, g.name, t.track_number, t.duration_secs, t.format, t.file_size
             FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
             LEFT JOIN genres g ON t.genre_id = g.id
             WHERE t.id = ?1",
            params![track_id],
            |row| {
                Ok(Track {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    title: row.get(2)?,
                    artist_id: row.get(3)?,
                    artist_name: row.get(4)?,
                    album_id: row.get(5)?,
                    album_title: row.get(6)?,
                    genre_id: row.get(7)?,
                    genre_name: row.get(8)?,
                    track_number: row.get(9)?,
                    duration_secs: row.get(10)?,
                    format: row.get(11)?,
                    file_size: row.get(12)?,
                })
            },
        )
    }

    pub fn search_tracks(&self, query: &str) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let fts_query = query
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" ");
        let mut stmt = conn.prepare(
            "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, t.genre_id, g.name, t.track_number, t.duration_secs, t.format, t.file_size
             FROM tracks_fts fts
             JOIN tracks t ON fts.rowid = t.id
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
             LEFT JOIN genres g ON t.genre_id = g.id
             WHERE tracks_fts MATCH ?1
             LIMIT 100",
        )?;
        let rows = stmt.query_map(params![fts_query], |row| {
            Ok(Track {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                artist_id: row.get(3)?,
                artist_name: row.get(4)?,
                album_id: row.get(5)?,
                album_title: row.get(6)?,
                genre_id: row.get(7)?,
                genre_name: row.get(8)?,
                track_number: row.get(9)?,
                duration_secs: row.get(10)?,
                format: row.get(11)?,
                file_size: row.get(12)?,
            })
        })?;
        rows.collect()
    }

    // --- Folders ---

    pub fn add_folder(&self, path: &str) -> SqlResult<FolderInfo> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO folders (path) VALUES (?1)",
            params![path],
        )?;
        conn.query_row(
            "SELECT id, path, last_scanned_at FROM folders WHERE path = ?1",
            params![path],
            |row| {
                Ok(FolderInfo {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    last_scanned_at: row.get(2)?,
                })
            },
        )
    }

    pub fn remove_folder(&self, folder_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let folder_path: String = conn.query_row(
            "SELECT path FROM folders WHERE id = ?1",
            params![folder_id],
            |row| row.get(0),
        )?;
        // Delete tracks whose path starts with this folder
        conn.execute(
            "DELETE FROM tracks WHERE path LIKE ?1 || '%'",
            params![folder_path],
        )?;
        conn.execute("DELETE FROM folders WHERE id = ?1", params![folder_id])?;
        // Clean up orphaned artists, albums, genres
        conn.execute_batch(
            "DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL);
             DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL)
                                   AND id NOT IN (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL);
             DELETE FROM genres WHERE id NOT IN (SELECT DISTINCT genre_id FROM tracks WHERE genre_id IS NOT NULL);",
        )?;
        Ok(())
    }

    pub fn get_folders(&self) -> SqlResult<Vec<FolderInfo>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id, path, last_scanned_at FROM folders ORDER BY path")?;
        let rows = stmt.query_map([], |row| {
            Ok(FolderInfo {
                id: row.get(0)?,
                path: row.get(1)?,
                last_scanned_at: row.get(2)?,
            })
        })?;
        rows.collect()
    }

    pub fn update_folder_scanned(&self, folder_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE folders SET last_scanned_at = strftime('%s', 'now') WHERE id = ?1",
            params![folder_id],
        )?;
        Ok(())
    }

    pub fn remove_track_by_path(&self, path: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tracks WHERE path = ?1", params![path])?;
        Ok(())
    }
}
