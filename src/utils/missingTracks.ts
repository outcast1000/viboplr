// Merging a provider's track list (an album's tracklist from Last.fm
// `album.getInfo`, in album order; an artist's Top Songs from
// `artist.getTopTracks`, in rank order) with the library rows the user actually
// has, so a detail page can show the tracks they're missing in place, marked as
// not in the library.
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
   *  before; `library.length` means after the last one. Rows sharing a slot
   *  are drawn in the order returned. */
  before: number;
}

/**
 * For each provider row, the library row it matches (index), or null when the
 * user doesn't own it. One-to-one by `normalizeTrackTitle`, in provider order —
 * two "Intro"s on the provider side claim two library rows, not the same one.
 * A title that normalizes to nothing (all punctuation) never matches.
 */
function matchProvider(
  library: ReadonlyArray<{ title: string }>,
  provider: ReadonlyArray<{ title: string }>,
): Array<number | null> {
  const libNorm = library.map(t => normalizeTrackTitle(t.title));
  const used = new Set<number>();
  return provider.map(p => {
    const n = normalizeTrackTitle(p.title);
    if (!n) return null;
    const i = libNorm.findIndex((x, j) => x === n && !used.has(j));
    if (i < 0) return null;
    used.add(i);
    return i;
  });
}

/**
 * Album pages: which tracklist entries the user lacks, and where each goes.
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
  const matchOf = matchProvider(library, provider);
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

/**
 * Artist pages: which ranked entries (Top Songs) the user lacks, and where.
 *
 * A ranked list carries no album position, so there is nothing to interleave
 * by — except the rank value itself. With `byValue` set (the library list is
 * sorted by popularity, in that direction) each missing row goes where its
 * value falls among the library rows' values, after rows with an equal value,
 * so the whole list reads as one ranking. Otherwise every missing row follows
 * the library rows, in provider (rank) order.
 */
export function placeMissingRanked(
  library: ReadonlyArray<{ title: string }>,
  libraryValues: ReadonlyArray<number>,
  provider: ReadonlyArray<{ title: string }>,
  providerValues: ReadonlyArray<number>,
  byValue: "asc" | "desc" | null,
): MissingPlacement[] {
  const matchOf = matchProvider(library, provider);
  const missing = provider.map((_, p) => p).filter(p => matchOf[p] == null);
  if (!byValue) return missing.map(p => ({ providerIndex: p, before: library.length }));

  const sign = byValue === "desc" ? -1 : 1;
  const value = (p: number) => providerValues[p] ?? 0;
  // Stable: equal values keep rank order.
  missing.sort((a, b) => sign * (value(a) - value(b)));
  return missing.map(p => {
    const v = value(p);
    const i = libraryValues.findIndex(lv => (byValue === "desc" ? lv < v : lv > v));
    return { providerIndex: p, before: i < 0 ? library.length : i };
  });
}
