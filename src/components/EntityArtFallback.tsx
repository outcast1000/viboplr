import "./EntityArtFallback.css";

/**
 * Placeholder for an album or artist with no image: a vinyl disc for an album,
 * a person for an artist. Drawn in `currentColor` so it takes the surrounding
 * placeholder's skin colour, and sized as a share of the box it sits in, so one
 * component serves a 24px mini-player thumb and a 240px detail hero alike.
 *
 * It replaced first-letter placeholders, which drew `[` for Navidrome's
 * `[Unknown Album]` and `(` for titles opening with punctuation. Tracks keep
 * `TrackArtFallback` (audio vs video); tags keep their letter.
 */
export function EntityArtFallback({ kind }: { kind: "album" | "artist" }) {
  if (kind === "artist") {
    return (
      <svg className="entity-art-fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="8.5" r="3.8" />
        <path d="M4.5 20c1.2-3.8 4.2-5.6 7.5-5.6s6.3 1.8 7.5 5.6" />
      </svg>
    );
  }
  return (
    <svg className="entity-art-fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 5.6a6.4 6.4 0 0 1 6.4 6.4" opacity=".55" />
    </svg>
  );
}
