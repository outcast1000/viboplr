import type { Track, QueueTrack } from "./types";

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
  | { scheme: "plugin"; protocol: string; id: string }
  | { scheme: "subsonic"; url: string; id: string }
  | { scheme: "external" };

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

export function isLocalTrack(track: { path?: string | null }): boolean {
  return !!track.path?.startsWith("file://");
}

export function isRemoteTrack(track: { path?: string | null }): boolean {
  return !!track.path && track.path.length > 0 && !track.path.startsWith("file://");
}

/**
 * True when a local track lives on a Windows network share (UNC path).
 * Mirrors the backend `is_network_path`: after stripping the `file://` prefix,
 * a network share begins with two separators (`\\server\share` or
 * `//server/share`). Such files cannot go to the Recycle Bin, so deleting them
 * is permanent — the delete confirmation surfaces this.
 */
export function isNetworkSharePath(path: string | null | undefined): boolean {
  if (!path) return false;
  const bare = path.startsWith("file://") ? path.slice("file://".length) : path;
  return bare.startsWith("\\\\") || bare.startsWith("//");
}

/**
 * Extracts the remote ID from a subsonic:// or plugin scheme path.
 */
export function remoteId(track: Track): string | null {
  if (!track.path) return null;
  if (track.path.startsWith("subsonic://")) {
    const rest = track.path.substring(11);
    const lastSlash = rest.lastIndexOf("/");
    return lastSlash >= 0 ? rest.substring(lastSlash + 1) || null : null;
  }
  const parsed = parseUrlScheme(track.path);
  if (parsed.scheme === "plugin") return parsed.id;
  return null;
}

/**
 * Converts a Track or QueueTrack to a QueueEntry for serialization.
 */
export function trackToQueueEntry(track: Track | QueueTrack): QueueEntry {
  return {
    url: track.path ?? "",
    key: track.key,
    title: track.title,
    artist_name: track.artist_name,
    album_title: track.album_title,
    duration_secs: track.duration_secs,
    track_number: "track_number" in track ? track.track_number : null,
    year: "year" in track ? track.year : null,
    format: track.format,
    image_url: track.image_url,
    liked: track.liked,
  };
}

/**
 * Converts a Track to a QueueTrack, stripping DB IDs and keeping only
 * portable metadata needed for queue/playlist/now-playing contexts.
 */
export function trackToQueueTrack(track: Track): QueueTrack {
  return {
    key: track.key,
    path: track.path,
    title: track.title,
    artist_name: track.artist_name,
    album_title: track.album_title,
    duration_secs: track.duration_secs,
    format: track.format,
    image_url: track.image_url,
    liked: track.liked,
    file_size: track.file_size,
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
    added_at: null,
    modified_at: null,
    image_url: entry.image_url,
  };
}

/**
 * Converts a QueueEntry back to a QueueTrack.
 *
 * Produces a lightweight queue-only track without DB IDs.
 * The key is preserved from the entry, or a new external key is generated.
 */
export function queueEntryToQueueTrack(entry: QueueEntry): QueueTrack {
  return {
    key: entry.key ?? nextExternalKey(),
    path: entry.url,
    title: entry.title,
    artist_name: entry.artist_name,
    album_title: entry.album_title,
    duration_secs: entry.duration_secs,
    format: entry.format,
    liked: entry.liked ?? 0,
    image_url: entry.image_url,
  };
}

/**
 * Parses a URL into a typed ParsedUrl result.
 *
 * Supported schemes:
 * - file:// → { scheme: "file", path: string }
 * - subsonic:// → { scheme: "subsonic", url: string, id: string }
 * - {protocol}:// → { scheme: "plugin", protocol, id: string }
 */
export function parseUrlScheme(url: string): ParsedUrl {
  if (url.startsWith("file://")) {
    return { scheme: "file", path: url.substring(7) };
  }

  if (url.startsWith("subsonic://")) {
    const rest = url.substring(11);
    const lastSlash = rest.lastIndexOf("/");
    const id = lastSlash >= 0 ? rest.substring(lastSlash + 1) : "";
    return { scheme: "subsonic", url, id };
  }

  if (url.startsWith("external://")) {
    return { scheme: "external" };
  }

  if (url.includes("://")) {
    const colonPos = url.indexOf("://");
    const protocol = url.substring(0, colonPos);
    const id = url.substring(colonPos + 3);
    return { scheme: "plugin", protocol, id };
  }

  // Plain path (no scheme) — treat as local file
  return { scheme: "file", path: url };
}

/**
 * Returns true if the URL uses a remote app-specific scheme (subsonic://, plugin schemes).
 * Returns false for file://, http(s)://, and plain paths.
 */
export function isRemoteScheme(url: string): boolean {
  if (!url.includes("://")) return false;
  if (url.startsWith("file://")) return false;
  if (url.startsWith("http://") || url.startsWith("https://")) return false;
  return true;
}

/**
 * Where the bytes a track is playing actually come from — the "effective source"
 * of the *winning* playback-resolution entry, regardless of the track's original
 * scheme. This is the single thing that drives the now-playing download button
 * (visibility + which downloader) and the source label. See `decideDownload`.
 *
 * - `local`      — a file on disk (file://). Nothing to download.
 * - `subsonic`   — a Subsonic/Navidrome server stream. Downloads via the built-in provider.
 * - `plugin`     — streamed by a plugin (stream resolver win, native plugin scheme,
 *                  or a plugin-collection library row). Downloads via that plugin's
 *                  download provider, if it contributes one. `uri` is set when a
 *                  native scheme URL is available (prefer by-uri resolution over metadata).
 * - `direct-url` — a raw http(s) URL with no owning plugin. Nothing to download.
 */
export type EffectiveSource =
  | { kind: "local" }
  | { kind: "subsonic"; uri: string }
  | { kind: "plugin"; pluginId: string; uri?: string }
  | { kind: "direct-url"; uri: string };

/**
 * Classify a resolved playback URI into its `EffectiveSource`. Used for native
 * scheme entries (the track's own `path`) and for the built-in Library resolver
 * (the matched library row's `path`). Plugin *stream resolver* wins are classified
 * directly as `{ kind: "plugin", pluginId }` by the caller (no URI scheme to parse).
 *
 * `getSchemeOwner(scheme)` maps a custom URL scheme to the plugin id that
 * registered `onResolveStreamByUri` for it (so a native `tidal://` maps to the
 * TIDAL plugin's downloader). Returns null when unknown; the scheme string is then
 * used as the plugin id, which simply finds no provider and hides the button.
 */
export function classifyEffectiveSource(
  uri: string,
  getSchemeOwner: (scheme: string) => string | null,
): EffectiveSource {
  if (!uri.includes("://") || uri.startsWith("file://")) return { kind: "local" };
  if (uri.startsWith("http://") || uri.startsWith("https://")) return { kind: "direct-url", uri };
  if (uri.startsWith("subsonic://")) return { kind: "subsonic", uri };
  const scheme = uri.substring(0, uri.indexOf("://"));
  return { kind: "plugin", pluginId: getSchemeOwner(scheme) ?? scheme, uri };
}
