import { describe, expect, it } from "vitest";
import { VISUALIZER_TARGET_FPS, shouldRenderFrame } from "../components/VisualizerSlot";

/**
 * The host's frame budget for visualizers.
 *
 * `requestAnimationFrame` fires at the display's refresh rate, so an uncapped
 * loop runs at 120Hz on a ProMotion Mac — twice the frames, and twice the
 * recompositing of whatever layers the frame moved, for a picture nobody can
 * tell from 60. The gate is deliberately lenient about *when* a frame is due;
 * these tests pin that leniency, because the obvious strict version halves the
 * rate on any display whose interval doesn't divide the budget.
 */
const budget = 1000 / VISUALIZER_TARGET_FPS;

/** Walk N display frames at `intervalMs` and count how many the gate allowed. */
function drawnFrames(intervalMs: number, frames: number): number {
  let last: number | null = null;
  let drawn = 0;
  for (let i = 0; i < frames; i++) {
    const t = i * intervalMs;
    if (shouldRenderFrame(t, last)) {
      last = t;
      drawn += 1;
    }
  }
  return drawn;
}

describe("shouldRenderFrame", () => {
  it("always draws the first frame of a mount", () => {
    expect(shouldRenderFrame(0, null)).toBe(true);
    expect(shouldRenderFrame(1234.5, null)).toBe(true);
  });

  it("halves a 120Hz display to the target rate", () => {
    // 120 display frames = 1 second; the visual should get ~60 of them.
    expect(drawnFrames(1000 / 120, 120)).toBe(60);
  });

  it("leaves a 60Hz display untouched", () => {
    // Nothing to cap: every frame is already a whole budget apart, and the
    // slack is what keeps floating-point jitter from dropping every other one.
    expect(drawnFrames(1000 / 60, 60)).toBe(60);
  });

  it("lands a 144Hz display above the target rather than at half of it", () => {
    // The bug this slack exists for: two 144Hz frames are 13.9ms, which a strict
    // 16.67ms deadline rejects — so the third would carry it and the visual would
    // run at 48fps, *below* what an uncapped 60Hz panel gets.
    const drawn = drawnFrames(1000 / 144, 144);
    expect(drawn).toBeGreaterThanOrEqual(VISUALIZER_TARGET_FPS);
    expect(drawn).toBeLessThan(144);
  });

  it("never withholds the frame that ends a gap", () => {
    // Off-screen, hidden, or a stalled main thread: the frame bringing the
    // visualizer back must draw, or the first thing the user sees is a stale one.
    expect(shouldRenderFrame(5000, 0)).toBe(true);
  });

  it("draws on a backwards clock rather than stalling on it", () => {
    // A new timeline (the loop resuming after the page was hidden) would
    // otherwise read as "no time has passed" and withhold every frame.
    expect(shouldRenderFrame(10, 9000)).toBe(true);
  });

  it("withholds a frame that is only just short of the budget", () => {
    expect(shouldRenderFrame(budget * 0.5, 0)).toBe(false);
    expect(shouldRenderFrame(budget * 0.74, 0)).toBe(false);
    expect(shouldRenderFrame(budget, 0)).toBe(true);
  });
});
