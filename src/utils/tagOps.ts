// Tag operations shared by the control API dispatcher (hooks/useControlApi.ts)
// and the plugin API (usePlugins.buildAPI → api.library). Same split as
// hostOps.ts / queueOps.ts: the op owns what runs and what the app is told
// afterwards; each caller owns argument shape and its response.
//
// Two kinds of write, and the refresh each one needs:
//
//   - DB-only quick tags (add / remove). Adds go through
//     `plugin_apply_tags_bulk`, which updates FTS but does not recount — and
//     `get_tags` lists only `track_count > 0`, so a tag created this way was
//     invisible in the Library until the next scan. `tagsChanged` is App's
//     debounced `refresh_tag_counts` + library reload, so a burst (the
//     auto-tagger tags every scanned track) costs one recount, not one per call.
//     Removes go through `remove_tag_from_tracks`, the detail pages' path,
//     which recounts itself; `tagsChanged` still reloads the lists.
//   - File metadata (`bulk_update_tracks`, the only path that writes into
//     audio files). `filesWritten` is the same full refresh BulkEditModal's
//     save triggers, plus a `trackEvents` patch for the fields it changed.
//
// Before this module the three callers disagreed: the control API removed a
// tag via `replace_track_tags` (case-insensitive, not diacritic-insensitive
// like everything else), plugins could not remove tags at all, and a plugin's
// `bulkUpdateTracks({ tag_names })` never sent a mode — which the backend
// reads as REPLACE, silently wiping every other tag on the tracks.

import { invoke } from "@tauri-apps/api/core";
import { emitTrackPatch } from "../trackEvents";
import type { Track } from "../types";

export interface TagOpsDeps {
  /** DB-only tag rows changed. Debounced by the caller. */
  tagsChanged: () => void;
  /** Audio files and their library rows were rewritten. */
  filesWritten: () => void;
}

/** Deps for a caller with nothing to refresh (a test, a host without a UI). */
export const NO_TAG_REFRESH: TagOpsDeps = { tagsChanged: () => {}, filesWritten: () => {} };

function cleanNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    if (typeof n !== "string") continue;
    const t = n.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

async function addQuiet(assignments: Array<[number, string[]]>): Promise<number> {
  const clean = assignments
    .map(([id, names]) => [id, cleanNames(names)] as [number, string[]])
    .filter(([id, names]) => Number.isInteger(id) && names.length > 0);
  if (clean.length === 0) return 0;
  return invoke<number>("plugin_apply_tags_bulk", { assignments: clean });
}

async function removeQuiet(trackIds: number[], names: string[]): Promise<void> {
  for (const name of cleanNames(names)) {
    await invoke("remove_tag_from_tracks", { trackIds, tagName: name });
  }
}

async function tagsOf(trackId: number): Promise<Array<{ id: number; name: string }>> {
  const rows = await invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId });
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/** Add tags to tracks, per-track lists. Resolves with the number of tracks
 *  that received at least one tag. Additive — never removes anything. */
export async function addTags(deps: TagOpsDeps, assignments: Array<[number, string[]]>): Promise<number> {
  const n = await addQuiet(assignments);
  if (n > 0) deps.tagsChanged();
  return n;
}

/** Remove tags (matched accent- and case-insensitively) from tracks. */
export async function removeTags(deps: TagOpsDeps, trackIds: number[], names: string[]): Promise<void> {
  if (trackIds.length === 0 || cleanNames(names).length === 0) return;
  await removeQuiet(trackIds, names);
  deps.tagsChanged();
}

/** One track: remove, then add, then read back the full tag list. */
export async function editTrackTags(
  deps: TagOpsDeps,
  trackId: number,
  edit: { add?: string[]; remove?: string[] },
): Promise<Array<{ id: number; name: string }>> {
  const add = cleanNames(edit.add);
  const remove = cleanNames(edit.remove);
  if (add.length === 0 && remove.length === 0) throw new Error("nothing to change — pass add and/or remove");
  if (remove.length > 0) await removeQuiet([trackId], remove);
  if (add.length > 0) await addQuiet([[trackId, add]]);
  deps.tagsChanged();
  return tagsOf(trackId);
}

// --- File metadata ---

export type TagMode = "add" | "remove" | "replace";

