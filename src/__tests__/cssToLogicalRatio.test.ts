import { describe, it, expect } from "vitest";
import { cssToLogicalRatio } from "../hooks/useMiniMode";

describe("cssToLogicalRatio", () => {
  it("is 1 at any display scale when the page is not zoomed", () => {
    // macOS retina: 104 physical / 2 = 52 logical, and the page reports 52 CSS px.
    expect(cssToLogicalRatio(104, 2, 52)).toBe(1);
    // Non-retina, same agreement.
    expect(cssToLogicalRatio(52, 1, 52)).toBe(1);
    // Windows/WebView2 at 125% display scale, measured: 1320 physical / 1.25 =
    // 1056 logical, and window.innerHeight reads 1056 too — the display scale
    // rides on devicePixelRatio (1.25) and never reaches the CSS viewport. The
    // units agree here as well, which is why display scale alone never moves
    // this number and was NOT the cause of issue #130.
    expect(cssToLogicalRatio(1320, 1.25, 1056)).toBe(1);
  });

  it("carries the webview zoom, so callers must not apply it twice", () => {
    // Page zoom is the one thing that does move it: it shrinks the CSS viewport
    // by definition, so the window must grow by the same factor to still fit a
    // layout authored in unzoomed CSS px.
    // Page zoom 1.15: 52 / 1.15 = 45.2.
    expect(cssToLogicalRatio(52, 1, 45.217)).toBeCloseTo(1.15, 3);
    // Measured on Windows at 125% display scale with the mini zoom on 1.3
    // (devicePixelRatio 1.625 = 1.25 x 1.3): the ratio picks up the 1.3 alone.
    expect(cssToLogicalRatio(1320, 1.25, 812)).toBeCloseTo(1.3, 3);
  });

  it("falls back to 1 on a torn or nonsensical sample", () => {
    // The inputs are read over separate IPC hops; a sample taken mid-resize can
    // pair a stale viewport with a fresh window size. Better unchanged than wild.
    expect(cssToLogicalRatio(0, 1.25, 41.6)).toBe(1);
    expect(cssToLogicalRatio(65, 0, 41.6)).toBe(1);
    expect(cssToLogicalRatio(65, 1.25, 0)).toBe(1);
    expect(cssToLogicalRatio(NaN, 1.25, 41.6)).toBe(1);
    expect(cssToLogicalRatio(65, 1.25, 4)).toBe(1);   // ratio 13 — out of range
    expect(cssToLogicalRatio(65, 1.25, 400)).toBe(1); // ratio 0.13 — out of range
  });

  it("does NOT catch a mildly torn sample — the known limit of the guard", () => {
    // Observed live while the display scale changed under a running app:
    // phys=66 (52.8 logical) paired with a stale cssVH of 54. The range check
    // only rejects wild values, so this lands at ~0.978 and sizes the window
    // 1px short. Pinned rather than fixed: a near-1 tear is indistinguishable
    // from a real near-1 ratio at the sample, and the next sizing decision
    // resamples and corrects it.
    expect(cssToLogicalRatio(66, 1.25, 54)).toBeCloseTo(0.978, 3);
  });
});
