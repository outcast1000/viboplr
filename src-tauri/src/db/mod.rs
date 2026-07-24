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
     t.track_number, t.duration_secs, t.format, t.file_size, t.collection_id, co.name, t.liked, \
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
        added_at: row.get(15)?,
        modified_at: row.get(16)?,
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

impl Database {
    /// Lock-and-drop the connection mutex: blocks until the statement in
    /// flight *at call time* finishes (used by the profile-switch flow so a
    /// user action just before switching — e.g. a like — lands before exit).
    /// It is not a quiescence guarantee: a background writer (scan/sync) can
    /// re-acquire immediately after, and a statement cut off by the exit is
    /// rolled back by SQLite journaling — integrity holds, that write is lost.
    pub fn write_barrier(&self) {
        // Acquire (blocking until any in-flight write releases) and drop.
        drop(self.conn.lock());
    }
}

// --- db submodules (split out of this file; inherent impl Database methods) ---
mod albums;
mod artists;
mod auto_playlists;
pub mod collections;
mod history;
mod image_failures;
pub mod likes;
mod playlists;
mod plugin_storage;
mod providers;
pub mod publish_servers;
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
        // Repair any tracks.liked mirror drift from the durable entity_likes
        // store (e.g. a like set while a track was not yet in the library, or a
        // delete + re-add). Idempotent; runs every startup (NOT gated by the
        // one-time, opposite-direction backfill marker).
        timer.time("db: reconcile_track_likes", || db.reconcile_track_likes_from_entity_likes())?;
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
                extra_tags    TEXT,
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

            -- HTTP conditional-fetch cache for manifest collections (skip re-ingest
            -- of unchanged manifests). Keyed by collection; rows are orphaned when a
            -- collection is removed (harmless).
            CREATE TABLE IF NOT EXISTS manifest_http_cache (
                collection_id INTEGER PRIMARY KEY,
                etag          TEXT,
                last_modified TEXT
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

            -- Bandstatic publish targets (publish-to-server) — see db/publish_servers.rs.
            -- PAT stored plaintext, matching the collections-credentials precedent;
            -- acceptable because the token is upload-scoped only (cannot delete
            -- content or touch the account).
            CREATE TABLE IF NOT EXISTS publish_servers (
                id          INTEGER PRIMARY KEY,
                name        TEXT NOT NULL,
                url         TEXT NOT NULL,
                token       TEXT NOT NULL,
                artist_slug TEXT NOT NULL DEFAULT '',
                created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
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

        // 4. Drop the stale CHECK(entity IN ('artist','album')) constraint on
        //    image_providers. Pre-feature DBs created the table with that
        //    constraint, which silently rejects 'tag' (and any future entity)
        //    rows on INSERT OR IGNORE — so the Google Image Search plugin's tag
        //    provider never registers and "Tags" never appears in Settings.
        //    SQLite can't drop a CHECK via ALTER, so rebuild the table. Detected
        //    by schema presence (idempotent): only runs when the CHECK is found.
        let has_entity_check: bool = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'image_providers' AND sql LIKE '%CHECK%'",
                [], |r| r.get::<_, i64>(0),
            )? > 0
        };
        if has_entity_check {
            let conn = self.conn.lock().unwrap();
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE image_providers_new (
                     id          INTEGER PRIMARY KEY,
                     plugin_id   TEXT NOT NULL,
                     entity      TEXT NOT NULL,
                     priority    INTEGER NOT NULL DEFAULT 500,
                     active      INTEGER NOT NULL DEFAULT 1,
                     UNIQUE (plugin_id, entity)
                 );
                 INSERT INTO image_providers_new (id, plugin_id, entity, priority, active)
                     SELECT id, plugin_id, entity, priority, active FROM image_providers;
                 DROP TABLE image_providers;
                 ALTER TABLE image_providers_new RENAME TO image_providers;
                 COMMIT;",
            )?;
        }

        // 5. Drop the legacy tracks.youtube_url column. The "save this YouTube
        //    link" feature was removed; Find-in-YouTube now always searches
        //    fresh. Detected by schema presence (idempotent): only runs when the
        //    column still exists. DROP COLUMN needs SQLite >= 3.35 (bundled).
        let has_youtube_url_col: bool = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tracks') WHERE name = 'youtube_url'",
                [], |r| r.get::<_, i64>(0),
            )? > 0
        };
        if has_youtube_url_col {
            let conn = self.conn.lock().unwrap();
            conn.execute("ALTER TABLE tracks DROP COLUMN youtube_url", [])?;
        }

        // 6. Add tracks.extra_tags (a JSON catch-all for tag keys with no dedicated
        //    column — ReplayGain values live here). Fresh DBs get it via init_tables;
        //    pre-feature DBs need it added. Detected by schema presence (idempotent).
        let has_extra_tags: bool = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tracks') WHERE name = 'extra_tags'",
                [], |r| r.get::<_, i64>(0),
            )? > 0
        };
        if !has_extra_tags {
            let conn = self.conn.lock().unwrap();
            conn.execute("ALTER TABLE tracks ADD COLUMN extra_tags TEXT", [])?;
        }

        // 7. Publish servers (Bandstatic push targets) — see db/publish_servers.rs.
        //    Fresh DBs get the table via init_tables; pre-feature DBs get it here.
        //    Detected by schema presence (CREATE TABLE IF NOT EXISTS is self-gating),
        //    NOT a `db_version < N` gate — pre-squash DBs carry inflated versions
        //    that a numeric gate would skip (see the note at the top of this fn).
        //    PAT stored plaintext, matching the collections-credentials precedent;
        //    acceptable because the token is upload-scoped only (cannot delete
        //    content or touch the account).
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "CREATE TABLE IF NOT EXISTS publish_servers (
                    id          INTEGER PRIMARY KEY,
                    name        TEXT NOT NULL,
                    url         TEXT NOT NULL,
                    token       TEXT NOT NULL,
                    artist_slug TEXT NOT NULL DEFAULT '',
                    created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                )",
                [],
            )?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests;
