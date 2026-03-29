// src/skinUtils.ts
import { SKIN_COLOR_KEYS } from "./types/skin";
import type { SkinColors } from "./types/skin";

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_CUSTOM_CSS = 10240; // 10KB

export function validateSkin(
  skin: unknown
): { ok: true } | { ok: false; error: string } {
  if (!skin || typeof skin !== "object") return { ok: false, error: "Invalid skin object" };
  const s = skin as Record<string, unknown>;

  if (!s.name || typeof s.name !== "string") return { ok: false, error: "Missing or empty name" };
  if (!s.author || typeof s.author !== "string") return { ok: false, error: "Missing or empty author" };
  if (!s.version || typeof s.version !== "string") return { ok: false, error: "Missing or empty version" };
  if (s.type !== "dark" && s.type !== "light") return { ok: false, error: "Type must be 'dark' or 'light'" };

  if (!s.colors || typeof s.colors !== "object") return { ok: false, error: "Missing colors object" };
  const colors = s.colors as Record<string, unknown>;
  for (const key of SKIN_COLOR_KEYS) {
    const val = colors[key];
    if (typeof val !== "string" || !HEX_RE.test(val)) {
      return { ok: false, error: `Invalid color for '${key}': ${String(val)}` };
    }
  }

  if (s.customCSS !== undefined) {
    if (typeof s.customCSS !== "string") return { ok: false, error: "customCSS must be a string" };
    if (s.customCSS.length > MAX_CUSTOM_CSS) return { ok: false, error: `customCSS exceeds ${MAX_CUSTOM_CSS} bytes` };
  }

  return { ok: true };
}

export function sanitizeCustomCSS(css: string): string {
  return css
    .replace(/@import\b[^;]*;?/gi, "")
    .replace(/expression\s*\([^)]*\)\)?/gi, "")
    .replace(/javascript\s*:[^\s;}]*/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "");
}

export function generateSkinCSS(colors: SkinColors, customCSS?: string): string {
  const vars = Object.entries(colors)
    .map(([key, value]) => `  --${key}: ${value};`)
    .join("\n");
  let css = `:root {\n${vars}\n}`;
  if (customCSS) {
    css += "\n" + sanitizeCustomCSS(customCSS);
  }
  return css;
}

export function slugifySkinName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-|-$/g, "");
}
