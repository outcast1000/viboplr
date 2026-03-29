export const SKIN_COLOR_KEYS = [
  "bg-primary",
  "bg-secondary",
  "bg-surface",
  "bg-hover",
  "text-primary",
  "text-secondary",
  "accent",
  "accent-dim",
  "border",
  "now-playing-bg",
  "success",
  "error",
  "warning",
] as const;

export type SkinColorKey = (typeof SKIN_COLOR_KEYS)[number];

export type SkinColors = Record<SkinColorKey, string>;

export interface SkinJson {
  name: string;
  author: string;
  version: string;
  type: "dark" | "light";
  colors: SkinColors;
  customCSS?: string;
}

export interface SkinInfo {
  id: string;
  name: string;
  author: string;
  type: "dark" | "light";
  version: string;
  source: "builtin" | "user";
  colors: SkinColors;
  customCSS?: string;
}

export interface GallerySkinEntry {
  id: string;
  name: string;
  author: string;
  type: "dark" | "light";
  version: string;
  file: string;
  colors: [string, string, string, string];
}

export interface GalleryIndex {
  version: number;
  skins: GallerySkinEntry[];
}
