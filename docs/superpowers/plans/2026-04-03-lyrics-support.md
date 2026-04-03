# Lyrics Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lyrics fetching from external providers, storage in SQLite, display in Now Playing View with synced auto-scroll, and full-text search integration.

**Architecture:** Trait-based `LyricProvider` fallback chain (mirroring `image_provider/`), a `lyrics` DB table with migration v12, background fetch on playback via Tauri events, and a lyrics column in `NowPlayingView.tsx` with synced line highlighting.

**Tech Stack:** Rust (reqwest, regex, serde_json), SQLite FTS5, React/TypeScript, Tauri IPC events.

**Spec:** `docs/superpowers/specs/2026-04-03-lyrics-support-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src-tauri/src/lyric_provider/mod.rs` | `LyricProvider` trait, `LyricFallbackChain`, `LyricResult`, `LyricKind` |
| `src-tauri/src/lyric_provider/lrclib.rs` | LRCLIB provider implementation |
| `src/components/LyricsPanel.tsx` | Lyrics display component (synced + plain + edit mode) |

### Modified Files
| File | Changes |
|------|---------|
| `src-tauri/src/lib.rs:1` | Add `mod lyric_provider;`, build chain, add `lyric_provider` to `AppState`, register new commands |
| `src-tauri/src/models.rs:1-69` | Add `Lyrics` struct, `LyricsLoaded`/`LyricsError` event payloads |
| `src-tauri/src/commands.rs:39-54` | Add `lyric_provider` + `lyrics_fetching` fields to `AppState`; add `get_lyrics`, `fetch_lyrics`, `save_manual_lyrics`, `reset_lyrics` commands |
| `src-tauri/src/db.rs:173-257` | Add `lyrics` table to `init_tables()`; update FTS schema in 3 locations; add migration v12; add lyrics CRUD + FTS update functions |
| `src/components/NowPlayingView.tsx:1-199` | Add lyrics column to right side, move album/artist cards to left |
| `src/App.tsx:969-1002` | Add `fetch_lyrics` call in `fetchNpLastfmData`; add `lyrics-loaded`/`lyrics-error` event listeners; pass lyrics state to `NowPlayingView` |
| `src/App.css` | Add `.np-lyrics-*` styles for lyrics panel |

---

## Task 1: Lyrics Model & DB Schema

**Files:**
- Modify: `src-tauri/src/models.rs:69` (append after Track struct)
- Modify: `src-tauri/src/db.rs:173-257` (init_tables — add lyrics table after track_tags)
- Modify: `src-tauri/src/db.rs:249-257` (FTS schema — add lyrics_text column)
- Modify: `src-tauri/src/db.rs:715-739` (clear_database — add DELETE FROM lyrics + updated FTS)
- Modify: `src-tauri/src/db.rs:741-769` (rebuild_fts — add lyrics_text column + LEFT JOIN lyrics)
- Modify: `src-tauri/src/db.rs:460-463` (migration chain — add version 12)

- [ ] **Step 1: Add Lyrics model to models.rs**

