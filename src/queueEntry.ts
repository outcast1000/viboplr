import type { Track, Collection } from "./types";

export interface QueueEntry {
  location: string;
  title: string;
  artist_name: string | null;
  album_title: string | null;
  duration_secs: number | null;
  track_number: number | null;
  year: number | null;
  format: string | null;
}

export type ParsedLocation =
  | { scheme: "file"; path: string }
  | { scheme: "tidal"; id: string }
  | { scheme: "subsonic"; url: string; id: string };

let tidalIdCounter = -100000;

/**
 * Computes the location URI for a track based on its source.
 *
 * Rules:
 * - Local track (no subsonic_id): file://{track.path}
 * - TIDAL ephemeral (empty path + subsonic_id): tidal://{subsonic_id}
 * - TIDAL collection (collection.kind === "tidal"): tidal://{subsonic_id}
 * - Subsonic (collection.kind === "subsonic"): subsonic://{host}/rest/stream.view?id={subsonic_id}
 * - Fallback: file://{track.path}
 */
export function computeLocation(track: Track, collections: Collection[]): string {
  // TIDAL ephemeral: empty path + subsonic_id
  if (track.path === "" && track.subsonic_id) {
    return `tidal://${track.subsonic_id}`;
  }

  // Check collection kind if track has a collection
  if (track.collection_id !== null) {
    const collection = collections.find((c) => c.id === track.collection_id);
    if (collection) {
      if (collection.kind === "tidal" && track.subsonic_id) {
        return `tidal://${track.subsonic_id}`;
      }
      if (collection.kind === "subsonic" && track.subsonic_id && collection.url) {
        // Strip https:// and trailing slash
        let host = collection.url.replace(/^https:\/\//, "").replace(/\/$/, "");
        return `subsonic://${host}/rest/stream.view?id=${track.subsonic_id}`;
      }
    }
  }

  // Fallback to file://
  return `file://${track.path}`;
}

/**
 * Converts a Track to a QueueEntry by computing its location URI and
 * copying relevant metadata fields.
 */
export function trackToQueueEntry(track: Track, collections: Collection[]): QueueEntry {
  return {
    location: track._location ?? computeLocation(track, collections),
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
  const parsed = parseLocationScheme(entry.location);

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
    _location: entry.location,
  };
}

/**
 * Parses a location URI into a typed ParsedLocation result.
 *
 * Supported schemes:
 * - file:// → { scheme: "file", path: string }
 * - tidal:// → { scheme: "tidal", id: string }
 * - subsonic:// → { scheme: "subsonic", url: string, id: string }
 */
export function parseLocationScheme(location: string): ParsedLocation {
  if (location.startsWith("file://")) {
    return { scheme: "file", path: location.substring(7) };
  }

  if (location.startsWith("tidal://")) {
    return { scheme: "tidal", id: location.substring(8) };
  }

  if (location.startsWith("subsonic://")) {
    // Extract id from query param ?id=...
    const url = new URL(location);
    const id = url.searchParams.get("id") || "";
    return { scheme: "subsonic", url: location, id };
  }

  // Default to file scheme for unknown or plain paths
  return { scheme: "file", path: location };
}
