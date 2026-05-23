import { describe, it, expect } from "vitest";
import {
  BANDS,
  BUILTIN_PRESETS,
  presetForGains,
  validateImportedPreset,
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
