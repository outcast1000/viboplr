import type { PluginManifestContributes } from "../types/plugin";

/**
 * Pure helpers for the Extensions panel. Kept out of the component so the
 * capability summarization and the skin-card mock palette can be unit-tested.
 */

/** A plugin capability paired with a short, human-readable description of what
 *  it does. Shown in the detail "Capabilities" section. */
export interface CapabilityInfo {
  label: string;
  description: string;
}

/**
 * The services a plugin can provide to the rest of the app, as stable ids.
 * This list is a **wire format**: the plugin gallery's bot derives an entry's
 * `provides` from the plugin's manifest with the same rules
 * (`viboplr-plugins/scripts/lib.mjs` → `servicesOf`), so a gallery entry can
 * say "web search" before the plugin is installed. Add ids, never rename one —
 * an older app ignores an id it doesn't know, a renamed one just vanishes.
 */
export const PLUGIN_SERVICES: Record<string, CapabilityInfo> = {
  "playback-fallback": {
    label: "Playback fallback",
    description: "Finds a playable copy when a track can't play from its own source (Settings → Providers).",
  },
  "downloads": { label: "Download", description: "Resolves and downloads tracks through the unified downloader." },
  "web-search": {
    label: "Web search",
    description: "Searches the web for other plugins and AI assistants (Settings → Providers → Web search).",
  },
  "catalog-search": { label: "Catalog search", description: "Searchable from global search (Cmd+K)." },
  "images": { label: "Images", description: "Supplies artwork for artists and albums." },
  "scrobbling": { label: "Scrobbling", description: "Receives your plays (Settings → Playback → Scrobbling)." },
  "home-shelves": { label: "Home shelves", description: "Adds horizontal shelves of tracks or albums to the Home page." },
  "assistant-tools": { label: "AI tools", description: "Gives AI assistants tools of its own to call." },
  "visualizers": { label: "Visualizer", description: "Draws a visualizer on Now Playing or in fullscreen." },
  "waveforms": { label: "Waveforms", description: "Looks up or shares seek-bar waveforms." },
};

/** The finer ids after the `PLUGIN_SERVICES` ones — same pattern as the
 *  gallery bot's `FINE_SERVICE_ID`. */
export const FINE_SERVICE_ID = /^(images:(artist|album|tag)|info:[A-Za-z0-9_.-]+)$/;

/**
 * The service ids a manifest declares: the `PLUGIN_SERVICES` ids in that
 * order, then one `images:<entity>` per entity it supplies images for
 * (`images:artist`, `images:album`, …), then one `info:<typeId>` per
 * information type (`info:lyrics`, `info:artist_bio`, …), each in manifest
 * order. The finer ids are what lets a surface ask "who can find an *artist*
 * image" or "who has *lyrics*"; they carry no label of their own. Declared, not
 * live: a provider registered only at runtime (yt-dlp's Cmd+K search, which
 * needs its binary) isn't here — the gallery can't know about it either.
 */
export function pluginServicesOf(contributes: PluginManifestContributes | undefined): string[] {
  const c = contributes;
  if (!c) return [];
  const fine: string[] = [];
  const addFine = (id: string) => { if (FINE_SERVICE_ID.test(id) && !fine.includes(id)) fine.push(id); };
  for (const p of c.imageProviders ?? []) if (typeof p?.entity === "string") addFine(`images:${p.entity}`);
  for (const t of c.informationTypes ?? []) if (typeof t?.id === "string") addFine(`info:${t.id}`);
  return [...pluginBaseServicesOf(c), ...fine];
}

function pluginBaseServicesOf(c: PluginManifestContributes): string[] {
  const has: Record<string, boolean> = {
    "playback-fallback": !!c.streamResolvers?.length,
    "downloads": !!c.downloadProviders?.length,
    "web-search": !!c.webSearchProviders?.length,
    "catalog-search": !!c.searchProviders?.length,
    "images": !!c.imageProviders?.length,
    "scrobbling": !!c.scrobbler || !!c.eventHooks?.includes("track:scrobbled"),
    "home-shelves": !!c.homeShelves?.length,
    "assistant-tools": !!c.assistant?.tools?.length,
    "visualizers": !!c.visualizers?.length,
    "waveforms": !!c.waveformProvider,
  };
  return Object.keys(PLUGIN_SERVICES).filter((id) => has[id]);
}

/** A gallery entry's `provides` as capabilities. Unknown ids are skipped (a
 *  newer gallery than this app); order follows `PLUGIN_SERVICES`. */
export function describeProvides(provides: unknown): CapabilityInfo[] {
  if (!Array.isArray(provides)) return [];
  const wanted = new Set(provides.filter((p): p is string => typeof p === "string"));
  return Object.keys(PLUGIN_SERVICES).filter((id) => wanted.has(id)).map((id) => PLUGIN_SERVICES[id]);
}

