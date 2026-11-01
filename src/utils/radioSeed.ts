// Picks the seed track for an artist / album / tag page's Radio button.
//
// A station is always built from one seed track (`startRadio`), so an entity's
// Radio has to choose one. The pick is random — each press is a different
// station — but weighted, so the songs people actually know come up more often:
// with any popularity data (Last.fm listeners: an artist's Top Songs, an
// album's tracklist) a track weighs 1 + 4 × its share of the most popular
// track's count, so the top song is 5× as likely as one with no count. A tag
// page has no popularity data, so there liked tracks stand in for it (3× an
// unrated one). Disliked tracks are never a seed.

import type { QueueTrack, Track } from "../types";

export type RadioSeed =
  | { kind: "library"; track: Track }
  | { kind: "external"; track: QueueTrack };

export interface SeedCandidate {
  seed: RadioSeed;
  /** Provider listener count; 0 when unknown. */
  popularity: number;
}

const POPULARITY_BOOST = 4;
const LIKED_WEIGHT = 3;

/** A seed's like state. The caller passes the track-like store's answer
 *  (`useEntityRadio`); without one, a library row's own mirror is used and a
 *  provider-only row (no `liked` of its own) counts as unrated. */
export type SeedLikeOf = (seed: RadioSeed) => number;

export const seedOwnLike: SeedLikeOf = (seed) => (seed.kind === "library" ? seed.track.liked ?? 0 : 0);

/** The pick weight of each candidate, in order (0 = never picked). */
export function seedWeights(candidates: SeedCandidate[], likedOf: SeedLikeOf = seedOwnLike): number[] {
  const maxPop = Math.max(0, ...candidates.map(c => c.popularity || 0));
  return candidates.map(c => {
    if (likedOf(c.seed) === -1) return 0;
    if (maxPop > 0) return 1 + POPULARITY_BOOST * ((c.popularity || 0) / maxPop);
    return likedOf(c.seed) === 1 ? LIKED_WEIGHT : 1;
  });
}

/** A weighted-random seed, or null when there is nothing to seed from.
 *  `rand` is injectable for tests; call it from an event handler, never render. */
export function pickRadioSeed(
  candidates: SeedCandidate[],
  rand: () => number = Math.random,
  likedOf: SeedLikeOf = seedOwnLike,
): RadioSeed | null {
  const weights = seedWeights(candidates, likedOf);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let r = rand() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r < 0 && weights[i] > 0) return candidates[i].seed;
  }
  // Floating-point remainder: the last pickable candidate.
  for (let i = candidates.length - 1; i >= 0; i--) if (weights[i] > 0) return candidates[i].seed;
  return null;
}

/** Candidates from a page's library rows plus its provider-only rows. */
export function seedCandidates(
  library: Track[],
  libraryPopularity: Record<number, number>,
  external: Array<{ track: QueueTrack; popularity?: number }>,
): SeedCandidate[] {
  return [
    ...library.map(t => ({ seed: { kind: "library" as const, track: t }, popularity: (t.id != null ? libraryPopularity[t.id] : 0) ?? 0 })),
    ...external.map(e => ({ seed: { kind: "external" as const, track: e.track }, popularity: e.popularity ?? 0 })),
  ];
}
