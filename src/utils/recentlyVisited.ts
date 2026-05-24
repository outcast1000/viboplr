export type RecentlyVisitedKind = "album" | "artist";

export interface RecentlyVisitedEntry {
  kind: RecentlyVisitedKind;
  id: number;
  ts: number;
}

const MAX_RECENTLY_VISITED = 20;

export function recordVisit(
  prev: RecentlyVisitedEntry[],
  entry: RecentlyVisitedEntry,
): RecentlyVisitedEntry[] {
  const filtered = prev.filter((e) => !(e.kind === entry.kind && e.id === entry.id));
  filtered.push(entry);
  if (filtered.length > MAX_RECENTLY_VISITED) {
    return filtered.slice(filtered.length - MAX_RECENTLY_VISITED);
  }
  return filtered;
}
