// Cue-sheet save shared by the control API dispatcher (hooks/useControlApi.ts,
// `cues.set`) and the plugin API (usePlugins.buildAPI → api.cues.set). Same
// split as hostOps.ts / tagOps.ts: the op owns what is checked and what is
// stored; each caller owns how it names the song and its response.
//
// Before this module the plugin path was a bare `cue_sheet_set`: it skipped
// the past-the-end check (the backend never learns the song's length, so a
// sheet timed in milliseconds saved fine and never showed a card) and never
// filled in the album or length from what the app knows about the song.

import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack, Track } from "../types";
import { cuePastEndError, sameCueSong, splitSheetMeta, type CueSheetRow } from "./cueSheet";

export interface CueSong {
  title: string;
  artistName: string | null;
}

export interface CueOpsDeps {
  currentTrack: () => QueueTrack | null;
  /** The engine's length for the playing track, when it has one. */
  currentDurationSecs: () => number | null;
  queue: () => QueueTrack[];
}

export interface CueSaveMeta {
  author?: string | null;
  /** The length the cues were timed to, declared by the caller — wins over
   *  the app's own facts (a shared sheet was timed to its author's copy, and
   *  that difference is what the "different cut" note reports). */
  durationSecs?: number | null;
  albumName?: string | null;
}

/** What the app itself knows about the song — its length and album, from the
 *  engine / playing entry, a queue entry, else the library row. The same
 *  lookup order `cues.context` describes the song in, so the length recorded
 *  is the one the author was shown. */
export async function cueSongFacts(
  deps: CueOpsDeps,
  song: CueSong,
): Promise<{ durationSecs: number | null; albumName: string | null }> {
  const current = deps.currentTrack();
  if (current && sameCueSong({ title: current.title, artistName: current.artist_name }, song)) {
    return {
      durationSecs: deps.currentDurationSecs() || current.duration_secs || null,
      albumName: current.album_title ?? null,
    };
  }
  const queued = deps.queue().find((t) => sameCueSong({ title: t.title, artistName: t.artist_name }, song));
  if (queued?.duration_secs) return { durationSecs: queued.duration_secs, albumName: queued.album_title ?? null };
  try {
    const row = await invoke<Track | null>("find_track_by_metadata", {
      title: song.title, artistName: song.artistName, albumName: null,
    });
    return { durationSecs: row?.duration_secs ?? null, albumName: row?.album_title ?? null };
  } catch (e) {
    console.error("Failed to look up the cue sheet song:", e);
    return { durationSecs: null, albumName: null };
  }
}

/**
 * Save a cue sheet for `song`. `rawSheet` may carry its own `track` / `author`
 * block (a sheet written to a file names its song); that block only fills a
 * gap the caller's `meta` and the app's facts leave. Throws, with a message a
 * caller can show verbatim, for a malformed block or a cue past the song's end.
 * `Row` is the caller's view of the stored row (the plugin API types it loosely).
 */
export async function saveCueSheet<Row = CueSheetRow>(
  deps: CueOpsDeps,
  song: CueSong,
  rawSheet: unknown,
  meta: CueSaveMeta = {},
): Promise<Row> {
  const { sheet, track: sheetTrack, author: sheetAuthor } = splitSheetMeta(rawSheet);
  const facts = await cueSongFacts(deps, song);
  const durationSecs = meta.durationSecs ?? facts.durationSecs ?? sheetTrack?.durationSecs ?? null;
  const pastEnd = cuePastEndError(sheet, durationSecs);
  if (pastEnd) throw new Error(pastEnd);
  return invoke<Row>("cue_sheet_set", {
    ...song,
    sheet,
    author: meta.author ?? sheetAuthor,
    albumName: meta.albumName ?? facts.albumName ?? sheetTrack?.albumName ?? null,
    durationSecs,
  });
}
