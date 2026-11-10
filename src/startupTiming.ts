export interface TimingEntry {
  label: string;
  duration_ms: number;
  offset_ms: number;
}

const entries: TimingEntry[] = [];
const origin = performance.now();

// What happened before this module ran: loading the page and the bundle, then
// parsing, compiling and evaluating every module ahead of this one (React and
// ReactDOM included). Read from Navigation / Resource Timing, whose zero is the
// navigation start, and stored at **negative** offsets from `origin` so the
// frontend span — the furthest point any entry reaches — keeps meaning what it
// always meant and `benchmarks/startup-history.json` stays comparable.
entries.push(...pageLoadEntries(readPageTiming(), origin));

export interface PageTiming {
  /** When index.html had fully arrived (navigation `responseEnd`). */
  documentEnd: number | null;
  /** The main bundle's fetch, if the webview reported a resource entry for it. */
  bundle: { start: number; end: number } | null;
}

function readPageTiming(): PageTiming {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    // The entry bundle is the largest script the page loaded before us; in
    // dev there are many small ones and the pick is merely indicative.
    const scripts = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((r) => r.initiatorType === "script" && r.responseEnd > 0 && r.responseEnd <= origin);
    const main = scripts.reduce<PerformanceResourceTiming | null>(
      (best, r) => (!best || r.encodedBodySize + r.decodedBodySize > best.encodedBodySize + best.decodedBodySize ? r : best),
      null,
    );
    return {
      documentEnd: nav && nav.responseEnd > 0 ? nav.responseEnd : null,
      bundle: main ? { start: main.startTime, end: main.responseEnd } : null,
    };
  } catch (e) {
    console.error("Failed to read page load timing:", e);
    return { documentEnd: null, bundle: null };
  }
}

/**
 * Split navigation start → `origin` into consecutive, non-overlapping phases
 * (so a table that sums durations stays honest). Phases the webview did not
 * report are folded into the next one rather than invented:
 * - `page.document` — index.html requested and received
 * - `page.bundle_fetch` — the main script read from the app bundle
 * - `page.bundle_eval` — waiting on, parsing, compiling and running the modules
 *   evaluated before this one: the cost bundle size actually buys
 */
export function pageLoadEntries(t: PageTiming, originMs: number): TimingEntry[] {
  const out: TimingEntry[] = [];
  let cursor = 0;
  const push = (label: string, end: number) => {
    const clamped = Math.min(Math.max(end, cursor), originMs);
    out.push({ label, duration_ms: clamped - cursor, offset_ms: cursor - originMs });
    cursor = clamped;
  };
  if (t.documentEnd != null) push("page.document", t.documentEnd);
  if (t.bundle) push("page.bundle_fetch", t.bundle.end);
  push("page.bundle_eval", originMs);
  return out;
}

export async function timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  entries.push({
    label,
    duration_ms: performance.now() - start,
    offset_ms: start - origin,
  });
  return result;
}

export function getTimingEntries(): TimingEntry[] {
  return [...entries];
}
