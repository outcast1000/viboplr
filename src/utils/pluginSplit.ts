/**
 * The pure half of the plugin `split` view node (`components/pluginViews/
 * PluginSplit.tsx`): the first pane's width rules, and the persisted
 * `pluginSplitSizes` record (`<pluginId>:<persistKey>` → px).
 */

export const SPLIT_DEFAULT_SIZE = 300;
export const SPLIT_DEFAULT_MIN = 160;
/** The second pane always keeps at least this much, whatever `maxSize` says. */
export const SPLIT_MIN_SECOND_PANE = 240;
/** A stored record never grows past this many keys (one per plugin view). */
export const SPLIT_SIZES_MAX_KEYS = 100;

export interface SplitBounds {
  minSize?: number;
  maxSize?: number;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Clamp a first-pane width: at least `minSize` (default 160), at most
 * `maxSize`, and never so wide that the second pane drops under
 * `SPLIT_MIN_SECOND_PANE` of `containerWidth` (when known). The min wins a
 * conflict — a pane collapsed to nothing is worse than one that overflows.
 */
export function clampSplitSize(size: number, bounds: SplitBounds, containerWidth?: number): number {
  const min = finite(bounds.minSize) && bounds.minSize > 0 ? bounds.minSize : SPLIT_DEFAULT_MIN;
  let max = finite(bounds.maxSize) && bounds.maxSize > 0 ? bounds.maxSize : Infinity;
  if (finite(containerWidth) && containerWidth > 0) max = Math.min(max, containerWidth - SPLIT_MIN_SECOND_PANE);
  const s = finite(size) ? size : SPLIT_DEFAULT_SIZE;
  return Math.round(Math.max(min, Math.min(s, max)));
}

/** The persisted key for a split: per plugin, so two plugins can't share one. */
export function splitSizeKey(pluginId: string, persistKey: string): string {
  return `${pluginId}:${persistKey}`;
}

/** One plugin's widths, keyed by `persistKey` (the prefix stripped). */
export function splitSizesForPlugin(sizes: Record<string, number>, pluginId: string): Record<string, number> {
  const prefix = `${pluginId}:`;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(sizes)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}

/** Restore rule for the `pluginSplitSizes` store key: keep finite positive
 *  numbers only, at most `SPLIT_SIZES_MAX_KEYS` entries. */
export function coerceSplitSizes(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= SPLIT_SIZES_MAX_KEYS) break;
    if (finite(v) && v > 0) {
      out[k] = Math.round(v);
      n++;
    }
  }
  return out;
}

/** Forget a width (a reset), so the plugin's own default applies again —
 *  including a default a later plugin release changes. */
export function withoutSplitSize(sizes: Record<string, number>, key: string): Record<string, number> {
  if (!(key in sizes)) return sizes;
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(sizes)) if (k !== key) next[k] = v;
  return next;
}

/** Record a width, keeping the record bounded (newest key last). Returns the
 *  previous object when nothing changed, so React state bails out. */
export function withSplitSize(sizes: Record<string, number>, key: string, size: number): Record<string, number> {
  if (sizes[key] === size) return sizes;
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(sizes)) if (k !== key) next[k] = v;
  next[key] = size;
  const keys = Object.keys(next);
  for (let i = 0; i < keys.length - SPLIT_SIZES_MAX_KEYS; i++) delete next[keys[i]];
  return next;
}
