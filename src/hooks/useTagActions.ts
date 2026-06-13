import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Add one tag to a library track (additive — does not touch existing tags).
 * `plugin_apply_tags` returns ONLY the tag(s) it just added, so we re-read the
 * track's full tag set afterward and return that — callers replace their chip
 * list with the result, and returning only the new tag would wipe the rest.
 */
export async function applyTag(trackId: number, tagName: string): Promise<string[]> {
  await invoke("plugin_apply_tags", { trackId, tagNames: [tagName] });
  const rows = await invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId });
  return rows.map((r) => r.name);
}

/** Remove one tag from a library track by replacing the tag set with the remainder. */
export async function removeTag(
  trackId: number,
  currentTags: string[],
  tagToRemove: string,
): Promise<string[]> {
  const remaining = currentTags.filter(
    (t) => t.toLowerCase() !== tagToRemove.toLowerCase(),
  );
  const result = await invoke<Array<[number, string]>>("replace_track_tags", {
    trackId,
    tagNames: remaining,
  });
  return result.map(([, name]) => name);
}

/**
 * Thin hook exposing tag add/remove for a single library track id. Each handler
 * resolves to the track's new tag-name list (or null on failure). Mirrors the
 * useLikeActions shape: console.error in catch, no addLog (none exists).
 */
export function useTagActions() {
  const add = useCallback(async (trackId: number, tagName: string): Promise<string[] | null> => {
    try {
      return await applyTag(trackId, tagName);
    } catch (e) {
      console.error("Failed to apply tag:", e);
      return null;
    }
  }, []);

  const remove = useCallback(
    async (trackId: number, currentTags: string[], tagToRemove: string): Promise<string[] | null> => {
      try {
        return await removeTag(trackId, currentTags, tagToRemove);
      } catch (e) {
        console.error("Failed to remove tag:", e);
        return null;
      }
    },
    [],
  );

  return { add, remove };
}
