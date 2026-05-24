export interface AlbumLite {
  id: number;
  title: string;
  year: number | null;
  artist_id: number;
  artist_name: string;
}

export interface TopArtistRow {
  name: string;
  track_count: number;
}

export interface ArtistAlbumHeroResult {
  resolved: string[];
  pending: Array<{ title: string; artistName: string }>;
}

export interface TagTopArtistHeroResult {
  resolved: string[];
  pending: string[];
}

export function selectArtistAlbumHeroImages(
  albums: AlbumLite[],
  artistId: number,
  resolveAlbumImage: (title: string, artistName: string) => string | null,
  max: number,
): ArtistAlbumHeroResult {
  const owned = albums.filter(a => a.artist_id === artistId);
  // Stable sort: year asc (null = 0), then id asc as tiebreaker.
  const sorted = [...owned].sort((a, b) => {
    const ay = a.year ?? 0;
    const by = b.year ?? 0;
    if (ay !== by) return ay - by;
    return a.id - b.id;
  });
  const slice = sorted.slice(0, max);
  const resolved: string[] = [];
  const pending: Array<{ title: string; artistName: string }> = [];
  for (const album of slice) {
    const path = resolveAlbumImage(album.title, album.artist_name);
    if (path) resolved.push(path);
    else pending.push({ title: album.title, artistName: album.artist_name });
  }
  return { resolved, pending };
}

export function selectTagTopArtistHeroImages(
  topArtists: TopArtistRow[],
  resolveArtistImage: (name: string) => string | null,
): TagTopArtistHeroResult {
  const resolved: string[] = [];
  const pending: string[] = [];
  for (const row of topArtists) {
    const path = resolveArtistImage(row.name);
    if (path) resolved.push(path);
    else pending.push(row.name);
  }
  return { resolved, pending };
}
