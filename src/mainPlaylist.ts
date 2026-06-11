import type { QueueTrack, QueueMode } from "./types";
import type { PlaylistContext } from "./hooks/useQueue";
import { nextExternalKey } from "./queueEntry";

export interface ManifestTrack {
  title: string;
  artist: string;
  album: string | null;
  duration_secs: number | null;
  file: string | null;
  thumb: string | null;
  format?: string | null;
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
 * The thumb file is written asynchronously by `main_playlist_set_thumb` (and
 * reconciled on restore by `main_playlist_touch_thumbs`), which emit
 * `main-playlist-thumb-ready { key, filename }` only *after* the file exists.
 * The frontend records that as `thumbInfo[uri]`. Until an entry is present we
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

export function buildManifest(queue: QueueTrack[], context: PlaylistContext | null | undefined): Manifest {
  const metadata: Record<string, string> = {};
  if (context?.source) metadata.source = context.source;
  if (context?.description) metadata.description = context.description;
  if (context?.metadata) for (const [k, v] of Object.entries(context.metadata)) metadata[k] = v;

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
      album: t.album_title ?? null,
      duration_secs: t.duration_secs,
      file: t.path,
      // The main playlist no longer persists a thumb path: the on-disk
      // filename is derived solely from `file` (canonical_slug) by the backend,
      // and gc()/restore key off that, not this string. The field stays on the
      // shared MixtapeTrack type for mixtape export, which sets it itself.
      thumb: null,
      format: t.format,
    })),
  };
}

export function buildState(queueIndex: number, queueMode: QueueMode): MainPlaylistState {
  return { queueIndex, queueMode };
}

export function tracksFromManifest(manifest: Manifest): QueueTrack[] {
  return manifest.tracks.map((m): QueueTrack => ({
    // QueueEntry.key is an in-memory identity used for React rendering + multi-select.
    // It is not persisted. Generate fresh keys on restore from the SAME shared
    // counter (nextExternalKey) that every other queue mutation uses — a private
    // local counter here would restart at ext:1 and collide with keys minted later
    // by nextExternalKey(), producing duplicate React keys that corrupt
    // reconciliation (phantom rows that survive clear/remove). Thumbnail identity on
    // disk is keyed off the file URI (canonical_slug, backend-side), not this key,
    // so thumbs cached before restart are still found — repopulated into thumbInfo
    // by the post-restore main_playlist_touch_thumbs call, not from the manifest.
    key: nextExternalKey(),
    path: m.file,
    title: m.title,
    artist_name: m.artist || null,
    album_title: m.album,
    duration_secs: m.duration_secs,
    // Restore the persisted format. Legacy manifests written before format was
    // stored omit the field → null (audio default). isVideoTrack reads this, so
    // dropping it would misclassify a restored video as audio after restart.
    format: m.format ?? null,
    liked: 0,
    // image_url is intentionally NOT seeded from m.thumb: the queue thumbnail is
    // resolved from thumbInfo (populated by touch_thumbs) so Rust remains the
    // sole namer of the on-disk file. Library art still resolves via the entity
    // cache in QueuePanel/App.
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
  const meta: Record<string, string> = {};
  if (ctx.source) meta.source = ctx.source;
  if (ctx.description) meta.description = ctx.description;
  if (ctx.metadata) {
    for (const [k, v] of Object.entries(ctx.metadata)) {
      if (v) meta[k] = v;
    }
  }
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
