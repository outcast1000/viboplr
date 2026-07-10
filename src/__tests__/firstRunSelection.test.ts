import { describe, it, expect } from "vitest";
import type { GalleryPluginEntry } from "../types/plugin";
import {
  computeInitialSelection,
  computeInstallEntries,
  filterOnboardingEntries,
} from "../components/firstRunSelection";

function entry(over: Partial<GalleryPluginEntry> & { id: string }): GalleryPluginEntry {
  return {
    name: over.id,
    author: "tester",
    description: "desc",
    version: "1.0.0",
    updateUrl: `https://example.com/${over.id}/update.json`,
    ...over,
  };
}

describe("computeInitialSelection", () => {
  it("checks recommended entries that are not installed", () => {
    const entries = [
      entry({ id: "a", recommended: true }),
      entry({ id: "b", recommended: false }),
      entry({ id: "c" }), // recommended absent => false
    ];
    const sel = computeInitialSelection(entries, new Set(), "normal");
    expect(sel.has("a")).toBe(true);
    expect(sel.has("b")).toBe(false);
    expect(sel.has("c")).toBe(false);
  });

  it("does not check recommended entries that are already installed", () => {
    const entries = [entry({ id: "a", recommended: true })];
    const sel = computeInitialSelection(entries, new Set(["a"]), "normal");
    expect(sel.has("a")).toBe(false);
  });

  it("treats absent recommended as false", () => {
    const entries = [entry({ id: "a" })];
    const sel = computeInitialSelection(entries, new Set(), "normal");
    expect(sel.size).toBe(0);
  });

  it("pre-checks entries whose profiles include the chosen profile", () => {
    const entries = [
      entry({ id: "spotify-browse", profiles: ["streaming"] }),
      entry({ id: "youtube", profiles: ["streaming", "video"] }),
      entry({ id: "duplicate-finder", profiles: ["normal"] }),
    ];
    const sel = computeInitialSelection(entries, new Set(), "streaming");
    expect(sel).toEqual(new Set(["spotify-browse", "youtube"]));
  });

  it("treats profiles-less recommended entries as recommended for every profile", () => {
    const entries = [entry({ id: "lyrics", recommended: true }), entry({ id: "plain" })];
    for (const profile of ["normal", "video", "streaming", "server"] as const) {
      const sel = computeInitialSelection(entries, new Set(), profile);
      expect(sel.has("lyrics")).toBe(true);
      expect(sel.has("plain")).toBe(false);
    }
  });

  it("lets profiles win over recommended when both are present", () => {
    const entries = [entry({ id: "x", recommended: true, profiles: ["video"] })];
    expect(computeInitialSelection(entries, new Set(), "normal").has("x")).toBe(false);
    expect(computeInitialSelection(entries, new Set(), "video").has("x")).toBe(true);
  });

  it("never pre-checks installed entries, even on profile match", () => {
    const entries = [entry({ id: "youtube", profiles: ["video"] })];
    expect(computeInitialSelection(entries, new Set(["youtube"]), "video").size).toBe(0);
  });

  it("treats an explicit empty profiles array as pre-checked nowhere (no recommended fallback)", () => {
    const entries = [entry({ id: "x", recommended: true, profiles: [] })];
    for (const profile of ["normal", "video", "streaming", "server"] as const) {
      expect(computeInitialSelection(entries, new Set(), profile).has("x")).toBe(false);
    }
  });
});

describe("computeInstallEntries", () => {
  const entries = [
    entry({ id: "a", recommended: true }),
    entry({ id: "b" }),
    entry({ id: "nourl", updateUrl: undefined }),
  ];

  it("returns only checked, not-installed entries that have an updateUrl", () => {
    const result = computeInstallEntries(
      entries,
      new Set(["a", "b", "nourl"]),
      new Set(["b"]), // b already installed
    );
    expect(result.map((e) => e.id)).toEqual(["a"]);
  });

  it("returns empty when nothing is checked", () => {
    const result = computeInstallEntries(entries, new Set(), new Set());
    expect(result).toEqual([]);
  });
});

describe("filterOnboardingEntries", () => {
  it("excludes experimental entries even when recommended or profiled", () => {
    const entries = [
      entry({ id: "a", recommended: true }),
      entry({ id: "b", recommended: true, stability: "experimental" }),
      entry({ id: "c", profiles: ["normal"], stability: "experimental" }),
    ];
    const visible = filterOnboardingEntries(entries);
    expect(visible.map((e) => e.id)).toEqual(["a"]);
  });

  it("excludes unknown stability values (fail-safe)", () => {
    const entries = [entry({ id: "a", stability: "beta" }), entry({ id: "b", stability: "stable" })];
    expect(filterOnboardingEntries(entries).map((e) => e.id)).toEqual(["b"]);
  });

  it("keeps stable and unmarked entries; empty input stays empty", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b", stability: "stable" })];
    expect(filterOnboardingEntries(entries)).toHaveLength(2);
    expect(filterOnboardingEntries([])).toEqual([]);
  });

  it("composes with computeInitialSelection: filtered experimental never pre-checks", () => {
    const entries = [
      entry({ id: "a", recommended: true }),
      entry({ id: "b", recommended: true, stability: "experimental" }),
    ];
    const sel = computeInitialSelection(filterOnboardingEntries(entries), new Set(), "normal");
    expect(sel.has("a")).toBe(true);
    expect(sel.has("b")).toBe(false);
  });
});
