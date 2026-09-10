import type { QueueTrack, QueueMode } from "./types";
import type { PlaylistContext } from "./hooks/useQueue";
import { nextQueueKey } from "./queueEntry";

export interface ManifestTrack {
  title: string;
  artist: string;
  /** ALBUMARTIST when known. Optional: manifests written before it existed
   * omit it, and the restore path falls back to `artist`. */
  album_artist?: string | null;
  album: string | null;
  duration_secs: number | null;
  file: string | null;
  thumb: string | null;
  format?: string | null;
  /** The entry's own artwork reference — an http(s) URL or a plugin-supplied
   *  local path. Distinct from `thumb` (the on-disk cache file, which the live
   *  queue never sets: Rust names that from `file`). Optional so manifests
   *  written before it existed restore unchanged. */
  image_url?: string | null;
  /** Bytes on disk, when known. Optional for the same reason. */
  file_size?: number | null;
}

export interface Manifest {
  version: 1;
  title: string;
  type: "custom";
  metadata?: Record<string, string>;
  created_at: string;
  created_by: string | null;
  cover: string | null;
  tracks: ManifestTrack[];
}

export interface MainPlaylistState {
  queueIndex: number;
  queueMode: QueueMode;
}

const LIBRARY_SOURCES = new Set(["library", "album", "artist", "tag", "playlist"]);

/**
 * What we know about a track's on-disk thumbnail. Both fields come from the
 * backend `main-playlist-thumb-ready` event — the frontend never computes the
 * filename itself (Rust's `canonical_slug` is the single source of truth, so
 * there is no JS slug mirror to drift out of sync). `version` is bumped on each
 * ready event to bust the WebView cache.
 */
export interface ThumbInfo {
  version: number;
  filename: string;
}

/**
 * Resolve the on-disk local thumbnail path for a queue item, or null if no
 * thumb has been confirmed on disk.
 *
 * The thumb file is written asynchronously by `main_playlist_set_thumb`, which
 * emits `main-playlist-thumb-ready { key, filename }` only *after* the file
 * exists. On restore the frontend instead seeds `thumbInfo` from the
 * existence-checked `thumbs` list returned by `main_playlist_read`. Either way
 * the frontend records `thumbInfo[uri]`. Until an entry is present we
 * have no proof the file exists, so requesting it would make the asset protocol
 * log a spurious "File does not exist" error on first paint — callers fall back
 * to the track's own `image_url` / the entity-image chain until then.
 *
 * No remote gate: a thumb is used iff one exists on disk for this URI. Library
 * tracks never get a thumb written (their art resolves through the shared
 * entity-image cache), so this naturally returns null for them.
 *
 * Returns the raw local path with a `#v=N` cache-buster suffix (NOT run
 * through convertFileSrc) so this stays pure/testable. The caller passes it
 * through `resolveImageUrl`, which converts `#v=N` to a post-convert `?v=N`.
 */
export function queueItemLocalThumb(args: {
  mainPlaylistDir: string | null | undefined;
  uri: string | null | undefined;
  thumbInfo: Record<string, ThumbInfo>;
}): string | null {
  const { mainPlaylistDir, uri, thumbInfo } = args;
  if (!mainPlaylistDir || !uri) return null;
  const info = thumbInfo[uri];
  if (!info) return null;
  return `${mainPlaylistDir}/thumbs/${info.filename}#v=${info.version}`;
}

export function isContextRemote(ctx: PlaylistContext | null | undefined): boolean {
  if (!ctx) return false;
  if (typeof ctx.remote === "boolean") return ctx.remote;
  if (!ctx.source) return false;
  return !LIBRARY_SOURCES.has(ctx.source);
}

/**
 * Coerce one untyped metadata value into the single line the wire format and
 * the QueuePanel tooltip both want, or null to drop it. String-ish arrays are
 * joined rather than dropped — they render as one tooltip row, where an array
 * would otherwise print with its members run together.
 */
