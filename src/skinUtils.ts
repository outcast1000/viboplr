// src/skinUtils.ts
import { SKIN_COLOR_KEYS, OPTIONAL_SKIN_COLOR_KEYS } from "./types/skin";
import type { SkinColors } from "./types/skin";
import { LINKS } from "./constants/links";

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
    // Optional keys postdate the original schema; older skins may omit them
    // (they fall back to the default skin's values at inject time).
    if (val === undefined && OPTIONAL_SKIN_COLOR_KEYS.has(key)) continue;
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

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

const RGB_DERIVED_KEYS = ["accent", "now-playing-bg", "bg-primary", "bg-surface", "success", "error", "warning", "text-primary", "like", "dislike"];

export function generateSkinCSS(colors: SkinColors, customCSS?: string): string {
  const vars = Object.entries(colors)
    .map(([key, value]) => {
      let line = `  --${key}: ${value};`;
      if (RGB_DERIVED_KEYS.includes(key)) {
        line += `\n  --${key}-rgb: ${hexToRgb(value)};`;
      }
      return line;
    })
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

// A complete, valid neutral palette (the Default Dark Blue look) used to seed a
// brand-new user skin. Every one of the 18 keys is present and valid so the
// starter passes validateSkin() and renders immediately — the author then tweaks
// values in their editor and hits Refresh.
const STARTER_COLORS: SkinColors = {
  "bg-primary": "#1a1a2e",
  "bg-secondary": "#16213e",
  "bg-tertiary": "#1e2a4a",
  "bg-surface": "#0f3460",
  "bg-hover": "#1a3a6e",
  "text-primary": "#e0e0e0",
  "text-secondary": "#a0a0b0",
  "text-tertiary": "#707080",
  "accent": "#53a8ff",
  "accent-dim": "#3a7bd5",
  "accent-text": "#ffffff",
  "border": "#2a2a4a",
  "now-playing-bg": "#0d1b2a",
  "success": "#4caf50",
  "error": "#f44336",
  "warning": "#ff9500",
  "like": "#ff4d6a",
  "dislike": "#ff9500",
};

export interface StarterSkin {
  name: string;
  author: string;
  version: string;
  type: "dark" | "light";
  colors: SkinColors;
  customCSS: string;
}

export function buildStarterSkin(): StarterSkin {
  return {
    name: "My Skin",
    author: "You",
    version: "1.0.0",
    type: "dark",
    // Fresh copy per call so editing one starter never mutates another.
    colors: { ...STARTER_COLORS },
    customCSS:
      "/* Optional structural overrides (uncomment to use):\n" +
      "   :root { --ds-radius: 10px; --ds-radius-card: 10px; } */",
  };
}

// GitHub issue-form field id for the JSON textarea (see submit-skin.yml in the
// viboplr-skins gallery repo). A query param keyed by this id pre-fills it.
const SKIN_SUBMIT_FIELD = "skin-json";
// Keep the pre-filled URL comfortably under browser/GitHub length limits. A large
// customCSS would overflow the query string, so we drop the pre-fill and rely on
// the clipboard copy the caller also makes.
const SKIN_SUBMIT_MAX_ENCODED = 6000;

export function skinSubmissionUrl(skinJson: string): string {
  const encoded = encodeURIComponent(skinJson);
  if (encoded.length > SKIN_SUBMIT_MAX_ENCODED) return LINKS.skinSubmitForm;
  return `${LINKS.skinSubmitForm}&${SKIN_SUBMIT_FIELD}=${encoded}`;
}
