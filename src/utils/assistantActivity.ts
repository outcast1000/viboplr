// What the assistant is doing to the app: the pure half of the activity pill
// and the Settings → AI control log. The events come from the control API's
// middleware (`assistant_activity.rs`); nothing here touches Tauri, so the
// reducer and the pill's rules are asserted without a webview.

export type ActivityKind = "read" | "ui" | "write" | "outward";
export type ActivityStatus = "running" | "ok" | "failed" | "paused";

/** One `assistant-activity` event, as Rust sends it. */
export interface ActivityEvent {
  id: number;
  phase: "start" | "end";
  atMs: number;
  method: string;
  route: string;
  label: string;
  kind: ActivityKind;
  outcome?: "ok" | "failed" | "paused";
  status?: number;
  error?: string;
  /** What the call touched: "Liked track “So What” – Miles Davis". */
  detail?: string;
  /** What came back, when the request didn't say it: "added 2, skipped 1 duplicate". */
  result?: string;
  durationMs?: number;
}

/** One request's whole life, folded from its start and end events. */
export interface ActivityEntry {
  id: number;
  startedMs: number;
  label: string;
  kind: ActivityKind;
  method: string;
  route: string;
  status: ActivityStatus;
  error?: string;
  detail?: string;
  result?: string;
  durationMs?: number;
}

/** The log keeps this many entries; reads are the bulk of them. */
export const ACTIVITY_LOG_LIMIT = 200;
/** How long a finished call stays visible in the pill. */
export const PILL_LINGER_MS = 3000;
/** How far back the pill's list reaches. */
export const PANEL_WINDOW_MS = 5 * 60 * 1000;
/** Rows the pill's list shows. */
export const PANEL_MAX_ROWS = 8;

/** Fold one event into the log (newest first, capped). A `start` adds a running
 *  entry; an `end` settles it — or, for a read or a refused call that announced
 *  nothing before, creates it. */
export function applyActivityEvent(entries: ActivityEntry[], event: ActivityEvent): ActivityEntry[] {
  const idx = entries.findIndex((e) => e.id === event.id);
  if (event.phase === "start") {
    if (idx >= 0) return entries;
    const entry: ActivityEntry = {
      id: event.id,
      startedMs: event.atMs,
      label: event.label,
      kind: event.kind,
      method: event.method,
      route: event.route,
      status: "running",
      detail: event.detail,
    };
    return [entry, ...entries].slice(0, ACTIVITY_LOG_LIMIT);
  }
  const status: ActivityStatus = event.outcome ?? "ok";
  if (idx >= 0) {
    const next = entries.slice();
    next[idx] = {
      ...entries[idx],
      status,
      error: event.error,
      detail: event.detail ?? entries[idx].detail,
      result: event.result,
      durationMs: event.durationMs,
    };
    return next;
  }
  const entry: ActivityEntry = {
    id: event.id,
    startedMs: event.atMs - (event.durationMs ?? 0),
    label: event.label,
    kind: event.kind,
    method: event.method,
    route: event.route,
    status,
    error: event.error,
    detail: event.detail,
    result: event.result,
    durationMs: event.durationMs,
  };
  return [entry, ...entries].slice(0, ACTIVITY_LOG_LIMIT);
}

/** Kinds the pill reports. Reads and page navigation are log-only: a pill that
 *  lit up for every `GET /v1/status` poll would be noise nobody could act on. */
export function isPillWorthy(entry: ActivityEntry): boolean {
  return entry.kind === "write" || entry.kind === "outward";
}

export type PillView =
  | { mode: "hidden" }
  | { mode: "paused"; refused: number }
  | { mode: "running"; label: string; detail?: string; extra: number; outward: boolean }
  | { mode: "done"; label: string; detail?: string; outward: boolean }
  | { mode: "failed"; label: string; detail?: string; count: number };

/**
 * What the pill shows right now.
 *
 * Precedence: **paused** (a standing state the user chose, so it never goes
 * away on a timer) → **running** → **failed** (stays until dismissed, since the
 * failure that matters comes from a call nobody watched) → **done** (lingers
 * `PILL_LINGER_MS` so a quick call is still seen) → hidden.
 *
 * `dismissedBefore` is the highest entry id the user has dismissed: failures at
 * or below it no longer count.
 */
export function pillView(
  entries: ActivityEntry[],
  paused: boolean,
  now: number,
  dismissedBefore: number,
): PillView {
  const worthy = entries.filter(isPillWorthy);
  const refused = worthy.filter((e) => e.status === "paused" && e.id > dismissedBefore).length;
  if (paused) return { mode: "paused", refused };
  const running = worthy.filter((e) => e.status === "running");
  if (running.length > 0) {
    const latest = running[0];
    return { mode: "running", label: latest.label, detail: latest.detail, extra: running.length - 1, outward: latest.kind === "outward" };
  }
  const failed = worthy.filter((e) => e.status === "failed" && e.id > dismissedBefore);
  if (failed.length > 0) return { mode: "failed", label: failed[0].label, detail: failed[0].detail, count: failed.length };
  const recent = worthy.find((e) => e.status === "ok" && now - (e.startedMs + (e.durationMs ?? 0)) < PILL_LINGER_MS);
  if (recent) return { mode: "done", label: recent.label, detail: recent.detail, outward: recent.kind === "outward" };
  return { mode: "hidden" };
}

/** The pill's list: the last few minutes of anything that changed something,
 *  newest first. A failure outlives the window until dismissed. */
export function panelEntries(entries: ActivityEntry[], now: number, dismissedBefore: number): ActivityEntry[] {
  return entries
    .filter(isPillWorthy)
    .filter(
      (e) =>
        e.status === "running" ||
        now - e.startedMs < PANEL_WINDOW_MS ||
        ((e.status === "failed" || e.status === "paused") && e.id > dismissedBefore),
    )
    .slice(0, PANEL_MAX_ROWS);
}

export type LogFilter = "all" | "writes" | "outward" | "failed";

export const LOG_FILTERS: { id: LogFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "writes", label: "Writes" },
  { id: "outward", label: "May leave this machine" },
  { id: "failed", label: "Failed" },
];

export function filterLog(entries: ActivityEntry[], filter: LogFilter): ActivityEntry[] {
  switch (filter) {
    case "writes":
      return entries.filter((e) => e.kind === "write" || e.kind === "outward");
    case "outward":
      return entries.filter((e) => e.kind === "outward");
    case "failed":
      return entries.filter((e) => e.status === "failed" || e.status === "paused");
    default:
      return entries;
  }
}

/** "now", "12s ago", "4 min ago", "2 h ago" — compact, for a list that is read
 *  at a glance. */
export function relativeTime(thenMs: number, now: number): string {
  const secs = Math.max(0, Math.round((now - thenMs) / 1000));
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

export const KIND_LABELS: Record<ActivityKind, string> = {
  read: "Read",
  ui: "Page",
  write: "Write",
  outward: "May leave this machine",
};
