// Pure geometry + sampling math for the EQ response curve, shared by the
// interactive popover editor (EqCurve.tsx) and the read-only bar preview
// (EqBarControl.tsx). Kept dependency-free and unit-tested like utils/knob.ts.
//
// The DSP magnitude math itself lives in eqPresets.ts (peakingResponseDb /
// shelfResponseDb) — this module only maps frequency↔x and dB↔y for a given
// canvas layout, builds the SVG path, and inverts y→dB for drag/keyboard input.

import {
  BANDS,
  BAND_Q,
  SHELF_BASS_FREQ,
  SHELF_TREBLE_FREQ,
  peakingResponseDb,
  shelfResponseDb,
  type EqMode,
} from "../eqPresets";

export const FREQ_MIN = 20;
export const FREQ_MAX = 20000;
export const Y_MAX_DB = 15;

// Canvas geometry — width/height vary (bar slot vs. popover), padding fixed.
export interface CurveLayout {
  width: number;
  height: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
}

const LOG_MIN = Math.log10(FREQ_MIN);
const LOG_MAX = Math.log10(FREQ_MAX);

/** Map a frequency (Hz) to an x coordinate on a log scale. */
export function freqToX(freq: number, layout: CurveLayout): number {
  const innerW = layout.width - layout.padL - layout.padR;
  const t = (Math.log10(freq) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return layout.padL + t * innerW;
}

/** Map a gain (dB) to a y coordinate. +Y_MAX_DB at top, −Y_MAX_DB at bottom. */
export function dbToY(db: number, layout: CurveLayout): number {
  const innerH = layout.height - layout.padT - layout.padB;
  const t = (Y_MAX_DB - db) / (2 * Y_MAX_DB);
  return layout.padT + t * innerH;
}

/** Inverse of dbToY — turn a y coordinate (canvas px) back into a gain (dB). */
export function yToDb(y: number, layout: CurveLayout): number {
  const innerH = layout.height - layout.padT - layout.padB;
  const t = (y - layout.padT) / innerH;
  return Y_MAX_DB - t * 2 * Y_MAX_DB;
}

export interface CurveInput {
  enabled: boolean;
  mode: EqMode;
  gains: number[];
  preGainDb: number;
  bassDb: number;
  trebleDb: number;
}

/** Total EQ magnitude response (dB) at frequency f for the current settings. */
export function responseDbAt(freq: number, input: CurveInput): number {
  if (!input.enabled) return 0;
  if (input.mode === "simple") {
    return (
      shelfResponseDb(freq, SHELF_BASS_FREQ, input.bassDb, "low") +
      shelfResponseDb(freq, SHELF_TREBLE_FREQ, input.trebleDb, "high")
    );
  }
  let total = input.preGainDb;
  for (let b = 0; b < BANDS.length; b++) {
    total += peakingResponseDb(freq, BANDS[b], BAND_Q, input.gains[b] ?? 0);
  }
  return total;
}

function clampDb(db: number): number {
  return Math.max(-Y_MAX_DB, Math.min(Y_MAX_DB, db));
}

/**
 * Build the SVG path strings for the response curve.
 * `samples` controls resolution (higher = smoother). Returns the stroked
 * `line` and the filled `area` (closed down to the 0 dB baseline).
 */
export function buildCurvePath(
  input: CurveInput,
  layout: CurveLayout,
  samples = 160,
): { line: string; area: string } {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const f = Math.pow(10, LOG_MIN + t * (LOG_MAX - LOG_MIN));
    const db = clampDb(responseDbAt(f, input));
    pts.push([freqToX(f, layout), dbToY(db, layout)]);
  }
  const line = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(" ");
  const yZero = dbToY(0, layout);
  const area =
    `M${pts[0][0].toFixed(1)} ${yZero.toFixed(1)} ` +
    pts.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ") +
    ` L${pts[pts.length - 1][0].toFixed(1)} ${yZero.toFixed(1)} Z`;
  return { line, area };
}

// A draggable handle on the curve. `key` identifies what it edits:
// "bass" / "treble" (simple shelves) or "band:<index>" (advanced peaking bands).
export interface CurveHandle {
  key: string;
  freq: number;
  label: string; // band frequency label or shelf letter
  ariaLabel: string;
}

/** The set of handles for a given mode. */
export function handlesForMode(mode: EqMode): CurveHandle[] {
  if (mode === "simple") {
    return [
      { key: "bass", freq: SHELF_BASS_FREQ, label: "B", ariaLabel: "Bass shelf" },
      { key: "treble", freq: SHELF_TREBLE_FREQ, label: "T", ariaLabel: "Treble shelf" },
    ];
  }
  return BANDS.map((f, i) => ({
    key: `band:${i}`,
    freq: f,
    label: formatHz(f),
    ariaLabel: `${formatHz(f)} Hz`,
  }));
}

/** Index into the handle list whose freq is horizontally closest to x (canvas px). */
export function nearestHandleIndex(
  x: number,
  handles: CurveHandle[],
  layout: CurveLayout,
): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < handles.length; i++) {
    const d = Math.abs(freqToX(handles[i].freq, layout) - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export function formatHz(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}

export function formatDb(db: number): string {
  return db >= 0 ? `+${db.toFixed(1)}` : db.toFixed(1);
}
