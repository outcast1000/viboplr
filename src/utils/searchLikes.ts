// Like/dislike plumbing shared by the two quick-search surfaces (the caption-bar
// dropdown and the mini-player panel). Both hold a transient `SearchAllResults`
// copy of rows the library also knows about, so a heart click has to do two
// things: patch the local copy so the row reacts immediately, and hand the
// write to the canonical `useLikeActions` handler, which persists it and mirrors
// it into the library / queue / now-playing state. Neither surface may call
// `set_entity_like_state` itself.
import type { Track, SearchAllResults } from "../types";
import { nextTriState } from "../likeKeys";

/** The canonical handlers a quick search needs — the relevant subset of what
 *  `useLikeActions` returns, by id for artists/albums (their handlers look the
 *  entity up in library state) and by row for tracks. A `type`, not an
 *  `interface`, so it satisfies `useStableCallbacks`' `Record<string, fn>`. */
export type SearchLikeDeps = {
  onToggleTrackLike: (track: Track) => void;
  onToggleTrackDislike: (track: Track) => void;
  onToggleArtistLike: (artistId: number) => void;
  onToggleArtistDislike: (artistId: number) => void;
  onToggleAlbumLike: (albumId: number) => void;
  onToggleAlbumDislike: (albumId: number) => void;
};

/** What a results list renders against: every callback takes the row, so the
 *  component never has to know which handlers key on id and which on row. */
export interface SearchLikeHandlers {
  toggleTrackLike: (track: Track) => void;
  toggleTrackDislike: (track: Track) => void;
  toggleArtistLike: (artistId: number) => void;
  toggleArtistDislike: (artistId: number) => void;
  toggleAlbumLike: (albumId: number) => void;
  toggleAlbumDislike: (albumId: number) => void;
}

export type SearchLikeKind = "track" | "artist" | "album";

/** Optimistically advance one row's `liked` inside a results snapshot, using
 *  the same tri-state cycle the canonical handlers apply (`nextTriState`) so
 *  the local copy lands on exactly the value the write will persist. Rows of
 *  other kinds and other ids come back by reference. */
export function patchSearchResultsLike(
  results: SearchAllResults,
  kind: SearchLikeKind,
  id: number,
  action: "like" | "dislike",
): SearchAllResults {
  // `Track.id` is `number | null` in the type (a metadata-only entry has none),
  // but every row `search_all` returns is a library row with an id.
  const step = <T extends { id: number | null; liked: number }>(rows: T[]): T[] =>
    rows.map((r) => (r.id === id ? { ...r, liked: nextTriState(r.liked, action) } : r));
  switch (kind) {
    case "track": return { ...results, tracks: step(results.tracks) };
    case "artist": return { ...results, artists: step(results.artists) };
    case "album": return { ...results, albums: step(results.albums) };
  }
}

/** Build the row-level handlers for a results list: patch the snapshot through
 *  `setResults`, then run the canonical write. Returns undefined when no deps
 *  are wired, so a surface without like support renders no hearts at all
 *  rather than dead buttons. */
export function buildSearchLikeHandlers(
  deps: SearchLikeDeps | undefined,
  setResults: (fn: (prev: SearchAllResults) => SearchAllResults) => void,
): SearchLikeHandlers | undefined {
  if (!deps) return undefined;
  const patch = (kind: SearchLikeKind, id: number, action: "like" | "dislike") =>
    setResults((prev) => patchSearchResultsLike(prev, kind, id, action));
  // A search row always carries its library id; the null guard is for the type.
  const patchTrack = (t: Track, action: "like" | "dislike") => {
    if (t.id != null) patch("track", t.id, action);
  };
  return {
    toggleTrackLike: (t) => { patchTrack(t, "like"); deps.onToggleTrackLike(t); },
    toggleTrackDislike: (t) => { patchTrack(t, "dislike"); deps.onToggleTrackDislike(t); },
    toggleArtistLike: (id) => { patch("artist", id, "like"); deps.onToggleArtistLike(id); },
    toggleArtistDislike: (id) => { patch("artist", id, "dislike"); deps.onToggleArtistDislike(id); },
    toggleAlbumLike: (id) => { patch("album", id, "like"); deps.onToggleAlbumLike(id); },
    toggleAlbumDislike: (id) => { patch("album", id, "dislike"); deps.onToggleAlbumDislike(id); },
  };
}
