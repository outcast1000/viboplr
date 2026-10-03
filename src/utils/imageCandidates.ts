// An ordered chain of `<img src>` candidates for a card/hero cover. A thunk is
// only evaluated once every earlier candidate is missing or has failed to load,
// so a fallback that triggers an on-demand fetch (album/artist image lookups)
// costs nothing while the explicit cover is fine.
export type ImageCandidate = string | null | undefined | (() => string | null | undefined);

/** First candidate that is present and not in `failed`, or null. */
export function firstUsableImage(candidates: ImageCandidate[], failed: ReadonlySet<string>): string | null {
  for (const c of candidates) {
    const src = typeof c === "function" ? c() : c;
    if (src && !failed.has(src)) return src;
  }
  return null;
}
