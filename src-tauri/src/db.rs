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
     t.track_number, t.duration_secs, t.format, t.file_size, t.collection_id, co.name, t.subsonic_id, t.liked, t.deleted, t.youtube_url, \
     t.added_at, t.modified_at \
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
        youtube_url: row.get(17)?,
        added_at: row.get(18)?,
        modified_at: row.get(19)?,
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
        liked: row.get::<_, i32>(6).unwrap_or(0) != 0,
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
        Some("year") => Some("COALESCE(al.year, 0)".to_string()),
        Some("quality") => Some("(CASE WHEN t.duration_secs > 0 AND t.file_size > 0 THEN t.file_size * 8.0 / t.duration_secs / 1000.0 ELSE 0 END)".to_string()),
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
            // Tables are created in init_tables() via CREATE IF NOT EXISTS.
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
            conn.execute("UPDATE db_version SET version = 6 WHERE rowid = 1", [])?;
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
                liked: row.get::<_, i32>(3).unwrap_or(0) != 0,
            })
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
                liked: row.get::<_, i32>(3).unwrap_or(0) != 0,
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
            let sql = format!("{} WHERE t.album_id = ?1 AND t.deleted = 0 {} ORDER BY t.track_number, t.title", TRACK_SELECT, ENABLED_COLLECTION_FILTER);
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
        let sql = format!("{} WHERE t.deleted = 0 {} {} {} {} LIMIT ?1 OFFSET ?2", TRACK_SELECT, ENABLED_COLLECTION_FILTER, youtube_filter, media_type_filter, order_by);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit, offset], |row| track_from_row(row))?;
        rows.collect()
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

    fn search_tracks_inner(&self, conn: &rusqlite::Connection, opts: &TrackQuery, query: &str) -> SqlResult<Vec<Track>> {
        let normalized = strip_diacritics(query);
        let fts_query = normalized
            .split_whitespace()
            .map(|w| format!("\"{}\"*", w.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" AND ");

        let mut sql = String::from(
            "SELECT t.id, t.path, t.title, t.artist_id, ar.name, t.album_id, al.title, al.year, \
             t.track_number, t.duration_secs, t.format, t.file_size, t.collection_id, co.name, t.subsonic_id, t.liked, t.deleted, t.youtube_url, \
             t.added_at, t.modified_at \
             FROM tracks_fts fts \
             JOIN tracks t ON fts.rowid = t.id \
             LEFT JOIN artists ar ON t.artist_id = ar.id \
             LEFT JOIN albums al ON t.album_id = al.id \
             LEFT JOIN collections co ON t.collection_id = co.id"
        );

        if opts.tag_id.is_some() {
            sql.push_str(" JOIN track_tags tt ON tt.track_id = t.id");
        }

        sql.push_str(" WHERE tracks_fts MATCH ?1 AND t.deleted = 0");
        sql.push_str(&format!(" {}", ENABLED_COLLECTION_FILTER));

        let mut param_idx = 2;
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

    pub fn soft_delete_tracks_by_ids(&self, ids: &[i64]) -> SqlResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        for chunk in ids.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("UPDATE tracks SET deleted = 1 WHERE id IN ({})", placeholders);
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::types::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
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

    pub fn get_track_modified_at_by_path(&self, path: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT modified_at FROM tracks WHERE path = ?1",
            params![path],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn get_local_track_paths_for_collection(&self, collection_id: i64) -> SqlResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path FROM tracks WHERE collection_id = ?1 AND subsonic_id IS NULL AND deleted = 0"
        )?;
        let rows = stmt.query_map(params![collection_id], |row| row.get(0))?;
        rows.collect()
    }

    pub fn remove_track_by_path(&self, path: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tracks WHERE path = ?1", params![path])?;
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

    pub fn toggle_liked(&self, table: &str, id: i64, liked: bool) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            &format!("UPDATE {} SET liked = ?2 WHERE id = ?1", table),
            params![id, liked as i32],
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
        let dominated: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM play_history
                WHERE track_id = ?1 AND played_at > strftime('%s', 'now') - 30
            )",
            params![track_id],
            |row| row.get(0),
        )?;
        if dominated {
            return Ok(());
        }
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

    pub fn get_auto_continue_track(&self, strategy: &str, current_track_id: i64, format_filter: Option<&str>) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();

        let format_clause = match format_filter {
            Some("video") => " AND LOWER(t.format) IN ('mp4','m4v','mov','webm')",
            Some("audio") => " AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))",
            _ => "",
        };

        match strategy {
            "random" => {
                let sql = format!("{} WHERE t.id != ?1 AND t.deleted = 0 {}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause);
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
                        let sql = format!("{} WHERE t.id != ?1 AND t.artist_id = ?2 AND t.deleted = 0 {}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause);
                        conn.query_row(&sql, params![current_track_id, aid], |row| track_from_row(row)).optional()
                    }
                    None => Ok(None),
                }
            }
            "same_tag" => {
                let sql = format!(
                    "{} WHERE t.id != ?1 AND t.deleted = 0 {}{} AND t.id IN (\
                        SELECT tt2.track_id FROM track_tags tt1 \
                        JOIN track_tags tt2 ON tt1.tag_id = tt2.tag_id \
                        WHERE tt1.track_id = ?1 AND tt2.track_id != ?1\
                    ) ORDER BY RANDOM() LIMIT 1",
                    TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause
                );
                conn.query_row(&sql, params![current_track_id], |row| track_from_row(row)).optional()
            }
            "most_played" => {
                let sql = format!(
                    "{} WHERE t.id != ?1 AND t.deleted = 0 {}{} AND t.id IN (\
                        SELECT sub_t.id FROM history_tracks ht \
                        JOIN history_artists ha ON ha.id = ht.history_artist_id \
                        JOIN tracks sub_t ON strip_diacritics(unicode_lower(sub_t.title)) = ht.canonical_title \
                        LEFT JOIN artists sub_ar ON sub_t.artist_id = sub_ar.id \
                        WHERE strip_diacritics(unicode_lower(COALESCE(sub_ar.name, ''))) = ha.canonical_name \
                        AND sub_t.deleted = 0 \
                        ORDER BY ht.play_count DESC LIMIT 50\
                    ) ORDER BY RANDOM() LIMIT 1",
                    TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause
                );
                conn.query_row(&sql, params![current_track_id], |row| track_from_row(row)).optional()
            }
            "liked" => {
                let sql = format!("{} WHERE t.id != ?1 AND t.liked = 1 AND t.deleted = 0 {}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause);
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

    // --- Decoupled history ---

    pub fn record_history_play(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        // Fetch track metadata
        let (title, artist_name): (String, Option<String>) = conn.query_row(
            "SELECT t.title, ar.name FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             WHERE t.id = ?1",
            params![track_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let canonical_artist = strip_diacritics(&artist_name.as_deref().unwrap_or("").to_lowercase());
        let canonical_title = strip_diacritics(&title.to_lowercase());

        // Dedup: skip if same canonical key played within 30 seconds
        let dominated: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM history_plays hp
                JOIN history_tracks ht ON ht.id = hp.history_track_id
                JOIN history_artists ha ON ha.id = ht.history_artist_id
                WHERE ha.canonical_name = ?1 AND ht.canonical_title = ?2
                AND hp.played_at > strftime('%s', 'now') - 30
            )",
            params![canonical_artist, canonical_title],
            |row| row.get(0),
        )?;
        if dominated {
            return Ok(());
        }

        // Upsert history_artists
        conn.execute(
            "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
             VALUES (?1, ?2, strftime('%s', 'now'), strftime('%s', 'now'), 0)
             ON CONFLICT(canonical_name) DO UPDATE SET
               display_name = excluded.display_name",
            params![canonical_artist, artist_name],
        )?;
        let history_artist_id: i64 = conn.query_row(
            "SELECT id FROM history_artists WHERE canonical_name = ?1",
            params![canonical_artist],
            |row| row.get(0),
        )?;

        // Upsert history_tracks
        conn.execute(
            "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count)
             VALUES (?1, ?2, ?3, strftime('%s', 'now'), strftime('%s', 'now'), 0)
             ON CONFLICT(history_artist_id, canonical_title) DO UPDATE SET
               display_title = excluded.display_title",
            params![history_artist_id, canonical_title, title],
        )?;
        let history_track_id: i64 = conn.query_row(
            "SELECT id FROM history_tracks WHERE history_artist_id = ?1 AND canonical_title = ?2",
            params![history_artist_id, canonical_title],
            |row| row.get(0),
        )?;

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

    pub fn get_history_recent(&self, limit: i64) -> SqlResult<Vec<HistoryEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT hp.id, ht.id, hp.played_at, ht.display_title, ha.display_name,
                    ht.play_count,
                    (SELECT t.id FROM tracks t
                     LEFT JOIN artists ar ON t.artist_id = ar.id
                     WHERE strip_diacritics(unicode_lower(t.title)) = ht.canonical_title
                     AND strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) = ha.canonical_name
                     AND t.deleted = 0 LIMIT 1) as library_track_id
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
            "SELECT ht.id, ht.play_count, ht.display_title, ha.display_name,
                    (SELECT t.id FROM tracks t
                     LEFT JOIN artists ar ON t.artist_id = ar.id
                     WHERE strip_diacritics(unicode_lower(t.title)) = ht.canonical_title
                     AND strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) = ha.canonical_name
                     AND t.deleted = 0 LIMIT 1) as library_track_id
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
            })
        })?;
        rows.collect()
    }

    pub fn get_history_most_played_since(&self, since_ts: i64, limit: i64) -> SqlResult<Vec<HistoryMostPlayed>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ht.id, COUNT(*) as cnt, ht.display_title, ha.display_name,
                    (SELECT t.id FROM tracks t
                     LEFT JOIN artists ar ON t.artist_id = ar.id
                     WHERE strip_diacritics(unicode_lower(t.title)) = ht.canonical_title
                     AND strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) = ha.canonical_name
                     AND t.deleted = 0 LIMIT 1) as library_track_id
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
            })
        })?;
        rows.collect()
    }

    pub fn get_history_most_played_artists(&self, limit: i64) -> SqlResult<Vec<HistoryArtistStats>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ha.id, ha.play_count,
                    (SELECT COUNT(*) FROM history_tracks ht WHERE ht.history_artist_id = ha.id) as track_count,
                    ha.display_name,
                    (SELECT a.id FROM artists a
                     WHERE strip_diacritics(unicode_lower(a.name)) = ha.canonical_name
                     LIMIT 1) as library_artist_id
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
            })
        })?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        Database::new_in_memory().expect("Failed to create in-memory database")
    }

    /// Helper: insert a track and return its id
    fn insert_track(db: &Database, path: &str, title: &str, artist_id: Option<i64>, album_id: Option<i64>) -> i64 {
        db.upsert_track(path, title, artist_id, album_id, None, Some(180.0), Some("mp3"), Some(5_000_000), None, None, None)
            .expect("upsert_track failed")
    }

    #[test]
    fn test_upsert_and_get_track() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Pink Floyd").unwrap();
        let album_id = db.get_or_create_album("Dark Side", Some(artist_id), Some(1973)).unwrap();
        let track_id = db.upsert_track(
            "/music/time.mp3", "Time", Some(artist_id), Some(album_id),
            Some(4), Some(413.0), Some("mp3"), Some(10_000_000), None, None, None,
        ).unwrap();

        let track = db.get_track_by_id(track_id).unwrap();
        assert_eq!(track.title, "Time");
        assert_eq!(track.artist_name.as_deref(), Some("Pink Floyd"));
        assert_eq!(track.album_title.as_deref(), Some("Dark Side"));
        assert_eq!(track.track_number, Some(4));
        assert_eq!(track.duration_secs, Some(413.0));
        assert_eq!(track.format.as_deref(), Some("mp3"));
        assert_eq!(track.year, Some(1973));
        assert!(!track.liked);
        assert!(!track.deleted);
    }

    #[test]
    fn test_upsert_track_deduplication() {
        let db = test_db();
        let id1 = insert_track(&db, "/music/song.mp3", "Song V1", None, None);
        let id2 = db.upsert_track(
            "/music/song.mp3", "Song V2", None, None,
            None, Some(200.0), Some("mp3"), None, None, None, None,
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
        let track_id = insert_track(&db, "/music/song.mp3", "Song", None, None);
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
        insert_track(&db, "/music/time.mp3", "Time", Some(artist_id), Some(album_id));
        insert_track(&db, "/music/money.mp3", "Money", Some(artist_id), Some(album_id));
        insert_track(&db, "/music/creep.mp3", "Creep", None, None);

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

        let t1 = insert_track(&db, "/a1.mp3", "Song Alpha", Some(artist1), Some(album1));
        insert_track(&db, "/a2.mp3", "Song Alpha Two", Some(artist2), None);
        db.add_track_tag(t1, tag_rock).unwrap();
        db.toggle_liked("tracks", t1, true).unwrap();

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
        let t1 = insert_track(&db, "/a.mp3", "Song A", None, None);
        let t2 = insert_track(&db, "/b.mp3", "Song B", None, None);

        db.record_play(t1).unwrap();
        db.record_play(t1).unwrap(); // deduplicated (same track within 30s)
        db.record_play(t2).unwrap();

        let recent = db.get_recent_plays(10).unwrap();
        assert_eq!(recent.len(), 2); // was 3, now 2 due to dedup
        let t1_plays = recent.iter().filter(|r| r.track_id == t1).count();
        let t2_plays = recent.iter().filter(|r| r.track_id == t2).count();
        assert_eq!(t1_plays, 1); // was 2, now 1 due to dedup
        assert_eq!(t2_plays, 1);

        let most = db.get_most_played(10).unwrap();
        assert_eq!(most.len(), 2);
        // Both have 1 play each now, order may vary
        assert!(most.iter().all(|m| m.play_count == 1));
    }

    #[test]
    fn test_play_history_dedup() {
        let db = test_db();
        let t1 = insert_track(&db, "/a.mp3", "Song A", None, None);
        let t2 = insert_track(&db, "/b.mp3", "Song B", None, None);

        // Same track twice in quick succession → deduplicated
        db.record_play(t1).unwrap();
        db.record_play(t1).unwrap();
        let recent = db.get_recent_plays(10).unwrap();
        assert_eq!(recent.iter().filter(|r| r.track_id == t1).count(), 1);

        // Different tracks are NOT deduplicated
        db.record_play(t2).unwrap();
        let recent = db.get_recent_plays(10).unwrap();
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
        let track_id = insert_track(&db, "/music/creep.mp3", "Creep", Some(artist_id), None);

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
        let track_id = insert_track(&db, "/music/smells.mp3", "Smells Like Teen Spirit", Some(artist_id), None);

        db.record_history_play(track_id).unwrap();

        // Soft-delete the track
        db.soft_delete_tracks_by_ids(&[track_id]).unwrap();

        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].display_title, "Smells Like Teen Spirit");
        assert!(recent[0].library_track_id.is_none(), "should be ghost after deletion");
    }

    #[test]
    fn test_history_reconnect() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Björk").unwrap();
        let track_id = insert_track(&db, "/music/army.mp3", "Army of Me", Some(artist_id), None);

        db.record_history_play(track_id).unwrap();
        db.soft_delete_tracks_by_ids(&[track_id]).unwrap();

        // Verify ghost
        let recent = db.get_history_recent(10).unwrap();
        assert!(recent[0].library_track_id.is_none());

        // Re-add with same artist+title but different path
        let artist_id2 = db.get_or_create_artist("Björk").unwrap();
        let track_id2 = insert_track(&db, "/new_music/army.mp3", "Army of Me", Some(artist_id2), None);

        // Should reconnect
        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent[0].library_track_id, Some(track_id2));
        assert_eq!(recent[0].play_count, 1);
    }

    #[test]
    fn test_history_dedup() {
        let db = test_db();
        let artist_id = db.get_or_create_artist("Tool").unwrap();
        let track_id = insert_track(&db, "/music/lateralus.mp3", "Lateralus", Some(artist_id), None);

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
        let t1 = insert_track(&db, "/music/around.mp3", "Around the World", Some(artist_id), None);
        let t2 = insert_track(&db, "/music/harder.mp3", "Harder Better Faster", Some(artist_id), None);

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
        let t1 = insert_track(&db, "/music/t1.mp3", "Track 1", Some(a1), None);
        let t2 = insert_track(&db, "/music/t2.mp3", "Track 2", Some(a1), None);
        let t3 = insert_track(&db, "/music/t3.mp3", "Track 3", Some(a2), None);

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
        assert!(artists[0].library_artist_id.is_some());
        assert_eq!(artists[1].display_name, "Artist B");
        assert_eq!(artists[1].play_count, 2);
    }

    #[test]
    fn test_history_unicode_canonical() {
        let db = test_db();
        // Greek artist
        let a1 = db.get_or_create_artist("Σωκράτης").unwrap();
        let t1 = insert_track(&db, "/music/greek.mp3", "Τραγούδι", Some(a1), None);
        db.record_history_play(t1).unwrap();

        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].display_artist.as_deref(), Some("Σωκράτης"));
        assert_eq!(recent[0].display_title, "Τραγούδι");

        // Cyrillic artist
        let a2 = db.get_or_create_artist("Кино").unwrap();
        let t2 = insert_track(&db, "/music/russian.mp3", "Группа крови", Some(a2), None);
        db.record_history_play(t2).unwrap();

        let recent = db.get_history_recent(10).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].display_artist.as_deref(), Some("Кино"));
    }
}
