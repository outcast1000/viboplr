// Pure filter/sort helpers for the playlist detail track list (PlaylistsView).
// Client-side on purpose: a playlist's tracks are already fully loaded, so —
// unlike the Library, which pages through the DB — search and sort here are
// instant with no backend round-trip.

import type { SortKey } from "../sortChain";
import { seededRandom } from "../hooks/useEntityDetail";
import { isVideoTrack } from "../utils";

export interface PlaylistTrackListItem {
  title: string;
  artist_name: string | null;
  album_name: string | null;
  duration_secs: number | null;
  source: string | null;
  liked?: number;
}

export type TrackMediaFilter = "all" | "audio" | "video";

/**
 * Instant text + media-type filter. Text matches title/artist/album,
 * case-insensitively. Media type is judged from the source path's extension
 * (playlist rows carry no format), so an extension-less stream counts as audio.
 */
export function filterPlaylistTracks<T extends PlaylistTrackListItem>(
  tracks: T[],
  query: string,
  media: TrackMediaFilter,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q && media === "all") return tracks;
  return tracks.filter((t) => {
    if (media !== "all" && (media === "video") !== isVideoTrack({ format: null, path: t.source })) return false;
    if (!q) return true;
    return (
      t.title.toLowerCase().includes(q) ||
      (t.artist_name?.toLowerCase().includes(q) ?? false) ||
      (t.album_name?.toLowerCase().includes(q) ?? false)
    );
  });
}

/**
 * Multi-key sort over the detail view's chain (fields: "title", "artist",
 * "album", "duration", "liked"). An empty chain keeps the playlist's own
 * order; ties keep it too (Array.sort is stable). A leading "random" key is a
 * seeded shuffle — deterministic per `shuffleKey`, re-rolled only when the
 * caller bumps it (never Math.random(); see useEntityDetail.seededRandom).
 * Unknown fields compare equal rather than throwing.
 */
export function sortPlaylistTracks<T extends PlaylistTrackListItem>(
  tracks: T[],
  chain: SortKey[],
  shuffleKey: number,
): T[] {
  if (chain.length === 0) return tracks;
  if (chain[0].field === "random") {
    const rand = seededRandom(shuffleKey);
    const shuffled = [...tracks];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
  const sorted = [...tracks];
  sorted.sort((a, b) => {
    for (const k of chain) {
      let cmp = 0;
      if (k.field === "title") cmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      else if (k.field === "artist") cmp = (a.artist_name ?? "").localeCompare(b.artist_name ?? "", undefined, { sensitivity: "base" });
      else if (k.field === "album") cmp = (a.album_name ?? "").localeCompare(b.album_name ?? "", undefined, { sensitivity: "base" });
      else if (k.field === "duration") cmp = (a.duration_secs ?? 0) - (b.duration_secs ?? 0);
      else if (k.field === "liked") cmp = (a.liked ?? 0) - (b.liked ?? 0);
      if (cmp !== 0) return k.dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
  return sorted;
}
