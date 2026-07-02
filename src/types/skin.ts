export const SKIN_COLOR_KEYS = [
  "bg-primary",
  "bg-secondary",
  "bg-tertiary",
  "bg-surface",
  "bg-hover",
  "text-primary",
  "text-secondary",
  "text-tertiary",
  "accent",
  "accent-dim",
  "accent-text",
  "border",
  "now-playing-bg",
  "success",
  "error",
  "warning",
  "like",
  "dislike",
] as const;

export type SkinColorKey = (typeof SKIN_COLOR_KEYS)[number];

// Keys added after the original 15-key schema. Skins published before the
// addition (e.g. older gallery skins) may lack them: validateSkin() tolerates
// their absence, and injectSkinCSS() falls back to the default skin's values.
export const OPTIONAL_SKIN_COLOR_KEYS: ReadonlySet<SkinColorKey> = new Set([
  "accent-text",
  "like",
  "dislike",
]);

export type SkinColors = Record<SkinColorKey, string>;

export interface SkinInfo {
  id: string;
  name: string;
  author: string;
  type: "dark" | "light";
  version: string;
  source: "builtin" | "user";
  colors: SkinColors;
  customCSS?: string;
  updateUrl?: string;
}

export interface GallerySkinEntry {
  id: string;
  name: string;
  author: string;
  type: "dark" | "light";
  version: string;
  file: string;
  updateUrl?: string;
  colors: [string, string, string, string];
  /** Marked as recommended in the gallery index. Optional; absent = false.
   *  Source of truth is the separate outcast1000/viboplr-skins index.json. */
  recommended?: boolean;
}
