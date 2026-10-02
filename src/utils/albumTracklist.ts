// Merging an album's provider tracklist (Last.fm `album.getInfo`, in album
// order) with the library rows the user actually has, so the album page can
// show the tracks they're missing in place, marked as not in the library.
import { stripAccents } from "../utils";

/** Title identity for matching a provider row to a library row: case and
 *  accents folded, anything in parentheses dropped ("(Remastered 2011)"), then
 *  only letters and digits kept. Also what the popularity bars match by. */
export function normalizeTrackTitle(s: string): string {
  return stripAccents(s.toLowerCase().replace(/\([^)]*\)/g, "").trim()).replace(/[^\p{L}\p{N}]/gu, "");
}

export interface MissingPlacement {
  /** Index into the provider list. */
  providerIndex: number;
  /** The library row (index into the displayed list) this missing row is drawn
   *  before; `library.length` means after the last one. */
  before: number;
}

/**
 * Which provider tracks have no library copy, and where each goes.
 *
 * Matching is one-to-one by `normalizeTrackTitle`, in provider order — two
 * "Intro"s on the provider side claim two library rows, not the same one. A
 * title that normalizes to nothing (all punctuation) never matches.
 *
 * With `interleave` (the list is in album order) a missing track is placed
 * right after the nearest earlier provider track the user owns, or — when
 * nothing earlier is owned — before the nearest later one. Runs of missing
 * tracks keep the provider's order. Without it (the user sorted by a column,
 * where album position means nothing) they all follow the library rows.
 */
export function placeMissingTracks(
  library: ReadonlyArray<{ title: string }>,
  provider: ReadonlyArray<{ title: string }>,
  interleave: boolean,
): MissingPlacement[] {
  const libNorm = library.map(t => normalizeTrackTitle(t.title));
  const used = new Set<number>();
  const matchOf: Array<number | null> = provider.map(p => {
    const n = normalizeTrackTitle(p.title);
    if (!n) return null;
    const i = libNorm.findIndex((x, j) => x === n && !used.has(j));
    if (i < 0) return null;
    used.add(i);
    return i;
  });

  const out: MissingPlacement[] = [];
  for (let p = 0; p < provider.length; p++) {
    if (matchOf[p] != null) continue;
    let before = library.length;
    if (interleave) {
      let anchor: number | null = null;
      for (let q = p - 1; q >= 0 && anchor == null; q--) if (matchOf[q] != null) anchor = matchOf[q]! + 1;
      for (let q = p + 1; q < provider.length && anchor == null; q++) if (matchOf[q] != null) anchor = matchOf[q]!;
      if (anchor != null) before = anchor;
    }
    out.push({ providerIndex: p, before });
  }
  return out;
}
