import { describe, it, expect } from "vitest";
import type { GalleryPluginEntry } from "../types/plugin";
import {
  computeInitialSelection,
  computeInstallEntries,
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
    const sel = computeInitialSelection(entries, new Set());
    expect(sel.has("a")).toBe(true);
    expect(sel.has("b")).toBe(false);
    expect(sel.has("c")).toBe(false);
  });

  it("does not check recommended entries that are already installed", () => {
    const entries = [entry({ id: "a", recommended: true })];
    const sel = computeInitialSelection(entries, new Set(["a"]));
    expect(sel.has("a")).toBe(false);
  });

  it("treats absent recommended as false", () => {
    const entries = [entry({ id: "a" })];
    const sel = computeInitialSelection(entries, new Set());
    expect(sel.size).toBe(0);
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
