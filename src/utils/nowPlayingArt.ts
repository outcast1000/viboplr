import type { QueueTrack } from "../types";

/**
 * The image-provider chain the Now Playing view reads: explicit `image_url` →
 * album image → artist image. The `is*Resolved` legs are optional; without them
 * a lookup is assumed settled, which is the pre-existing behaviour.
 */
export interface NowPlayingArtLookups {
  getAlbumImage: (name: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
  isAlbumImageResolved?: (name: string, artistName?: string | null) => boolean;
  isArtistImageResolved?: (name: string) => boolean;
}

export interface NowPlayingArt {
  /** Unresolved path/URL — the caller runs it through `resolveImageSrc`. */
  path: string | null;
  /** No answer yet: at least one lookup for this track is still in flight. */
  pending: boolean;
}

/**
 * Resolve the current track's art, and say whether a `null` means "this track
 * has no art" or "nobody knows yet".
 *
 * The distinction matters here in a way it doesn't for a plain `<img>`: art
 * decides the whole surface regime of the Now Playing view — blurred backdrop
 * with always-light text when there is art, skin gradient with skin text when
 * there isn't. `getAlbumImage` returns `null` for both cases, so reading an
 * in-flight lookup as "no art" committed to the no-art regime and undid it a
 * frame later, which on a light skin inverted every line of text on screen.
 *
 * Both legs are asked in the same pass (the artist fallback doesn't wait for the
 * album lookup to settle), so either can still be outstanding.
 */
export function resolveNowPlayingArt(
  track: QueueTrack,
  lookups: NowPlayingArtLookups,
): NowPlayingArt {
  if (track.image_url) return { path: track.image_url, pending: false };

  const albumPath = track.album_title
    ? lookups.getAlbumImage(track.album_title, track.artist_name)
    : null;
  const artistPath = !albumPath && track.artist_name
    ? lookups.getArtistImage(track.artist_name)
    : null;
  const path = albumPath ?? artistPath;
  if (path) return { path, pending: false };

  const albumOut = !!track.album_title
    && !(lookups.isAlbumImageResolved?.(track.album_title, track.artist_name) ?? true);
  const artistOut = !!track.artist_name
    && !(lookups.isArtistImageResolved?.(track.artist_name) ?? true);
  return { path: null, pending: albumOut || artistOut };
}
