import { describe, expect, it } from "vitest";
import { pageLoadEntries } from "../startupTiming";

// The page-load phases sit before the frontend timer's origin. They must
// partition navigation start → origin exactly (a table summing durations stays
// honest) and must never reach past the origin, or the frontend span — and
// with it every row of benchmarks/startup-history.json — would change meaning.
describe("pageLoadEntries", () => {
  it("splits navigation start → origin into document, fetch and eval", () => {
    const entries = pageLoadEntries({ documentEnd: 12, bundle: { start: 14, end: 30 } }, 80);
    expect(entries).toEqual([
      { label: "page.document", duration_ms: 12, offset_ms: -80 },
      { label: "page.bundle_fetch", duration_ms: 18, offset_ms: -68 },
      { label: "page.bundle_eval", duration_ms: 50, offset_ms: -50 },
    ]);
    expect(entries.reduce((s, e) => s + e.duration_ms, 0)).toBe(80);
    for (const e of entries) expect(e.offset_ms + e.duration_ms).toBeLessThanOrEqual(0);
  });

  it("folds a phase the webview didn't report into the next one", () => {
    expect(pageLoadEntries({ documentEnd: 12, bundle: null }, 80)).toEqual([
      { label: "page.document", duration_ms: 12, offset_ms: -80 },
      { label: "page.bundle_eval", duration_ms: 68, offset_ms: -68 },
    ]);
    expect(pageLoadEntries({ documentEnd: null, bundle: null }, 80)).toEqual([
      { label: "page.bundle_eval", duration_ms: 80, offset_ms: -80 },
    ]);
  });

  it("clamps timestamps that run backwards or past the origin", () => {
    // A bundle fetch reported as ending before the document did, and a
    // document end after the origin: nothing negative, nothing past zero.
    const entries = pageLoadEntries({ documentEnd: 90, bundle: { start: 1, end: 5 } }, 80);
    for (const e of entries) {
      expect(e.duration_ms).toBeGreaterThanOrEqual(0);
      expect(e.offset_ms + e.duration_ms).toBeLessThanOrEqual(0);
    }
    expect(entries.reduce((s, e) => s + e.duration_ms, 0)).toBe(80);
  });
});
