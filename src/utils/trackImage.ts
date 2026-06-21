import { resolveImageUrl } from "./resolveImageUrl";

// Minimal track shape the image chain reads. Works for QueueTrack, HomeShelf
// track items, and the now-playing currentTrack alike.
export interface TrackImageMeta {
  title?: string;
  artist_name?: string | null;
  album_title?: string | null;
  image_url?: string | null;
}

export interface EntityImageLookups {
  // Name-based album image lookup (e.g. useImageCache("album").getImage). The
  // optional artist disambiguates same-titled albums.
  albumImageFor: (albumTitle: string, artistName?: string) => string | null;
  // Name-based artist image lookup (e.g. useImageCache("artist").getImage).
  artistImageFor: (artistName: string) => string | null;
}

// The shared album→artist priority: a track's album image, falling back to its
// artist image. Returns a RAW path (local filesystem path or remote URL) — it is
// deliberately NOT run through resolveImageUrl, so callers can either convert it
// at render (queue/home shelves) or stamp it raw for later conversion
// (now-playing, which converts in NowPlayingBar). This is the single source of
// truth for the entity-image fallback order across every surface.
export function pickEntityImagePath(
  t: TrackImageMeta,
  deps: EntityImageLookups,
): string | null {
  return (
    (t.album_title ? deps.albumImageFor(t.album_title, t.artist_name ?? undefined) : null) ??
    (t.artist_name ? deps.artistImageFor(t.artist_name) : null) ??
    null
  );
}

// The full render-time image chain shared by the queue panel and home shelves:
//   explicit image_url → already-converted video frame → album → artist.
// `videoFrame` is an already-converted asset URL from the VideoFrameQueue (or
// null) and is used verbatim — re-converting it would corrupt the URL. Every
// other candidate goes through resolveImageUrl, so http/data passthrough and
// `#v=N` → `?v=N` cache-busting behave identically on every surface. Returns a
// value ready to assign to an image element's source (or null, for the
// first-letter placeholder the surfaces render on a miss).
export function resolveTrackImage(
  t: TrackImageMeta,
  deps: EntityImageLookups & { videoFrame?: string | null },
): string | null {
  if (t.image_url) return resolveImageUrl(t.image_url) ?? null;
  if (deps.videoFrame) return deps.videoFrame;
  return resolveImageUrl(pickEntityImagePath(t, deps)) ?? null;
}
