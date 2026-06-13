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

export function buildTagSuggestionPool(
  libraryTags: LibraryTagLike[],
  communityTags: CommunityTagLike[],
): string[] {
  const sorted = [...libraryTags].sort((a, b) => b.track_count - a.track_count);
  const pool: string[] = [];
  const seen = new Set<string>();
  for (const t of sorted) {
    const lower = t.name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    pool.push(t.name);
  }
  for (const t of communityTags) {
    const lower = t.name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    pool.push(t.name);
  }
  return pool;
}
