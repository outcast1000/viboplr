import { describe, it, expect } from "vitest";
import { cssToLogicalRatio } from "../hooks/useMiniMode";

describe("cssToLogicalRatio", () => {
  it("is 1 when the CSS viewport matches the window's logical size", () => {
    // macOS retina: 104 physical / 2 = 52 logical, and the page reports 52 CSS px.
    expect(cssToLogicalRatio(104, 2, 52)).toBe(1);
    // Non-retina, same agreement.
    expect(cssToLogicalRatio(52, 1, 52)).toBe(1);
  });

  it("reports the shortfall when the webview scales the page a second time", () => {
    // Issue #130: Windows at 125%. The window is 52 logical px (65 physical),
    // but WebView2 lays the page out as if the viewport were 52 / 1.25 CSS px,
    // so a 52-CSS-px design needs a 65-logical-px window to fit.
    expect(cssToLogicalRatio(65, 1.25, 41.6)).toBeCloseTo(1.25, 5);
  });

  it("carries the webview zoom, so callers must not apply it twice", () => {
    // Page zoom 1.15 shrinks the CSS viewport by definition: 52 / 1.15 = 45.2.
    expect(cssToLogicalRatio(52, 1, 45.217)).toBeCloseTo(1.15, 3);
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
});
