import type { GalleryPluginEntry } from "../types/plugin";

/**
 * IDs that should start checked in the first-run modal:
 * recommended entries that are not already installed.
 */
export function computeInitialSelection(
  entries: GalleryPluginEntry[],
  installedIds: Set<string>,
): Set<string> {
  const selected = new Set<string>();
  for (const e of entries) {
    if (e.recommended === true && !installedIds.has(e.id)) {
      selected.add(e.id);
    }
  }
  return selected;
}

/**
 * Gallery entries to actually install: checked, not already installed,
 * and installable (has an updateUrl).
 */
export function computeInstallEntries(
  entries: GalleryPluginEntry[],
  checkedIds: Set<string>,
  installedIds: Set<string>,
): GalleryPluginEntry[] {
  return entries.filter(
    (e) => checkedIds.has(e.id) && !installedIds.has(e.id) && !!e.updateUrl,
  );
}
