// src/types/skin.ts
export interface SkinColors {
  "bg-primary": string;
  "bg-secondary": string;
  "bg-surface": string;
  "bg-hover": string;
  "text-primary": string;
  "text-secondary": string;
  accent: string;
  "accent-dim": string;
  border: string;
  "now-playing-bg": string;
  success: string;
  error: string;
  warning: string;
}

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
  colors: [string, string, string, string]; // preview swatches: bg-primary, bg-secondary, accent, bg-surface
}

export interface GalleryIndex {
  version: number;
  skins: GallerySkinEntry[];
}

export const SKIN_COLOR_KEYS: (keyof SkinColors)[] = [
  "bg-primary", "bg-secondary", "bg-surface", "bg-hover",
  "text-primary", "text-secondary",
  "accent", "accent-dim",
  "border", "now-playing-bg",
  "success", "error", "warning",
];
