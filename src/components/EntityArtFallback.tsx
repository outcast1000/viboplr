import { PersonArt, VinylArt } from "./PlaceholderArt";
import "./EntityArtFallback.css";

/**
 * Placeholder for an album or artist with no image: a vinyl record for an
 * album, a band of three for an artist — `PlaceholderArt`'s drawings, in the skin
 * accent for every album and artist alike (only track surfaces colour them per
 * artist). Sized as a share of the box it sits in, so one component serves a
 * 24px mini-player thumb and a 240px detail hero alike.
 *
 * It replaced first-letter placeholders, which drew `[` for Navidrome's
 * `[Unknown Album]` and `(` for titles opening with punctuation. Tracks keep
 * `TrackArtFallback` (audio vs video); tags keep their letter.
 */
export function EntityArtFallback({ kind }: { kind: "album" | "artist" }) {
  return kind === "artist"
    ? <PersonArt className="entity-art-fallback" color="var(--accent)" />
    : <VinylArt className="entity-art-fallback" color="var(--accent)" />;
}
