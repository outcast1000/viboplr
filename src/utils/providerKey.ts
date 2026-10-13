// Provider keys: one plugin, several providers of the same thing.
//
// `image_providers.plugin_id` and `information_types.plugin_id` have always
// meant "which provider is this row", not "which installed plugin": the
// built-in `core:folder` / `core:local-lyrics` rows live there with no plugin
// behind them. A plugin that offers several providers for one entity or info
// type (the bundled Artwork plugin: Deezer, iTunes, TheAudioDB, MusicBrainz)
// gives each its own row under the key `<pluginId>/<providerId>`, so the user
// orders and switches them one by one in Settings → Providers. A plugin that
// declares no provider keeps its bare id, unchanged.
//
// `/` can't occur in a plugin id (ids are folder names) and `:` marks core
// rows, so every key parses one way.

import type { PluginManifest } from "../types/plugin";

export const PROVIDER_KEY_SEP = "/";

export function providerKey(pluginId: string, provider?: string | null): string {
  return provider ? `${pluginId}${PROVIDER_KEY_SEP}${provider}` : pluginId;
}

export function parseProviderKey(key: string): { pluginId: string; provider: string | null } {
  const at = key.indexOf(PROVIDER_KEY_SEP);
  if (at <= 0) return { pluginId: key, provider: null };
  return { pluginId: key.slice(0, at), provider: key.slice(at + 1) || null };
}

/** The handler-map key inside one loaded plugin: the entity or info type id,
 *  plus the provider when the plugin declared several. */
export function handlerKey(name: string, provider?: string | null): string {
  return provider ? `${name}${PROVIDER_KEY_SEP}${provider}` : name;
}

/**
 * Does provider row `key` answer to `ref`? What a caller may name when pinning
 * one provider (the control API's `pluginId`, `api.informationTypes.fetch`'s
 * `opts.pluginId`):
 * - the exact key (`artwork/deezer`);
 * - a plugin id, meaning every provider that plugin offers (`artwork`);
 * - a bare provider id (`deezer`) — what the merged bundled plugins were
 *   called before they were merged, so older assistant instructions and
 *   scripts keep working.
 */
export function matchesProviderRef(key: string, ref: string): boolean {
  if (key === ref) return true;
  const { pluginId, provider } = parseProviderKey(key);
  return pluginId === ref || provider === ref;
}

type NamedPlugin = { id: string; manifest: Pick<PluginManifest, "name" | "contributes"> };

/**
 * Display names for provider rows: every plugin id → the plugin's name, and
 * every declared provider key → that provider's own name (falling back to the
 * plugin's). Core rows are named separately (coreImageProviders.ts).
 */
export function providerNames(plugins: readonly NamedPlugin[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const p of plugins) {
    names.set(p.id, p.manifest.name);
    for (const d of p.manifest.contributes?.providers ?? []) {
      names.set(providerKey(p.id, d.id), d.name || p.manifest.name);
    }
  }
  return names;
}
