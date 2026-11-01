// Reads the saved queue (the main-playlist folder) at startup and turns it into
// what the restore applies once the window is up. Pure over its `invoke`, so it
// is unit-tested without Tauri (`__tests__/restoreMainPlaylist.test.ts`).
import type { QueueMode, QueueTrack } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";
import { tracksFromManifest, contextFromManifest, type Manifest, type MainPlaylistState } from "../mainPlaylist";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface RestoredMainPlaylist {
  /** The saved queue, or null when there was none (or it was empty). */
  queue: { tracks: QueueTrack[]; index: number } | null;
  /** Cached-thumb pairs (`[uri, filename]`), seeded with the queue so rows
   *  paint their art on the first render. */
  thumbs: Array<[string, string]>;
  context: PlaylistContext | null;
  /** Null when no state file was saved — the queue keeps its default mode. */
  mode: QueueMode | null;
}

export async function restoreMainPlaylist(invoke: Invoke): Promise<RestoredMainPlaylist> {
  const [{ manifest, state, thumbs }, dir] = await Promise.all([
    invoke<{ manifest: Manifest | null; state: MainPlaylistState | null; thumbs: [string, string][] }>("main_playlist_read"),
    invoke<string>("main_playlist_dir"),
  ]);
  const result: RestoredMainPlaylist = { queue: null, thumbs: [], context: null, mode: null };
  if (manifest) {
    const tracks = tracksFromManifest(manifest);
    result.context = contextFromManifest(manifest, dir);
    if (tracks.length > 0) {
      // No like step: queue entries carry no like; their hearts read the
      // track-like store, which loads itself at startup.
      //
      // Re-resolve `libraryId`. The manifest deliberately does not persist it
      // (SQLite reuses the rowids of deleted tracks, so a stale id would
      // silently address the wrong row) — the durable identity is the file
      // URI, so ask the DB what each path maps to *now*, in one bulk call.
      // Best-effort: on failure every entry keeps `libraryId` absent and its
      // consumer falls back to a path/metadata lookup, as an external track does.
      const paths = [...new Set(tracks.map(t => t.path).filter((p): p is string => !!p))];
      try {
        const idByPath = new Map(await invoke<[string, number][]>("find_track_ids_by_paths", { paths }));
        if (idByPath.size > 0) {
          for (let i = 0; i < tracks.length; i++) {
            const id = tracks[i].path ? idByPath.get(tracks[i].path!) : undefined;
            if (id != null) tracks[i] = { ...tracks[i], libraryId: id };
          }
        }
      } catch (e) {
        console.error("Failed to resolve restored queue library ids:", e);
      }
      const saved = state?.queueIndex;
      const index = saved != null && saved >= 0 && saved < tracks.length ? saved : -1;
      result.queue = { tracks, index };
      result.thumbs = thumbs ?? [];
    }
  }
  if (state) {
    const raw = state.queueMode as string | undefined;
    result.mode = raw === "repeat-all" || raw === "repeat-one" ? raw : "normal";
  }
  return result;
}
