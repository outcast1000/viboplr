import type { PluginManifestContributes } from "../types/plugin";

/**
 * Pure helpers for the Extensions panel. Kept out of the component so the
 * capability summarization and the skin-card mock palette can be unit-tested.
 */

/**
 * Condense a plugin's `contributes` into short, human-readable capability
 * labels (e.g. "Lyrics", "Streaming", "Images") for the list-row chips and the
 * detail "Capabilities" section. Order is stable and de-duplicated.
 */
export function summarizeContributes(
  contributes: PluginManifestContributes | undefined,
): string[] {
  if (!contributes) return [];
  const caps: string[] = [];
  const push = (label: string) => {
    if (label && !caps.includes(label)) caps.push(label);
  };

  if (contributes.streamResolvers?.length) push("Streaming");
  if (contributes.downloadProviders?.length) push("Download");
  if (contributes.imageProviders?.length) push("Images");
  if (contributes.homeShelves?.length) push("Home shelves");
  if (contributes.sidebarItems?.length) push("Sidebar view");

  // Information types often carry the most descriptive intent — surface a few
  // named ones (e.g. "Lyrics", "Bio") before falling back to the generic label.
  if (contributes.informationTypes?.length) {
    const named = contributes.informationTypes
      .map((t) => infoTypeLabel(t.id, t.name))
      .filter((l): l is string => Boolean(l));
    if (named.length) named.forEach(push);
    else push("Info");
  }

  if (contributes.contextMenuItems?.length) push("Menu actions");
  if (contributes.settingsPanel) push("Settings");
  if (contributes.eventHooks?.length) push("Events");

  return caps;
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
