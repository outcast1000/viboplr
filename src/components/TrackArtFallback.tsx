import { isVideoTrack } from "../utils";
import { SpinningDisc } from "./SpinningDisc";
import { FilmStrip } from "./FilmStrip";

/**
 * Uniform, type-aware placeholder icon for a track that has no resolvable
 * artwork: a static film strip for video, a static vinyl disc for audio (reusing
 * the app's SpinningDisc/FilmStrip vocabulary, frozen). Meant to sit inside a
 * surface's existing flat, centered placeholder container and inherit its color
 * via `currentColor` — it renders only the icon, not its own background.
 *
 * Scoped to TRACK surfaces (queue, now-playing bar/view, home track-rows).
 * Entity placeholders (artist initials, album/tag first-letter) keep their own
 * conventions — "audio vs video" is a track concept and doesn't describe them.
 */
export function TrackArtFallback({
  track,
  size = 16,
}: {
  track: { format?: string | null; path?: string | null };
  size?: number;
}) {
  const isVideo = isVideoTrack({ format: track.format ?? null, path: track.path });
  return isVideo
    ? <FilmStrip size={size} playing={false} />
    : <SpinningDisc size={size} playing={false} />;
}
