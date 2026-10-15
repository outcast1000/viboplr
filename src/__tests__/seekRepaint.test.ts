import { describe, it, expect } from "vitest";
import { seekPaintKey, quantizeFraction } from "../utils/seekRepaint";

const base = { progress: 0.5, width: 700, height: 34, hoverPct: null, bufferedPct: null };

describe("seekPaintKey", () => {
  it("is unchanged while the playhead stays on the same pixel", () => {
    // A 4-minute song on a 700px bar moves ~0.73px per 250ms tick.
    const a = seekPaintKey({ ...base, progress: 100 / 700 });
    const b = seekPaintKey({ ...base, progress: 100.3 / 700 });
    expect(b).toBe(a);
  });

  it("changes once the playhead reaches the next pixel", () => {
    const a = seekPaintKey({ ...base, progress: 100 / 700 });
    const b = seekPaintKey({ ...base, progress: 101 / 700 });
    expect(b).not.toBe(a);
  });

  it("changes for anything else the picture depends on", () => {
    const a = seekPaintKey(base);
    expect(seekPaintKey({ ...base, width: 701 })).not.toBe(a);
    expect(seekPaintKey({ ...base, height: 75 })).not.toBe(a);
    expect(seekPaintKey({ ...base, hoverPct: 0.2 })).not.toBe(a);
    expect(seekPaintKey({ ...base, bufferedPct: 0.9 })).not.toBe(a);
    expect(seekPaintKey({ ...base, extra: "skin-b" })).not.toBe(a);
  });

  it("tells an unknown buffer apart from an empty one", () => {
    expect(seekPaintKey({ ...base, bufferedPct: null })).not.toBe(seekPaintKey({ ...base, bufferedPct: 0 }));
  });
});

describe("quantizeFraction", () => {
  it("snaps to the nearest step and clamps to 0..1", () => {
    expect(quantizeFraction(0.50004, 600)).toBe(0.5);
    expect(quantizeFraction(-0.2, 600)).toBe(0);
    expect(quantizeFraction(1.3, 600)).toBe(1);
  });

  it("holds still between steps", () => {
    expect(quantizeFraction(0.1001, 600)).toBe(quantizeFraction(0.1004, 600));
  });
});
