# AllMusic Plugin — Artist Bio Fallback

## Summary

Add an AllMusic plugin that provides artist biographies as a fallback provider when Last.fm (priority 100) and Genius (priority 200) have no data. The plugin scrapes AllMusic's public web pages — searching for the artist, then fetching the biography via an AJAX endpoint — and returns the result as `rich_text` for the existing `artist_bio` info type.

## Motivation

Some artists have AllMusic biographies but lack Last.fm or Genius descriptions. Adding AllMusic as a third provider in the `artist_bio` chain increases coverage with no UI changes required.

## Files

- `src-tauri/plugins/allmusic/manifest.json` — Plugin manifest
- `src-tauri/plugins/allmusic/index.js` — Plugin logic

No backend (Rust) or frontend (React) changes needed. The plugin system handles registration, caching, and display.

## Manifest

```json
{
  "id": "allmusic",
  "name": "AllMusic",
  "version": "1.0.0",
  "author": "Viboplr",
  "description": "Artist biographies from AllMusic",
  "minAppVersion": "0.9.4",
  "contributes": {
    "informationTypes": [
      {
        "id": "artist_bio",
        "name": "About",
        "entity": "artist",
        "displayKind": "rich_text",
        "ttl": 7776000,
        "order": 200,
        "priority": 300
      }
    ]
  }
}
```

Key fields:
- `id: "artist_bio"` — Shared with Last.fm and Genius, forming a provider chain.
- `priority: 300` — Tried after Last.fm (100) and Genius (200).
- `ttl: 7776000` — 90-day cache, matching Genius.

## Plugin Flow

### 1. Search (`searchArtist`)

- **Request**: `GET https://www.allmusic.com/search/artists/{encodedName}`
- **Parse**: Regex-extract the first `href="/artist/{slug}-{mnId}"` from the HTML. The AllMusic ID format is `mn` followed by 10 digits (e.g., `mn0000326249`).
- **Return**: `{ id: "mn0000326249", url: "https://www.allmusic.com/artist/radiohead-mn0000326249" }` or `null`.

### 2. Fetch Biography (`getArtistBio`)

- **Request**: `GET https://www.allmusic.com/artist/{mnId}/biographyAjax`
  - This AJAX endpoint returns an HTML fragment (not a full page) containing the biography within `<div id="biography">`.
- **Parse**:
  1. Extract the author from the `<h2>` tag (pattern: `"by Author Name"`).
  2. Strip `<span class="inlineImage ...">...</span>` blocks (album cover images embedded in the text).
  3. Strip HTML tags from `<a>` elements but keep their inner text.
  4. Extract `<p>` tag contents from within the biography div.
  5. First paragraph becomes `summary`. All paragraphs joined become `full`.
- **Return**: `{ summary, full, _meta: { url, providerName: "AllMusic" } }` or `null` if no biography content found.

### 3. onFetch Handler

```
onFetch("artist_bio", entity) ->
  if entity.kind !== "artist" -> { status: "not_found" }
  searchArtist(entity.name) -> found or null
  if !found -> { status: "not_found" }
  getArtistBio(found.id, found.url) -> result or null
  if !result -> { status: "not_found" }
  return { status: "ok", value: result }
  on error -> { status: "error" }
```

## HTML Parsing Details

The `biographyAjax` response has this structure:

```html
<div id="biography" class="artistContentSubModule">
  <h2>Artist Name Biography
    by Author Name</h2>
  <p>
    <span class="inlineImage odd">
      <a href="/album/..."><img ...></a>
    </span>
    Biography text with <a href="/artist/...">linked names</a>...
  </p>
  <p>More paragraphs...</p>
</div>
```

Regex strategy:
1. `/<div id="biography"[^>]*>([\s\S]*?)(?:<\/div>\s*<div|$)/` — isolate biography div content.
2. `/<span class="inlineImage[\s\S]*?<\/span>/g` — remove inline album images.
3. `/<h2>([\s\S]*?)<\/h2>/` — extract and remove the heading; parse author with `/by\s+(.+)$/`.
4. `/<p[^>]*>([\s\S]*?)<\/p>/g` — extract paragraph contents.
5. `/<[^>]+>/g` — strip remaining HTML tags to get plain text.
6. Trim whitespace and collapse multiple spaces/newlines.

## Error Handling

- Network failures or non-200 responses: caught by `.catch()`, returns `{ status: "error" }`.
- No search results or empty biography: returns `{ status: "not_found" }`.
- Follows the same pattern as the Genius plugin.

## Testing

- Verify search returns correct artist for common names (e.g., "Radiohead", "The Beatles").
- Verify biography extraction produces clean text without HTML artifacts or inline image remnants.
- Verify the plugin only activates when Last.fm and Genius return `not_found` (priority chain behavior).
- Verify `_meta.url` links to the correct AllMusic artist page.
