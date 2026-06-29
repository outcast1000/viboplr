import { describe, it, expect, afterEach, vi } from "vitest";
import { isReducedMotion, applyReduceMotionAttr, subscribeReducedMotion } from "../utils/reducedMotion";

// jsdom has no matchMedia, so these exercise the in-app (attribute) path. The OS
// path is `|| matchMedia(...)`, verified by the live Playwright run separately.

afterEach(() => {
  applyReduceMotionAttr(false); // reset the root attribute between tests
});

describe("reducedMotion", () => {
  it("is false by default and reflects the in-app toggle", () => {
    expect(isReducedMotion()).toBe(false);
    applyReduceMotionAttr(true);
    expect(isReducedMotion()).toBe(true);
    expect(document.documentElement.hasAttribute("data-reduce-motion")).toBe(true);
    applyReduceMotionAttr(false);
    expect(isReducedMotion()).toBe(false);
    expect(document.documentElement.hasAttribute("data-reduce-motion")).toBe(false);
  });

  it("notifies subscribers when the toggle flips, and stops after unsubscribe", () => {
    const cb = vi.fn();
    const unsub = subscribeReducedMotion(cb);
    applyReduceMotionAttr(true);
    applyReduceMotionAttr(false);
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    applyReduceMotionAttr(true);
    expect(cb).toHaveBeenCalledTimes(2); // no further calls after unsubscribe
  });
});
