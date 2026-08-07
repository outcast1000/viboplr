import { describe, it, expect } from "vitest";
import { clampRate, MIN_VISUALIZER_RATE, MAX_VISUALIZER_RATE } from "../components/VisualizerSlot";
import { applyRateTo } from "../hooks/usePlayback";

describe("clampRate", () => {
  // The contract's promise is that a misbehaving visualizer can cost you a view
  // but never your music. Rate is the first write that could break that — it's
  // audible, subtle and sticky — so the clamp is load-bearing, not a formality.
  it("passes normal rates through", () => {
    expect(clampRate(1)).toBe(1);
    expect(clampRate(1.35)).toBeCloseTo(1.35);
    expect(clampRate(2.34)).toBeCloseTo(2.34); // 78 on a 33 pressing
    expect(clampRate(0.74)).toBeCloseTo(0.74); // 33 on a 45
  });

  it("refuses a rate of zero rather than producing silence that looks like a hang", () => {
    expect(clampRate(0)).toBe(1);
  });

  it("refuses negative and non-finite rates", () => {
    for (const bad of [-1, -0.5, NaN, Infinity, -Infinity]) {
      expect(clampRate(bad)).toBe(1);
    }
  });

  it("bounds absurd rates instead of honouring them", () => {
    expect(clampRate(1000)).toBe(MAX_VISUALIZER_RATE);
    expect(clampRate(0.0001)).toBe(MIN_VISUALIZER_RATE);
  });

  it("leaves room for every speed a deck can honestly ask for", () => {
    // 78rpm on a 33 pressing is the fastest real one.
    expect(MAX_VISUALIZER_RATE).toBeGreaterThanOrEqual(2.34);
    expect(MIN_VISUALIZER_RATE).toBeLessThanOrEqual(0.74);
  });
});

describe("applyRateTo", () => {
  function fakeEl() {
    return { playbackRate: 1, preservesPitch: true, webkitPreservesPitch: true } as unknown as
      HTMLMediaElement & { preservesPitch: boolean; webkitPreservesPitch: boolean };
  }

  it("turns pitch preservation OFF, which is what makes this a deck", () => {
    // preservesPitch defaults to TRUE. Left alone, the browser time-stretches and
    // holds the original pitch — correct for a podcast, wrong for a turntable,
    // which resamples so 45 on a 33 pressing is faster AND higher. This one line
    // is the whole difference and it is invisible in a screenshot.
    const el = fakeEl();
    applyRateTo(el, 1.35);
    expect(el.preservesPitch).toBe(false);
    expect(el.playbackRate).toBeCloseTo(1.35);
  });

  it("also sets the webkit-prefixed name, which is what some WKWebViews honour", () => {
    const el = fakeEl();
    applyRateTo(el, 2);
    expect(el.webkitPreservesPitch).toBe(false);
  });

  it("is a no-op on a missing element", () => {
    expect(() => applyRateTo(null, 1.35)).not.toThrow();
  });
});
