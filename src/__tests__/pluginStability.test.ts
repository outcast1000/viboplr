import { describe, it, expect } from "vitest";
import {
  stabilityTier,
  isExperimental,
  partitionByStability,
  partitionGallery,
  resolveInstalledStability,
} from "../utils/pluginStability";

describe("stabilityTier", () => {
  it("treats absent and empty values as stable", () => {
    expect(stabilityTier(undefined)).toBe("stable");
    expect(stabilityTier(null)).toBe("stable");
    expect(stabilityTier("")).toBe("stable");
    expect(stabilityTier("   ")).toBe("stable");
  });

  it("recognizes explicit stable with normalization", () => {
    expect(stabilityTier("stable")).toBe("stable");
    expect(stabilityTier(" Stable ")).toBe("stable");
    expect(stabilityTier("STABLE")).toBe("stable");
  });

  it("classifies experimental", () => {
    expect(stabilityTier("experimental")).toBe("experimental");
    expect(stabilityTier(" Experimental ")).toBe("experimental");
  });

  it("fails safe on unknown values", () => {
    expect(stabilityTier("beta")).toBe("experimental");
    expect(stabilityTier("deprecated")).toBe("experimental");
    expect(stabilityTier("garbage")).toBe("experimental");
    expect(stabilityTier("stabel")).toBe("experimental");
  });

  it("tolerates non-string JSON values without throwing (fail-safe)", () => {
    expect(stabilityTier(true as unknown as string)).toBe("experimental");
    expect(stabilityTier(1 as unknown as string)).toBe("experimental");
    expect(stabilityTier({} as unknown as string)).toBe("experimental");
  });
});

describe("isExperimental", () => {
  it("mirrors stabilityTier", () => {
    expect(isExperimental(undefined)).toBe(false);
    expect(isExperimental("stable")).toBe(false);
    expect(isExperimental("experimental")).toBe(true);
    expect(isExperimental("beta")).toBe(true);
  });
});

describe("resolveInstalledStability", () => {
  it("falls back to the gallery value when the manifest lacks the field", () => {
    expect(resolveInstalledStability(undefined, "experimental", false)).toBe("experimental");
  });

  it("prefers the manifest when present", () => {
    expect(resolveInstalledStability("stable", "experimental", false)).toBe("stable");
    expect(resolveInstalledStability("experimental", undefined, false)).toBe("experimental");
  });

  it("never inherits from the gallery for dev checkouts", () => {
    expect(resolveInstalledStability(undefined, "experimental", true)).toBeUndefined();
    expect(resolveInstalledStability("experimental", undefined, true)).toBe("experimental");
  });

  it("treats a blank manifest value as absent for the fallback", () => {
    expect(resolveInstalledStability("", "experimental", false)).toBe("experimental");
    expect(resolveInstalledStability("  ", "experimental", false)).toBe("experimental");
  });

  it("returns undefined when neither source carries the field", () => {
    expect(resolveInstalledStability(undefined, undefined, false)).toBeUndefined();
  });
});

describe("partitionByStability", () => {
  const item = (id: string, stability?: string) => ({ id, stability });

  it("separates experimental entries preserving order", () => {
    const { stable, experimental } = partitionByStability([
      item("a"),
      item("b", "experimental"),
      item("c", "stable"),
      item("d", "beta"),
    ]);
    expect(stable.map((i) => i.id)).toEqual(["a", "c"]);
    expect(experimental.map((i) => i.id)).toEqual(["b", "d"]);
  });

  it("returns empty experimental pool when none are marked", () => {
    const { stable, experimental } = partitionByStability([item("a"), item("b")]);
    expect(stable).toHaveLength(2);
    expect(experimental).toHaveLength(0);
  });

  it("returns empty stable pool when all are experimental", () => {
    const { stable, experimental } = partitionByStability([
      item("a", "experimental"),
      item("b", "experimental"),
    ]);
    expect(stable).toHaveLength(0);
    expect(experimental).toHaveLength(2);
  });
});

describe("partitionGallery", () => {
  const item = (id: string, opts: { stability?: string; recommended?: boolean } = {}) => ({ id, ...opts });
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

  it("leads with recommended stable entries and lists every other one under More", () => {
    const g = partitionGallery([
      item("genius", { recommended: true }),
      item("auto-tagger"),
      item("slskd", { stability: "experimental" }),
      item("duplicate-finder"),
    ]);
    expect(g.recommended).toBe(true);
    expect(ids(g.discover)).toEqual(["genius"]);
    // The non-recommended stable entry is no longer reachable only by search.
    expect(ids(g.more.stable)).toEqual(["auto-tagger", "duplicate-finder"]);
    expect(ids(g.more.experimental)).toEqual(["slskd"]);
    expect(g.hasExperimental).toBe(true);
  });

  it("never puts an experimental entry in the curated pool, even when recommended", () => {
    const g = partitionGallery([item("x", { stability: "experimental", recommended: true }), item("y")]);
    expect(g.recommended).toBe(false);
    expect(ids(g.discover)).toEqual(["y"]);
    expect(ids(g.more.experimental)).toEqual(["x"]);
  });

  it("shows every stable entry up front when the gallery recommends none", () => {
    const g = partitionGallery([item("a"), item("b"), item("c", { stability: "experimental" })]);
    expect(g.recommended).toBe(false);
    expect(ids(g.discover)).toEqual(["a", "b"]);
    expect(g.more.stable).toHaveLength(0);
    expect(ids(g.more.experimental)).toEqual(["c"]);
  });

  it("reports no experimental entries when there are none", () => {
    const g = partitionGallery([item("a", { recommended: true }), item("b")]);
    expect(g.hasExperimental).toBe(false);
    expect(ids(g.more.stable)).toEqual(["b"]);
  });
});
