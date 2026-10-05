// Row status for the plugin `track-row-list`: the state chip (`badge`) and the
// work-under-way bar (`progress`) a plugin can put on a row. Both are plugin
// data crossing a trust boundary, so everything here is normalisation: a value
// the host can't draw honestly is dropped, never guessed at.

export type RowBadgeVariant = "default" | "accent" | "success" | "warning" | "error" | "muted";

const VARIANTS: readonly RowBadgeVariant[] = ["default", "accent", "success", "warning", "error", "muted"];

// Long enough for "Needs attention", short enough that a chip can't crowd the
// subtitle it leads off the line.
export const ROW_BADGE_MAX_CHARS = 24;

export interface RowBadge {
  label: string;
  variant: RowBadgeVariant;
}

/** The chip to draw, or null. An unknown variant draws as `default` rather
 * than vanishing — the word is the information, the colour only a hint. */
export function normalizeRowBadge(raw: unknown): RowBadge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { label?: unknown; variant?: unknown };
  if (typeof r.label !== "string") return null;
  const label = r.label.trim();
  if (!label) return null;
  const variant = VARIANTS.includes(r.variant as RowBadgeVariant) ? (r.variant as RowBadgeVariant) : "default";
  return {
    label: label.length > ROW_BADGE_MAX_CHARS ? label.slice(0, ROW_BADGE_MAX_CHARS - 1) + "…" : label,
    variant,
  };
}

/** Percent (0–100) for the row's bar, or null for no bar. `progress` is 0–1;
 * out-of-range values clamp, and anything that isn't a finite number draws
 * nothing — a bar at 0% for "unknown" would claim a fact nobody reported. */
export function rowProgressPercent(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.round(Math.min(1, Math.max(0, raw)) * 1000) / 10;
}
