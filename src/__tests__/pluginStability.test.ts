import { describe, it, expect } from "vitest";
import {
  stabilityTier,
  isExperimental,
  partitionByStability,
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
