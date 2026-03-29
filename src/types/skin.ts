// Skin/theme system types

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

export interface StoredSkin extends SkinJson {
  id: string;
  slug: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
