import { describe, it, expect } from "vitest";
import {
  knobClamp,
  knobQuantize,
  valueToAngle,
  dragDeltaToValue,
  HALF_SWEEP,
} from "../utils/knob";

describe("knobClamp", () => {
  it("clamps below, above, and within range", () => {
    expect(knobClamp(-99, -15, 15)).toBe(-15);
    expect(knobClamp(99, -15, 15)).toBe(15);
    expect(knobClamp(3, -15, 15)).toBe(3);
  });
});

describe("knobQuantize", () => {
  it("snaps to the nearest step", () => {
    expect(knobQuantize(2.3, -15, 15, 0.5)).toBe(2.5);
    expect(knobQuantize(2.2, -15, 15, 0.5)).toBe(2.0);
  });

  it("clamps the snapped value into range", () => {
    expect(knobQuantize(99, -15, 15, 0.5)).toBe(15);
    expect(knobQuantize(-99, -15, 15, 0.5)).toBe(-15);
  });
});

describe("valueToAngle", () => {
  it("puts the min at the left end of the sweep", () => {
    expect(valueToAngle(-15, -15, 15)).toBeCloseTo(-HALF_SWEEP, 5);
  });

  it("puts the max at the right end of the sweep", () => {
    expect(valueToAngle(15, -15, 15)).toBeCloseTo(HALF_SWEEP, 5);
  });

  it("puts a bipolar zero at 12 o'clock (0 degrees)", () => {
    expect(valueToAngle(0, -15, 15)).toBeCloseTo(0, 5);
  });

  it("clamps out-of-range values to the sweep ends", () => {
    expect(valueToAngle(99, -15, 15)).toBeCloseTo(HALF_SWEEP, 5);
    expect(valueToAngle(-99, -15, 15)).toBeCloseTo(-HALF_SWEEP, 5);
  });

  it("does not divide by zero for a degenerate range", () => {
    expect(valueToAngle(5, 5, 5)).toBe(-HALF_SWEEP);
  });
});

describe("dragDeltaToValue", () => {
  it("maps a full 160px upward drag to the full positive range", () => {
    expect(dragDeltaToValue(160, -15, 15)).toBeCloseTo(30, 5);
  });

  it("is signed: downward drag decreases", () => {
    expect(dragDeltaToValue(-80, -15, 15)).toBeCloseTo(-15, 5);
  });

  it("is zero for no movement", () => {
    expect(dragDeltaToValue(0, -15, 15)).toBe(0);
  });
});
