# Lyrics Support Design

## Overview

Add lyrics fetching, storage, display, and search to Viboplr. Lyrics are fetched from external providers using a trait-based fallback chain (same pattern as image providers), stored in a dedicated database table, displayed in the Now Playing View, and indexed for full-text search.

## Backend: Lyric Provider Trait & Chain

### Module Structure

```
src-tauri/src/lyric_provider/
  mod.rs        — LyricProvider trait, LyricFallbackChain, helpers
  lrclib.rs     — LRCLIB provider (synced + plain, free, no API key)
  genius.rs     — Genius provider (plain only, requires API key) — stretch goal
```

### Trait Definition

```rust
pub struct LyricResult {
    pub text: String,              // LRC format if synced, plain text otherwise
    pub kind: LyricKind,           // Synced or Plain
    pub provider_name: String,
}

pub enum LyricKind {
    Synced,  // text contains LRC with timestamps
    Plain,   // text is plain lyrics
}

pub trait LyricProvider: Send + Sync {
    fn fetch_lyrics(
        &self,
        artist: &str,
        title: &str,
        duration_secs: Option<f64>,
    ) -> Result<LyricResult, String>;
}
```

When a provider returns synced lyrics, `text` contains the full LRC-format string (with `[mm:ss.xx]` timestamps). When only plain lyrics are available, `text` is plain text. The frontend parses/strips timestamps as needed for display and FTS indexing.

### Fallback Chain

`LyricFallbackChain` wraps `Vec<Box<dyn LyricProvider>>`, iterates sequentially, returns first success. Same pattern as `ArtistImageFallbackChain` in `image_provider/mod.rs`.

**Chain order:** LRCLIB → Genius (when API key configured)

### Provider Details

**LRCLIB:** GET `https://lrclib.net/api/get?artist_name=X&track_name=Y&duration=Z`. Returns `syncedLyrics` and `plainLyrics` fields. Duration helps disambiguate versions. Free, no API key. If `syncedLyrics` is present, return as `LyricKind::Synced`. Otherwise fall back to `plainLyrics` as `LyricKind::Plain`.

**Genius (stretch goal):** Search API → scrape lyrics from song page HTML (extract from `[data-lyrics-container]` divs using `scraper` crate). Requires `GENIUS_API_TOKEN` configured in settings. Returns plain text only. Skipped if no API key configured. Fragile due to HTML structure changes — implement after LRCLIB is working.

## Database

### Lyrics Table

```sql
CREATE TABLE IF NOT EXISTS lyrics (
    track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    kind        TEXT NOT NULL,           -- "synced" or "plain"
    provider    TEXT NOT NULL,           -- "lrclib", "genius", "manual"
    fetched_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
```

- One lyrics row per track (`track_id` is the primary key), upserted on re-fetch.
- `kind` describes the format of `text`: `"synced"` = LRC with timestamps, `"plain"` = plain text.
- `provider = "manual"` indicates user-edited lyrics. Provider fetches will not overwrite manual lyrics.
- `ON DELETE CASCADE` removes lyrics when the track is deleted.

**Storage rule:** When synced lyrics are available, `text` stores the LRC-format string (with `[mm:ss.xx]` timestamps) and `kind = "synced"`. Plain text is derived at display time by stripping timestamps. When only plain lyrics are available, `text` stores plain text and `kind = "plain"`.

### Failure Tracking

Reuse the existing `image_fetch_failures` table with `kind = 'lyrics'`. Call the existing `record_image_failure`, `is_image_failed`, `clear_image_failure` functions with `kind = "lyrics"` — the functions are generic despite their `image_` naming (the underlying table accepts any `kind` value). Force refresh clears the failure record. Saving manual lyrics also clears any existing failure record for that track.

### Migration

This is migration version 12 (`if version < 12` in the migration chain — adjust if another migration lands first). The migration:

1. `CREATE TABLE IF NOT EXISTS lyrics (...)` as defined above.
2. `DROP TABLE IF EXISTS tracks_fts` — FTS5 virtual tables cannot be altered.
3. Recreate `tracks_fts` with the new `lyrics_text` column.
4. Repopulate via `rebuild_fts()`.

All three code locations that define the FTS schema must be updated in sync: `init_tables()`, `clear_database()`, and `rebuild_fts()`. Additionally, `clear_database()` must include `DELETE FROM lyrics`.

### FTS Extension

