import { describe, it, expect } from "vitest";
import {
  LOOKS,
  LOOK_IDS,
  EFFECT_MODE_OPTIONS,
  getLook,
  hasOverlayLayers,
  hashString,
  resolveHeroLook,
  coerceEffectMode,
  isValidMode,
} from "../heroLooks";

describe("heroLooks data", () => {
  it("defines exactly 8 looks", () => {
    expect(LOOKS).toHaveLength(8);
    expect(LOOK_IDS).toHaveLength(8);
  });

  it("LOOK_IDS mirrors LOOKS order", () => {
    expect(LOOK_IDS).toEqual(LOOKS.map((l) => l.id));
  });

  it("exposes 11 dropdown options in order (disabled, 8 looks, random, by-artist)", () => {
    const values = EFFECT_MODE_OPTIONS.map((o) => o.value);
    expect(values).toEqual([
      "disabled",
      ...LOOK_IDS,
      "random",
      "by-artist",
    ]);
    expect(EFFECT_MODE_OPTIONS.every((o) => o.label.length > 0)).toBe(true);
  });

  it("getLook returns the matching look", () => {
    expect(getLook("worn-tape").id).toBe("worn-tape");
    expect(getLook("minimal").motion).toBe("current");
  });

  it("hasOverlayLayers is false only for minimal", () => {
    expect(hasOverlayLayers(getLook("minimal"))).toBe(false);
    expect(hasOverlayLayers(getLook("worn-tape"))).toBe(true);
    expect(hasOverlayLayers(getLook("daydream"))).toBe(true);
  });
});

describe("hashString", () => {
  it("is deterministic", () => {
    expect(hashString("Radiohead")).toBe(hashString("Radiohead"));
  });
  it("returns a non-negative integer", () => {
    const h = hashString("Björk");
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
  });
  it("handles empty string without throwing", () => {
    expect(() => hashString("")).not.toThrow();
    expect(hashString("")).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveHeroLook", () => {
  it("returns null for disabled", () => {
    expect(resolveHeroLook("disabled", "Anything", 0.5)).toBeNull();
  });

  it("returns the named look for a look id", () => {
    expect(resolveHeroLook("late-night", "X", 0.5)).toBe("late-night");
    expect(resolveHeroLook("minimal", "X", 0.5)).toBe("minimal");
  });

  it("random maps the roll across the looks and never returns disabled", () => {
    expect(resolveHeroLook("random", "X", 0)).toBe(LOOK_IDS[0]);
    expect(resolveHeroLook("random", "X", 0.999999)).toBe(LOOK_IDS[LOOK_IDS.length - 1]);
    for (let i = 0; i < 50; i++) {
      const id = resolveHeroLook("random", "X", i / 50);
      expect(LOOK_IDS).toContain(id);
    }
  });

  it("by-artist is deterministic for a name and always a valid look", () => {
    const a = resolveHeroLook("by-artist", "Radiohead", 0.1);
    const b = resolveHeroLook("by-artist", "Radiohead", 0.9);
    expect(a).toBe(b);
    expect(LOOK_IDS).toContain(a);
  });

  it("by-artist varies across different names (basic spread)", () => {
    const names = ["Radiohead", "Bjork", "Miles Davis", "Aphex Twin", "Nina Simone", "Boards of Canada"];
    const ids = new Set(names.map((n) => resolveHeroLook("by-artist", n, 0)));
    expect(ids.size).toBeGreaterThan(1);
  });

  it("by-artist with empty name resolves to a valid look (no throw)", () => {
    const id = resolveHeroLook("by-artist", "", 0);
    expect(LOOK_IDS).toContain(id);
  });
});

describe("coerceEffectMode (migration + validation)", () => {
  it("uses a valid stored mode string as-is", () => {
    expect(coerceEffectMode("silent-film", undefined)).toBe("silent-film");
    expect(coerceEffectMode("disabled", undefined)).toBe("disabled");
    expect(coerceEffectMode("random", undefined)).toBe("random");
  });
  it("migrates legacy boolean true -> worn-tape, false -> disabled", () => {
    expect(coerceEffectMode(undefined, true)).toBe("worn-tape");
    expect(coerceEffectMode(undefined, false)).toBe("disabled");
  });
  it("prefers a valid stored mode over the legacy boolean", () => {
    expect(coerceEffectMode("daydream", false)).toBe("daydream");
  });
  it("falls back to default worn-tape when nothing valid is present", () => {
    expect(coerceEffectMode(undefined, undefined)).toBe("worn-tape");
    expect(coerceEffectMode("nonsense", undefined)).toBe("worn-tape");
    expect(coerceEffectMode(42, undefined)).toBe("worn-tape");
  });
});

describe("isValidMode", () => {
  it("accepts every dropdown option value", () => {
    for (const o of EFFECT_MODE_OPTIONS) {
      expect(isValidMode(o.value)).toBe(true);
    }
  });
  it("rejects unknown strings and non-strings", () => {
    expect(isValidMode("nonsense")).toBe(false);
    expect(isValidMode(42)).toBe(false);
    expect(isValidMode(undefined)).toBe(false);
    expect(isValidMode(null)).toBe(false);
  });
});