function metadataValue(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (Array.isArray(v)) {
    const parts = v.map(metadataValue).filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

/**
 * Coerce an untyped metadata bag into the `Record<string, string>` the manifest
 * demands. The backend deserializes this field into a Rust `HashMap<String,
 * String>`, so a **single** non-string value fails the whole command's argument
 * decoding ("invalid type: sequence, expected a string") — and for the live
 * queue that means the manifest silently stops being written, so the next
 * launch restores whatever stale playlist was last written successfully.
 *
 * Values arrive untyped from two directions the TS type can't police: playlist
 * rows (auto-mix metadata carries `featured_artists: string[]`, `tag_id:
 * number`, `seed_title: null`) and plugin-supplied play contexts. Anything with
 * no sensible one-line form — null, nested objects — is dropped.
 */
export function toStringMetadata(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = metadataValue(v);
    if (s !== null) out[k] = s;
  }
  return out;
}

export function buildManifest(queue: QueueTrack[], context: PlaylistContext | null | undefined): Manifest {
  const raw: Record<string, unknown> = {};
  if (context?.source) raw.source = context.source;
  if (context?.description) raw.description = context.description;
  if (context?.metadata) for (const [k, v] of Object.entries(context.metadata)) raw[k] = v;
  const metadata = toStringMetadata(raw);

  return {
    version: 1,
    title: context?.name ?? "Main Playlist",
    type: "custom",
    metadata,
    created_at: new Date().toISOString(),
    created_by: null,
    cover: context?.imagePath ? "cover.jpg" : null,
    tracks: queue.map(t => ({
      title: t.title,
      artist: t.artist_name ?? "",
      album_artist: t.album_artist_name ?? null,
      album: t.album_title ?? null,
      duration_secs: t.duration_secs,
      file: t.path,
      // The main playlist no longer persists a thumb path: the on-disk
      // filename is derived solely from `file` (canonical_slug) by the backend,
      // and gc()/restore key off that, not this string. The field stays on the
      // shared MixtapeTrack type for mixtape export, which sets it itself.
      thumb: null,
      format: t.format,
      // Persisted so a **path-less** entry keeps its art across a restart —
      // that entry can have no cached thumb, because the thumb filename is
      // derived from the file URI and there is no URI to key one under (see the
      // `if (!t.path) continue` guard in useQueue's thumb effect). Library
      // tracks carry no `image_url` at all, so this is null for them and the
      // entity-image chain still owns their art.
      image_url: t.image_url ?? null,
      file_size: t.file_size ?? null,
    })),
  };
}

export function buildState(queueIndex: number, queueMode: QueueMode): MainPlaylistState {
  return { queueIndex, queueMode };
}

/**
 * Immediate drain of the debounced main-playlist write — same payload the
 * debounced effect in useQueue sends, fired synchronously (used by the
 * profile-switch flow before relaunch). No-op before restore completes:
 * flushing pre-restore would overwrite the saved queue with the empty default.
 * Rejections propagate so the caller can abort the switch.
 */
export function flushMainPlaylist(
  restored: boolean,
  queue: QueueTrack[],
  context: PlaylistContext | null,
  queueIndex: number,
  queueMode: QueueMode,
  invokeFn: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  if (!restored) return Promise.resolve();
  return invokeFn("main_playlist_write", {
    manifest: buildManifest(queue, context),
    stateData: buildState(queueIndex, queueMode),
  }).then(() => undefined);
}

export function tracksFromManifest(manifest: Manifest): QueueTrack[] {
  return manifest.tracks.map((m): QueueTrack => ({
    // QueueEntry.key is an in-memory identity used for React rendering + multi-select.
    // It is not persisted. Generate fresh keys on restore from the SAME shared
    // counter (nextQueueKey) that every other queue mutation uses — a private
    // local counter here would restart at q:1 and collide with keys minted later
    // by nextQueueKey(), producing duplicate React keys that corrupt
    // reconciliation (phantom rows that survive clear/remove). Thumbnail identity on
    // disk is keyed off the file URI (canonical_slug, backend-side), not this key,
    // so thumbs cached before restart are still found — seeded into thumbInfo
    // from main_playlist_read's existence-checked `thumbs` list, not the manifest.
    key: nextQueueKey(),
    path: m.file,
    title: m.title,
    artist_name: m.artist || null,
    album_artist_name: m.album_artist ?? null,
    album_title: m.album,
    duration_secs: m.duration_secs,
    // Restore the persisted format. Legacy manifests written before format was
    // stored omit the field → null (audio default). isVideoTrack reads this, so
    // dropping it would misclassify a restored video as audio after restart.
    format: m.format ?? null,
    liked: 0,
    // Seeded from the entry's OWN `image_url`, never from `m.thumb`: the on-disk
    // thumbnail is resolved separately through `thumbInfo` (seeded from
    // `main_playlist_read` on restore, and from `main-playlist-thumb-ready`
    // during the session) so Rust stays the sole namer of that file. QueuePanel
    // prefers the thumb and only falls back to this, and `QueueItemThumb`
    // records failed sources — so a plugin URL that has since expired degrades
    // to the placeholder rather than sticking as a broken image.
    //
    // Library tracks have no `image_url`, so this is undefined for them and
    // their art still resolves via the entity cache.
    image_url: m.image_url ?? undefined,
    file_size: m.file_size ?? null,
    // libraryId is intentionally NOT persisted or seeded here. A stored rowid
    // can go stale — SQLite reuses the ids of deleted rows — and a stale id is
    // worse than none, because consumers stop falling back. It is also
    // unnecessary: the only two writers of `libraryId` are `trackToQueueTrack`
    // (from a `Track`, whose `path` is non-null in Rust) and the restore
    // reconcile itself, so every entry that has an id also has a URI — and
    // App.tsx re-resolves it from that URI via `find_track_ids_by_paths`,
    // getting an answer that is correct *now* rather than remembered.
  }));
}

export function contextFromManifest(manifest: Manifest, mainPlaylistDir: string | null): PlaylistContext | null {
  const metadata = manifest.metadata ?? {};
  const source = metadata.source ?? null;
  const description = metadata.description ?? null;
  const { source: _s, description: _d, coverUrl: _c, ...restMeta } = metadata;
  if (!source && !description && !manifest.cover && Object.keys(restMeta).length === 0) return null;
  const remote = source ? !LIBRARY_SOURCES.has(source) : false;
  const imagePath = manifest.cover && mainPlaylistDir
    ? `${mainPlaylistDir}/${manifest.cover}`
    : null;
  return {
    name: manifest.title,
    imagePath,
    source,
    description,
    metadata: Object.keys(restMeta).length > 0 ? restMeta : null,
    remote,
  };
}

/**
 * Flatten PlaylistContext fields into a single metadata map for mixtape export.
 * source and description become top-level keys; context.metadata is merged in.
 */
export function contextToExportMetadata(ctx: PlaylistContext | null | undefined): Record<string, string> | null {
  if (!ctx) return null;
  const raw: Record<string, unknown> = {};
  if (ctx.source) raw.source = ctx.source;
  if (ctx.description) raw.description = ctx.description;
  if (ctx.metadata) {
    for (const [k, v] of Object.entries(ctx.metadata)) {
      if (v) raw[k] = v;
    }
  }
  // Same string-map wire type as the manifest — see toStringMetadata.
  const meta = toStringMetadata(raw);
  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Extract PlaylistContext fields from a flat mixtape metadata map.
 * Inverse of contextToExportMetadata: pulls source and description out,
 * remaining keys become context.metadata.
 */
export function contextFromMixtapeMetadata(
  name: string,
  imagePath: string | null,
  metadata: Record<string, string> | null,
): PlaylistContext {
  const { source, description, ...rest } = metadata ?? {};
  return {
    name,
    imagePath,
    source: source ?? null,
    description: description ?? null,
    metadata: Object.keys(rest).length > 0 ? rest : null,
    remote: false,
  };
}

/**
 * Diff queues by **file URI** (stable across restarts), not by `key` (in-memory only).
 * `added` are full track records (so callers can read image_url); `removed` is a list
 * of URIs to delete thumb files for.
 */
export function diffThumbs(
  prev: QueueTrack[],
  next: QueueTrack[],
): { added: QueueTrack[]; removed: string[] } {
  const prevUris = new Set(prev.map(t => t.path).filter((p): p is string => !!p));
  const nextUris = new Set(next.map(t => t.path).filter((p): p is string => !!p));
  const added = next.filter(t => t.path && !prevUris.has(t.path));
  const removed = prev
    .map(t => t.path)
    .filter((p): p is string => !!p && !nextUris.has(p));
  return { added, removed };
}
