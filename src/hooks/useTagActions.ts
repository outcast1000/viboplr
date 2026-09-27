import { useCallback } from "react";
import { useTagOpsDeps } from "../contexts/TagOpsContext";
import { editTrackTags } from "../utils/tagOps";

/**
 * Tag add/remove for a single library track id, for in-app quick-edit surfaces
 * (the Now Playing bar's TagPopover). A thin layer over utils/tagOps.ts — the
 * same ops the plugin API and control API run — so an add here also recounts
 * tags and reloads the Library (a new tag used to stay invisible in the Tags
 * tab until the next scan). Each handler resolves to the track's full new tag
 * list, or null on failure; callers keep their optimistic chip and revert on
 * null. Removal matches accent- and case-insensitively.
 */
export function useTagActions() {
  const deps = useTagOpsDeps();

  const add = useCallback(async (trackId: number, tagName: string): Promise<string[] | null> => {
    try {
      return (await editTrackTags(deps, trackId, { add: [tagName] })).map((t) => t.name);
    } catch (e) {
      console.error("Failed to apply tag:", e);
      return null;
    }
  }, [deps]);

  // `_currentTags` is kept for the existing call shape: the old implementation
  // replaced the tag set with the remainder, the shared op removes by name.
  const remove = useCallback(
    async (trackId: number, _currentTags: string[], tagToRemove: string): Promise<string[] | null> => {
      try {
        return (await editTrackTags(deps, trackId, { remove: [tagToRemove] })).map((t) => t.name);
      } catch (e) {
        console.error("Failed to remove tag:", e);
        return null;
      }
    },
    [deps],
  );

  return { add, remove };
}
