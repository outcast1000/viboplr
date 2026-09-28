// The header the host draws at the top of every plugin view: icon · name ·
// view label · subtitle · status · buttons, optionally a logo or banner image.
//
// Three layers, later wins per field: the manifest's `viewHeader`, the sidebar
// item's own `header`, then whatever the plugin set at runtime with
// `api.ui.setViewHeader`. Everything here is pure so the merge, the limits and
// the image rules are asserted without a webview (pluginViewHeader.test.ts).
//
// What a plugin cannot set, on purpose: colours, fonts, CSS, HTML, height or
// position. The strip takes its look from the skin, and a banner always sits
// under the host's scrim, so no plugin can make its own header unreadable.

import type {
  PluginManifest,
  PluginManifestViewHeader,
  PluginViewHeader,
  PluginViewHeaderStatusVariant,
} from "../types/plugin";
import { pluginIconPath } from "./pluginIconPath";

export const VIEW_HEADER_LIMITS = {
  title: 60,
  subtitle: 160,
  statusLabel: 32,
  actionLabel: 24,
  actions: 2,
  /** Plugin-shipped image files; enforced in Rust (`plugin_asset_path`). */
  imageBytes: 512 * 1024,
} as const;

const STATUS_VARIANTS: readonly PluginViewHeaderStatusVariant[] = ["success", "warning", "error", "muted"];

/** Where an image comes from. `plugin-file` paths are relative to the plugin's
 *  folder and resolved (and size-checked) by the backend; `src` is usable by
 *  `resolveImageUrl` as-is (http(s), `data:image/…`, an absolute local path). */
export type ViewHeaderImage =
  | { kind: "plugin-file"; path: string }
  | { kind: "src"; value: string };

export interface ResolvedViewHeaderAction {
  label: string;
  action: string;
  variant: "accent" | "secondary";
  disabled: boolean;
}

export interface ResolvedPluginViewHeader {
  hidden: boolean;
  title: string;
  /** The view's sidebar label, shown after the name when the plugin has more
   *  than one view (otherwise it just repeats what the sidebar says). */
  viewLabel: string | null;
  subtitle: string | null;
  /** SVG path data for the glyph (used when there is no logo). */
  iconPath: string;
  status: { variant: PluginViewHeaderStatusVariant; label: string } | null;
  actions: ResolvedViewHeaderAction[];
  logo: ViewHeaderImage | null;
  logoLight: ViewHeaderImage | null;
  banner: ViewHeaderImage | null;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** A manifest image: a path inside the plugin's folder, nothing else. A URL
 *  would make every view load hit the network before the plugin even runs, and
 *  `..` or an absolute path would reach outside the plugin. */
export function manifestImage(value: unknown): ViewHeaderImage | null {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  if (path.split("/").some((seg) => seg === ".." || seg === "")) return null;
  return { kind: "plugin-file", path };
}

/** A runtime image: everything a manifest image may be, plus what only running
 *  code has — a web URL, an inline `data:image/…`, or an absolute path to a
 *  file the plugin wrote into its own storage. */
export function runtimeImage(value: unknown): ViewHeaderImage | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v) || /^data:image\//i.test(v)) return { kind: "src", value: v };
  if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) return { kind: "src", value: v };
  return manifestImage(v);
}

/** Validate what a plugin passed to `setViewHeader`. Unknown fields and wrong
 *  types are dropped rather than rejected, so one bad field doesn't cost the
 *  rest. `null` (or anything that isn't an object) means "back to the manifest". */
export function sanitizeViewHeader(input: unknown): PluginViewHeader | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const h = input as Record<string, unknown>;
  const out: PluginViewHeader = {};
  const title = cleanText(h.title, VIEW_HEADER_LIMITS.title);
  if (title) out.title = title;
  if ("subtitle" in h) {
    // An explicit empty subtitle clears the manifest's; keep that intent.
    out.subtitle = cleanText(h.subtitle, VIEW_HEADER_LIMITS.subtitle) ?? "";
  }
  if (h.status === null) {
    out.status = null;
  } else if (h.status && typeof h.status === "object") {
    const s = h.status as Record<string, unknown>;
    const label = cleanText(s.label, VIEW_HEADER_LIMITS.statusLabel);
    const variant = STATUS_VARIANTS.includes(s.variant as PluginViewHeaderStatusVariant)
      ? (s.variant as PluginViewHeaderStatusVariant)
      : "muted";
    if (label) out.status = { variant, label };
  }
  if (Array.isArray(h.actions)) {
    out.actions = h.actions
      .map((a) => {
        if (!a || typeof a !== "object") return null;
        const r = a as Record<string, unknown>;
        const label = cleanText(r.label, VIEW_HEADER_LIMITS.actionLabel);
        const action = typeof r.action === "string" && r.action.trim() ? r.action.trim() : null;
        if (!label || !action) return null;
        return { label, action, variant: r.variant === "accent" ? "accent" as const : "secondary" as const, disabled: r.disabled === true };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .slice(0, VIEW_HEADER_LIMITS.actions);
  }
  for (const key of ["logo", "logoLight", "banner"] as const) {
    if (typeof h[key] === "string") out[key] = h[key] as string;
  }
  if (typeof h.hidden === "boolean") out.hidden = h.hidden;
  return out;
}

export interface ResolveViewHeaderInput {
  manifest: PluginManifest;
  viewId: string;
  /** Sanitized runtime overrides for this view, or null. */
  runtime: PluginViewHeader | null;
}

export function resolvePluginViewHeader({ manifest, viewId, runtime }: ResolveViewHeaderInput): ResolvedPluginViewHeader {
  const items = manifest.contributes?.sidebarItems ?? [];
  const item = items.find((i) => i.id === viewId);
  const base: PluginManifestViewHeader = { ...(manifest.viewHeader ?? {}), ...(item?.header ?? {}) };
  const rt = runtime ?? {};

  const title = cleanText(rt.title, VIEW_HEADER_LIMITS.title)
    ?? cleanText(base.title, VIEW_HEADER_LIMITS.title)
    ?? cleanText(manifest.name, VIEW_HEADER_LIMITS.title)
    ?? manifest.id;

  const label = cleanText(item?.label, VIEW_HEADER_LIMITS.title);
  const viewLabel = items.length > 1 && label && label.toLowerCase() !== title.toLowerCase() ? label : null;

  const subtitle = rt.subtitle !== undefined
    ? cleanText(rt.subtitle, VIEW_HEADER_LIMITS.subtitle) ?? null
    : cleanText(base.subtitle, VIEW_HEADER_LIMITS.subtitle) ?? null;

  const pick = (key: "logo" | "logoLight" | "banner") =>
    rt[key] !== undefined ? runtimeImage(rt[key]) : manifestImage(base[key]);

  return {
    hidden: rt.hidden ?? base.hidden ?? false,
    title,
    viewLabel,
    subtitle,
    iconPath: pluginIconPath(manifest.icon ?? item?.icon),
    status: rt.status ?? null,
    actions: (rt.actions ?? []).map((a) => ({
      label: a.label,
      action: a.action,
      variant: a.variant === "accent" ? "accent" : "secondary",
      disabled: a.disabled === true,
    })),
    logo: pick("logo"),
    logoLight: pick("logoLight"),
    banner: pick("banner"),
  };
}