/**
 * Condense a plugin's `contributes` into short, human-readable capabilities
 * (e.g. "Lyrics", "Playback fallback", "Images"), each paired with a
 * description of what it does — used by the detail "Capabilities" section so
 * users can understand a plugin's contributions before installing/enabling it.
 * Services come first, with the same labels a gallery entry's `provides`
 * gets, so a plugin reads the same before and after install. Order is stable
 * and de-duplicated by label.
 */
export function describeContributes(
  contributes: PluginManifestContributes | undefined,
): CapabilityInfo[] {
  if (!contributes) return [];
  const caps: CapabilityInfo[] = [];
  const seen = new Set<string>();
  const push = (label: string, description: string) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    caps.push({ label, description });
  };

  for (const id of pluginBaseServicesOf(contributes)) push(PLUGIN_SERVICES[id].label, PLUGIN_SERVICES[id].description);
  if (contributes.sidebarItems?.length)
    push("Sidebar view", "Adds its own view to the navigation sidebar.");

  // Information types often carry the most descriptive intent — surface a few
  // named ones (e.g. "Lyrics", "Bio") before falling back to the generic label.
  // Prefer the type's own declared description when the manifest provides one.
  if (contributes.informationTypes?.length) {
    let named = 0;
    for (const t of contributes.informationTypes) {
      const label = infoTypeLabel(t.id, t.name);
      if (!label) continue;
      named++;
      const declared = (t.description || "").trim();
      push(label, declared || infoTypeDescription(label, t.name));
    }
    if (named === 0) push("Info", "Adds an information section to detail pages.");
  }

  if (contributes.contextMenuItems?.length)
    push("Menu actions", "Adds actions to right-click context menus.");
  if (contributes.settingsPanel)
    push("Settings", "Adds a settings panel you can configure.");
  if (contributes.eventHooks?.length)
    push("Events", "Reacts to playback and library events in the background.");

  return caps;
}

/** A short description for a well-known capability label, falling back to a
 *  generic line built from the info type's declared name. */
function infoTypeDescription(label: string, name: string): string {
  switch (label) {
    case "Lyrics": return "Shows synced or plain lyrics on track pages.";
    case "Bio": return "Shows artist biographies on detail pages.";
    case "Similar": return "Shows similar artists or tracks.";
    case "Tags": return "Shows community tags gathered from external sources.";
    case "Reviews": return "Shows album or artist reviews.";
    case "Annotations": return "Shows song annotations and explanations.";
    case "Stats": return "Shows play counts and listening statistics.";
    default:
      return `Adds the "${name || label}" information section to detail pages.`;
  }
}

/** Map well-known information-type ids to a tidy one-word chip label. */
function infoTypeLabel(id: string, name: string): string | undefined {
  const k = id.toLowerCase();
  if (k.includes("lyric")) return "Lyrics";
  if (k.includes("bio")) return "Bio";
  if (k.includes("similar")) return "Similar";
  if (k.includes("tag")) return "Tags";
  if (k.includes("review")) return "Reviews";
  if (k.includes("annotation") || k.includes("explanation")) return "Annotations";
  if (k.includes("scrobble") || k.includes("history") || k.includes("played"))
    return "Stats";
  // Unknown info type: fall back to its declared name, trimmed to a chip.
  const trimmed = (name || "").trim();
  return trimmed ? trimmed : undefined;
}

export interface SkinMockColors {
  bg: string;
  sidebar: string;
  surface: string;
  accent: string;
  text: string;
  nowPlaying: string;
}

/**
 * Derive the colors for a skin-card mini-mock from the 4-tuple the gallery /
 * installed-skin list carries: `[bg-primary, accent, bg-secondary, text-primary]`.
 * Surface and now-playing tones are derived so both installed and gallery skins
 * (which only ship 4 preview colors) render a consistent mock.
 */
export function skinMockColors(
  tuple: [string, string, string, string] | undefined,
): SkinMockColors {
  const [bg = "#101018", accent = "#53a8ff", sidebar = "#181826", text = "#e0e0e0"] =
    tuple ?? [];
  return {
    bg,
    sidebar,
    surface: mixHex(sidebar, accent, 0.18),
    accent,
    text,
    nowPlaying: mixHex(bg, "#000000", 0.35),
  };
}

/** Blend two #rrggbb colors. `t` is the weight toward `b` (0..1). */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return a;
  const w = Math.max(0, Math.min(1, t));
  const ch = (x: number, y: number) => Math.round(x + (y - x) * w);
  const r = ch(pa[0], pb[0]);
  const g = ch(pa[1], pb[1]);
  const bl = ch(pa[2], pb[2]);
  return "#" + [r, g, bl].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
