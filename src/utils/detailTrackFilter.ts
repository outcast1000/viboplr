// Pure helpers for the local filter on the artist / album / tag detail pages'
// track lists. Client-side on purpose, like the playlist detail's: the page has
// already loaded every track it shows, so filtering needs no backend call.

import { normalizeForMatch } from "./normalize";

/** The filter box only shows once a list has more rows than this. Counted over
 *  every row the list draws (library + "Not in library"), and over the
 *  unfiltered list, so the box doesn't vanish while you type in it. */
export const DETAIL_FILTER_MIN_ROWS = 10;

export function showDetailFilter(rowCount: number): boolean {
  return rowCount > DETAIL_FILTER_MIN_ROWS;
}

interface FilterableTrack {
  title: string;
  artist_name: string | null;
  album_title?: string | null;
  album_artist_name?: string | null;
}

/** Normalizes a query once for repeated `trackMatches` calls; "" means no filter. */
export function normalizeFilterQuery(query: string): string {
  return normalizeForMatch(query.trim());
}

/** True when the track's title, artist, album or album artist contains `q`
 *  (already normalized). Case- and accent-insensitive: "bjork" finds "Björk". */
export function trackMatches(t: FilterableTrack, q: string): boolean {
  if (!q) return true;
  return [t.title, t.artist_name, t.album_title, t.album_artist_name]
    .some(field => field != null && normalizeForMatch(field).includes(q));
}

/**
 * Filters a detail page's library rows and its "Not in library" rows together.
 *
 * Missing rows are placed against the *full* list (placing them against the
 * filtered one would make an owned track that's merely hidden look missing),
 * so each kept row's `before` index is remapped onto the filtered list: it
 * becomes the number of kept library rows that preceded its old position.
 * Returns the inputs unchanged for an empty query, keeping their identities.
 */
export function filterDetailRows<T extends FilterableTrack, M extends { track: FilterableTrack; before: number }>(
  tracks: T[],
  missingRows: M[],
  query: string,
): { tracks: T[]; missingRows: M[] } {
  const q = normalizeFilterQuery(query);
  if (!q) return { tracks, missingRows };
  // keptBefore[i] = how many matching library rows sit before index i.
  const keptBefore = new Array<number>(tracks.length + 1);
  keptBefore[0] = 0;
  const kept: T[] = [];
  tracks.forEach((t, i) => {
    const match = trackMatches(t, q);
    if (match) kept.push(t);
    keptBefore[i + 1] = keptBefore[i] + (match ? 1 : 0);
  });
  const keptMissing = missingRows
    .filter(m => trackMatches(m.track, q))
    .map(m => ({ ...m, before: keptBefore[Math.min(Math.max(m.before, 0), tracks.length)] }));
  return { tracks: kept, missingRows: keptMissing };
}