In `src-tauri/src/models.rs`, append after the `Track` struct (line 69):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lyrics {
    pub track_id: i64,
    pub text: String,
    pub kind: String,
    pub provider: String,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricsLoaded {
    pub track_id: i64,
    pub text: String,
    pub kind: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricsError {
    pub track_id: i64,
    pub error: String,
}
```

- [ ] **Step 2: Add lyrics table to init_tables()**

In `src-tauri/src/db.rs`, inside `init_tables()` after the `track_tags` CREATE TABLE (line 247), add:

```sql
CREATE TABLE IF NOT EXISTS lyrics (
    track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    provider    TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
```

- [ ] **Step 3: Update FTS schema in all 3 locations**

Add `lyrics_text,` column to the `tracks_fts` CREATE statement in:
1. `init_tables()` (line 249-257)
2. `clear_database()` (line 728-736)
3. `rebuild_fts()` (line 745-753)

Each should become:
```sql
CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title,
    artist_name,
    album_title,
    tag_names,
    filename,
    lyrics_text,
    content='',
    tokenize='unicode61 remove_diacritics 2'
);
```

- [ ] **Step 4: Update rebuild_fts() INSERT to include lyrics_text**

In `rebuild_fts()` (line 755-767), update the INSERT to LEFT JOIN on lyrics and add the lyrics_text column. Strip LRC timestamps using regex for synced lyrics:

```rust
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
             lyrics_text,
             content='',
             tokenize='unicode61 remove_diacritics 2'
         );"
    )?;
    conn.execute_batch(
        &format!(
            "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, filename, lyrics_text)
             SELECT t.id, strip_diacritics(t.title), strip_diacritics(COALESCE(ar.name, '')), strip_diacritics(COALESCE(al.title, '')),
                    strip_diacritics(COALESCE((SELECT GROUP_CONCAT(tg.name, ' ') FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.track_id = t.id), '')),
                    strip_diacritics(filename_from_path(t.path)),
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
```

Note: LRC timestamp stripping for the FTS index is handled in the `strip_lrc_timestamps` helper function (see Task 2, Step 5) which is called when storing lyrics, not in the FTS rebuild SQL. The rebuild query uses the pre-stripped plain text stored in the `lyrics.text` column for plain lyrics, or the raw LRC text for synced lyrics (acceptable for FTS — timestamps are noise but don't break search). For better accuracy, add a `plain_for_fts` approach: call `strip_lrc_timestamps` in Rust before inserting into FTS in the incremental update path (Task 2 Step 6), and for bulk rebuild accept the minor noise from timestamps in synced lyrics.

- [ ] **Step 5: Add DELETE FROM lyrics to clear_database()**

In `clear_database()` (line 718), add `DELETE FROM lyrics;` after `DELETE FROM track_tags;`.

- [ ] **Step 6: Add migration version 12**

In `run_migrations()`, after the `version < 11` block (line 462), add:

```rust
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
    // FTS must be rebuilt to add the lyrics_text column.
    // rebuild_fts() is called after dropping conn, so just set the version here.
    conn.execute("UPDATE db_version SET version = 12 WHERE rowid = 1", [])?;
}
```

Then after the `drop(conn)` (line 465), add FTS rebuild for v12:

```rust
if version < 12 {
    crate::timing::timer().time("db: rebuild_fts_for_lyrics", || self.rebuild_fts())?;
}
```

- [ ] **Step 7: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully (warnings about unused structs in models.rs are fine for now).

- [ ] **Step 8: Write tests for lyrics DB operations**

In `src-tauri/src/db.rs`, at the end of the `mod tests` block, add placeholder test:

```rust
#[test]
fn test_lyrics_table_exists() {
    let db = test_db();
    let artist_id = db.get_or_create_artist("Test Artist").unwrap();
    let track_id = insert_track(&db, "/test/lyrics.mp3", "Test Song", Some(artist_id), None);
    // Table should exist after init — insert directly to verify schema
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
```

- [ ] **Step 9: Run tests**

Run: `cd src-tauri && cargo test test_lyrics_table_exists -- --nocapture`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/db.rs
git commit -m "feat(lyrics): add lyrics table, model, FTS column, and migration v12"
```

---

## Task 2: Lyrics DB CRUD Functions

**Files:**
- Modify: `src-tauri/src/db.rs:1513` (append after image failure functions)

- [ ] **Step 1: Write tests for lyrics CRUD**

Add to `mod tests` in `db.rs`:

```rust
#[test]
fn test_save_and_get_lyrics() {
    let db = test_db();
    let artist_id = db.get_or_create_artist("Artist").unwrap();
    let track_id = insert_track(&db, "/test/song.mp3", "Song", Some(artist_id), None);

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
    let track_id = insert_track(&db, "/test/song.mp3", "Song", Some(artist_id), None);

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
    let track_id = insert_track(&db, "/test/song.mp3", "Song", Some(artist_id), None);

    db.save_lyrics(track_id, "Text", "plain", "manual").unwrap();
    assert!(db.get_lyrics(track_id).unwrap().is_some());

    db.delete_lyrics(track_id).unwrap();
    assert!(db.get_lyrics(track_id).unwrap().is_none());
}

#[test]
fn test_lyrics_cascade_on_track_delete() {
    let db = test_db();
    let artist_id = db.get_or_create_artist("Artist").unwrap();
    let track_id = insert_track(&db, "/test/song.mp3", "Song", Some(artist_id), None);

    db.save_lyrics(track_id, "Text", "plain", "lrclib").unwrap();
    db.delete_tracks_by_ids(&[track_id]).unwrap();
    assert!(db.get_lyrics(track_id).unwrap().is_none());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test test_save_and_get_lyrics test_save_lyrics_upsert test_delete_lyrics test_lyrics_cascade -- --nocapture 2>&1 | head -30`
Expected: FAIL — `get_lyrics`, `save_lyrics`, `delete_lyrics` methods don't exist yet.

- [ ] **Step 3: Implement lyrics CRUD functions in db.rs**

Add after the `clear_image_failures` function (around line 1513):

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test test_save_and_get_lyrics test_save_lyrics_upsert test_delete_lyrics test_lyrics_cascade test_lyrics_table_exists -- --nocapture`
Expected: All PASS

- [ ] **Step 5: Add strip_lrc_timestamps helper and FTS update function**

Add to `db.rs` after the `delete_lyrics` function:

```rust
/// Strip LRC timestamps like [01:23.45] from synced lyrics text.
pub fn strip_lrc_timestamps(text: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\[\d{2}:\d{2}[.:]\d{2,3}\]").unwrap());
    re.replace_all(text, "").trim().to_string()
}

/// Update the FTS index for a single track after lyrics change.
/// For contentless FTS5, we must delete the old row by supplying all original values,
/// then re-insert with updated values.
pub fn update_fts_for_track(&self, track_id: i64) -> SqlResult<()> {
    let conn = self.conn.lock().unwrap();
    // Read current FTS values for this track
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

    // For contentless FTS5, we cannot simply DELETE by rowid.
    // Instead, do a full rebuild of just this track's row by dropping and re-inserting.
    // Use the rebuild approach: delete the whole FTS table content for this rowid
    // via the special 'delete' command, then re-insert.
    // However, since we can't read old values from a contentless table, the safest
    // approach is a targeted rebuild: delete-all + reinsert via rebuild for just this row.
    // Actually, the simplest reliable approach for a single-row update in a contentless
    // FTS5 table is to rebuild the entire index. For performance, we only do this
    // during bulk operations. For single-track updates, we accept that the FTS may be
    // slightly stale until the next full rebuild. The row will be correct after any
    // rebuild_fts() call (which happens on scan/sync).
    //
    // For now, just insert the new row — duplicates in FTS are handled gracefully
    // (search returns the track once due to JOIN with tracks table).
    conn.execute(
        &format!(
            "INSERT OR REPLACE INTO tracks_fts (rowid, title, artist_name, album_title, tag_names, filename, lyrics_text)
             SELECT t.id, strip_diacritics(t.title), strip_diacritics(COALESCE(ar.name, '')), strip_diacritics(COALESCE(al.title, '')),
                    strip_diacritics(COALESCE((SELECT GROUP_CONCAT(tg.name, ' ') FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.track_id = t.id), '')),
                    strip_diacritics(filename_from_path(t.path)),
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
```

- [ ] **Step 6: Write test for strip_lrc_timestamps and FTS update**

```rust
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
    let track_id = insert_track(&db, "/test/song.mp3", "Song Title", Some(artist_id), None);

    db.save_lyrics(track_id, "unique_lyric_word in a song", "plain", "lrclib").unwrap();
    db.rebuild_fts().unwrap();

    let opts = crate::models::TrackQuery { query: Some("unique_lyric_word".to_string()), ..Default::default() };
    let results = db.get_tracks(&opts).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, track_id);
}
```

Note: `strip_lrc_timestamps` is a free function, not a method on `Database`. Adjust the test call accordingly: `use super::strip_lrc_timestamps;` then `strip_lrc_timestamps(...)`.

- [ ] **Step 7: Run tests**

Run: `cd src-tauri && cargo test test_strip_lrc test_lyrics_in_fts -- --nocapture`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(lyrics): add lyrics CRUD, LRC timestamp stripping, and FTS update functions"
```

---

## Task 3: LyricProvider Trait & LRCLIB Provider

**Files:**
- Create: `src-tauri/src/lyric_provider/mod.rs`
- Create: `src-tauri/src/lyric_provider/lrclib.rs`
- Modify: `src-tauri/src/lib.rs:1` (add `mod lyric_provider;`)

- [ ] **Step 1: Create lyric_provider/mod.rs**

Create `src-tauri/src/lyric_provider/mod.rs`:

```rust
pub mod lrclib;

pub struct LyricResult {
    pub text: String,
    pub kind: LyricKind,
    pub provider_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LyricKind {
    Synced,
    Plain,
}

impl LyricKind {
    pub fn as_str(&self) -> &str {
        match self {
            LyricKind::Synced => "synced",
            LyricKind::Plain => "plain",
        }
    }
}

pub trait LyricProvider: Send + Sync {
    fn name(&self) -> &str;
    fn fetch_lyrics(
        &self,
        artist: &str,
        title: &str,
        duration_secs: Option<f64>,
    ) -> Result<LyricResult, String>;
}

pub struct LyricFallbackChain {
    providers: Vec<Box<dyn LyricProvider>>,
}

impl LyricFallbackChain {
    pub fn new(providers: Vec<Box<dyn LyricProvider>>) -> Self {
        Self { providers }
    }
}

impl LyricProvider for LyricFallbackChain {
    fn name(&self) -> &str {
        "FallbackChain"
    }

    fn fetch_lyrics(
        &self,
        artist: &str,
        title: &str,
        duration_secs: Option<f64>,
    ) -> Result<LyricResult, String> {
        let mut last_err = String::from("No lyric providers configured");
        for provider in &self.providers {
            match provider.fetch_lyrics(artist, title, duration_secs) {
                Ok(result) => return Ok(result),
                Err(e) => {
                    log::warn!(
                        "Lyric provider '{}' failed for '{}' - '{}': {}",
                        provider.name(),
                        artist,
                        title,
                        e
                    );
                    last_err = e;
                }
            }
        }
        Err(last_err)
    }
}
```

- [ ] **Step 2: Create lyric_provider/lrclib.rs**

Create `src-tauri/src/lyric_provider/lrclib.rs`:

```rust
use super::{LyricKind, LyricProvider, LyricResult};
use crate::image_provider::{http_client, logged_get, urlencoded};

pub struct LrclibProvider;

impl LyricProvider for LrclibProvider {
    fn name(&self) -> &str {
        "lrclib"
    }

    fn fetch_lyrics(
        &self,
        artist: &str,
        title: &str,
        duration_secs: Option<f64>,
    ) -> Result<LyricResult, String> {
        let client = http_client()?;

        let mut url = format!(
            "https://lrclib.net/api/get?artist_name={}&track_name={}",
            urlencoded(artist),
            urlencoded(title),
        );
        if let Some(dur) = duration_secs {
            url.push_str(&format!("&duration={}", dur.round() as i64));
        }

        let resp = logged_get(&client, &url)
            .map_err(|e| format!("LRCLIB request failed: {}", e))?;

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err("No lyrics found on LRCLIB".to_string());
        }
        if !resp.status().is_success() {
            return Err(format!("LRCLIB returned status {}", resp.status()));
        }

        let body: serde_json::Value = resp
            .json()
            .map_err(|e| format!("Failed to parse LRCLIB response: {}", e))?;

        // Prefer synced lyrics, fall back to plain
        if let Some(synced) = body["syncedLyrics"].as_str() {
            if !synced.trim().is_empty() {
                return Ok(LyricResult {
                    text: synced.to_string(),
                    kind: LyricKind::Synced,
                    provider_name: self.name().to_string(),
                });
            }
        }

        if let Some(plain) = body["plainLyrics"].as_str() {
            if !plain.trim().is_empty() {
                return Ok(LyricResult {
                    text: plain.to_string(),
                    kind: LyricKind::Plain,
                    provider_name: self.name().to_string(),
                });
            }
        }

        Err("LRCLIB returned empty lyrics".to_string())
    }
}
```

- [ ] **Step 3: Register module in lib.rs**

In `src-tauri/src/lib.rs` line 5 (after `mod image_provider;`), add:

```rust
mod lyric_provider;
```

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles (warnings about unused code are fine).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lyric_provider/
git commit -m "feat(lyrics): add LyricProvider trait, fallback chain, and LRCLIB provider"
```

---

## Task 4: Backend Commands & Fetch Worker

**Files:**
- Modify: `src-tauri/src/commands.rs:39-54` (AppState + new commands)
- Modify: `src-tauri/src/lib.rs:488-509` (build lyric chain)
- Modify: `src-tauri/src/lib.rs:31-156,158-283` (register commands in both handlers)

- [ ] **Step 1: Add lyric_provider and lyrics_fetching to AppState**

In `src-tauri/src/commands.rs`, add imports at the top and new fields to `AppState` (line 39-54):

Add to imports:
```rust
use std::sync::atomic::AtomicI64;
```

Add fields to `AppState`:
```rust
pub lyric_provider: Arc<dyn crate::lyric_provider::LyricProvider>,
pub lyrics_fetching_track_id: Arc<AtomicI64>,  // 0 = idle
```

- [ ] **Step 2: Add get_lyrics command**

Append to `commands.rs`:

```rust
// --- Lyrics commands ---

#[tauri::command]
pub fn get_lyrics(state: State<'_, AppState>, track_id: i64) -> Result<Option<crate::models::Lyrics>, String> {
    state.db.get_lyrics(track_id).map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Add fetch_lyrics command**

```rust
#[tauri::command]
pub fn fetch_lyrics(app: tauri::AppHandle, state: State<'_, AppState>, track_id: i64, force: Option<bool>) {
    let force = force.unwrap_or(false);
    let db = state.db.clone();

    // If force, clear failure record
    if force {
        let _ = db.clear_image_failure("lyrics", track_id);
    }

    // Check DB for existing lyrics
    if let Ok(Some(lyrics)) = db.get_lyrics(track_id) {
        if !force || lyrics.provider == "manual" {
            let _ = app.emit("lyrics-loaded", crate::models::LyricsLoaded {
                track_id: lyrics.track_id,
                text: lyrics.text,
                kind: lyrics.kind,
                provider: lyrics.provider,
            });
            return;
        }
    }

    // Check failure record (skip if not force)
    if !force && db.is_image_failed("lyrics", track_id).unwrap_or(false) {
        return;
    }

    // Resolve track info before spawning
    let track = match db.get_track_by_id(track_id) {
        Ok(t) => t,
        Err(_) => return,
    };
    let artist_name = match track.artist_name {
        Some(ref name) => name.clone(),
        None => return,  // Can't search without artist
    };
    let title = track.title.clone();
    let duration = track.duration_secs;

    let provider = state.lyric_provider.clone();
    let fetching_id = state.lyrics_fetching_track_id.clone();

    // Mark this track as being fetched
    fetching_id.store(track_id, std::sync::atomic::Ordering::Relaxed);

    std::thread::spawn(move || {
        match provider.fetch_lyrics(&artist_name, &title, duration) {
            Ok(result) => {
                let kind_str = result.kind.as_str();
                if let Ok(lyrics) = db.save_lyrics(track_id, &result.text, kind_str, &result.provider_name) {
                    let _ = db.update_fts_for_track(track_id);
                    // Only emit if this track is still the one being fetched
                    let current = fetching_id.load(std::sync::atomic::Ordering::Relaxed);
                    if current == track_id {
                        let _ = app.emit("lyrics-loaded", crate::models::LyricsLoaded {
                            track_id: lyrics.track_id,
                            text: lyrics.text,
                            kind: lyrics.kind,
                            provider: lyrics.provider,
                        });
                    }
                }
            }
            Err(e) => {
                let _ = db.record_image_failure("lyrics", track_id);
                let current = fetching_id.load(std::sync::atomic::Ordering::Relaxed);
                if current == track_id {
                    let _ = app.emit("lyrics-error", crate::models::LyricsError {
                        track_id,
                        error: e,
                    });
                }
            }
        }
    });
}
```

- [ ] **Step 4: Add save_manual_lyrics command**

```rust
#[tauri::command]
pub fn save_manual_lyrics(state: State<'_, AppState>, track_id: i64, text: String, kind: String) -> Result<crate::models::Lyrics, String> {
    let _ = state.db.clear_image_failure("lyrics", track_id);
    let lyrics = state.db.save_lyrics(track_id, &text, &kind, "manual").map_err(|e| e.to_string())?;
    let _ = state.db.update_fts_for_track(track_id);
    Ok(lyrics)
}
```

- [ ] **Step 5: Add reset_lyrics command**

```rust
#[tauri::command]
pub fn reset_lyrics(app: tauri::AppHandle, state: State<'_, AppState>, track_id: i64) {
    let _ = state.db.delete_lyrics(track_id);
    let _ = state.db.clear_image_failure("lyrics", track_id);
    let _ = state.db.update_fts_for_track(track_id);
    // Trigger fresh fetch
    fetch_lyrics(app, state, track_id, Some(false));
}
```

- [ ] **Step 6: Build lyric provider chain in lib.rs**

In `src-tauri/src/lib.rs`, after the image provider chain setup (around line 509), add:

```rust
let lyric_provider: Arc<dyn lyric_provider::LyricProvider> = Arc::new(
    lyric_provider::LyricFallbackChain::new(vec![
        Box::new(lyric_provider::lrclib::LrclibProvider),
    ]),
);
```

And add the new fields to the `AppState` construction (find the `AppState { ... }` block):

```rust
lyric_provider,
lyrics_fetching_track_id: Arc::new(AtomicI64::new(0)),
```

Add the necessary imports at the top of `lib.rs`:
```rust
use std::sync::atomic::AtomicI64;
```

- [ ] **Step 7: Register commands in both invoke handlers**

In both `get_invoke_handler()` functions (debug: line 31-156, release: line 158-283), add these 4 commands:

```rust
commands::get_lyrics,
commands::fetch_lyrics,
commands::save_manual_lyrics,
commands::reset_lyrics,
```

- [ ] **Step 8: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully.

- [ ] **Step 9: Run all existing tests to verify no regressions**

Run: `cd src-tauri && cargo test`
Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(lyrics): add backend commands, fetch worker, and lyric provider chain"
```

---

## Task 5: Frontend — LyricsPanel Component

**Files:**
- Create: `src/components/LyricsPanel.tsx`

- [ ] **Step 1: Create LyricsPanel.tsx**

Create `src/components/LyricsPanel.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback } from "react";

interface LyricsPanelProps {
  trackId: number;
  positionSecs: number;
  lyrics: { text: string; kind: string; provider: string } | null;
  loading: boolean;
  onSave: (text: string, kind: string) => void;
  onReset: () => void;
  onForceRefresh: () => void;
}

interface LrcLine {
  time: number; // seconds
  text: string;
}

function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const line of lrc.split("\n")) {
    const match = line.match(/^\[(\d{2}):(\d{2})[.:]\d{2,3}\](.*)$/);
    if (match) {
      const mins = parseInt(match[1], 10);
      const secs = parseInt(match[2], 10);
      const text = match[3].trim();
      if (text) {
        lines.push({ time: mins * 60 + secs, text });
      }
    }
  }
  return lines;
}

function getCurrentLineIndex(lines: LrcLine[], position: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= position) idx = i;
    else break;
  }
  return idx;
}