Add `lyrics_text` column to `tracks_fts`:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
    title, artist_name, album_title, tag_names, filename,
    lyrics_text,
    content='',
    tokenize='unicode61 remove_diacritics 2'
);
```

- `rebuild_fts` updated to LEFT JOIN on `lyrics` table, populating `lyrics_text` with `strip_diacritics(plain_text)`. For synced lyrics, strip LRC timestamps using regex `\[\d{2}:\d{2}[\.:]\d{2,3}\]` before indexing.
- When lyrics are fetched for a single track, the FTS entry is incrementally updated. Because `tracks_fts` is a contentless FTS5 table, deletion requires supplying original column values: `INSERT INTO tracks_fts(tracks_fts, rowid, title, artist_name, album_title, tag_names, filename, lyrics_text) VALUES('delete', ?, ?, ?, ?, ?, ?, ?)` followed by a regular INSERT with the new values.

### Search Results

The existing `search_tracks_inner` query matches across all FTS columns unchanged. To indicate "matched in lyrics," a second lightweight query checks `lyrics_text MATCH ?` for the result set and flags those track IDs. The frontend shows a "lyrics" badge on matching results.

## Backend: Models

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lyrics {
    pub track_id: i64,
    pub text: String,
    pub kind: String,       // "synced" or "plain"
    pub provider: String,   // "lrclib", "genius", "manual"
    pub fetched_at: i64,
}
```

## Backend: Commands

| Command | Purpose |
|---------|---------|
| `get_lyrics(track_id) -> Option<Lyrics>` | Returns stored lyrics from DB, or `None`. Synchronous read — does not trigger fetch. |
| `fetch_lyrics(track_id, force) -> ()` | Checks DB first: if found, emits `lyrics-loaded` immediately. If not found (and no failure record, or `force`), spawns background fetch. If `force`, clears failure record and overwrites non-manual lyrics. |
| `save_manual_lyrics(track_id, text, kind) -> Lyrics` | Saves user-edited lyrics with `provider = "manual"`. Clears any failure record. Returns the saved lyrics. |
| `reset_lyrics(track_id) -> ()` | Deletes lyrics row + clears failure record, then triggers fresh fetch from providers. |

Backend resolves `artist_name`, `title`, and `duration_secs` from the `tracks` table (joined with `artists`) before spawning the background fetch thread.

## Backend: Events

| Event | Payload |
|-------|---------|
| `lyrics-loaded` | `{ track_id: i64, text: String, kind: String, provider: String }` |
| `lyrics-error` | `{ track_id: i64, error: String }` |

## Backend: Concurrency

Only one lyrics fetch runs at a time. If a new `fetch_lyrics` call arrives while one is in progress, the in-flight fetch is not cancelled (its result is still stored if it completes), but no event is emitted for a stale `track_id`. The frontend checks that `track_id` in the `lyrics-loaded` event matches the currently playing track before updating the display.

## Event Flow

### On Playback (auto-fetch)

1. Frontend calls `fetch_lyrics(track_id, false)` when a track starts playing.
2. Backend checks DB for existing lyrics.
   - Found → emit `lyrics-loaded` event immediately.
   - Not found + failure record → skip, no event.
   - Not found + no failure → spawn background thread → provider chain → store in DB → update FTS row → emit `lyrics-loaded`.
   - Provider chain fails → `record_failure("lyrics", track_id)` → emit `lyrics-error`.

### Manual Edit

1. User clicks edit button → textarea replaces lyrics display → user picks kind (synced/plain) → saves.
2. Frontend calls `save_manual_lyrics(track_id, text, kind)`.
3. Backend upserts with `provider = "manual"` → clears failure record → updates FTS row → returns updated lyrics.

### Reset

1. User clicks reset button.
2. Frontend calls `reset_lyrics(track_id)`.
3. Backend deletes lyrics row → clears failure record → triggers a fresh fetch (since the row is deleted and failure is cleared, a normal `fetch_lyrics(track_id, false)` will proceed to the provider chain).

### Force Refresh

Same as `fetch_lyrics(track_id, force: true)`. Clears failure record, overwrites existing lyrics unless `provider = "manual"`. To overwrite manual lyrics, user must reset first.

## Frontend: Now Playing View

### Layout

Side-by-side column layout in `NowPlayingView.tsx`:
- **Left column:** Existing content — album art hero, track/artist/album info, tags, similar artists, artist bio/wiki.
- **Right column:** Lyrics panel replaces the existing right column content (album card, artist card). These cards are moved to the bottom of the left column, below the existing similar artists section.

### Synced Display

- Current line highlighted at full opacity and slightly larger font weight.
- Surrounding lines dimmed (lower opacity).
- Auto-scrolls to keep current line centered in the panel.
- User can manually scroll; auto-scroll pauses until the next line transition.

### Plain Display

- Full text displayed with normal scrolling, no line highlighting.

### Edit Mode

- Click edit button (✎) → textarea replaces lyrics display.
- User selects kind (synced/plain) via toggle.
- Save commits changes, cancel returns to display mode.

### States

- **Loading:** Spinner while fetching from providers.
- **Loaded:** Lyrics display (synced or plain mode).
- **Not found:** "No lyrics found" message with prompt to add manually.
- **Error:** Brief error message.

### Badges & Attribution

- Kind badge: "synced" (green) or "plain" indicator.
- Provider attribution: "via lrclib" / "via genius" / "manual" in bottom corner.

### Search Integration

- When search results include lyrics matches, show a small "lyrics" badge next to the track title in result lists.

## Settings

New "Lyrics" section in the Settings > Providers tab:
- Genius API key input field (optional — provider chain skips Genius if no key configured).
