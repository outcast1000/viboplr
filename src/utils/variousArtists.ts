/**
 * Is this artist name a "Various Artists"-style collective rather than a real
 * musician? Compilations file under such a name (`albums.artist_id` holds the
 * ALBUMARTIST), so it appears as a navigable artist — but external metadata
 * services have no meaningful entity for it: Last.fm's "Various Artists" page
 * is a junk catch-all whose bio/similar/stats describe nothing. Surfaces that
 * fetch per-artist metadata (the artist detail's info sections and title line)
 * use this to skip those lookups; library-derived content (albums, tracks) is
 * unaffected.
 *
 * The set mirrors common tagger conventions (MusicBrainz/Picard, iTunes,
 * beets): "Various Artists" plus its usual abbreviations. Matching is
 * case-insensitive on the trimmed name. Deliberately conservative — a false
 * positive only suppresses external-metadata sections for that one page.
 */
const COLLECTIVE_NAMES = new Set([
  "various artists",
  "various",
  "va",
  "v.a.",
  "v/a",
]);

export function isVariousArtists(name: string | null | undefined): boolean {
  if (!name) return false;
  return COLLECTIVE_NAMES.has(name.trim().toLowerCase());
}
