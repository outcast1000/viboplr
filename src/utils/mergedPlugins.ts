// The bundled plugins that were merged into one plugin each (2026-10-13): four
// image sources into Artwork, two lyrics sources into Lyrics, each old plugin
// now a provider of the new one (utils/providerKey.ts). The database moves
// their provider rows (migration #15 in db/mod.rs); this moves the user's
// plugin switches, which live in the store.

import type { PluginManifest } from "../types/plugin";
import { providerKey } from "./providerKey";

export const MERGED_PLUGINS_DONE_KEY = "mergedBundledPlugins";

export const MERGED_BUNDLED_PLUGINS: ReadonlyArray<{ into: string; from: readonly string[] }> = [
  { into: "artwork", from: ["audiodb", "deezer", "itunes", "musicbrainz"] },
  { into: "lyrics", from: ["lrclib", "lyrics-ovh"] },
];

export interface MergedPluginsMigration {
  /** The enabled-plugin list with the old ids replaced by their new home. */
  enabled: string[];
  /** Provider keys to switch off: a source whose plugin the user had turned
   *  off while another source of the same group stayed on. */
  disabledProviders: string[];
}

/**
 * What a saved enabled-plugin list becomes. A group's new plugin is enabled
 * when ANY of its old plugins was — and the old plugins that were off become
 * switched-off providers, so the sources that run are exactly the ones that
 * ran before. A group the user had turned off entirely stays off (its new
 * plugin is not added). Old ids are dropped either way: nothing ships under
 * them any more.
 */
export function migrateMergedPlugins(saved: readonly string[]): MergedPluginsMigration {
  const enabled = new Set(saved);
  const disabledProviders: string[] = [];
  for (const { into, from } of MERGED_BUNDLED_PLUGINS) {
    const on = from.filter((id) => enabled.has(id));
    for (const id of from) enabled.delete(id);
    if (on.length === 0) continue;
    enabled.add(into);
    for (const id of from) {
      if (!on.includes(id)) disabledProviders.push(providerKey(into, id));
    }
  }
  return { enabled: Array.from(enabled), disabledProviders };
}

/** The provider rows behind each provider key, from the merged plugin's own
 *  manifest — what has to be switched off for a `disabledProviders` entry. */
export function providerRowsFor(
  pluginId: string,
  manifest: Pick<PluginManifest, "contributes">,
  keys: readonly string[],
): { images: Array<[string, string]>; info: Array<[string, string]> } {
  const wanted = new Set(keys);
  const images: Array<[string, string]> = [];
  const info: Array<[string, string]> = [];
  for (const ip of manifest.contributes?.imageProviders ?? []) {
    const key = providerKey(pluginId, ip.provider);
    if (wanted.has(key)) images.push([key, ip.entity]);
  }
  for (const it of manifest.contributes?.informationTypes ?? []) {
    const key = providerKey(pluginId, it.provider);
    if (wanted.has(key)) info.push([it.id, key]);
  }
  return { images, info };
}
