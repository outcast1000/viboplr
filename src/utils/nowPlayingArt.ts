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

  // Album art is keyed by the album's OWN artist (ALBUMARTIST) — on a
  // compilation the track artist keys nothing. Falls back to the track artist
  // for entries that don't carry it (older persisted queues, plugin tracks).
  const albumArtist = track.album_artist_name ?? track.artist_name;
  const albumPath = track.album_title
    ? lookups.getAlbumImage(track.album_title, albumArtist)
    : null;
  const artistPath = !albumPath && track.artist_name
    ? lookups.getArtistImage(track.artist_name)
    : null;
  const path = albumPath ?? artistPath;
  if (path) return { path, pending: false };

  const albumOut = !!track.album_title
    && !(lookups.isAlbumImageResolved?.(track.album_title, albumArtist) ?? true);
  const artistOut = !!track.artist_name
    && !(lookups.isArtistImageResolved?.(track.artist_name) ?? true);
  return { path: null, pending: albumOut || artistOut };
}

/** How long each slide holds before the Now Playing surface rotates to the
    next one (issue #135). A constant, not a setting — tune here if feedback
    asks for a different pace. */
export const NOW_PLAYING_SLIDE_INTERVAL_MS = 20_000;

export interface NowPlayingSlides {
  /** Unresolved paths in slideshow order — primary (explicit `image_url`, else
      the album cover) first, the artist image second. Length 0–2; entries are
      distinct, so a track whose artist image IS its only image yields one slide
      and the slideshow degrades to the static art it always was. */
  paths: string[];
  /** Same meaning as `NowPlayingArt.pending`, and only ever true while `paths`
      is empty: no image has settled yet but a lookup is still in flight, so the
      surface should hold the art regime rather than commit to "no art". */
  pending: boolean;
}

/**
 * The Now Playing slideshow's image list (issue #135): the same ladder as
 * `resolveNowPlayingArt`, except the artist image is asked for **always** —
 * there it is only a fallback for a missing album cover; here it is the second
 * slide. The ask itself matters: `getArtistImage` is what triggers
 * `useImageCache`'s on-demand fetch, and the settle re-renders the caller, so
 * the list grows 1 → 2 when the artist image lands and rotation simply begins.
 */
export function resolveNowPlayingSlides(
  track: QueueTrack,
  lookups: NowPlayingArtLookups,
): NowPlayingSlides {
  const albumArtist = track.album_artist_name ?? track.artist_name;
  const albumPath = !track.image_url && track.album_title
    ? lookups.getAlbumImage(track.album_title, albumArtist)
    : null;
  const primary = track.image_url ?? albumPath;
  const artistPath = track.artist_name ? lookups.getArtistImage(track.artist_name) : null;

  const paths: string[] = [];
  if (primary) paths.push(primary);
  if (artistPath && artistPath !== primary) paths.push(artistPath);
  if (paths.length > 0) return { paths, pending: false };

  const albumOut = !track.image_url && !!track.album_title
    && !(lookups.isAlbumImageResolved?.(track.album_title, albumArtist) ?? true);
  const artistOut = !!track.artist_name
    && !(lookups.isArtistImageResolved?.(track.artist_name) ?? true);
  return { paths, pending: albumOut || artistOut };
}
