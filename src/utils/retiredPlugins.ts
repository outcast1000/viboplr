// Plugins retired outright (2026-10-19): `youtube` (superseded by `ytdlp`) and
// `tidal-browse`. The backend deletes installed copies with their files and
// database rows at startup (`plugins::RETIRED_PLUGIN_IDS` — keep the two lists
// equal); this drops what the store still says about them.

export const RETIRED_PLUGIN_IDS: readonly string[] = ["youtube", "tidal-browse"];

const isRetired = (id: string) => RETIRED_PLUGIN_IDS.includes(id);

/** `enabledPlugins` without the retired ids, or null when there were none. */
export function withoutRetiredIds(list: readonly string[] | null): string[] | null {
  if (!list || !list.some(isRetired)) return null;
  return list.filter((id) => !isRetired(id));
}

/** A record keyed by plugin id (grants, program consent, info versions)
 *  without the retired ids, or null when there were none. */
export function withoutRetiredKeys<T>(record: Record<string, T> | null | undefined): Record<string, T> | null {
  if (!record || !Object.keys(record).some(isRetired)) return null;
  return Object.fromEntries(Object.entries(record).filter(([id]) => !isRetired(id)));
}

/** `pluginContributionVisibility` (keys `pluginId:kind:itemId`) without the
 *  retired plugins' entries, or null when there were none. */
export function withoutRetiredContributions(
  record: Record<string, boolean> | null | undefined,
): Record<string, boolean> | null {
  const owner = (key: string) => key.slice(0, key.indexOf(":"));
  if (!record || !Object.keys(record).some((k) => isRetired(owner(k)))) return null;
  return Object.fromEntries(Object.entries(record).filter(([k]) => !isRetired(owner(k))));
}
