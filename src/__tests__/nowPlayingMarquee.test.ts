import { describe, it, expect } from "vitest";
import { computeMarquee } from "../components/NowPlayingInfoCycler";

describe("computeMarquee", () => {
  it("returns null when the content fits the line", () => {
    expect(computeMarquee(100, 200)).toBeNull();
  });

  it("scrolls on any real overflow (no ellipsis gate)", () => {
    expect(computeMarquee(200, 200)).toBeNull(); // fits exactly → static
    expect(computeMarquee(199, 200)).toBeNull(); // fits → static
    expect(computeMarquee(201, 200)).not.toBeNull(); // 1px overflow → scrolls, never ellipsis
    expect(computeMarquee(203, 200)).not.toBeNull(); // 3px overflow → scrolls
  });

  it("floors the glide duration so a small overflow drifts gently instead of twitching", () => {
    const plan = computeMarquee(230, 200, 45)!; // 30px overflow → ~855ms raw, floored up
    expect(plan.durMs).toBe(1200);
    expect(plan.cycleMs).toBe(1600);
    // A 1px subpixel overflow is floored to the same gentle, imperceptible drift.
    expect(computeMarquee(201, 200, 45)!.durMs).toBe(1200);
  });

  it("returns null when the viewport is too small to measure", () => {
    expect(computeMarquee(500, 0)).toBeNull();
    expect(computeMarquee(500, 10)).toBeNull();
  });

  it("plans a marquee when the content overflows", () => {
    const plan = computeMarquee(300, 100, 50);
    expect(plan).not.toBeNull();
    expect(plan!.shift).toBe(200); // 300 - 100
    // travel = 200px / 50px/s = 4000ms; one direction = 4000 / 0.78
    expect(plan!.durMs).toBe(Math.round(4000 / 0.78));
    expect(plan!.cycleMs).toBe(plan!.durMs + 400);
  });

  it("scales shift and duration with the overflow distance", () => {
    const a = computeMarquee(200, 100, 50)!;
    const b = computeMarquee(400, 100, 50)!;
    expect(b.shift).toBeGreaterThan(a.shift);
    expect(b.durMs).toBeGreaterThan(a.durMs);
  });

  it("slower speed yields a longer glide", () => {
    const fast = computeMarquee(300, 100, 90)!;
    const slow = computeMarquee(300, 100, 30)!;
    expect(slow.durMs).toBeGreaterThan(fast.durMs);
    expect(slow.shift).toBe(fast.shift); // distance is speed-independent
  });
});
