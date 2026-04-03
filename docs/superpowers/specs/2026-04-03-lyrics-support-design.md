# Lyrics Support Design

## Overview

Add lyrics fetching, storage, display, and search to Viboplr. Lyrics are fetched from external providers using a trait-based fallback chain (same pattern as image providers), stored in a dedicated database table, displayed in the Now Playing View, and indexed for full-text search.

## Backend: Lyric Provider Trait & Chain

### Module Structure

```
src-tauri/src/lyric_provider/
  mod.rs        — LyricProvider trait, LyricFallbackChain, helpers
  lrclib.rs     — LRCLIB provider (synced + plain, free, no API key)
  genius.rs     — Genius provider (plain only, requires API key)
```

### Trait Definition

```rust
pub struct LyricResult {
    pub plain_text: String,
    pub synced_lrc: Option<String>,  // LRC format with timestamps
    pub provider_name: String,
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

### Fallback Chain

`LyricFallbackChain` wraps `Vec<Box<dyn LyricProvider>>`, iterates sequentially, returns first success. Same pattern as `ArtistImageFallbackChain` in `image_provider/mod.rs`.

**Chain order:** LRCLIB → Genius

### Provider Details

**LRCLIB:** GET `https://lrclib.net/api/get?artist_name=X&track_name=Y&duration=Z`. Returns `syncedLyrics` and `plainLyrics` fields. Duration helps disambiguate versions. Free, no API key.

**Genius:** Search API → scrape lyrics from song page HTML. Requires `GENIUS_API_TOKEN` configured in settings. Returns plain text only. Skipped if no API key configured.

## Database

### Lyrics Table

```sql
CREATE TABLE IF NOT EXISTS lyrics (
    id          INTEGER PRIMARY KEY,
    track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    kind        TEXT NOT NULL,           -- "synced" or "plain"
    provider    TEXT NOT NULL,           -- "lrclib", "genius", "manual"
    fetched_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE(track_id)
);
```

- One lyrics row per track (UNIQUE on `track_id`), upserted on re-fetch.
- `kind` describes the format: `"synced"` = LRC with timestamps, `"plain"` = plain text.
- `provider = "manual"` indicates user-edited lyrics. Provider fetches will not overwrite manual lyrics.
- `ON DELETE CASCADE` removes lyrics when the track is deleted.

### Failure Tracking

Reuse the existing `image_fetch_failures` table with `kind = 'lyrics'`. Same `record_failure` / `is_failed` / `clear_failure` pattern. Force refresh clears the failure record.

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

- `rebuild_fts` updated to LEFT JOIN on `lyrics` table, populating `lyrics_text` with `strip_diacritics(plain_text)`. For synced lyrics, timestamps are stripped before indexing.
- When lyrics are fetched for a single track, the FTS entry for that track is incrementally updated (delete + re-insert the row) rather than rebuilding the whole index.

### Search Results

The existing `search_tracks_inner` query matches across all FTS columns unchanged. To indicate "matched in lyrics," a second lightweight query checks `lyrics_text MATCH ?` for the result set and flags those track IDs. The frontend shows a "lyrics" badge on matching results.

## Backend: Commands

| Command | Purpose |
|---------|---------|
| `get_lyrics(track_id)` | Returns stored lyrics from DB, or `None` |
| `fetch_lyrics(track_id, force)` | Triggers provider chain fetch. If `force`, clears failure record and overwrites non-manual lyrics |
| `save_manual_lyrics(track_id, text, kind)` | Saves user-edited lyrics with `provider = "manual"` |
| `reset_lyrics(track_id)` | Deletes lyrics row + clears failure record, then re-fetches from providers |
| `delete_lyrics(track_id)` | Removes lyrics entirely |

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
3. Backend upserts with `provider = "manual"` → updates FTS row → returns updated lyrics.

### Reset

1. User clicks reset button.
2. Frontend calls `reset_lyrics(track_id)`.
3. Backend deletes lyrics row → clears failure record → re-fetches from providers (same as auto-fetch with force).

### Force Refresh

Same as `fetch_lyrics(track_id, force: true)`. Clears failure record, overwrites existing lyrics unless `provider = "manual"`. To overwrite manual lyrics, user must reset first.

## Frontend: Now Playing View

### Layout

Side-by-side column layout in `NowPlayingView.tsx`:
- **Left column:** Existing track info (album art, title, artist, tags, similar artists, etc.).
- **Right column:** Lyrics panel with header, scrollable lyrics content, and provider attribution footer.

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
