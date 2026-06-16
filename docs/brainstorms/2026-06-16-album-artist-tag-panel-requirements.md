---
date: 2026-06-16
topic: album-artist-tag-panel
---

# Album / Artist Tag Panel — Requirements

## Summary

Add a single editable **Tags** panel to the album and artist detail pages. It shows the union of tags already carried across the entity's tracks and lets the user apply or remove a tag for all of those tracks at once — instant and DB-only. Tags present on only some tracks render as "partial" chips with a count and a one-click *fill to all*.

## Problem Frame

Tagging a whole album or artist is tedious today. The only way to tag every track of an album is to open its detail page, multi-select the track list (Cmd+A), right-click, and run Bulk Edit — and there is no surface at all that simply shows what tags an album's or artist's tracks already carry. This started as a richer "artist/album tags that tracks inherit" idea, which was dropped: it required new name-keyed storage, a per-track exclusion model, and read-time unions threaded through search, counts, and the file-write path. This proposal keeps the everyday value — see and bulk-apply tags from the album/artist page — without any of that machinery, by operating directly on each track's own tags.

---

## Key Decisions

- **One editable panel, not display + separate action.** The aggregated tag view *is* the bulk control. Adding/removing a chip writes to the whole track set; there is no second "bulk apply" surface to keep in sync.
- **DB-only and optimistic.** Panel edits write to the library database only, update the UI immediately, and revert on failure. They never touch audio-file genre metadata. Baking tags into files stays on the deliberate Bulk Edit path (`BulkEditModal` → `bulk_update_tracks`) for when the user explicitly wants it — that remains the only path that writes genre into files.
- **Partial chips are first-class.** A tag on some-but-not-all tracks shows muted with an `n of m` count, a *fill to all* affordance, and the same remove control. This is what makes the panel a bulk tool rather than a read-only list.
- **Reuse `TagEditor`.** Per the canonical Tag Operations convention, every tag-editing surface uses the shared `TagEditor` chip+autocomplete component and the shared suggestion pool. This panel is a new host for it, not a reimplementation.
- **Artist scope is the whole discography.** The artist panel acts on every track by that artist across all albums (matching the artist detail page's track set), not the currently visible subset.
- **Not inheritance.** No artist/album tag entity, no per-track exclusions, no read-time union in FTS / membership / counts. Tags live only on tracks, exactly as today.

---

## Requirements

**Display**

- R1. The album and artist detail pages render a Tags panel listing the distinct union of tags across that entity's tracks.
- R2. Each tag indicates coverage: a full chip when every track carries it, or a muted partial chip with an `n of m` count when only some do.

**Editing**

- R3. Adding a tag in the panel applies it to all of the entity's tracks (DB-only).
- R4. Removing a tag (the chip's X) removes it from every track of the entity that currently carries it (DB-only).
- R5. A partial chip offers a one-click *fill to all* that applies the tag to the tracks missing it, promoting it to a full chip.
- R6. All panel edits are optimistic with revert-on-failure; every `catch` logs via `console.error`.
- R7. Panel edits never write audio-file genre metadata.

**Navigation, suggestions, reuse**

- R8. Clicking a chip's label opens that Tag's detail page.
- R9. The panel uses the shared `TagEditor` and the shared suggestion pool (library tags ranked by usage plus community tags), consistent with other tag-editing surfaces.
- R10. The album panel operates on that album's tracks; the artist panel operates on the artist's entire track set across all albums. Both act on the same track set the detail page lists for the entity.

**Consistency**

- R11. Applying or removing tags via the panel refreshes the affected tags' `track_count` so the Library tags tab and Tag detail reflect the change without an app restart.

---

## Key Flows

- F1. Apply a tag to the whole entity
  - **Trigger:** User types/picks a tag in the panel input on an album or artist page.
  - **Steps:** Tag is added to all of the entity's tracks in the DB; chip appears immediately as a full chip; affected tag's count refreshes.
  - **Covered by:** R3, R6, R9, R11

- F2. Complete a partial tag
  - **Trigger:** User clicks *fill to all* on a partial chip showing `3 of 5`.
  - **Steps:** Tag is applied to the 2 missing tracks; chip switches from partial to full; count refreshes.
  - **Covered by:** R5, R6, R11

- F3. Remove a tag from the whole entity
  - **Trigger:** User clicks the X on a full or partial chip.
  - **Steps:** Tag is removed from every track of the entity that carries it; chip disappears; count refreshes (tag may drop off the Library list if it now has zero tracks).
  - **Covered by:** R4, R6, R11

---

## Acceptance Examples

- AE1. Tag on all tracks
  - **Given:** An album where all 5 tracks carry `jazz`.
  - **Then:** `jazz` renders as a full chip; its X removes `jazz` from all 5 tracks.
  - **Covers:** R2, R4

- AE2. Tag on some tracks
  - **Given:** An album where 3 of 5 tracks carry `bebop`.
  - **When:** The user clicks *fill to all*.
  - **Then:** `bebop` is applied to the remaining 2 tracks and becomes a full chip; the X instead would have removed it from the 3 that had it.
  - **Covers:** R2, R4, R5

- AE3. Add a new tag, optimistic + revert
  - **Given:** An album with no `live` tag.
  - **When:** The user adds `live` and the backend write fails.
  - **Then:** The chip appears immediately, then reverts; the failure is logged via `console.error`.
  - **Covers:** R3, R6

- AE4. Large artist scope
  - **Given:** An artist with `remastered` on 50 of 300 tracks across several albums.
  - **Then:** The artist panel shows a `50 of 300` partial chip; *fill to all* applies it to the remaining 250 tracks.
  - **Covers:** R5, R10

---

## Scope Boundaries

**Deferred for later**

- Automatically writing panel tags into audio-file genre metadata — use the existing Bulk Edit modal when file-level persistence is wanted.
- Surfacing other entity metadata (likes, properties) in this panel — tags only for now.

**Outside this proposal's identity**

- Artist/album tags as a first-class, inheritable entity: no separate name-keyed storage, no per-track exclusion/override, no read-time union of inherited tags in FTS, tag membership, or counts. Tags remain track-only.

---

## Dependencies / Assumptions

- Reuses `TagEditor`, the shared `buildTagSuggestionPool` / `appendCommunityTags` helpers, and `useCommunityTags`.
- The album/artist detail pages (`src/components/AlbumDetail.tsx`, `src/components/ArtistDetailContent.tsx`) currently have no tag UI — this is a net-new surface on each.
- Tracks on these pages carry library IDs, so writes use IDs directly — no `find_track_by_metadata` resolution is needed.
- The panel acts on the same enabled-collection track set the detail page already lists for the entity (honoring `ENABLED_COLLECTION_FILTER`).
- Aggregation reads the distinct tags across the entity's tracks with per-tag counts to classify full vs partial.

---

## Outstanding Questions

**Deferred to planning**

- Exact placement on each detail page (header region vs a dedicated section under the header), matching the Detail Page Consistency conventions in `.claude/rules/conventions.md` and `.claude/rules/ui.md`.
- Whether to add a batched backend command that applies/removes a tag across a set of track IDs in one transaction, or to loop the existing `plugin_apply_tags` / `replace_track_tags` commands — and the most efficient way to refresh affected `track_count`s (no existing quick-edit path does this today; only startup/sync/download/bulk-update call `recompute_counts`).
- Suggestion-pool details for artist vs album (artist-level community tags vs album/track-level), following the existing `useCommunityTags` gating.
- Performance check for large artists (hundreds of tracks) — DB-only keeps it cheap, but confirm the aggregation query and batched write stay responsive at scale (db-bench has a tag-union gap; may need a new bench case).

---

## Sources / Research

- `.claude/rules/conventions.md` — "Tag Operations" (canonical add/remove via `useTagActions`; `BulkEditModal` is the only file-genre write path; `TagEditor` reuse rule).
- `src/hooks/useTagActions.ts` — DB-only optimistic add (`plugin_apply_tags`) / remove (`replace_track_tags`).
- `src/components/BulkEditModal.tsx`, `bulk_update_tracks` (`src-tauri/src/commands/library.rs`) — the existing multi-track tag + file-genre flow this builds alongside.
- `src-tauri/src/db/tags.rs`, `src-tauri/src/db/tracks.rs` — tag schema, `track_tags`, `get_tags_for_track`, and `recompute_counts` (the count-refresh gap noted in R11).
- `src/utils/tagSuggestions.ts`, `src/hooks/useCommunityTags.ts` — shared suggestion pool and community-tag fetch.
