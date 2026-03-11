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

            CREATE TABLE IF NOT EXISTS tags (
                id   INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
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
                added_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );

            CREATE TABLE IF NOT EXISTS track_tags (
                track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
                tag_id   INTEGER REFERENCES tags(id) ON DELETE CASCADE,
                UNIQUE(track_id, tag_id)
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
                tag_names,
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
        let mut stmt = conn.prepare(
            "SELECT a.id, a.name, COUNT(t.id)
             FROM artists a
             LEFT JOIN tracks t ON t.artist_id = a.id
             GROUP BY a.id
             ORDER BY a.name"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Artist {
                id: row.get(0)?,
                name: row.get(1)?,
                track_count: row.get(2)?,
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
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, COUNT(t.id)
                 FROM albums a
                 LEFT JOIN artists ar ON a.artist_id = ar.id
                 LEFT JOIN tracks t ON t.album_id = a.id
                 WHERE a.artist_id = ?1
                 GROUP BY a.id
                 ORDER BY a.year, a.title"
            )?;
            let rows = stmt.query_map(params![aid], |row| {
                Ok(Album { id: row.get(0)?, title: row.get(1)?, artist_id: row.get(2)?, artist_name: row.get(3)?, year: row.get(4)?, track_count: row.get(5)? })
            })?;
            rows.collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT a.id, a.title, a.artist_id, ar.name, a.year, COUNT(t.id)
                 FROM albums a
                 LEFT JOIN artists ar ON a.artist_id = ar.id
                 LEFT JOIN tracks t ON t.album_id = a.id
                 GROUP BY a.id
                 ORDER BY a.title"
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(Album { id: row.get(0)?, title: row.get(1)?, artist_id: row.get(2)?, artist_name: row.get(3)?, year: row.get(4)?, track_count: row.get(5)? })
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
            "SELECT tg.id, tg.name, COUNT(tt.track_id)
             FROM tags tg
             LEFT JOIN track_tags tt ON tt.tag_id = tg.id
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
            "SELECT tg.id, tg.name, COUNT(tt2.track_id)
             FROM tags tg
             JOIN track_tags tt ON tt.tag_id = tg.id
             LEFT JOIN track_tags tt2 ON tt2.tag_id = tg.id
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
        let mut stmt = conn.prepare(
            "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, t.track_number, t.duration_secs, t.format, t.file_size
             FROM tracks t
             JOIN track_tags tt ON tt.track_id = t.id
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
             WHERE tt.tag_id = ?1
             ORDER BY ar.name, al.title, t.track_number, t.title"
        )?;
        let rows = stmt.query_map(params![tag_id], |row| {
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
            })
        })?;
        rows.collect()
    }

    // --- Tracks ---

    pub fn get_track_count(&self) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
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
    ) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tracks (path, title, artist_id, album_id, track_number, duration_secs, format, file_size, modified_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(path) DO UPDATE SET
                title=excluded.title, artist_id=excluded.artist_id, album_id=excluded.album_id,
                track_number=excluded.track_number,
                duration_secs=excluded.duration_secs, format=excluded.format,
                file_size=excluded.file_size, modified_at=excluded.modified_at",
            params![path, title, artist_id, album_id, track_number, duration_secs, format, file_size, modified_at],
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
             DELETE FROM folders;
             DROP TABLE IF EXISTS tracks_fts;
             CREATE VIRTUAL TABLE tracks_fts USING fts5(
                 title,
                 artist_name,
                 album_title,
                 tag_names,
                 filename,
                 content='',
                 tokenize='unicode61'
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
                 tokenize='unicode61'
             );"
        )?;
        conn.execute_batch(
            "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, filename)
             SELECT t.id, t.title, COALESCE(ar.name, ''), COALESCE(al.title, ''),
                    COALESCE((SELECT GROUP_CONCAT(tg.name, ' ') FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.track_id = t.id), ''),
                    filename_from_path(t.path)
             FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id;",
        )?;
        Ok(())
    }

    pub fn get_tracks(&self, album_id: Option<i64>) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        if let Some(aid) = album_id {
            let mut stmt = conn.prepare(
                "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, t.track_number, t.duration_secs, t.format, t.file_size
                 FROM tracks t LEFT JOIN artists ar ON t.artist_id = ar.id LEFT JOIN albums al ON t.album_id = al.id
                 WHERE t.album_id = ?1 ORDER BY t.track_number, t.title"
            )?;
            let rows = stmt.query_map(params![aid], |row| {
                Ok(Track { id: row.get(0)?, path: row.get(1)?, title: row.get(2)?, artist_id: row.get(3)?, artist_name: row.get(4)?, album_id: row.get(5)?, album_title: row.get(6)?, track_number: row.get(7)?, duration_secs: row.get(8)?, format: row.get(9)?, file_size: row.get(10)? })
            })?;
            rows.collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, t.track_number, t.duration_secs, t.format, t.file_size
                 FROM tracks t LEFT JOIN artists ar ON t.artist_id = ar.id LEFT JOIN albums al ON t.album_id = al.id
                 ORDER BY ar.name, al.title, t.track_number, t.title
                 LIMIT 100"
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(Track { id: row.get(0)?, path: row.get(1)?, title: row.get(2)?, artist_id: row.get(3)?, artist_name: row.get(4)?, album_id: row.get(5)?, album_title: row.get(6)?, track_number: row.get(7)?, duration_secs: row.get(8)?, format: row.get(9)?, file_size: row.get(10)? })
            })?;
            rows.collect()
        }
    }

    pub fn get_tracks_by_artist(&self, artist_id: i64) -> SqlResult<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, t.track_number, t.duration_secs, t.format, t.file_size
             FROM tracks t LEFT JOIN artists ar ON t.artist_id = ar.id LEFT JOIN albums al ON t.album_id = al.id
             WHERE t.artist_id = ?1 ORDER BY al.title, t.track_number, t.title"
        )?;
        let rows = stmt.query_map(params![artist_id], |row| {
            Ok(Track { id: row.get(0)?, path: row.get(1)?, title: row.get(2)?, artist_id: row.get(3)?, artist_name: row.get(4)?, album_id: row.get(5)?, album_title: row.get(6)?, track_number: row.get(7)?, duration_secs: row.get(8)?, format: row.get(9)?, file_size: row.get(10)? })
        })?;
        rows.collect()
    }

    pub fn get_track_by_id(&self, track_id: i64) -> SqlResult<Track> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, t.track_number, t.duration_secs, t.format, t.file_size
             FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
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
                    track_number: row.get(7)?,
                    duration_secs: row.get(8)?,
                    format: row.get(9)?,
                    file_size: row.get(10)?,
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
            .join(" AND ");
        let mut stmt = conn.prepare(
            "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, t.track_number, t.duration_secs, t.format, t.file_size
             FROM tracks_fts fts
             JOIN tracks t ON fts.rowid = t.id
             LEFT JOIN artists ar ON t.artist_id = ar.id
             LEFT JOIN albums al ON t.album_id = al.id
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
                track_number: row.get(7)?,
                duration_secs: row.get(8)?,
                format: row.get(9)?,
                file_size: row.get(10)?,
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
        // Clean up orphaned artists, albums, tags
        conn.execute_batch(
            "DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL);
             DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL)
                                   AND id NOT IN (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL);
             DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM track_tags);",
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
