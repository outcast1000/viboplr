// What a running collection scan/sync is doing, in one place for every surface
// that shows it (caption bar, Collections, Home, onboarding).

export interface ResyncProgressInfo {
  kind: "scan" | "sync";
  scanned: number;
  total: number;
  /** A scan's first pass: walking the folder to count its files. `scanned` is
   *  then the number found so far and `total` is 0. */
  counting?: boolean;
}

/** 0..1, or null while the total isn't known yet (counting, or a sync that
 *  hasn't reported one) — show an indeterminate indicator then. */
export function resyncFraction(p: ResyncProgressInfo): number | null {
  if (p.counting || p.total <= 0) return null;
  return Math.min(1, Math.max(0, p.scanned / p.total));
}

/** A fraction as a CSS percentage, or undefined when it isn't known. */
export function fractionWidth(fraction: number | null): string | undefined {
  return fraction == null ? undefined : `${Math.round(fraction * 100)}%`;
}

/** One line describing the current step. */
export function resyncStatusText(p: ResyncProgressInfo): string {
  if (p.counting) {
    return p.scanned > 0 ? `Counting files… ${p.scanned.toLocaleString()} found` : "Counting files…";
  }
  if (p.total > 0) {
    const verb = p.kind === "scan" ? "Scanning" : "Syncing";
    const unit = p.kind === "scan" ? "files" : "albums";
    return `${verb}… ${p.scanned.toLocaleString()} / ${p.total.toLocaleString()} ${unit}`;
  }
  return p.kind === "scan" ? "Preparing scan…" : "Preparing sync…";
}
