import { describe, it, expect } from "vitest";
import {
  BANDS,
  BUILTIN_PRESETS,
  SHELF_BASS_FREQ,
  SHELF_TREBLE_FREQ,
  presetForGains,
  validateImportedPreset,
  peakingResponseDb,
  shelfResponseDb,
} from "../eqPresets";

describe("eqPresets - constants", () => {
  it("BANDS has 10 frequencies in ascending order", () => {
    expect(BANDS).toHaveLength(10);
    expect(BANDS).toEqual([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  });

  it("every built-in preset has 10 gains in -15..+15", () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.gains).toHaveLength(10);
      for (const g of p.gains) {
        expect(g).toBeGreaterThanOrEqual(-15);
        expect(g).toBeLessThanOrEqual(15);
      }
    }
  });

  it("includes the 8 documented preset ids", () => {
    const ids = BUILTIN_PRESETS.map(p => p.id).sort();
    expect(ids).toEqual(
      ["bass", "classical", "electronic", "flat", "jazz", "rock", "treble", "vocal"]
    );
  });

  it("flat preset is all zeros", () => {
    const flat = BUILTIN_PRESETS.find(p => p.id === "flat");
    expect(flat).toBeDefined();
    expect(flat!.gains).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("presetForGains", () => {
  it("returns 'flat' for all-zero gains", () => {
    expect(presetForGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [])).toBe("flat");
  });

  it("returns matching built-in id when gains match exactly", () => {
    const rock = BUILTIN_PRESETS.find(p => p.id === "rock")!;
    expect(presetForGains(rock.gains, [])).toBe("rock");
  });

  it("returns matching custom preset id when gains match a custom", () => {
    const custom = [{ id: "mine", name: "Mine", gains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }];
    expect(presetForGains([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], custom)).toBe("mine");
  });

  it("returns 'custom' when gains do not match any preset", () => {
    expect(presetForGains([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [])).toBe("custom");
  });

  it("treats values as equal within 0.001 dB tolerance", () => {
    const rock = BUILTIN_PRESETS.find(p => p.id === "rock")!;
    const fuzzed = rock.gains.map(g => g + 0.0005);
    expect(presetForGains(fuzzed, [])).toBe("rock");
  });
});

describe("validateImportedPreset", () => {
  it("accepts a valid preset and assigns a fresh id", () => {
    const result = validateImportedPreset({ name: "Imported", gains: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Imported");
    expect(result!.gains).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result!.id).toMatch(/^[a-z0-9-]+$/);
  });

  it("clamps out-of-range gains to -15..+15", () => {
    const result = validateImportedPreset({ name: "Loud", gains: [99, -99, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(result!.gains[0]).toBe(15);
    expect(result!.gains[1]).toBe(-15);
  });

  it("rejects wrong-length gains array", () => {
    expect(validateImportedPreset({ name: "Short", gains: [0, 0, 0] })).toBeNull();
  });

  it("rejects missing name", () => {
    expect(validateImportedPreset({ gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] })).toBeNull();
  });

  it("rejects non-numeric gains", () => {
    expect(validateImportedPreset({ name: "Bad", gains: ["x", 0, 0, 0, 0, 0, 0, 0, 0, 0] })).toBeNull();
  });

  it("rejects null/undefined input", () => {
    expect(validateImportedPreset(null)).toBeNull();
    expect(validateImportedPreset(undefined)).toBeNull();
  });
});

describe("peakingResponseDb", () => {
  it("is exactly 0 dB at any frequency when gain is 0", () => {
    expect(peakingResponseDb(1000, 1000, 1.41, 0)).toBe(0);
    expect(peakingResponseDb(50, 1000, 1.41, 0)).toBe(0);
  });

  it("hits ~full gain at the center frequency", () => {
    // At f == f0 a peaking filter reaches its full gain.
    expect(peakingResponseDb(1000, 1000, 1.41, 6)).toBeCloseTo(6, 1);
    expect(peakingResponseDb(1000, 1000, 1.41, -6)).toBeCloseTo(-6, 1);
  });

  it("returns toward 0 dB far from the center (bell shape)", () => {
    // Two decades below center the boost has essentially decayed away.
    expect(Math.abs(peakingResponseDb(10, 1000, 1.41, 12))).toBeLessThan(0.5);
  });
});

describe("shelfResponseDb", () => {
  it("is exactly 0 dB at any frequency when gain is 0", () => {
    expect(shelfResponseDb(50, SHELF_BASS_FREQ, 0, "low")).toBe(0);
    expect(shelfResponseDb(15000, SHELF_TREBLE_FREQ, 0, "high")).toBe(0);
  });

  it("low-shelf holds full gain well below the corner and stays flat to DC", () => {
    // A shelf (unlike a bell) keeps its gain out toward the spectral extreme.
    const deep = shelfResponseDb(20, SHELF_BASS_FREQ, 10, "low");
    const deeper = shelfResponseDb(25, SHELF_BASS_FREQ, 10, "low");
    expect(deep).toBeGreaterThan(9.5);
    expect(deep).toBeLessThan(10.5);
    // Still essentially full gain even closer to DC (does not roll off).
    expect(Math.abs(deeper - deep)).toBeLessThan(0.5);
  });

  it("low-shelf leaves high frequencies unaffected", () => {
    expect(Math.abs(shelfResponseDb(15000, SHELF_BASS_FREQ, 10, "low"))).toBeLessThan(0.5);
  });

  it("high-shelf holds full gain well above the corner", () => {
    const high = shelfResponseDb(18000, SHELF_TREBLE_FREQ, 8, "high");
    expect(high).toBeGreaterThan(7);
    expect(high).toBeLessThan(8.5);
  });

  it("high-shelf leaves low frequencies unaffected", () => {
    expect(Math.abs(shelfResponseDb(100, SHELF_TREBLE_FREQ, 8, "high"))).toBeLessThan(0.5);
  });

  it("is approximately half the gain (in dB) at the corner frequency", () => {
    // Web Audio shelf .frequency is the midpoint where response ~= G/2 dB.
    const atCorner = shelfResponseDb(SHELF_BASS_FREQ, SHELF_BASS_FREQ, 12, "low");
    expect(atCorner).toBeGreaterThan(4);
    expect(atCorner).toBeLessThan(8);
  });

  it("cuts (negative gain) mirror boosts", () => {
    const boost = shelfResponseDb(25, SHELF_BASS_FREQ, 10, "low");
    const cut = shelfResponseDb(25, SHELF_BASS_FREQ, -10, "low");
    expect(cut).toBeCloseTo(-boost, 1);
  });
});
