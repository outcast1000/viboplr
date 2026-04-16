import type { Track, Collection } from "./types";

export interface QueueEntry {
  url: string;
  title: string;
  artist_name: string | null;
  album_title: string | null;
  duration_secs: number | null;
  track_number: number | null;
  year: number | null;
  format: string | null;
}

export type ParsedUrl =
  | { scheme: "file"; path: string }
  | { scheme: "tidal"; id: string }
  | { scheme: "subsonic"; url: string; id: string }
  | { scheme: "unknown"; url: string };

let tidalIdCounter = -100000;

/**
 * Returns true if this is a remote track (subsonic:// or tidal://).
 */
export function isRemoteTrack(track: Track): boolean {
  return track.path.startsWith("subsonic://") || track.path.startsWith("tidal://");
}

/**
 * Extracts the remote ID from a subsonic:// or tidal:// path.
 */
export function remoteId(track: Track): string | null {
  if (track.path.startsWith("tidal://")) return track.path.substring(8);
  if (track.path.startsWith("subsonic://")) {
    const rest = track.path.substring(11);
    const lastSlash = rest.lastIndexOf("/");
    return lastSlash >= 0 ? rest.substring(lastSlash + 1) || null : null;
  }
  return null;
}

/**
 * Returns the canonical URL for a track.
 * Since track.path is already a URI (file://, subsonic://, tidal://),
 * this just returns track.path (or track.url if already stamped).
 */
export function computeUrl(track: Track, _collections: Collection[]): string {
  return track.url ?? track.path;
}

/**
 * Stamps a url on a track for queue use. Since path is already a URI, just copies it.
 */
export function stampUrl(track: Track, _collections: Collection[]): Track {
  if (track.url) return track;
  return { ...track, url: track.path };
}

/**
 * Converts a Track to a QueueEntry for serialization.
 */
export function trackToQueueEntry(track: Track, _collections: Collection[]): QueueEntry {
  return {
    url: track.url ?? track.path,
    title: track.title,
    artist_name: track.artist_name,
    album_title: track.album_title,
    duration_secs: track.duration_secs,
    track_number: track.track_number,
    year: track.year,
    format: track.format,
  };
}

/**
 * Converts a QueueEntry back to a Track.
 *
 * path = url (the canonical URI) for all schemes.
 * TIDAL tracks get unique negative IDs since they aren't in the library.
 */
export function queueEntryToTrack(entry: QueueEntry): Track {
  const parsed = parseUrlScheme(entry.url);
  const id = parsed.scheme === "tidal" ? tidalIdCounter-- : 0;

  return {
    id,
    path: entry.url,
    title: entry.title,
    artist_id: null,
    artist_name: entry.artist_name,
    album_id: null,
    album_title: entry.album_title,
    year: entry.year,
    track_number: entry.track_number,
    duration_secs: entry.duration_secs,
    format: entry.format,
    file_size: null,
    collection_id: null,
    collection_name: null,
    liked: 0,
    youtube_url: null,
    added_at: null,
    modified_at: null,
    relative_path: null,
    url: entry.url,
  };
}

/**
 * Parses a URL into a typed ParsedUrl result.
 *
 * Supported schemes:
 * - file:// → { scheme: "file", path: string }
 * - tidal:// → { scheme: "tidal", id: string }
 * - subsonic:// → { scheme: "subsonic", url: string, id: string }
 */
export function parseUrlScheme(url: string): ParsedUrl {
  if (url.startsWith("file://")) {
    return { scheme: "file", path: url.substring(7) };
  }

  if (url.startsWith("tidal://")) {
    return { scheme: "tidal", id: url.substring(8) };
  }

  if (url.startsWith("subsonic://")) {
    const rest = url.substring(11); // strip "subsonic://"
    const lastSlash = rest.lastIndexOf("/");
    const id = lastSlash >= 0 ? rest.substring(lastSlash + 1) : "";
    return { scheme: "subsonic", url, id };
  }

  // Unknown scheme — enters fallback chain
  if (url.includes("://")) {
    return { scheme: "unknown", url };
  }

  // Plain path (no scheme) — treat as local file
  return { scheme: "file", path: url };
}
