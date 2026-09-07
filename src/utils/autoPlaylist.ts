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

import { toStringMetadata } from "../mainPlaylist";
import type { SortKey } from "../sortChain";

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

/** The three playlist classes, as a value (for filtering/labels). */
export type PlaylistKind = "system" | "auto" | "user";

export function playlistKind(p: PlaylistLike): PlaylistKind {
  if (isProtectedSystem(p)) return "system";
  if (isAuto(p)) return "auto";
  return "user";
}

/** Short human label for a playlist's class, for list/table subtitles. */
export function playlistKindLabel(kind: PlaylistKind): string {
  switch (kind) {
    case "system":
      return "System";
    case "auto":
      return "Made for you";
    default:
      return "Saved";
  }
}

export interface SortablePlaylist extends PlaylistLike {
  name: string;
  track_count: number;
  saved_at: number;
}

/**
 * Multi-key comparator over the Playlists view's sort chain (fields: "name",
 * "tracks", "updated"). Ties — and an empty chain — fall back to playlistRank
 * so the class grouping (system → auto → user) stays the default order.
 * Unknown fields compare equal rather than throwing.
 */
export function comparePlaylists(a: SortablePlaylist, b: SortablePlaylist, chain: SortKey[]): number {
  for (const k of chain) {
    let cmp = 0;
    if (k.field === "name") cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    else if (k.field === "tracks") cmp = a.track_count - b.track_count;
    else if (k.field === "updated") cmp = a.saved_at - b.saved_at;
    if (cmp !== 0) return k.dir === "desc" ? -cmp : cmp;
  }
  return playlistRank(a) - playlistRank(b);
}

/** The recipe encoded in an auto-playlist's metadata JSON (best-effort). */
export type AutoRecipe = "daily-mix" | "genre" | "decade" | "discovery" | "seeded" | "sampler" | "unknown";

/**
 * Parse the recipe label from an auto-playlist's metadata JSON. Tolerant of
 * missing/malformed metadata — returns "unknown" rather than throwing.
 */
export function parseRecipe(metadata: string | null | undefined): AutoRecipe {
  if (!metadata) return "unknown";
  try {
    const parsed = JSON.parse(metadata) as { recipe?: string };
    // "seeded" and "sampler" are the top-up recipes the backend generates when
    // the four primary ones can't fill MIN_AUTO_PLAYLISTS: a station from a
    // liked/recently-played/random seed, and a plain random library slice.
    switch (parsed?.recipe) {
      case "daily-mix":
      case "genre":
      case "decade":
      case "discovery":
      case "seeded":
      case "sampler":
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
 * Parse a playlist row's metadata JSON into the flat string map its consumers
 * (the queue's PlaylistContext, mixtape export) hand to the backend. Auto-mix
 * rows carry values that are not strings — `featured_artists` (array), `tag_id`
 * (number), `seed_title` (null) — and both commands deserialize the map into a
 * Rust `HashMap<String, String>`, which rejects the entire payload over one of
 * them. That is what silently stopped the live queue from persisting. Tolerant
 * of missing/malformed JSON (returns null), like the other readers here.
 */
export function parsePlaylistMetadata(metadata: string | null | undefined): Record<string, string> | null {
  if (!metadata) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(metadata);
  } catch {
    return null;
  }
  const map = toStringMetadata(raw);
  return Object.keys(map).length > 0 ? map : null;
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
    case "seeded":
      return "Mix";
    case "sampler":
      return "From your library";
    default:
      return "Auto playlist";
  }
}

// ── Post-sync regeneration ──
//
// The automatic "Made for you" refresh in App.tsx is throttled to once a day,
// which is right for a steady library but wrong for the two moments where the
// mixes are visibly stale: a library that produced no mixes at all (the backend
// persists no empty mix, so a run made before the first scan finished leaves the
// section empty for up to 24h), and a freshly added collection (whose artists,
// tags and decades can't be in any existing snapshot). Both are detected when a
// scan/sync completes, so the decision is made here and pinned by unit tests.

export interface AutoRerunInput {
  /** Whether any `auto:*` playlist currently exists. */
  hasAutoPlaylists: boolean;
  /** Collection ids recorded by previous post-sync checks. */
  seenCollectionIds: number[];
  /** The collection whose scan/sync just completed; null when the event omits it. */
  collectionId: number | null;
}

export interface AutoRerunDecision {
  /** Whether to invoke `ensure_auto_playlists`. */
  run: boolean;
  /** The `force` flag for that invoke. */
  force: boolean;
  reason: "new-collection" | "no-mixes" | "none";
  /** The seen-collection list to persist after this check. */
  nextSeenCollectionIds: number[];
}

export function decideAutoRerunAfterSync(input: AutoRerunInput): AutoRerunDecision {
  const { hasAutoPlaylists, seenCollectionIds, collectionId } = input;
  const nextSeenCollectionIds =
    collectionId != null && !seenCollectionIds.includes(collectionId)
      ? [...seenCollectionIds, collectionId]
      : seenCollectionIds;

  // An empty record means we've never checked (a fresh profile, or an upgrade
  // from a build without this bookkeeping) — every collection would look new,
  // so seed the list instead and let the no-mixes branch decide. Otherwise a
  // routine sync right after updating the app would force a pointless rebuild.
  const seeding = seenCollectionIds.length === 0;
  const isNewCollection =
    collectionId != null && !seeding && !seenCollectionIds.includes(collectionId);

  if (isNewCollection) {
    // A new collection can change the top artists / tags / decades every mix is
    // built from, so rebuild the snapshots rather than only filling in gaps.
    return { run: true, force: true, reason: "new-collection", nextSeenCollectionIds };
  }
  if (!hasAutoPlaylists) {
    return { run: true, force: false, reason: "no-mixes", nextSeenCollectionIds };
  }
  return { run: false, force: false, reason: "none", nextSeenCollectionIds };
}
