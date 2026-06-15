import { describe, it, expect } from "vitest";
import {
  freqToX,
  dbToY,
  yToDb,
  buildCurvePath,
  responseDbAt,
  handlesForMode,
  nearestHandleIndex,
  formatHz,
  formatDb,
  FREQ_MIN,
  FREQ_MAX,
  Y_MAX_DB,
  type CurveLayout,
  type CurveInput,
} from "../utils/eqCurve";
import { SHELF_BASS_FREQ, SHELF_TREBLE_FREQ } from "../eqPresets";

const layout: CurveLayout = { width: 560, height: 190, padL: 34, padR: 12, padT: 10, padB: 22 };

const flatSimple: CurveInput = { enabled: true, mode: "simple", gains: new Array(10).fill(0), preGainDb: 0, bassDb: 0, trebleDb: 0 };

describe("eqCurve geometry", () => {
  it("freqToX maps FREQ_MIN to left edge and FREQ_MAX to right edge", () => {
    expect(freqToX(FREQ_MIN, layout)).toBeCloseTo(layout.padL, 5);
    expect(freqToX(FREQ_MAX, layout)).toBeCloseTo(layout.width - layout.padR, 5);
  });

  it("freqToX is monotonically increasing across the band", () => {
    let prev = -Infinity;
    for (const f of [20, 50, 100, 500, 1000, 5000, 20000]) {
      const x = freqToX(f, layout);
      expect(x).toBeGreaterThan(prev);
      prev = x;
    }
  });

  it("dbToY maps +Y_MAX to top and -Y_MAX to bottom", () => {
    expect(dbToY(Y_MAX_DB, layout)).toBeCloseTo(layout.padT, 5);
    expect(dbToY(-Y_MAX_DB, layout)).toBeCloseTo(layout.height - layout.padB, 5);
  });

  it("dbToY(0) is the vertical midpoint of the inner area", () => {
    const innerMid = layout.padT + (layout.height - layout.padT - layout.padB) / 2;
    expect(dbToY(0, layout)).toBeCloseTo(innerMid, 5);
  });

  it("yToDb is the exact inverse of dbToY (round-trip)", () => {
    for (const db of [-15, -7.5, -3, 0, 4.5, 9, 15]) {
      expect(yToDb(dbToY(db, layout), layout)).toBeCloseTo(db, 6);
    }
  });

  it("round-trips across a different layout (bar slot size)", () => {
    const bar: CurveLayout = { width: 118, height: 34, padL: 3, padR: 3, padT: 4, padB: 4 };
    for (const db of [-12, -1, 0, 6, 13]) {
      expect(yToDb(dbToY(db, bar), bar)).toBeCloseTo(db, 6);
    }
  });
});

describe("responseDbAt", () => {
  it("returns 0 everywhere when disabled", () => {
    const input: CurveInput = { ...flatSimple, enabled: false, bassDb: 10, trebleDb: 10 };
    for (const f of [20, 100, 1000, 10000, 20000]) {
      expect(responseDbAt(f, input)).toBe(0);
    }
  });

  it("flat settings produce ~0 dB across the band", () => {
    for (const f of [20, 100, 1000, 10000, 20000]) {
      expect(Math.abs(responseDbAt(f, flatSimple))).toBeLessThan(0.01);
    }
  });

  it("simple bass boost lifts low frequencies, leaves highs ~flat", () => {
    const input: CurveInput = { ...flatSimple, bassDb: 10, trebleDb: 0 };
    expect(responseDbAt(30, input)).toBeGreaterThan(5);
    expect(Math.abs(responseDbAt(18000, input))).toBeLessThan(1);
  });

  it("simple treble boost lifts high frequencies", () => {
    const input: CurveInput = { ...flatSimple, bassDb: 0, trebleDb: 10 };
    expect(responseDbAt(18000, input)).toBeGreaterThan(5);
    expect(Math.abs(responseDbAt(30, input))).toBeLessThan(1);
  });

  it("advanced mode includes pre-gain as a flat offset", () => {
    const input: CurveInput = { enabled: true, mode: "advanced", gains: new Array(10).fill(0), preGainDb: 3, bassDb: 0, trebleDb: 0 };
    expect(responseDbAt(1000, input)).toBeCloseTo(3, 5);
  });
});

describe("buildCurvePath", () => {
  it("produces a line path starting with M and an area path closing with Z", () => {
    const { line, area } = buildCurvePath(flatSimple, layout, 32);
    expect(line.startsWith("M")).toBe(true);
    expect(area.trim().endsWith("Z")).toBe(true);
  });

  it("samples+1 points in the line path", () => {
    const samples = 24;
    const { line } = buildCurvePath(flatSimple, layout, samples);
    const commands = line.match(/[ML]/g) ?? [];
    expect(commands.length).toBe(samples + 1);
  });
});

describe("handlesForMode", () => {
  it("simple mode has bass + treble shelf handles at the right freqs", () => {
    const hs = handlesForMode("simple");
    expect(hs.map((h) => h.key)).toEqual(["bass", "treble"]);
    expect(hs[0].freq).toBe(SHELF_BASS_FREQ);
    expect(hs[1].freq).toBe(SHELF_TREBLE_FREQ);
  });

  it("advanced mode has 10 band handles keyed band:0..9", () => {
    const hs = handlesForMode("advanced");
    expect(hs.length).toBe(10);
    expect(hs[0].key).toBe("band:0");
    expect(hs[9].key).toBe("band:9");
  });
});

describe("nearestHandleIndex", () => {
  it("picks the handle whose freq column is closest to x", () => {
    const hs = handlesForMode("advanced");
    const xOf = (i: number) => freqToX(hs[i].freq, layout);
    expect(nearestHandleIndex(xOf(0), hs, layout)).toBe(0);
    expect(nearestHandleIndex(xOf(5), hs, layout)).toBe(5);
    expect(nearestHandleIndex(xOf(9) + 100, hs, layout)).toBe(9);
  });
});

describe("formatters", () => {
  it("formatHz uses k suffix at/above 1000", () => {
    expect(formatHz(125)).toBe("125");
    expect(formatHz(1000)).toBe("1k");
    expect(formatHz(16000)).toBe("16k");
  });

  it("formatDb shows a + sign for non-negative values", () => {
    expect(formatDb(0)).toBe("+0.0");
    expect(formatDb(4)).toBe("+4.0");
    expect(formatDb(-3.5)).toBe("-3.5");
  });
});
