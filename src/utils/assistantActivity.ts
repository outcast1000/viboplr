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
/** A gap longer than this between two changes starts a new session, so the
 *  segment's count starts again from 1. */
export const SESSION_GAP_MS = 8000;
/** "Working" holds this long after the last call ends, so a burst of quick
 *  calls reads as one session instead of flickering between states. */
export const PILL_HOLD_MS = 4000;
/** How long the segment stays once the session is over (with its countdown
 *  ring), so the one-click Pause is still there right after something
 *  happened — which is exactly when people reach for it. */
export const PILL_LINGER_MS = 60_000;

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
  | { mode: "working"; count: number; outward: boolean }
  | { mode: "failed"; label: string; detail?: string; count: number }
  /** `left` is the share of the linger still to go, 1 → 0, for the ring. */
  | { mode: "done"; count: number; outward: boolean; left: number };

const endMs = (e: ActivityEntry) => e.startedMs + (e.durationMs ?? 0);

/** The current session, newest first: the newest run of changes in which each
 *  one started no more than `SESSION_GAP_MS` after the one before it ended. A
 *  refused call isn't part of it — it changed nothing. */
export function currentSession(entries: ActivityEntry[]): ActivityEntry[] {
  const session: ActivityEntry[] = [];
  for (const e of entries) {
    if (!isPillWorthy(e) || e.status === "paused") continue;
    const newer = session[session.length - 1];
    if (newer && e.status !== "running" && newer.startedMs - endMs(e) > SESSION_GAP_MS) break;
    session.push(e);
  }
  return session;
}

/**
 * What the assistant segment shows right now. It describes a **session**, not
 * the latest call: a burst of five changes reads "Working · 5" with only the
 * count moving — five labels replacing each other was the flicker this
 * replaced.
 *
 * Precedence: **paused** (a standing state the user chose, never on a timer)
 * → **working** (a call running, or the last one ended under `PILL_HOLD_MS`
 * ago) → **failed** (stays until the user has looked at Settings → AI control:
 * `dismissedBefore` is the highest entry id they saw, so a newer failure still
 * speaks up) → **done** (lingers `PILL_LINGER_MS`) → hidden.
 */
export function pillView(
  entries: ActivityEntry[],
  paused: boolean,
  now: number,
  dismissedBefore: number,
): PillView {
  if (paused) {
    const refused = entries.filter((e) => isPillWorthy(e) && e.status === "paused" && e.id > dismissedBefore).length;
    return { mode: "paused", refused };
  }
  const session = currentSession(entries);
  const outward = session.some((e) => e.kind === "outward");
  const running = session.some((e) => e.status === "running");
  const lastEnd = session.reduce((max, e) => Math.max(max, endMs(e)), -Infinity);
  // A failed call is part of the session's timing but changed nothing, so it
  // isn't counted (the failed state and the notification speak for it).
  const count = session.filter((e) => e.status !== "failed").length;
  if (session.length > 0 && (running || now - lastEnd < PILL_HOLD_MS)) {
    return { mode: "working", count, outward };
  }
  const failed = entries.filter((e) => isPillWorthy(e) && e.status === "failed" && e.id > dismissedBefore);
  if (failed.length > 0) return { mode: "failed", label: failed[0].label, detail: failed[0].detail, count: failed.length };
  const since = now - lastEnd;
  if (count > 0 && since < PILL_LINGER_MS) {
    return { mode: "done", count, outward, left: 1 - since / PILL_LINGER_MS };
  }
  return { mode: "hidden" };
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
