---
date: 2026-06-23
topic: subsonic-unified-search
---

# Subsonic Browse — Unified Tabbed Search

## Summary

Give the `subsonic-browse` plugin a single search box that returns Tracks, Albums, and Artists under tabs, modeled on the library's SearchView. Album and artist cards drill into an in-plugin detail sub-view; a play button on each card plays immediately. Extends the existing plugin — no core app change required.

---

## Problem Frame

The plugin is named "Browse" but today it only does flat **song** search: one query, one row list of tracks (`src-tauri/plugins/subsonic-browse/index.js` hard-zeros `artistCount`/`albumCount` in its `search3` call at `index.js:281`). A user who wants to find an album or an artist across their registered servers can't — they have to know a song title. Meanwhile the rest of the app trains users on the library SearchView's tabbed Tracks/Artists/Albums/Tags surface, so the plugin's single list feels foreign. The data is already there: `search3` returns artists, albums, and songs in one call; the plugin just discards two-thirds of it.

---

## Key Decisions

- **Hybrid card interaction (matches the library/Home convention).** Card body click drills into a detail sub-view; a hover play button plays all of that entity's tracks. Chosen over play-on-click so albums/artists are browseable, not just play shortcuts.
- **Three tabs, not four.** Tracks / Albums / Artists. No Tags tab — `search3` returns no tag/genre results, so there's nothing to populate it.
- **Two-level drill for artists.** Artist → their albums (grid) → an album's tracks. Mirrors how the library nests; the trade-off is one extra tap to reach a song versus a flat artist track list.
- **Cross-server merge extends to albums and artists.** Albums dedup by normalized (artist + title), artists by normalized name — the same dedup, "N servers" affordance, and healthy-server failover the tracks already use.
- **Search-driven, not browse-all.** Tabs and results appear only after a query, mirroring SearchView's empty state. No "list every album on a server."
- **Extend the existing plugin; no core change.** `card-grid` already has a play-button-vs-body-click split (`src/components/pluginViews.tsx:148-158`), `tabs` auto-hoist above the scroll area, and `scrollKey` gives per-view scroll memory. Sub-views render by swapping the plugin's single-view content (the Spotify drill-in pattern), not via new sidebar items.

---

## Requirements

**Search & results**

- R1. A single query box in the Subsonic Servers view searches all registered servers in parallel and returns tracks, albums, and artists from one `search3` call per server (song/album/artist counts all non-zero), reusing the existing per-server timeout and up/down tracking.
- R2. Results render only after a search runs. Before that, the view shows a placeholder, mirroring the library SearchView's empty state.

**Tabbed results UI**

- R3. Results display under three tabs — Tracks, Albums, Artists — each labeled with its result count. No Tags tab.
- R4. Tracks render as a row list; Albums and Artists render as image-card grids. Active tab and per-tab scroll position are preserved as the user switches tabs and enters/leaves detail views.

**Card interaction**

- R5. Clicking a track plays it within the current result set's queue context (existing behavior, preserved).
- R6. Clicking an album or artist card body opens its in-plugin detail sub-view. A play button on the card plays all of that entity's tracks immediately, without leaving the results.

**Detail sub-views**

- R7. Album detail shows the album's track list (fetched on demand via `getAlbum`) with per-track play and a back affordance to the results.
- R8. Artist detail shows the artist's albums as a card grid (fetched via `getArtist`); clicking an album there opens its album detail per R7. A back affordance returns to the results.
- R9. Detail sub-views render inside the plugin's single sidebar view by swapping its content (the Spotify drill-in pattern), not by registering additional sidebar items.

**Cross-server behavior**

- R10. Albums merge across servers by normalized (artist + title); artists merge by normalized name. A merged card indicates it spans N servers, and drilling in or playing resolves against a healthy server, failing over when one is down.

**Playback & download integration**

- R11. Tracks surfaced from any tab or detail view carry the existing `xsonic://` scheme and flow through the current stream resolver, download provider, and scrobble-back paths unchanged.

---

## Key Flows

- F1. Unified search
  - **Trigger:** User types a query and submits in the Subsonic Servers view.
  - **Steps:** Plugin fans out one `search3` per server (artists + albums + songs) → merges and dedups each type across servers → renders Tracks/Albums/Artists tabs with counts.
  - **Covered by:** R1, R2, R3, R4, R10.

- F2. Album drill-in and play
  - **Trigger:** User clicks an album card (body) or its play button.
  - **Steps:** Body click → fetch `getAlbum` for a healthy server → render the album's track list with a back affordance. Play button → play all the album's tracks immediately, results view unchanged.
  - **Covered by:** R6, R7, R10, R11.

- F3. Artist → album → tracks
  - **Trigger:** User clicks an artist card body.
  - **Steps:** Fetch `getArtist` → render the artist's albums as a grid → user clicks an album → album detail (F2 album branch) → user plays a track.
  - **Covered by:** R6, R8, R7, R11.

---

## Acceptance Examples

- AE1. **Covers R2.** Empty / not-yet-searched view shows the placeholder and no tabs; tabs appear only once a search has run.
- AE2. **Covers R6.** Clicking an album card body opens its track list; clicking the album card's play button plays the album and leaves the user on the results tabs.
- AE3. **Covers R10.** The same album indexed on two servers shows as one card labeled "2 servers"; if the primary server is down when the user plays it, playback resolves from the other server.
- AE4. **Covers R8.** An artist with multiple albums opens to an album grid (not a flat track list); selecting an album opens that album's tracks.

---

## Scope Boundaries

- No Tags / genre tab — `search3` returns none.
- No browse-without-search (no "list all albums", no alphabetical browse). The surface stays query-driven.
- Results still never enter the library — this remains a live discovery layer, distinct from a `subsonic` collection.
- No per-tab view-mode toggle (table / list / tiles). Rendering is fixed: rows for tracks, card grids for albums/artists.

---

## Dependencies / Assumptions

- Reuses the `card-grid` node's existing play-button affordance, which is currently keyed to a `play-playlist` context action (`src/components/pluginViews.tsx:148-158`). If album/artist cards need a neutral play action id rather than overloading `play-playlist`, that's a small renderer generalization decided at planning.
- Assumes target servers expose the standard `getAlbum`, `getArtist`, and `getSong` endpoints. The plugin already relies on `search3`, `stream`, `download`, `scrobble`, and `getCoverArt`, so this is the same Subsonic API surface.

---

## Outstanding Questions

**Deferred to Planning**

- The in-plugin view-state model: how `activeTab`, the current drill target, and back navigation are held and re-rendered through `setViewData` / `scrollKey`.
- Whether the card play button reuses the existing `play-playlist` action id or warrants generalizing the renderer to a neutral play id (see Dependencies).
- Whether artist detail also surfaces the artist's loose songs from the original search result alongside their albums. Default: albums only.

---

## Sources / Research

- Grounding dossier (verbatim quotes with `file:line` pointers): `/tmp/compound-engineering/ce-brainstorm/subsonic-unified-search/grounding.md`
- Current plugin (search/play/resolvers, `search3` count-zeroing): `src-tauri/plugins/subsonic-browse/index.js`
- Library tabbed search to mirror (tabs, counts, empty state): `src/components/SearchView.tsx`
- Plugin view node types — `tabs`, `card-grid` (play vs body click), `track-row-list`: `src/components/pluginViews.tsx`, `src/types/plugin.ts`
- Drill-in precedent (sub-views within one sidebar view): `src-tauri/plugins/spotify-browse/index.js`
