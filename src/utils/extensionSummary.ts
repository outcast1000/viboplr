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
 * Condense a plugin's `contributes` into short, human-readable capability
 * labels (e.g. "Lyrics", "Streaming", "Images") for the card chips. Order is
 * stable and de-duplicated. This is the label-only projection of
 * `describeContributes`, so chips and detail descriptions never drift apart.
 */
export function summarizeContributes(
  contributes: PluginManifestContributes | undefined,
): string[] {
  return describeContributes(contributes).map((c) => c.label);
}

/**
 * Like `summarizeContributes`, but each capability also carries a short
 * description of what it does — used by the detail "Capabilities" section so
 * users can understand a plugin's contributions before installing/enabling it.
 * Order is stable and de-duplicated by label.
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

  if (contributes.streamResolvers?.length)
    push("Streaming", "Provides playback URLs so tracks can stream from this source.");
  if (contributes.downloadProviders?.length)
    push("Download", "Resolves and downloads tracks through the unified downloader.");
  if (contributes.imageProviders?.length)
    push("Images", "Supplies artwork for artists and albums.");
  if (contributes.homeShelves?.length)
    push("Home shelves", "Adds horizontal shelves of tracks or albums to the Home page.");
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
