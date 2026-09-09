/**
 * Is this artist name a tagger placeholder rather than a real musician?
 * Compilations and untagged rips file under such a name (`albums.artist_id`
 * holds the ALBUMARTIST), so it appears as a navigable artist — but external
 * metadata services have no meaningful entity for it: Last.fm's "Various
 * Artists" and "Unknown Artist" pages are junk catch-alls whose bio, similar
 * artists and scrobble stats describe nothing. Surfaces that fetch per-artist
 * metadata (the artist detail's info sections and title line) use this to skip
 * those lookups; library-derived content (albums, tracks) is unaffected.
 *
 * Two kinds of placeholder, one rule — the name stands for *no single
 * musician*, so there is nothing to look up:
 *   - a **collective**: many artists (MusicBrainz/Picard, iTunes, beets)
 *   - **unknown**: no artist known (iTunes, Windows Media Player, most rippers
 *     write this into ALBUMARTIST when the tag is absent rather than leaving it
 *     empty, which is why the scanner's blank-tag filter doesn't catch it)
 *
 * Matching is case-insensitive on the trimmed name and **exact** — deliberately
 * conservative, since a false positive suppresses external-metadata sections
 * for a real artist's page. This is display-only suppression: such a name still
 * keys its album, and the row is still listed and navigable.
 */
const PLACEHOLDER_NAMES = new Set([
  // Collectives
  "various artists",
  "various",
  "va",
  "v.a.",
  "v/a",
  // Unknown
  "unknown artist",
  "unknown",
  "[unknown]",
  "<unknown>",
]);

export function isVariousArtists(name: string | null | undefined): boolean {
  if (!name) return false;
  return PLACEHOLDER_NAMES.has(name.trim().toLowerCase());
}
