// What a running collection scan/sync is doing, in one place for every surface
// that shows it (caption bar, Collections, Home, onboarding).

/** Why a local collection is being scanned (the backend's `ScanMode`). */
export type ScanMode = "first" | "quick" | "full";

export interface ResyncProgressInfo {
  kind: "scan" | "sync";
  scanned: number;
  total: number;
  /** A scan's first pass: walking the folder to count its files. `scanned` is
   *  then the number found so far and `total` is 0. */
  counting?: boolean;
  /** Folders the counting pass has walked — moves even through folders with
   *  no media in them, where the found count stands still. */
  folders?: number;
  /** Scans only: first scan of a new collection, quick or full rescan. */
  mode?: ScanMode;
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

/** What kind of run this is — shown next to the collection's name. */
export function resyncModeLabel(p: ResyncProgressInfo): string {
  if (p.kind === "sync") return "Sync";
  switch (p.mode) {
    case "first": return "First scan";
    case "full": return "Full rescan";
    case "quick": return "Quick rescan";
    default: return "Scan";
  }
}

/** One line describing the current step. */
export function resyncStatusText(p: ResyncProgressInfo): string {
  if (p.counting) {
    const folders = p.folders ?? 0;
    if (folders > 0) {
      return `Counting files… ${p.scanned.toLocaleString()} found in ${folders.toLocaleString()} ${folders === 1 ? "folder" : "folders"}`;
    }
    return p.scanned > 0 ? `Counting files… ${p.scanned.toLocaleString()} found` : "Counting files…";
  }
  if (p.total > 0) {
    const verb = p.kind === "scan" ? "Scanning" : "Syncing";
    const unit = p.kind === "scan" ? "files" : "albums";
    return `${verb}… ${p.scanned.toLocaleString()} / ${p.total.toLocaleString()} ${unit}`;
  }
  return p.kind === "scan" ? "Preparing scan…" : "Preparing sync…";
}

/** The step in a few characters, for the caption bar (which also shows the
 *  collection's name and the mode, so it has no room for the full line). */
export function resyncShortText(p: ResyncProgressInfo): string {
  if (p.counting) {
    return p.scanned > 0 || (p.folders ?? 0) > 0 ? `${p.scanned.toLocaleString()} found` : "Counting…";
  }
  return fractionWidth(resyncFraction(p)) ?? "Preparing…";
}
