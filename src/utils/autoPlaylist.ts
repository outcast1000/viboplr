// Pure helpers for classifying playlists by their `system_kind`.
//
// Three playlist classes share the `playlists` table:
//   - protected system playlists: system_kind === "liked" | "disliked"
//     (undeletable, tracks projected live from entity_likes)
//   - algorithmic "auto" playlists: system_kind starts with "auto:"
//     (deletable, tracks materialized as a snapshot, regenerated on a 24h cadence)
//   - user playlists: system_kind == null
//
// Extracted from PlaylistsView so the classification/ordering logic is unit-testable.

export interface PlaylistLike {
  system_kind: string | null;
  metadata?: string | null;
}

/** An algorithmic auto-playlist (Daily Mix, genre, decade, discovery). */
export function isAuto(p: PlaylistLike): boolean {
  return !!p.system_kind && p.system_kind.startsWith("auto:");
}

/** A protected, undeletable system playlist (Liked / Disliked Tracks). */
export function isProtectedSystem(p: PlaylistLike): boolean {
  return p.system_kind === "liked" || p.system_kind === "disliked";
}

/**
 * List ordering: protected system first, then auto mixes, then user playlists.
 * Lower rank sorts first.
 */
export function playlistRank(p: PlaylistLike): number {
  if (p.system_kind === "liked") return 0;
  if (p.system_kind === "disliked") return 1;
  if (isAuto(p)) return 2;
  return 3;
}

/** The recipe encoded in an auto-playlist's metadata JSON (best-effort). */
export type AutoRecipe = "daily-mix" | "genre" | "decade" | "discovery" | "unknown";

/**
 * Parse the recipe label from an auto-playlist's metadata JSON. Tolerant of
 * missing/malformed metadata — returns "unknown" rather than throwing.
 */
export function parseRecipe(metadata: string | null | undefined): AutoRecipe {
  if (!metadata) return "unknown";
  try {
    const parsed = JSON.parse(metadata) as { recipe?: string };
    switch (parsed?.recipe) {
      case "daily-mix":
      case "genre":
      case "decade":
      case "discovery":
        return parsed.recipe;
      default:
        return "unknown";
    }
  } catch {
    return "unknown";
  }
}

/**
 * The mix's first track artist, recorded in metadata at materialization. Used to
 * resolve the auto-playlist's cover image. Tolerant of missing/malformed metadata.
 */
export function firstArtist(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const m = JSON.parse(metadata) as { first_artist?: unknown };
    return typeof m?.first_artist === "string" && m.first_artist ? m.first_artist : null;
  } catch {
    return null;
  }
}

/**
 * The featured artists recorded in an auto-playlist's metadata JSON at
 * materialization (top artists by track count). Lets the card grid show a
 * Spotify-style "Artist A, Artist B and more" subtitle without loading the
 * mix's tracks. Tolerant of missing/malformed/legacy metadata (returns []).
 */
export function featuredArtistsFromMetadata(metadata: string | null | undefined): string[] {
  if (!metadata) return [];
  try {
    const m = JSON.parse(metadata) as { featured_artists?: unknown };
    if (!Array.isArray(m?.featured_artists)) return [];
    return m.featured_artists.filter((a): a is string => typeof a === "string" && a.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * A Spotify-"Daily Mix"-style subtitle from a ranked artist list: the first
 * few names joined by commas, with "and more" appended when the list is capped.
 * Returns null for an empty list so callers can fall back. `shown` caps how
 * many names are displayed; `capped` indicates more artists exist beyond them.
 */
export function featuredArtistsLabel(artists: string[], shown = 3): string | null {
  if (artists.length === 0) return null;
  const names = artists.slice(0, shown);
  const more = artists.length > names.length;
  return more ? `${names.join(", ")} and more` : names.join(", ");
}

/**
 * Top featured artists across a playlist's tracks, ranked by track count
 * descending and capped at `max`. Used to give a playlist a "Featuring …"
 * description. Ties keep first-seen order; blank artist names are skipped.
 */
export function featuredArtists(
  tracks: Array<{ artist_name: string | null }>,
  max = 4,
): string[] {
  const counts = new Map<string, number>();
  for (const t of tracks) {
    const name = t.artist_name?.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name]) => name);
}

/** Short human label describing what an auto-playlist is, for card subtitles. */
export function autoRecipeLabel(recipe: AutoRecipe): string {
  switch (recipe) {
    case "daily-mix":
      return "Daily mix";
    case "genre":
      return "Genre mix";
    case "decade":
      return "Decade mix";
    case "discovery":
      return "For you";
    default:
      return "Auto playlist";
  }
}
