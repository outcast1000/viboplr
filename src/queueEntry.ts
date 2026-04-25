import type { Track } from "./types";

export interface QueueEntry {
  url: string;
  key?: string;
  title: string;
  artist_name: string | null;
  album_title: string | null;
  duration_secs: number | null;
  track_number: number | null;
  year: number | null;
  format: string | null;
  image_url?: string;
  liked?: number;
}

export type ParsedUrl =
  | { scheme: "file"; path: string }
  | { scheme: "tidal"; id: string }
  | { scheme: "subsonic"; url: string; id: string }
  | { scheme: "external" }
  | { scheme: "unknown"; url: string };

let externalKeyCounter = 1;

export function nextExternalKey(): string {
  return `ext:${externalKeyCounter++}`;
}

export function parseLibraryId(key: string | null | undefined): number | null {
  if (!key) return null;
  if (key.startsWith("lib:")) return parseInt(key.substring(4), 10);
  return null;
}

export function isLibraryTrack(track: Track): boolean {
  return track.id != null;
}

/**
 * Returns true if this is a remote track (subsonic:// or tidal://).
 */
export function isRemoteTrack(track: Track): boolean {
  return !!track.path && (track.path.startsWith("subsonic://") || track.path.startsWith("tidal://"));
}

/**
 * Extracts the remote ID from a subsonic:// or tidal:// path.
 */
export function remoteId(track: Track): string | null {
  if (!track.path) return null;
  if (track.path.startsWith("tidal://")) return track.path.substring(8);
  if (track.path.startsWith("subsonic://")) {
    const rest = track.path.substring(11);
    const lastSlash = rest.lastIndexOf("/");
    return lastSlash >= 0 ? rest.substring(lastSlash + 1) || null : null;
  }
  return null;
}

/**
 * Converts a Track to a QueueEntry for serialization.
 */
export function trackToQueueEntry(track: Track): QueueEntry {
  return {
    url: track.path ?? "",
    key: track.key,
    title: track.title,
    artist_name: track.artist_name,
    album_title: track.album_title,
    duration_secs: track.duration_secs,
    track_number: track.track_number,
    year: track.year,
    format: track.format,
    image_url: track.image_url,
    liked: track.liked,
  };
}

/**
 * Converts a QueueEntry back to a Track.
 *
 * Non-library tracks get id: null. The key is preserved from the entry,
 * or a new external key is generated for backward compatibility.
 */
export function queueEntryToTrack(entry: QueueEntry): Track {
  return {
    id: null,
    key: entry.key ?? nextExternalKey(),
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
    liked: entry.liked ?? 0,
    youtube_url: null,
    added_at: null,
    modified_at: null,
    image_url: entry.image_url,
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

  if (url.startsWith("external://")) {
    return { scheme: "external" };
  }

  // Unknown scheme — enters stream resolver chain
  if (url.includes("://")) {
    return { scheme: "unknown", url };
  }

  // Plain path (no scheme) — treat as local file
  return { scheme: "file", path: url };
}

/**
 * Returns true if the URL uses a remote app-specific scheme (tidal://, subsonic://).
 * Returns false for file://, http(s)://, and plain paths.
 */
export function isRemoteScheme(url: string): boolean {
  if (!url.includes("://")) return false;
  if (url.startsWith("file://")) return false;
  if (url.startsWith("http://") || url.startsWith("https://")) return false;
  return true;
}

/**
 * Determines whether a track should be auto-saved to the downloads collection
 * after playback resolution.
 *
 * Returns true when the resolver that played the track is enabled in the
 * per-resolver auto-save map and the track uses a remote scheme.
 */
export function shouldAutoSave(
  autoSaveMap: Record<string, boolean>,
  trackPath: string,
  resolvedSourceId: string | null,
): boolean {
  if (!resolvedSourceId) return false;
  if (!isRemoteScheme(trackPath)) return false;
  return !!autoSaveMap[resolvedSourceId];
}
