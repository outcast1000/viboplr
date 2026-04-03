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
  | { scheme: "subsonic"; url: string; id: string };

let tidalIdCounter = -100000;

/**
 * Computes the playback URL for a track based on its source.
 *
 * Rules:
 * - TIDAL (empty path + subsonic_id): tidal://{subsonic_id}
 * - Subsonic (collection.kind === "subsonic"): subsonic://{host}/rest/stream.view?id={subsonic_id}
 * - Everything else: file://{track.path}
 */
export function computeUrl(track: Track, collections: Collection[]): string {
  // TIDAL: empty path + subsonic_id
  if (track.path === "" && track.subsonic_id) {
    return `tidal://${track.subsonic_id}`;
  }

  // Check collection kind for Subsonic
  if (track.collection_id !== null) {
    const collection = collections.find((c) => c.id === track.collection_id);
    if (collection) {
      if (collection.kind === "subsonic" && track.subsonic_id && collection.url) {
        let host = collection.url.replace(/^https:\/\//, "").replace(/\/$/, "");
        return `subsonic://${host}/rest/stream.view?id=${track.subsonic_id}`;
      }
    }
  }

  // Fallback to file://
  return `file://${track.path}`;
}

/**
 * Stamps a url on a track for queue use. If the track already has a url, keeps it.
 * Otherwise computes one from the track's source info.
 */
export function stampUrl(track: Track, collections: Collection[]): Track {
  if (track.url) return track;
  return { ...track, url: computeUrl(track, collections) };
}

/**
 * Converts a Track to a QueueEntry for serialization.
 */
export function trackToQueueEntry(track: Track, collections: Collection[]): QueueEntry {
  return {
    url: track.url ?? computeUrl(track, collections),
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
 * Rules:
 * - file:// → set path (strip prefix), id=0, subsonic_id=null
 * - tidal:// → set subsonic_id (strip prefix), negative id (unique), path=""
 * - subsonic:// → extract id from ?id= param, set subsonic_id, id=0, path=""
 */
export function queueEntryToTrack(entry: QueueEntry): Track {
  const parsed = parseUrlScheme(entry.url);

  let id = 0;
  let path = "";
  let subsonic_id: string | null = null;

  if (parsed.scheme === "file") {
    path = parsed.path;
  } else if (parsed.scheme === "tidal") {
    id = tidalIdCounter--;
    subsonic_id = parsed.id;
  } else if (parsed.scheme === "subsonic") {
    subsonic_id = parsed.id || null;
  }

  return {
    id,
    path,
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
    subsonic_id,
    liked: 0,
    youtube_url: null,
    added_at: null,
    modified_at: null,
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
    const parsed = new URL(url);
    const id = parsed.searchParams.get("id") || "";
    return { scheme: "subsonic", url, id };
  }

  // Default to file scheme for unknown or plain paths
  return { scheme: "file", path: url };
}
