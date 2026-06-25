import { describe, it, expect } from "vitest";
import { ZOOM_PRESETS, clampZoomToPreset, stepZoomPreset } from "../utils/zoom";

describe("clampZoomToPreset", () => {
  it("returns exact presets unchanged", () => {
    for (const p of ZOOM_PRESETS) expect(clampZoomToPreset(p)).toBe(p);
  });

  it("snaps arbitrary values to the nearest preset", () => {
    expect(clampZoomToPreset(0.88)).toBe(0.9);
    expect(clampZoomToPreset(1.05)).toBe(1);
    expect(clampZoomToPreset(1.1)).toBe(1.15);
    expect(clampZoomToPreset(2)).toBe(1.3); // above the top clamps to top
    expect(clampZoomToPreset(0.1)).toBe(0.9); // below the bottom clamps to bottom
  });

  it("falls back to 1 for non-finite input", () => {
    expect(clampZoomToPreset(NaN)).toBe(1);
    expect(clampZoomToPreset(Infinity)).toBe(1);
  });
});

describe("stepZoomPreset", () => {
  it("steps up and down the ladder", () => {
    expect(stepZoomPreset(1, 1)).toBe(1.15);
    expect(stepZoomPreset(1, -1)).toBe(0.9);
    expect(stepZoomPreset(0.9, 1)).toBe(1);
    expect(stepZoomPreset(1.15, 1)).toBe(1.3);
  });

  it("clamps at the ends without wrapping", () => {
    expect(stepZoomPreset(0.9, -1)).toBe(0.9);
    expect(stepZoomPreset(1.3, 1)).toBe(1.3);
  });

  it("snaps an off-ladder value before stepping", () => {
    expect(stepZoomPreset(1.05, 1)).toBe(1.15); // 1.05 → 1 → up → 1.15
    expect(stepZoomPreset(1.05, -1)).toBe(0.9); // 1.05 → 1 → down → 0.9
  });
});
