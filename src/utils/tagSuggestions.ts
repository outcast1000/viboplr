/**
 * Pure helper that builds the ranked tag-suggestion pool for the TagEditor.
 * Library tags first (most-used by track_count), then community tags not
 * already present (case-insensitive). Order is preserved so a downstream
 * filterSuggestions() keeps the frequency ranking.
 */
export interface LibraryTagLike {
  name: string;
  track_count: number;
}

export interface CommunityTagLike {
  name: string;
}

/**
 * Append community tag names to an already-ranked pool of names, skipping any
 * that are already present (case-insensitive) and de-duplicating among the
 * community tags themselves. Order is preserved: pool first, then the new
 * community names in their given order.
 *
 * Used by every tag-editing surface that already has a ranked library pool of
 * strings (BulkEditModal, the Now Playing TagPopover) and wants to fold in
 * Last.fm community/artist tags fetched on demand.
 */
export function appendCommunityTags(
  pool: string[],
  communityTags: CommunityTagLike[],
): string[] {
  const seen = new Set(pool.map((p) => p.toLowerCase()));
  const out = [...pool];
  for (const t of communityTags) {
    const lower = t.name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(t.name);
  }
  return out;
}

/**
 * Aggregate community-tag lists from several artists/tracks into one ranked list.
 * A tag that appears for more of the input lists ranks higher (so shared genres
 * bubble to the top of a mixed selection); ties keep first-seen order. Counts
 * each list at most once per tag, and de-duplicates case-insensitively while
 * preserving the original casing of the first occurrence.
 */
export function rankCommunityTags(lists: CommunityTagLike[][]): CommunityTagLike[] {
  const count = new Map<string, number>();
  const firstSeen = new Map<string, { name: string; order: number }>();
  let order = 0;
  for (const list of lists) {
    const seenInList = new Set<string>();
    for (const t of list) {
      const lower = t.name.toLowerCase();
      if (!firstSeen.has(lower)) firstSeen.set(lower, { name: t.name, order: order++ });
      if (seenInList.has(lower)) continue;
      seenInList.add(lower);
      count.set(lower, (count.get(lower) ?? 0) + 1);
    }
  }
  return [...firstSeen.entries()]
    .sort((a, b) => (count.get(b[0])! - count.get(a[0])!) || (a[1].order - b[1].order))
    .map(([, v]) => ({ name: v.name }));
}

/**
 * Pick the one-click suggestion pills to show below a TagEditor: the suggested
 * names minus any already-applied tag (case-insensitive), de-duplicated among
 * themselves, capped at `max`. Order is preserved.
 */
export function selectSuggestionPills(
  suggested: string[],
  applied: string[],
  max: number,
): string[] {
  const seen = new Set(applied.map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const name of suggested) {
    if (out.length >= max) break;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(name);
  }
  return out;
}

export function buildTagSuggestionPool(
  libraryTags: LibraryTagLike[],
  communityTags: CommunityTagLike[],
): string[] {
  const sorted = [...libraryTags].sort((a, b) => b.track_count - a.track_count);
  const libPool: string[] = [];
  const seen = new Set<string>();
  for (const t of sorted) {
    const lower = t.name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    libPool.push(t.name);
  }
  return appendCommunityTags(libPool, communityTags);
}
