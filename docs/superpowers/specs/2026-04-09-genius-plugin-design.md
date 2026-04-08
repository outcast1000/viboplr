# Genius Song Explanation Plugin — Design Spec

## Goal

Create a Genius plugin that provides song explanations (track), artist descriptions, and album descriptions through the existing information types plugin system. All parsing logic lives in the plugin's JavaScript; the Rust backend is used only as an HTTP proxy. The existing hardcoded Genius integration (`genius.rs`, `TrackDetailView.tsx`) is removed.

## Architecture

The plugin follows the same pattern as the Last.fm plugin: a frontend JavaScript plugin under `src-tauri/plugins/genius/` that declares information types in its manifest and registers `onFetch` handlers via the plugin API. All HTTP requests go through `api.network.fetch()` (which proxies through the Rust `plugin_fetch` command). A new `annotations` displayKind and renderer are added for the track song explanation, which preserves the existing visual treatment (left accent border, italic lyric fragments, explanation text).

## Plugin: `src-tauri/plugins/genius/`

### manifest.json

Declares 3 information types:

| id | entity | displayKind | name | ttl | order |
|----|--------|-------------|------|-----|-------|
| `genius_song_explanation` | track | `annotations` | Song Explanation | 7776000 (90d) | 50 |
| `genius_artist_description` | artist | `rich_text` | Description | 7776000 (90d) | 50 |
| `genius_album_description` | album | `rich_text` | Description | 7776000 (90d) | 50 |

### index.js

All API calls hit Genius's internal web API (no auth required):

**Search functions:**
- `searchSong(api, artist, title)` — `GET genius.com/api/search/multi?q={title} {artist}` — filters for `hit_type === "song"`, loose artist name matching (case-insensitive substring). Returns `{ id, url }` or null.
- `searchArtist(api, name)` — same endpoint, filters for `hit_type === "artist"`. Returns `{ id, url }` or null.
- `searchAlbum(api, artist, title)` — same endpoint, filters for `hit_type === "album"`. Returns `{ id, url }` or null.

**Data fetching:**
- `getSongExplanation(api, songId)` — two calls:
  1. `GET genius.com/api/songs/{songId}` — extracts `description_preview` as overview
  2. `GET genius.com/api/referents?song_id={songId}&per_page=50&text_format=plain` — extracts annotations, filters out section headers like `[Verse 1]`
  - Returns `AnnotationsData` with `_meta: { url, providerName: "Genius" }`

- `getArtistDescription(api, artistId)` — `GET genius.com/api/artists/{artistId}` — extracts artist description as HTML.
  - Returns `RichTextData` with `_meta: { url, providerName: "Genius" }`

- `getAlbumDescription(api, albumId)` — `GET genius.com/api/albums/{albumId}` — extracts album description as HTML.
  - Returns `RichTextData` with `_meta: { url, providerName: "Genius" }`

**onFetch handlers** — registered for each information type, orchestrate search + fetch, return `{ status: "ok", value }` or `{ status: "not_found" }`.

## New DisplayKind: `annotations`

### Type definition (in `informationTypes.ts`)

```typescript
export interface AnnotationsData {
  overview?: string;
  annotations: Array<{
    fragment: string;
    explanation: string;
  }>;
}
```

Added to `DisplayKind` union. Placement: `"below"` (long-form content needs full width).

### Renderer: `AnnotationsRenderer.tsx`

New file at `src/components/renderers/AnnotationsRenderer.tsx`.

Visual treatment (matching existing Genius UI):
- Overview paragraph at top if present
- Each annotation:
  - 3px left border in semi-transparent accent color
  - 10px left padding
  - Fragment: italic, `var(--fs-sm)`, `var(--text-primary)`, 4px bottom margin
  - Explanation: `var(--fs-xs)`, `var(--text-secondary)`
- 12px vertical gap between annotations

CSS added to `src/components/renderers/renderers.css`.

Registered in `src/components/renderers/index.ts` renderer map.

## Cleanup: Remove Hardcoded Genius Integration

### Rust backend removals
- Delete `src-tauri/src/genius.rs`
- Remove `mod genius;` from `lib.rs`
- Remove `get_genius_explanation` command registration from `commands.rs` (the command function and its entry in the invoke handler)
- Remove `genius-explanation` event emission
- Check if `urlencoding` crate is used elsewhere; if not, remove from `Cargo.toml`

### Frontend removals
- `TrackDetailView.tsx`: Remove `geniusExplanation` state, `geniusLoading` state, the `get_genius_explanation` invoke call, the `genius-explanation` event listener, and the Genius rendering block
- `TrackDetailView.css`: Remove `.genius-*` CSS classes (`.genius-link`, `.genius-about`, `.genius-annotations`, `.genius-annotation`, `.genius-annotation-fragment`, `.genius-annotation-explanation`)

## Data Flow

1. User views a track/artist/album detail page
2. `useInformationTypes` queries registered info types for that entity kind
3. Checks cache (`info_get_values_for_entity`); renders cached data if fresh
4. Calls `invokeInfoFetch("genius", typeId, entity)` if stale or missing
5. Plugin's onFetch handler runs: search Genius, fetch data, parse response
6. Returns `{ status: "ok", value }` — cached via `info_upsert_value`
7. `InformationSections` renders via the appropriate renderer (`AnnotationsRenderer` for tracks, `RichTextRenderer` for artist/album)

## Files Changed

| File | Action |
|------|--------|
| `src-tauri/plugins/genius/manifest.json` | Create |
| `src-tauri/plugins/genius/index.js` | Create |
| `src/types/informationTypes.ts` | Add `annotations` to DisplayKind, add `AnnotationsData`, add to placement map |
| `src/components/renderers/AnnotationsRenderer.tsx` | Create |
| `src/components/renderers/renderers.css` | Add `.renderer-annotations` styles |
| `src/components/renderers/index.ts` | Register `annotations` renderer |
| `src-tauri/src/genius.rs` | Delete |
| `src-tauri/src/lib.rs` | Remove `mod genius;` |
| `src-tauri/src/commands.rs` | Remove `get_genius_explanation` command |
| `src/components/TrackDetailView.tsx` | Remove Genius state, invoke, listener, rendering |
| `src/components/TrackDetailView.css` | Remove `.genius-*` styles |
