export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const BAND_Q = 1.41;
export const GAIN_MIN = -15;
export const GAIN_MAX = 15;
export const NUM_BANDS = 10;

// Simple (Bass/Treble) mode: a classic two-band Baxandall-style tone stack built
// from two shelving filters. Bass is a low-shelf at ~100 Hz (lifts/cuts the whole
// low end without dragging the 200-400 Hz "mud" region), treble is a high-shelf at
// ~10 kHz (adds "air"/sparkle without touching the harsh 2-5 kHz presence band).
// Gain range matches the graphic EQ for consistency. Shelves ignore Q in Web Audio.
export type EqMode = "advanced" | "simple";
export const SHELF_BASS_FREQ = 100;
export const SHELF_TREBLE_FREQ = 10000;
export const SHELF_GAIN_MIN = -15;
export const SHELF_GAIN_MAX = 15;

export interface EqPreset {
  id: string;
  name: string;
  gains: number[];
}

export const BUILTIN_PRESETS: EqPreset[] = [
  { id: "flat",       name: "Flat",        gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: "bass",       name: "Bass Boost",  gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: "treble",     name: "Treble Boost",gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { id: "vocal",      name: "Vocal",       gains: [-2, -1, 0, 2, 4, 4, 3, 2, 0, -1] },
  { id: "rock",       name: "Rock",        gains: [4, 3, 2, 0, -2, -1, 1, 3, 4, 5] },
  { id: "jazz",       name: "Jazz",        gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { id: "classical",  name: "Classical",   gains: [3, 2, 1, 0, 0, 0, -1, -1, 2, 3] },
  { id: "electronic", name: "Electronic",  gains: [5, 4, 1, 0, -2, 0, 1, 2, 4, 5] },
];

// Reference sample rate for drawing the EQ response curve. Biquad coefficients
// are sample-rate dependent, but the visual curve is just an indicator; 48 kHz
// matches the most common output rate and the shape is near-identical at 44.1k.
const CURVE_SAMPLE_RATE = 48000;

// Magnitude response in dB at frequency f for a biquad given its coefficients.
function biquadMagDb(
  f: number,
  b0: number, b1: number, b2: number,
  a0: number, a1: number, a2: number,
): number {
  const w = 2 * Math.PI * f / CURVE_SAMPLE_RATE;
  const cosw = Math.cos(w);
  const cos2w = Math.cos(2 * w);
  const sinw = Math.sin(w);
  const sin2w = Math.sin(2 * w);
  const numRe = b0 + b1 * cosw + b2 * cos2w;
  const numIm = -(b1 * sinw + b2 * sin2w);
  const denRe = a0 + a1 * cosw + a2 * cos2w;
  const denIm = -(a1 * sinw + a2 * sin2w);
  const numMagSq = numRe * numRe + numIm * numIm;
  const denMagSq = denRe * denRe + denIm * denIm;
  return 10 * Math.log10(numMagSq / denMagSq);
}

// Single peaking-biquad magnitude response in dB (Web Audio "peaking" coefficients).
export function peakingResponseDb(f: number, f0: number, q: number, gainDb: number): number {
  if (gainDb === 0) return 0;
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / CURVE_SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw0 = Math.cos(w0);
  return biquadMagDb(
    f,
    1 + alpha * A, -2 * cosw0, 1 - alpha * A,
    1 + alpha / A, -2 * cosw0, 1 - alpha / A,
  );
}

// Low/high-shelf magnitude response in dB, matching Web Audio's shelf coefficients
// (S = 1, so alphaS = sin(w0)/2 * sqrt(2)). Q is unused for shelving filters.
export function shelfResponseDb(f: number, f0: number, gainDb: number, kind: "low" | "high"): number {
  if (gainDb === 0) return 0;
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / CURVE_SAMPLE_RATE;
  const cosw0 = Math.cos(w0);
  const alphaS = (Math.sin(w0) / 2) * Math.SQRT2;
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alphaS;
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (kind === "low") {
    b0 = A * ((A + 1) - (A - 1) * cosw0 + twoSqrtAAlpha);
    b1 = 2 * A * ((A - 1) - (A + 1) * cosw0);
    b2 = A * ((A + 1) - (A - 1) * cosw0 - twoSqrtAAlpha);
    a0 = (A + 1) + (A - 1) * cosw0 + twoSqrtAAlpha;
    a1 = -2 * ((A - 1) + (A + 1) * cosw0);
    a2 = (A + 1) + (A - 1) * cosw0 - twoSqrtAAlpha;
  } else {
    b0 = A * ((A + 1) + (A - 1) * cosw0 + twoSqrtAAlpha);
    b1 = -2 * A * ((A - 1) + (A + 1) * cosw0);
    b2 = A * ((A + 1) + (A - 1) * cosw0 - twoSqrtAAlpha);
    a0 = (A + 1) - (A - 1) * cosw0 + twoSqrtAAlpha;
    a1 = 2 * ((A - 1) - (A + 1) * cosw0);
    a2 = (A + 1) - (A - 1) * cosw0 - twoSqrtAAlpha;
  }
  return biquadMagDb(f, b0, b1, b2, a0, a1, a2);
}

const EPSILON = 0.001;

function gainsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > EPSILON) return false;
  }
  return true;
}

export function presetForGains(gains: number[], customPresets: EqPreset[]): string {
  for (const p of BUILTIN_PRESETS) {
    if (gainsEqual(gains, p.gains)) return p.id;
  }
  for (const p of customPresets) {
    if (gainsEqual(gains, p.gains)) return p.id;
  }
  return "custom";
}

export function applyGainsToFilters(
  filters: { gain: { value: number } }[],
  gains: number[],
): void {
  for (let i = 0; i < filters.length && i < gains.length; i++) {
    filters[i].gain.value = gains[i];
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function freshId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function validateImportedPreset(raw: unknown): EqPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name.length === 0) return null;
  if (!Array.isArray(r.gains) || r.gains.length !== NUM_BANDS) return null;
  const gains: number[] = [];
  for (const g of r.gains) {
    if (typeof g !== "number" || !Number.isFinite(g)) return null;
    gains.push(clamp(g, GAIN_MIN, GAIN_MAX));
  }
  return { id: freshId(), name: r.name, gains };
}
