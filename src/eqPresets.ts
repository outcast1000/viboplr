export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const BAND_Q = 1.41;
export const GAIN_MIN = -15;
export const GAIN_MAX = 15;
export const NUM_BANDS = 10;

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
