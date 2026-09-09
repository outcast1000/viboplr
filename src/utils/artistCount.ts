/**
 * What to write under an artist's name.
 *
 * `track_count` counts tracks that *perform* under the name, which is 0 for an
 * album-artist-only artist — a "Various Artists"-style collective, a DJ-mix
 * curator, or a placeholder like "Unknown Artist" sitting in a file's
 * ALBUMARTIST tag. Those rows are listed because they own an album with tracks
 * in it (backend `artist_visible_clause`), so "0 tracks" is a false statement
 * about a row that demonstrably has music behind it.
 *
 * Albums, not "tracks on albums I own", is the fallback on purpose: the artist
 * detail page builds its track list from `artist_id`, so a row promising
 * "20 tracks" opens a page with an Albums section and no tracks — the same lie,
 * one click later. The album count describes exactly what that page contains.
 */
export function artistCountLabel(artist: {
  track_count: number;
  album_count?: number;
}): string {
  if (artist.track_count > 0) {
    return `${artist.track_count} ${artist.track_count === 1 ? "track" : "tracks"}`;
  }
  const albums = artist.album_count ?? 0;
  return `${albums} ${albums === 1 ? "album" : "albums"}`;
}