/** Presence rules: a key that is absent leaves the field alone; `null` (or
 *  `""` for strings) clears it. Values are `unknown` because both callers are
 *  untyped at runtime (a JSON body, a plugin's JS) — validation lives here. */
export interface FileMetadataEdit {
  artistName?: unknown;
  albumArtistName?: unknown;
  albumTitle?: unknown;
  year?: unknown;
  trackNumber?: unknown;
  title?: unknown;
  tagNames?: unknown;
  /** Defaults to `"add"`. Replace is the destructive reading, so it is never
   *  implied — the backend's own default for a missing mode is replace. */
  tagMode?: unknown;
}

/** Validate an edit and build the `bulk_update_tracks` fields. Throws with a
 *  message a caller can show verbatim. Pure. */
export function buildFileMetadataFields(trackIds: number[], edit: FileMetadataEdit): Record<string, unknown> {
  if (trackIds.length === 0) throw new Error("trackIds must be a non-empty array of numbers");
  const fields: Record<string, unknown> = {};
  const has = (k: keyof FileMetadataEdit) => Object.prototype.hasOwnProperty.call(edit, k) && edit[k] !== undefined;

  const stringField = (key: keyof FileMetadataEdit, target: string) => {
    if (!has(key)) return;
    const v = edit[key];
    if (v !== null && typeof v !== "string") throw new Error(`${key} must be a string or null`);
    fields[target] = v === "" ? null : v;
  };
  stringField("artistName", "artist_name");
  stringField("albumArtistName", "album_artist_name");
  stringField("albumTitle", "album_title");

  const intField = (key: keyof FileMetadataEdit, target: string) => {
    if (!has(key)) return;
    const v = edit[key];
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v))) throw new Error(`${key} must be an integer or null`);
    fields[target] = v;
  };
  intField("year", "year");
  intField("trackNumber", "track_number");

  if (has("title")) {
    if (typeof edit.title !== "string" || edit.title.trim() === "") throw new Error("title must be a non-empty string");
    if (trackIds.length > 1) throw new Error("title applies to a single track — send one trackId");
    fields.title = edit.title;
  }

  if (has("tagNames")) {
    if (!Array.isArray(edit.tagNames)) throw new Error("tagNames must be an array of strings");
    const tagNames = cleanNames(edit.tagNames);
    const mode = edit.tagMode ?? "add";
    if (mode !== "add" && mode !== "remove" && mode !== "replace") {
      throw new Error('tagMode must be "add", "remove" or "replace"');
    }
    if (tagNames.length === 0 && mode !== "replace") throw new Error("tagNames is empty — only tagMode=replace may clear tags");
    fields.tag_names = tagNames;
    fields.tag_mode = mode;
  } else if (has("tagMode")) {
    throw new Error("tagMode needs tagNames");
  }

  if (Object.keys(fields).length === 0) {
    throw new Error("nothing to write — pass tagNames, artistName, albumArtistName, albumTitle, year, trackNumber or title");
  }
  return fields;
}

/** Write metadata into the tracks' audio files (and their library rows).
 *  Resolves with per-track error strings — empty when every file was written. */
export async function writeFileMetadata(
  deps: TagOpsDeps,
  trackIds: number[],
  edit: FileMetadataEdit,
): Promise<string[]> {
  const fields = buildFileMetadataFields(trackIds, edit);
  const errors = await invoke<string[]>("bulk_update_tracks", { trackIds, fields });
  // Same live patch BulkEditModal sends, so an open detail page updates without
  // waiting for the reload. Only on full success — a partial failure leaves
  // the reload to tell the truth per track.
  if (errors.length === 0) {
    const patch: Partial<Track> = {};
    if ("artist_name" in fields) patch.artist_name = fields.artist_name as string | null;
    if ("album_artist_name" in fields) patch.album_artist_name = fields.album_artist_name as string | null;
    if ("album_title" in fields) patch.album_title = fields.album_title as string | null;
    if ("year" in fields) patch.year = fields.year as number | null;
    if ("title" in fields) patch.title = fields.title as string;
    if ("track_number" in fields) patch.track_number = fields.track_number as number | null;
    if (Object.keys(patch).length > 0) for (const id of trackIds) emitTrackPatch(id, patch);
  }
  deps.filesWritten();
  return errors;
}
