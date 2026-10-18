// "Nothing found — these plugins could find it." The one rule for every surface
// that offers plugins after a provider chain came back empty: the playback
// failure dialog (a playable copy) and the Retrieve modal (an image, a lyrics /
// bio / review). Pure: callers say which service they need and how to spot it
// in an installed manifest; App owns opening Extensions. Nothing here installs
// or switches anything on — the plugin's own page in Extensions does, on the
// user's click.
//
// Offered only on surfaces the user opened to get something, never next to a
// passive placeholder: a library has hundreds of artists without a photo, and
// a hint on each would turn the app into an advert for the gallery.

import type { GalleryPluginEntry, PluginManifestContributes, PluginState } from "../types/plugin";
import { isExperimental } from "./pluginStability";
import { semverSatisfies } from "./semver";

export interface ProviderSuggestion {
  id: string;
  name: string;
  description: string;
  /** "enable": installed but switched off; "install": only in the gallery. */
  action: "enable" | "install";
  experimental: boolean;
}

/**
 * Plugins that provide `service` (a gallery `provides` id — see
 * `PLUGIN_SERVICES` / `pluginServicesOf`) and aren't helping right now:
 * installed ones that are switched off (`declares` reads their manifest),
 * first, then gallery entries that aren't installed — stable before
 * experimental, never one needing a newer app than `appVersion` (unknown →
 * not filtered). Installed and enabled plugins are never offered: they were
 * already asked, or the user switched their row off in Settings → Providers.
 */
export function suggestProviders(args: {
  service: string;
  declares: (contributes: PluginManifestContributes) => boolean;
  pluginStates: Array<Pick<PluginState, "id" | "enabled" | "status" | "manifest">>;
  gallery: GalleryPluginEntry[];
  appVersion?: string | null;
}): ProviderSuggestion[] {
  const { service, declares, pluginStates, gallery, appVersion } = args;
  const installed = new Set(pluginStates.map((p) => p.id));
  const disabled: ProviderSuggestion[] = pluginStates
    // "disabled", not `!enabled`: a plugin in error (an invalid manifest) is
    // also not enabled, but switching it on wouldn't make it run.
    .filter((p) => p.status === "disabled" && !!p.manifest?.contributes && declares(p.manifest.contributes))
    .map((p) => ({
      id: p.id,
      name: p.manifest.name,
      description: p.manifest.description ?? "",
      action: "enable" as const,
      experimental: isExperimental(p.manifest.stability),
    }));
  const available: ProviderSuggestion[] = gallery
    .filter((e) => !installed.has(e.id))
    .filter((e) => Array.isArray(e.provides) && e.provides.includes(service))
    .filter((e) => !appVersion || !e.minAppVersion || semverSatisfies(appVersion, e.minAppVersion))
    .map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      action: "install" as const,
      experimental: isExperimental(e.stability),
    }))
    .sort((a, b) => Number(a.experimental) - Number(b.experimental));
  return [...disabled, ...available];
}

/** Who can supply an image for this kind of entity. */
export function suggestImageProviders(args: {
  entity: "artist" | "album" | "tag";
  pluginStates: Array<Pick<PluginState, "id" | "enabled" | "status" | "manifest">>;
  gallery: GalleryPluginEntry[];
  appVersion?: string | null;
}): ProviderSuggestion[] {
  return suggestProviders({
    ...args,
    service: `images:${args.entity}`,
    declares: (c) => (c.imageProviders ?? []).some((p) => p.entity === args.entity),
  });
}

/** Who provides this information type (lyrics, an artist bio, …). */
export function suggestInfoProviders(args: {
  typeId: string;
  pluginStates: Array<Pick<PluginState, "id" | "enabled" | "status" | "manifest">>;
  gallery: GalleryPluginEntry[];
  appVersion?: string | null;
}): ProviderSuggestion[] {
  return suggestProviders({
    ...args,
    service: `info:${args.typeId}`,
    declares: (c) => (c.informationTypes ?? []).some((t) => t.id === args.typeId),
  });
}
