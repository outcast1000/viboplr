import type { Track, QueueTrack, TrackSelection } from "./types";
import type { PluginTrack } from "./types/plugin";

export interface QueueEntry {
  url: string;
  key?: string;
  title: string;
  artist_name: string | null;
  album_title: string | null;
  /** ALBUMARTIST when known — optional so entries serialized by older builds
   * deserialize unchanged; consumers fall back to artist_name. */
  album_artist_name?: string | null;
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

let queueKeyCounter = 1;

/**
 * Mint a queue-entry render key (`q:N`). The ONE counter behind every queue
 * key — restore, plugin tracks, playlist rows, de-dupe re-mints — so two live
 * entries can never collide. The prefix is opaque (nothing parses it; identity
 * questions go through `libraryId`): it was renamed from `ext:` when library
 * tracks started minting here too and "external" became a lie.
 *
 * Keys are session-only by construction: no persisted format carries one back
 * in (the m3u writer emits only EXTINF+location, the main-playlist manifest
 * has no key field, and `currentTrackEntry` — the one store write that embeds
 * a key — has no reader). The only key not minted at the moment of addition is
 * a SAME-SESSION reuse: `playTracks`' continuation adopting the playing copy's
 * key, and re-adds of entries already in the queue (`withUniqueKeys` keeps a
 * collision-free key).
 */
export function nextQueueKey(): string {
  return `q:${queueKeyCounter++}`;
}

/**
 * A plugin-supplied track becomes a queue entry. Pure (bar the key counter) so
 * the kind→format stamp is testable; every plugin entry point in App routes
 * through it.
 *
 * The CONTAINER is deliberately not a plugin-declared field — it is learned at
 * RESOLVE time from the file the scheme resolves to and patched onto the track
 * before any element is chosen (see useStreamResolution's by-URI chain entry).
 * But the KIND may be declared: a plugin that read a filename (qbt) or serves
 * only video can say `kind: "video"`, and the host stamps the same provisional
 * "mp4" the prefer-video resolver pass uses, so the queue row classifies
 * (icon, frame thumb, routing) before anything plays. The resolve-time patch
 * overwrites it with the real container.
 */
export function pluginTrackToQueueTrack(info: PluginTrack): QueueTrack {
  return {
    key: nextQueueKey(),
    path: info.path ?? null,
    title: info.title,
    artist_name: info.artist_name ?? null,
    album_artist_name: info.album_artist_name ?? null,
    album_title: info.album_title ?? null,
    duration_secs: info.duration_secs ?? null,
    format: info.kind === "video" ? "mp4" : null,
    liked: 0,
    image_url: info.image_url ?? undefined,
  };
}

// Ids travel as numbers everywhere now — `Track.id`, `QueueTrack.libraryId`,
// `TrackSelection`. There is deliberately no key→id decoder: `parseLibraryId`
// used to be one, and every caller was a latent bug, because a queue key is a
// render identity that gets re-minted as `q:N` on collision and on every
// restore, so decoding one silently reported "not a library track" for a second
// copy or a restored entry.

/** Open the Track-detail page on a library row. */
export function librarySelection(libraryId: number): TrackSelection {
  return { kind: "library", libraryId };
}

/** Open the Track-detail page on an id-less queue entry, by its `QueueTrack.key`. */
export function entrySelection(key: string): TrackSelection {
  return { kind: "entry", key };
}

/** The selection for a queue entry: its library row when it knows one (so the
 *  detail page gets the real record), else the entry itself. */
export function queueTrackSelection(track: { key: string; libraryId?: number | null }): TrackSelection {
  return track.libraryId != null ? librarySelection(track.libraryId) : entrySelection(track.key);
}

/** Best selection for a track-shaped object from ANY surface: the library row
 *  by `id` when it has one, else — when the object is (or was built from) a
 *  queue entry and still carries a render key — the entry itself. Returns null
 *  when there is nothing to open (an id-less object with no key, e.g. a bare
 *  metadata row); callers no-op on null. This is what the locate-track lambdas
 *  use, since a library `Track` no longer carries any key at all. */
export function trackSelection(t: { id?: number | null; key?: string | null }): TrackSelection | null {
  if (t.id != null) return librarySelection(t.id);
  return t.key ? entrySelection(t.key) : null;
}

/** Is the Track-detail page showing the track that's playing? Compares on
 *  whichever axis the selection is expressed in, so it holds for a library row
 *  and for an id-less entry alike. */
export function isPlayingSelection(
  selection: TrackSelection | null,
  current: { key: string; libraryId?: number | null } | null | undefined,
): boolean {
  if (!selection || !current) return false;
  return selection.kind === "library"
    ? current.libraryId === selection.libraryId
    : current.key === selection.key;
}

/**
 * Is this library row the one currently playing?
 *
 * Compares the playing entry's cached `libraryId` against the row's `id`. The
 * two list surfaces used to compare `currentTrack.key === track.key`, which
 * worked only because `trackToQueueTrack` copied the library row's `lib:N` key
 * onto the queue entry — a coupling that made the *queue's* key format
 * load-bearing for a *library list's* highlight, two layers apart.
 *
 * Null-safe on both sides deliberately: an id-less playing entry (a plugin
 * result) must not match an id-less row, which `==` on two nulls would.
 */
export function isPlayingLibraryRow(
  row: { id: number | null },
  current: { libraryId?: number | null } | null | undefined,
): boolean {
  const playingId = current?.libraryId ?? null;
  return playingId != null && playingId === row.id;
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
 * The real file on disk behind a track, or null when there isn't one.
 *
 * `isLocalTrack` only looks at the track's own scheme, which is the wrong
 * question for a track that *plays* from a local file under some other scheme:
 * a resolver that landed on a file — a plugin's (qbt://) or the built-in
 * Library's — reports its `sourceUrl` as `file://…`. Those files are as
 * readable as any library track — tag readers and the audio-property probe
 * work on them — so a caller asking "can I inspect this file?" must ask this,
 * not the scheme. Returns the bare OS path, `file://` stripped.
 */
export function effectiveLocalPath(
  track: { path?: string | null },
  resolvedSource: { name?: string; sourceUrl?: string | null } | null,
): string | null {
  if (isLocalTrack(track)) return track.path!.slice("file://".length) || null;
  const sourceUrl = resolvedSource?.sourceUrl ?? null;
  if (!sourceUrl) return null;
  if (sourceUrl.startsWith("file://")) return sourceUrl.slice("file://".length) || null;
  return null;
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
    // Only a QueueTrack has a render key; a library Track carries none.
    key: "key" in track ? track.key : undefined,
    title: track.title,
    artist_name: track.artist_name,
    album_title: track.album_title,
    album_artist_name: track.album_artist_name,
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
 *
 * **Mints a fresh key** rather than inheriting the library row's, which is why
 * `withUniqueKeys` no longer has a collision to resolve on this path: two
 * copies of one track are two entries with two keys by construction. Inheriting
 * `lib:N` is what coupled a library list's now-playing highlight to the queue's
 * key format (see `isPlayingLibraryRow`) and what made the id look like part of
 * a queue entry's identity. Provenance rides in `libraryId` instead.
 */
export function trackToQueueTrack(track: Track): QueueTrack {
  // The `?? null` / `?? 0` defaults are load-bearing: some callers hand in a
  // sparse `Track` (the mixtape "Just Play" event serializes only
  // title/artist/album/duration/path/image_url), and QueueTrack's contract is
  // `null`/`0`, never `undefined` — consumers do strict `=== 0` checks and
  // `nextTriState` arithmetic on `liked`.
  return {
    key: nextQueueKey(),
    // The queue's one durable link back to the library row — shared by every
    // copy of it, where `key` is unique per entry. Opposite requirements, which
    // is why they are separate fields; the de-dupe in `withUniqueKeys` used to
    // resolve the conflict by destroying the provenance.
    libraryId: track.id ?? null,
    path: track.path ?? null,
    title: track.title,
    artist_name: track.artist_name ?? null,
    album_title: track.album_title ?? null,
    album_artist_name: track.album_artist_name ?? null,
    duration_secs: track.duration_secs ?? null,
    format: track.format ?? null,
    image_url: track.image_url,
    liked: track.liked ?? 0,
    file_size: track.file_size,
  };
}

/**
 * Normalize a mixed list at the queue's door. A library `Track` — discriminated
 * by its `id` field, which a `QueueTrack` never carries — is converted via
 * `trackToQueueTrack` (fresh key, `libraryId` stamped); a `QueueTrack` passes
 * through untouched, key and all.
 *
 * `useQueue` runs every entry path through this so `libraryId` reaches the
 * queue no matter which surface forgot to convert: the main play paths (list
 * double-click, context-menu Play, play-all, the control API) all pass raw
 * `Track[]`, which type-checks structurally — without the door conversion those
 * entries carried `libraryId: undefined` and every id-based consumer (the
 * now-playing row highlight, queue View Details, the like mirror) silently fell
 * back or went dark.
 */
export function toQueueTracks(tracks: ReadonlyArray<Track | QueueTrack>): QueueTrack[] {
  return tracks.map(t => ("id" in t ? trackToQueueTrack(t) : t));
}

/** One saved-playlist row as `get_playlist_tracks` returns it — the subset the
 *  queue conversion needs. (The row also carries `id`/`playlist_id`/`position`,
 *  which are playlist-editing concerns, not queue ones.) */
export interface PlaylistTrackRow {
  title: string;
  artist_name: string | null;
  album_name: string | null;
  duration_secs: number | null;
  source: string | null;
  image_path: string | null;
  liked?: number;
}

/**
 * Converts a saved-playlist row to a QueueTrack (fresh external key; the row's
 * `source` is the scheme-prefixed path). The one mapping for every surface
 * that plays playlist rows — PlaylistsView and the control API.
 */
export function playlistTrackToQueueTrack(t: PlaylistTrackRow): QueueTrack {
  return {
    key: nextQueueKey(),
    path: t.source ?? null,
    title: t.title,
    artist_name: t.artist_name,
    album_title: t.album_name,
    duration_secs: t.duration_secs ?? null,
    format: null,
    image_url: t.image_path ?? undefined,
    liked: t.liked ?? 0,
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
    key: entry.key ?? nextQueueKey(),
    path: entry.url,
    title: entry.title,
    artist_name: entry.artist_name,
    album_title: entry.album_title,
    album_artist_name: entry.album_artist_name ?? null,
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
 * Display name for a track's OWN source — the label the resolver chain uses for
 * the native entry, and what the source panel shows as its title.
 *
 * `pluginDisplayName(protocol)` resolves a plugin scheme to that plugin's
 * manifest name. Without it (or when nothing owns the scheme) the protocol is
 * capitalized, which is a fallback, not the intent: `ytdlp://` then reads
 * "Ytdlp" where the plugin calls itself "yt-dlp", and that string is user-facing
 * — it titles the source panel and fills in "Open on ___".
 */
export function nativeResolverName(
  url: string,
  pluginDisplayName?: (protocol: string) => string | null,
): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return "Direct URL";
  const parsed = parseUrlScheme(url);
  if (parsed.scheme === "file") return "Local";
  if (parsed.scheme === "subsonic") return "Subsonic";
  if (parsed.scheme === "plugin") {
    return (
      pluginDisplayName?.(parsed.protocol) ||
      parsed.protocol.charAt(0).toUpperCase() + parsed.protocol.slice(1)
    );
  }
  return "Unknown";
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
 * - `direct-url` — a raw http(s) URL with no owning plugin (e.g. a manifest
 *                  collection track, an internet stream). Downloads as itself:
 *                  the URL is the download ("Source" plan in `decideDownload`).
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