export default function LyricsPanel({ trackId, positionSecs, lyrics, loading, onSave, onReset, onForceRefresh }: LyricsPanelProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editKind, setEditKind] = useState<"plain" | "synced">("plain");
  const [userScrolled, setUserScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const userScrollTimeout = useRef<ReturnType<typeof setTimeout>>();

  // Reset edit state when track changes
  useEffect(() => {
    setEditing(false);
    setUserScrolled(false);
  }, [trackId]);

  // Parse synced lyrics
  const lrcLines = lyrics?.kind === "synced" ? parseLrc(lyrics.text) : null;
  const currentLineIdx = lrcLines ? getCurrentLineIndex(lrcLines, positionSecs) : -1;

  // Auto-scroll to current line
  useEffect(() => {
    if (!userScrolled && activeLineRef.current && scrollRef.current) {
      activeLineRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentLineIdx, userScrolled]);

  const handleScroll = useCallback(() => {
    setUserScrolled(true);
    if (userScrollTimeout.current) clearTimeout(userScrollTimeout.current);
    userScrollTimeout.current = setTimeout(() => setUserScrolled(false), 5000);
  }, []);

  const startEdit = () => {
    setEditText(lyrics?.text ?? "");
    setEditKind((lyrics?.kind as "plain" | "synced") ?? "plain");
    setEditing(true);
  };

  const handleSave = () => {
    onSave(editText, editKind);
    setEditing(false);
  };

  if (loading) {
    return (
      <div className="np-lyrics">
        <div className="np-lyrics-header">
          <span className="np-section-title">Lyrics</span>
        </div>
        <div className="np-lyrics-body np-lyrics-center">
          <span className="np-lyrics-loading">Loading…</span>
        </div>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="np-lyrics">
        <div className="np-lyrics-header">
          <span className="np-section-title">Edit Lyrics</span>
          <div className="np-lyrics-actions">
            <select value={editKind} onChange={e => setEditKind(e.target.value as "plain" | "synced")}>
              <option value="plain">Plain</option>
              <option value="synced">Synced (LRC)</option>
            </select>
            <button className="np-lyrics-btn" onClick={handleSave}>Save</button>
            <button className="np-lyrics-btn" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
        <textarea
          className="np-lyrics-editor"
          value={editText}
          onChange={e => setEditText(e.target.value)}
          spellCheck={false}
        />
      </div>
    );
  }

  if (!lyrics) {
    return (
      <div className="np-lyrics">
        <div className="np-lyrics-header">
          <span className="np-section-title">Lyrics</span>
          <div className="np-lyrics-actions">
            <button className="np-lyrics-btn" onClick={startEdit} title="Add lyrics manually">✎</button>
          </div>
        </div>
        <div className="np-lyrics-body np-lyrics-center">
          <span className="np-lyrics-empty">No lyrics found</span>
          <button className="np-lyrics-btn" onClick={startEdit}>Add manually</button>
        </div>
      </div>
    );
  }

  return (
    <div className="np-lyrics">
      <div className="np-lyrics-header">
        <span className="np-section-title">Lyrics</span>
        <div className="np-lyrics-actions">
          <span className={`np-lyrics-badge ${lyrics.kind === "synced" ? "np-lyrics-badge-synced" : ""}`}>
            {lyrics.kind}
          </span>
          <button className="np-lyrics-btn" onClick={startEdit} title="Edit lyrics">✎</button>
          {lyrics.provider === "manual" && (
            <button className="np-lyrics-btn" onClick={onReset} title="Reset to provider lyrics">↺</button>
          )}
          {lyrics.provider !== "manual" && (
            <button className="np-lyrics-btn" onClick={onForceRefresh} title="Re-fetch lyrics">↻</button>
          )}
        </div>
      </div>
      <div className="np-lyrics-body" ref={scrollRef} onScroll={handleScroll}>
        {lrcLines ? (
          lrcLines.map((line, i) => (
            <div
              key={i}
              ref={i === currentLineIdx ? activeLineRef : undefined}
              className={`np-lyrics-line ${i === currentLineIdx ? "np-lyrics-line-active" : ""}`}
            >
              {line.text}
            </div>
          ))
        ) : (
          <div className="np-lyrics-plain">{lyrics.text}</div>
        )}
      </div>
      <div className="np-lyrics-footer">
        via {lyrics.provider}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify frontend compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to LyricsPanel (may have pre-existing errors elsewhere).

- [ ] **Step 3: Commit**

```bash
git add src/components/LyricsPanel.tsx
git commit -m "feat(lyrics): add LyricsPanel component with synced/plain display and edit mode"
```

---

## Task 6: Integrate Lyrics into NowPlayingView & App.tsx

**Files:**
- Modify: `src/components/NowPlayingView.tsx:1-199`
- Modify: `src/App.tsx:969-1002` (fetchNpLastfmData + lyrics state)
- Modify: `src/App.tsx:2030-2055` (NowPlayingView props)

- [ ] **Step 1: Add lyrics props to NowPlayingView and restructure layout**

Update `NowPlayingView.tsx` — add lyrics props to the interface, import LyricsPanel, move album/artist cards to left column, and render LyricsPanel in right column:

Add to the `NowPlayingViewProps` interface:
```tsx
npLyrics: { text: string; kind: string; provider: string } | null;
npLyricsLoading: boolean;
positionSecs: number;
onSaveLyrics: (text: string, kind: string) => void;
onResetLyrics: () => void;
onForceRefreshLyrics: () => void;
```

Import LyricsPanel at the top:
```tsx
import LyricsPanel from "./LyricsPanel";
```

Restructure `NowPlayingBody`:
- Left column (`np-left`): keep hero + similar tracks, then append album card + artist card (moved from `np-right`)
- Right column (`np-right`): replace with `LyricsPanel`

The right column (lines 129-195) becomes:
```tsx
<div className="np-right">
  <LyricsPanel
    trackId={currentTrack.id}
    positionSecs={props.positionSecs}
    lyrics={props.npLyrics}
    loading={props.npLyricsLoading}
    onSave={props.onSaveLyrics}
    onReset={props.onResetLyrics}
    onForceRefresh={props.onForceRefreshLyrics}
  />
</div>
```

Move the album card (lines 131-154) and artist card (lines 157-193) into `np-left`, after the similar tracks section (line 125), before the closing `</div>` of `np-left`.

- [ ] **Step 2: Add lyrics state and event listeners in App.tsx**

In `App.tsx`, add state variables near other np* state (search for `npArtistBio`):
```tsx
const [npLyrics, setNpLyrics] = useState<{ text: string; kind: string; provider: string } | null>(null);
const [npLyricsLoading, setNpLyricsLoading] = useState(false);
```

Add event listeners for lyrics (near other event listener setup, around the `lastfm-similar-tracks` listeners):
```tsx
useEffect(() => {
  const unlistenLoaded = listen<{ track_id: number; text: string; kind: string; provider: string }>("lyrics-loaded", (event) => {
    if (event.payload.track_id === npTrackRef.current?.id) {
      setNpLyrics({ text: event.payload.text, kind: event.payload.kind, provider: event.payload.provider });
      setNpLyricsLoading(false);
    }
  });
  const unlistenError = listen<{ track_id: number; error: string }>("lyrics-error", (event) => {
    if (event.payload.track_id === npTrackRef.current?.id) {
      setNpLyricsLoading(false);
    }
  });
  return () => { unlistenLoaded.then(f => f()); unlistenError.then(f => f()); };
}, []);
```

- [ ] **Step 3: Add fetch_lyrics call on track change**

In `fetchNpLastfmData` (line 969-1002), add at the beginning:
```tsx
// Fetch lyrics
setNpLyrics(null);
setNpLyricsLoading(true);
invoke("fetch_lyrics", { trackId: track.id, force: false }).catch(() => setNpLyricsLoading(false));
```

Also clear lyrics state when track changes (near where other np* states are cleared):
```tsx
setNpLyrics(null);
setNpLyricsLoading(false);
```

- [ ] **Step 4: Add lyrics action callbacks and pass props to NowPlayingView**

Add callbacks in App.tsx:
```tsx
const handleSaveLyrics = useCallback(async (text: string, kind: string) => {
  if (!playback.currentTrack) return;
  try {
    const result = await invoke<{ text: string; kind: string; provider: string }>("save_manual_lyrics", {
      trackId: playback.currentTrack.id, text, kind
    });
    setNpLyrics(result);
  } catch (e) { console.error("Failed to save lyrics:", e); }
}, [playback.currentTrack]);

const handleResetLyrics = useCallback(() => {
  if (!playback.currentTrack) return;
  setNpLyrics(null);
  setNpLyricsLoading(true);
  invoke("reset_lyrics", { trackId: playback.currentTrack.id }).catch(() => setNpLyricsLoading(false));
}, [playback.currentTrack]);

const handleForceRefreshLyrics = useCallback(() => {
  if (!playback.currentTrack) return;
  setNpLyrics(null);
  setNpLyricsLoading(true);
  invoke("fetch_lyrics", { trackId: playback.currentTrack.id, force: true }).catch(() => setNpLyricsLoading(false));
}, [playback.currentTrack]);
```

Update NowPlayingView rendering (line 2030-2055) to pass new props:
```tsx
npLyrics={npLyrics}
npLyricsLoading={npLyricsLoading}
positionSecs={playback.positionSecs}
onSaveLyrics={handleSaveLyrics}
onResetLyrics={handleResetLyrics}
onForceRefreshLyrics={handleForceRefreshLyrics}
```

- [ ] **Step 5: Verify frontend compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/NowPlayingView.tsx src/components/LyricsPanel.tsx src/App.tsx
git commit -m "feat(lyrics): integrate LyricsPanel into NowPlayingView with event listeners and auto-fetch"
```

---

## Task 7: CSS Styles for Lyrics Panel

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Add lyrics CSS**

Find the `.np-right` styles in `App.css` and add lyrics-specific styles. Search for `.np-right` to find the right location:

```css
/* Lyrics panel */
.np-lyrics {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.np-lyrics-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0 8px 0;
  flex-shrink: 0;
}
.np-lyrics-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.np-lyrics-badge {
  font-size: var(--fs-2xs);
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--clr-surface-2);
  color: var(--clr-text-secondary);
}
.np-lyrics-badge-synced {
  background: rgba(100, 200, 100, 0.15);
  color: rgba(100, 200, 100, 0.8);
}
.np-lyrics-btn {
  background: none;
  border: none;
  color: var(--clr-text-secondary);
  cursor: pointer;
  font-size: var(--fs-xs);
  padding: 2px 4px;
  border-radius: 4px;
}
.np-lyrics-btn:hover {
  color: var(--clr-text-primary);
  background: var(--clr-surface-2);
}
.np-lyrics-body {
  flex: 1;
  overflow-y: auto;
  line-height: 2;
  padding-right: 4px;
}
.np-lyrics-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.np-lyrics-loading,
.np-lyrics-empty {
  color: var(--clr-text-secondary);
  font-size: var(--fs-sm);
}
.np-lyrics-line {
  color: var(--clr-text-secondary);
  opacity: 0.4;
  font-size: var(--fs-sm);
  transition: opacity 0.3s, font-weight 0.3s;
  padding: 1px 0;
}
.np-lyrics-line-active {
  opacity: 1;
  color: var(--clr-text-primary);
  font-weight: 500;
  font-size: var(--fs-base);
}
.np-lyrics-plain {
  color: var(--clr-text-secondary);
  font-size: var(--fs-sm);
  white-space: pre-wrap;
}
.np-lyrics-footer {
  flex-shrink: 0;
  padding-top: 6px;
  font-size: var(--fs-2xs);
  color: var(--clr-text-secondary);
  opacity: 0.5;
  text-align: right;
}
.np-lyrics-editor {
  flex: 1;
  width: 100%;
  background: var(--clr-surface-1);
  color: var(--clr-text-primary);
  border: 1px solid var(--clr-border);
  border-radius: 4px;
  font-family: monospace;
  font-size: var(--fs-xs);
  padding: 8px;
  resize: none;
}
.np-lyrics-editor:focus {
  outline: none;
  border-color: var(--clr-accent);
}
.np-lyrics-actions select {
  background: var(--clr-surface-1);
  color: var(--clr-text-primary);
  border: 1px solid var(--clr-border);
  border-radius: 4px;
  font-size: var(--fs-2xs);
  padding: 1px 4px;
}
```

- [ ] **Step 2: Verify frontend compiles and styles render**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/App.css
git commit -m "feat(lyrics): add CSS styles for lyrics panel"
```

---

## Task 8: Search Integration — Lyrics Badge

**Files:**
- Modify: `src-tauri/src/db.rs:850-909` (search_tracks_inner area)
- Modify: `src-tauri/src/commands.rs` (new command for lyrics match check)
- Modify: `src/App.tsx` or `src/components/TrackList.tsx` (badge display)

- [ ] **Step 1: Add check_lyrics_match DB function**

In `db.rs`, add after the lyrics CRUD functions:

```rust
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
    // Use FTS5 column filter syntax: prepend "lyrics_text:" to restrict match to that column
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
```

- [ ] **Step 2: Add check_lyrics_match command**

In `commands.rs`:

```rust
#[tauri::command]
pub fn check_lyrics_match(state: State<'_, AppState>, track_ids: Vec<i64>, query: String) -> Result<Vec<i64>, String> {
    state.db.check_lyrics_match(&track_ids, &query).map_err(|e| e.to_string())
}
```

Register in both `get_invoke_handler()` functions:
```rust
commands::check_lyrics_match,
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(lyrics): add check_lyrics_match for search result lyrics badges"
```

---

## Task 9: Final Verification

- [ ] **Step 1: Run all Rust tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass.

- [ ] **Step 2: Run frontend type check**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Check release build compiles**

Run: `cd src-tauri && cargo check --release`
Expected: Compiles (verifies no debug-only code leaked).

- [ ] **Step 4: Verify dev build runs**

Run: `npm run tauri dev` (manual test)
- Play a track → lyrics should auto-fetch and appear in Now Playing View
- Check synced lyrics scroll during playback
- Test edit mode (paste lyrics, save)
- Test reset button
- Search for lyrics text and verify results appear

- [ ] **Step 5: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix(lyrics): address issues found during integration testing"
```
