import type { Track } from "./types";
import type { PlaylistContext } from "./hooks/useQueue";

export interface ManifestTrack {
  title: string;
  artist: string;
  album: string | null;
  duration_secs: number | null;
  file: string | null;
  thumb: string | null;
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
  queueMode: "normal" | "loop" | "shuffle";
  shuffleOrder: number[];
  shufflePosition: number;
}

const LIBRARY_SOURCES = new Set(["library", "album", "artist", "tag", "playlist"]);

/**
 * Mirror of backend `canonical_slug` applied to a track's file URI.
 * Backend (src-tauri/src/entity_image.rs): lowercases, deletes `\ / : * ? " < > |` and
 * control chars, collapses whitespace, trims leading/trailing dots, returns "_unknown"
 * if empty.
 *
 * Rationale: URIs are stable across restarts (unlike the in-memory `QueueEntry.key`
 * which uses a resetting counter for external tracks). Keying thumbs by URI lets
 * cached thumbs survive app restarts.
 *
 * Known divergences from Rust canonical_slug (intentional; don't affect thumb lookup
 * because thumbs are only cached for remote-sourced playlists whose URIs are ASCII —
 * plugin schemes, `subsonic://`, `http(s)://`):
 *   - no `deunicode` / `strip_diacritics` (Rust transliterates non-ASCII)
 *   - no `RESERVED_NAMES` prefix (Rust adds `_` before CON/PRN/AUX/etc.)
 *   - no 200-byte truncation
 * If you change `canonical_slug` in Rust, update this to match and re-run both test suites.
 */
const FORBIDDEN_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;
export function thumbFilenameForUri(uri: string | null | undefined): string {
  if (!uri) return "_unknown.jpg";
  const lowered = uri.toLowerCase();
  const filtered = lowered.replace(FORBIDDEN_CHARS, "");
  const collapsed = filtered.split(/\s+/).filter(Boolean).join(" ");
  const trimmed = collapsed.replace(/^\.+|\.+$/g, "");
  const slug = trimmed.length === 0 ? "_unknown" : trimmed;
  return `${slug}.jpg`;
}

export function isContextRemote(ctx: PlaylistContext | null | undefined): boolean {
  if (!ctx) return false;
  if (typeof ctx.remote === "boolean") return ctx.remote;
  if (!ctx.source) return false;
  return !LIBRARY_SOURCES.has(ctx.source);
}

export function buildManifest(queue: Track[], context: PlaylistContext | null | undefined): Manifest {
  const remote = isContextRemote(context);
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
    cover: context?.imagePath || context?.coverUrl ? "cover.jpg" : null,
    tracks: queue.map(t => ({
      title: t.title,
      artist: t.artist_name ?? "",
      album: t.album_title ?? null,
      duration_secs: t.duration_secs,
      file: t.path,
      thumb: remote && t.path ? `thumbs/${thumbFilenameForUri(t.path)}` : null,
    })),
  };
}

export function buildState(
  queueIndex: number,
  queueMode: "normal" | "loop" | "shuffle",
  shuffleOrder: number[],
  shufflePosition: number,
): MainPlaylistState {
  return { queueIndex, queueMode, shuffleOrder, shufflePosition };
}

export function tracksFromManifest(manifest: Manifest): Track[] {
  let extCounter = 1;
  return manifest.tracks.map((m): Track => ({
    id: null,
    // QueueEntry.key is an in-memory identity used for React rendering + multi-select.
    // It is not persisted. Generate fresh keys on restore. Thumbnail identity on disk
    // is keyed off the file URI (see thumbFilenameForUri), not this key, so thumbs
    // cached before restart are still found.
    key: `ext:${extCounter++}`,
    path: m.file,
    title: m.title,
    artist_id: null, artist_name: m.artist || null,
    album_id: null, album_title: m.album,
    year: null, track_number: null,
    duration_secs: m.duration_secs,
    format: null, file_size: null,
    collection_id: null, collection_name: null,
    liked: 0, youtube_url: null,
    added_at: null, modified_at: null,
    image_url: undefined,
  }));
}

export function contextFromManifest(manifest: Manifest, mainPlaylistDir: string | null): PlaylistContext | null {
  const metadata = manifest.metadata ?? {};
  const source = metadata.source ?? null;
  const description = metadata.description ?? null;
  const { source: _s, description: _d, ...restMeta } = metadata;
  if (!source && !description && !manifest.cover && Object.keys(restMeta).length === 0) return null;
  const remote = source ? !LIBRARY_SOURCES.has(source) : false;
  // Resolve cover to its absolute filesystem path so downstream consumers
  // (mixtape export, update_playlist_image, edit-playlist modal) get a usable path.
  const imagePath = manifest.cover && mainPlaylistDir
    ? `${mainPlaylistDir}/${manifest.cover}`
    : null;
  return {
    name: manifest.title,
    imagePath,
    coverUrl: null,
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
  prev: Track[],
  next: Track[],
): { added: Track[]; removed: string[] } {
  const prevUris = new Set(prev.map(t => t.path).filter((p): p is string => !!p));
  const nextUris = new Set(next.map(t => t.path).filter((p): p is string => !!p));
  const added = next.filter(t => t.path && !prevUris.has(t.path));
  const removed = prev
    .map(t => t.path)
    .filter((p): p is string => !!p && !nextUris.has(p));
  return { added, removed };
}
