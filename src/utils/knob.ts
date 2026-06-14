// Pure value/angle math for the rotary Knob component (unit-tested).
// Zero sits at 12 o'clock; the dial sweeps SWEEP_DEG total, centered there.

export const SWEEP_DEG = 270;
export const HALF_SWEEP = SWEEP_DEG / 2;
export const DRAG_RANGE_PX = 160; // full-range travel for a 160px vertical drag

export function knobClamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Snap to the nearest step and clamp into [min, max].
export function knobQuantize(v: number, min: number, max: number, step: number): number {
  return knobClamp(Math.round(v / step) * step, min, max);
}

// Map a value in [min, max] to its dial angle in degrees (−HALF_SWEEP..+HALF_SWEEP).
export function valueToAngle(value: number, min: number, max: number): number {
  if (max === min) return -HALF_SWEEP;
  const t = knobClamp((value - min) / (max - min), 0, 1);
  return -HALF_SWEEP + t * SWEEP_DEG;
}

// Convert a vertical drag (px, up = positive) into a value delta over the range.
export function dragDeltaToValue(deltaPx: number, min: number, max: number): number {
  return (deltaPx / DRAG_RANGE_PX) * (max - min);
}
