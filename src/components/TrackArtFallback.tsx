import { isVideoTrack } from "../utils";
import { ReelArt, VinylArt } from "./PlaceholderArt";

/** What the placeholder reads off a track: audio vs video, and the artist for its colour. */
export type FallbackArtTrack = { format?: string | null; path?: string | null; artist_name?: string | null };

/**
 * Hue for a track's label, from its artist name: every art-less track by one
 * artist gets the same label, and a run of art-less rows reads as varied rather
 * than as a column of identical grey glyphs. Stable across launches.
 */
export function labelHue(artist: string | null | undefined): number {
  let h = 7;
  for (const c of (artist ?? "").trim().toLowerCase()) h = (h * 31 + c.codePointAt(0)!) % 360;
  return h;
}

/**
 * Placeholder art for a track that has none: a vinyl record whose label is
 * coloured from the artist for audio, a reel tinted the same way for video —
 * `PlaceholderArt`'s drawings.
 *
 * Scoped to TRACK surfaces (queue, now-playing bar/view, home track cards,
 * search, download results). Albums and artists use `EntityArtFallback` — the
 * same drawings in one shared colour — since "audio vs video" is a track concept.
 */
export function TrackArtFallback({
  track,
  size = 16,
  className,
}: {
  track: FallbackArtTrack;
  /** px, or `null` to size the svg from CSS (`className`), e.g. as a share of its box. */
  size?: number | null;
  className?: string;
}) {
  const isVideo = isVideoTrack({ format: track.format ?? null, path: track.path });
  const color = `hsl(${labelHue(track.artist_name)} 62% 56%)`;
  const cls = `track-art-fallback track-art-fallback--${isVideo ? "video" : "audio"}${className ? ` ${className}` : ""}`;
  const Art = isVideo ? ReelArt : VinylArt;
  return <Art size={size ?? undefined} color={color} className={cls} />;
}
