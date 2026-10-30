import { isVideoTrack } from "../utils";
import { isVariousArtists } from "../utils/variousArtists";
import { ReelArt, VinylArt } from "./PlaceholderArt";

/** What the placeholder reads off a track: audio vs video, and the artist for its colour. */
export type FallbackArtTrack = { format?: string | null; path?: string | null; artist_name?: string | null };

/** Below this the label is ~4px across and an initial on it is a smudge. */
const INITIAL_MIN_SIZE = 24;

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
 * The letter printed on the label: the artist's first letter or digit, skipping
 * a leading "The"/"A". None for a placeholder artist ("Unknown Artist", "Various
 * Artists") — a "U" would describe nobody — nor for a name with no letter at
 * all, which is what made album placeholders draw "[" (see EntityArtFallback).
 */
export function labelInitial(artist: string | null | undefined): string | null {
  if (!artist || isVariousArtists(artist)) return null;
  const m = artist.replace(/^\s*(the|a)\s+/i, "").match(/[\p{L}\p{N}]/u);
  return m ? m[0].toLocaleUpperCase() : null;
}

/**
 * Placeholder art for a track that has none: a vinyl record whose label is
 * coloured from the artist (with the artist's initial on it) for audio, a reel
 * tinted the same way for video — `PlaceholderArt`'s drawings.
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
  if (isVideo) return <ReelArt size={size ?? undefined} color={color} className={cls} />;
  // A CSS-sized svg is a share of a box at least as big as a queue thumb.
  const initial = size == null || size >= INITIAL_MIN_SIZE ? labelInitial(track.artist_name) : null;
  return <VinylArt size={size ?? undefined} color={color} initial={initial} className={cls} />;
}
