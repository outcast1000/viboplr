// The plugin API's library import surface — `api.library.findTrack`,
// `planImport` and `importFile` — as pure parsing + filtering, so the bridge in
// `usePlugins` is a thin invoke and the rules are testable without Tauri.
//
// The decisions themselves live in Rust (`media_import.rs`): which collection a
// song goes to (next to its album, else its artist, else the default), whether
// the song is already there, and where the file lands. This file only checks
// what a plugin sent and shapes the answer.

import type { Track } from "../types";

/** Two lengths further apart than this are different recordings (a live take).
 *  Mirrors `media_import::SAME_RECORDING_TOLERANCE_SECS`. */
export const SAME_RECORDING_TOLERANCE_SECS = 5;

export interface LibraryTrackQuery {
  title: string;
  artist: string;
  album?: string | null;
  /** When known, copies of a clearly different length are left out. */
  durationSecs?: number | null;
}

export type ImportPlacement = "given" | "album" | "artist" | "default" | "only";

export interface ImportPlanRequest {
  title: string;
  artist: string;
  album?: string | null;
  /** Put it exactly in this collection (an enabled local folder). */
  collectionId?: number | null;
  /** Prefer the collection already holding the album or artist. Default true. */
  keepWithExisting?: boolean;
}

export interface ImportPlan {
  collectionId: number;
  collectionName: string;
  /** Why this collection: "album" = next to the album, "artist" = next to the
   *  artist's other tracks, "default", "only" (the one local collection), or
   *  "given" (the caller named it). */
  placement: ImportPlacement;
}

export interface ImportFileRequest extends ImportPlanRequest {
  /** The file to copy in — an absolute local path (bare or `file://`). It is
   *  copied, never moved. */
  path: string;
  trackNumber?: number | null;
  /** Import even when the song is already in the library (Save as copy). */
  asCopy?: boolean;
}

export type ImportFileResult =
  | {
      status: "imported";
      trackId: number;
      path: string;
      collectionId: number;
      collectionName: string;
      placement: ImportPlacement;
    }
  | {
      /** The song is already in the library as a local file; nothing was copied.
       *  Offer `replaceTrackFile({ trackId, path })` or `importFile({ …, asCopy: true })`. */
      status: "exists";
      trackId: number;
      path: string;
      collectionId: number | null;
      collectionName: string | null;
      /** How many local copies matched; `trackId` is the one nearest in length. */
      copies: number;
    };

/** The Rust `ImportTarget` (camelCase over the wire). */
export interface ImportTargetArgs {
  title: string;
  artistName: string;
  albumTitle: string | null;
  trackNumber: number | null;
  collectionId: number | null;
  defaultCollectionId: number | null;
  keepWithExisting: boolean;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function optText(v: unknown): string | null {
  const t = text(v);
  return t ? t : null;
}

function optInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

function optSecs(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export function parseTrackQuery(raw: unknown): Required<LibraryTrackQuery> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const title = text(o.title);
  const artist = text(o.artist);
  if (!title || !artist) throw new Error("findTrack needs { title, artist }");
  return { title, artist, album: optText(o.album), durationSecs: optSecs(o.durationSecs) };
}

/** Library copies of the song a plugin asked about, local files first then
 *  nearest in length, without the ones whose length says another recording. */
export function sameRecordingCopies(rows: Track[], durationSecs: number | null): Track[] {
  const off = (t: Track) =>
    durationSecs != null && t.duration_secs != null ? Math.abs(t.duration_secs - durationSecs) : 0;
  const local = (t: Track) => (t.path?.startsWith("file://") ? 0 : 1);
  return rows
    .filter((t) => off(t) <= SAME_RECORDING_TOLERANCE_SECS)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => local(a.t) - local(b.t) || off(a.t) - off(b.t) || a.i - b.i)
    .map(({ t }) => t);
}

/** `lastDownloadDest` (the download modal's last collection) as an id. */
export function storedDefaultCollection(v: unknown): number | null {
  const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function importTargetArgs(raw: unknown, defaultCollectionId: number | null, what: string): ImportTargetArgs {
  const o = (raw ?? {}) as Record<string, unknown>;
  const title = text(o.title);
  const artistName = text(o.artist);
  if (!title || !artistName) throw new Error(`${what} needs { title, artist }`);
  return {
    title,
    artistName,
    albumTitle: optText(o.album),
    trackNumber: optInt(o.trackNumber),
    collectionId: optInt(o.collectionId),
    defaultCollectionId,
    keepWithExisting: o.keepWithExisting !== false,
  };
}

export function importSourcePath(raw: unknown): string {
  const path = text((raw as Record<string, unknown> | null)?.path);
  if (!path) throw new Error("importFile needs { path } — the file to copy in");
  return path;
}
