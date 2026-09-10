// The one implementation of "give me a library id for each queue entry":
// the cached `libraryId` when present, else ONE bulk `find_track_ids_by_paths`
// lookup over the id-less entries' paths. Shared by the queue Share and Delete
// paths (App.tsx handlePublishQueue, useContextMenuActions' queue-multi delete
// and video delete), which each used to loop `find_track_id_by_path` per entry
// — and PATH_EXPR is unindexable, so every one of those calls scans the whole
// tracks table (the O(queue × library) pattern the bulk command was added to
// kill; measured at 740ms for 500 entries over 20k tracks).
import { invoke } from "@tauri-apps/api/core";

/**
 * Resolve a library id per entry, aligned with the input (`null` = not in the
 * library). Best-effort: a failed bulk lookup logs and leaves the id-less
 * entries null — same contract as the restore reconcile.
 */
export async function resolveLibraryIds(
  tracks: ReadonlyArray<{ libraryId?: number | null; path: string | null }>,
): Promise<Array<number | null>> {
  const ids: Array<number | null> = tracks.map(t => t.libraryId ?? null);
  const missing = [...new Set(
    tracks.filter((t, i) => ids[i] == null && t.path).map(t => t.path!),
  )];
  if (missing.length === 0) return ids;
  try {
    const pairs = await invoke<[string, number][]>("find_track_ids_by_paths", { paths: missing });
    const byPath = new Map(pairs);
    for (let i = 0; i < tracks.length; i++) {
      const path = tracks[i].path;
      if (ids[i] == null && path) ids[i] = byPath.get(path) ?? null;
    }
  } catch (e) {
    console.error("Failed to resolve track ids by path:", e);
  }
  return ids;
}
