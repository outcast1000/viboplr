import type { Track } from "../types";
import { isLocalTrack, isNetworkSharePath } from "../queueEntry";

export interface DeleteConfirmPayload {
  trackIds: number[];
  title: string;
  network: boolean;
}

/**
 * Split a set of requested track ids into the ones already present in the
 * loaded library page and the ones still missing.
 *
 * `library.tracks` is paginated (first PAGE_SIZE rows of the current view), so
 * a plugin-initiated delete (e.g. Duplicate Finder) can reference ids that were
 * never loaded. Those must be reported as `missingIds` so the caller resolves
 * them via `get_tracks_by_ids` rather than silently dropping them — dropping was
 * the bug that made the Duplicate Finder delete buttons appear dead.
 */
export function partitionTrackIds(
  trackIds: number[],
  loadedTracks: Track[],
): { loaded: Track[]; missingIds: number[] } {
  const requested = new Set(trackIds);
  const loaded = loadedTracks.filter(t => t.id != null && requested.has(t.id));
  const haveIds = new Set(loaded.map(t => t.id!));
  const missingIds: number[] = [];
  const seen = new Set<number>();
  for (const id of trackIds) {
    if (haveIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    missingIds.push(id);
  }
  return { loaded, missingIds };
}

/**
 * Build the delete-confirmation payload from a set of resolved tracks. Filters
 * to local, deletable copies (only local files can be trashed), derives the
 * modal title, and flags whether any copy lives on a network share (a permanent
 * delete — it can't go to the Recycle Bin). Returns null when nothing is
 * deletable.
 *
 * Callers must resolve ids outside the loaded page (see `partitionTrackIds`)
 * before calling, so an off-page track still produces a payload.
 */
export function buildDeleteConfirmPayload(tracks: Track[]): DeleteConfirmPayload | null {
  const localTracks = tracks.filter(t => t.id != null && isLocalTrack(t));
  if (localTracks.length === 0) return null;
  const trackIds = localTracks.map(t => t.id!);
  const title = trackIds.length === 1 ? (localTracks[0].title ?? "track") : `${trackIds.length} tracks`;
  const network = localTracks.some(t => isNetworkSharePath(t.path));
  return { trackIds, title, network };
}
