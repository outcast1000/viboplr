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
  HERO_EFFECT_DEFAULT_MODE,
} from "../heroLooks";

const REMOVED = ["worn-tape", "signal-lost", "channel-surf", "neon-grid"];
const ADDED = ["aurora-drift", "light-leak", "prism-bloom"];

describe("heroLooks data", () => {
  it("defines exactly 8 looks", () => {
    expect(LOOKS).toHaveLength(8);
    expect(LOOK_IDS).toHaveLength(8);
  });

  it("no longer contains the removed looks", () => {
    for (const id of REMOVED) expect(LOOK_IDS).not.toContain(id);
  });

  it("contains the new looks", () => {
    for (const id of ADDED) expect(LOOK_IDS).toContain(id);
  });

  it("the new looks have the expected motion and layers", () => {
    expect(getLook("aurora-drift").motion).toBe("sway");
    expect(getLook("aurora-drift").layers.auroraA).toBe(true);
    expect(getLook("aurora-drift").layers.auroraB).toBe(true);
    expect(getLook("aurora-drift").layers.vignette).toBe(true);

    expect(getLook("light-leak").motion).toBe("breathe");
    expect(getLook("light-leak").layers.leakWarm).toBe(true);
    expect(getLook("light-leak").layers.leakCorner).toBe(true);

    expect(getLook("prism-bloom").motion).toBe("focal");
    expect(getLook("prism-bloom").layers.bloom).toBe(true);
    expect(getLook("prism-bloom").layers.fringe).toBe(true);
  });

  it("LOOK_IDS mirrors LOOKS order", () => {
    expect(LOOK_IDS).toEqual(LOOKS.map((l) => l.id));
  });

  it("exposes 11 dropdown options in order (disabled, 8 looks, random, by-artist)", () => {
    const values = EFFECT_MODE_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["disabled", ...LOOK_IDS, "random", "by-artist"]);
    expect(EFFECT_MODE_OPTIONS.every((o) => o.label.length > 0)).toBe(true);
  });

  it("getLook returns the matching look", () => {
    expect(getLook("late-night").id).toBe("late-night");
    expect(getLook("minimal").motion).toBe("current");
  });

  it("hasOverlayLayers is false only for minimal", () => {
    expect(hasOverlayLayers(getLook("minimal"))).toBe(false);
    expect(hasOverlayLayers(getLook("aurora-drift"))).toBe(true);
    expect(hasOverlayLayers(getLook("daydream"))).toBe(true);
  });

  it("minimal stays last in the registry", () => {
    expect(LOOK_IDS[LOOK_IDS.length - 1]).toBe("minimal");
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
    expect(resolveHeroLook("aurora-drift", "X", 0.5)).toBe("aurora-drift");
  });

  it("random maps the roll across the looks and never returns disabled", () => {
    expect(resolveHeroLook("random", "X", 0)).toBe(LOOK_IDS[0]);
    expect(resolveHeroLook("random", "X", 0.999999)).toBe(LOOK_IDS[LOOK_IDS.length - 1]);
    for (const roll of [0, 0.5, 0.999, 1, -1]) {
      const id = resolveHeroLook("random", "X", roll);
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
    expect(coerceEffectMode("aurora-drift", undefined)).toBe("aurora-drift");
  });
  it("migrates legacy boolean true -> by-artist, false -> disabled", () => {
    expect(coerceEffectMode(undefined, true)).toBe("by-artist");
    expect(coerceEffectMode(undefined, false)).toBe("disabled");
  });
  it("prefers a valid stored mode over the legacy boolean", () => {
    expect(coerceEffectMode("daydream", false)).toBe("daydream");
  });
  it("treats a removed look id as invalid and falls back to default", () => {
    expect(coerceEffectMode("worn-tape", undefined)).toBe("by-artist");
    expect(coerceEffectMode("signal-lost", undefined)).toBe("by-artist");
    expect(coerceEffectMode("channel-surf", undefined)).toBe("by-artist");
    expect(coerceEffectMode("neon-grid", undefined)).toBe("by-artist");
  });
  it("falls back to default by-artist when nothing valid is present", () => {
    expect(coerceEffectMode(undefined, undefined)).toBe("by-artist");
    expect(coerceEffectMode("nonsense", undefined)).toBe("by-artist");
    expect(coerceEffectMode(42, undefined)).toBe("by-artist");
  });
  it("HERO_EFFECT_DEFAULT_MODE is by-artist", () => {
    expect(HERO_EFFECT_DEFAULT_MODE).toBe("by-artist");
  });
});

describe("isValidMode", () => {
  it("accepts every dropdown option value", () => {
    for (const o of EFFECT_MODE_OPTIONS) {
      expect(isValidMode(o.value)).toBe(true);
    }
  });
  it("rejects removed look ids", () => {
    expect(isValidMode("worn-tape")).toBe(false);
    expect(isValidMode("signal-lost")).toBe(false);
    expect(isValidMode("channel-surf")).toBe(false);
    expect(isValidMode("neon-grid")).toBe(false);
  });
  it("rejects unknown strings and non-strings", () => {
    expect(isValidMode("nonsense")).toBe(false);
    expect(isValidMode(42)).toBe(false);
    expect(isValidMode(undefined)).toBe(false);
    expect(isValidMode(null)).toBe(false);
  });
});
