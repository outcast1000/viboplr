import type { HomeShelfItem } from "../types/plugin";

// Names the Home card a loading play came from (LoadingPlay.originKey), so
// that card can show it loading while the queue panel and the bar do too.
// The click site and the card compute it the same way; a playlist card's own
// id wins over its name, since two cards may share a name.
export function homeCardOriginKey(shelfId: string, item: HomeShelfItem): string {
  const it = item as { id?: string; name?: string; track?: { title?: string } };
  const identity = it.id ?? it.name ?? it.track?.title ?? "";
  return `${shelfId}\u0000${identity}`;
}
