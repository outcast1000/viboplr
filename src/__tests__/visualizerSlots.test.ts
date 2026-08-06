import { describe, it, expect, vi } from "vitest";
import type { PluginVisualizerRegistration } from "../types/pluginVisualizer";
import {
  visualizerKey,
  parseVisualizerKey,
  candidatesFor,
  resolveSlot,
  buildVisualizerMenuSpecs,
} from "../utils/visualizerSlots";

const deck: PluginVisualizerRegistration = {
  pluginId: "vinyl-deck",
  id: "deck",
  name: "Vinyl Deck",
  placements: ["nowplaying", "sidebar"],
};
const meter: PluginVisualizerRegistration = {
  pluginId: "meters",
  id: "vu",
  name: "VU Meters",
  placements: ["nowplaying", "miniplayer"],
};
const ALL = [deck, meter];

describe("visualizerKey / parseVisualizerKey", () => {
  it("round-trips", () => {
    expect(visualizerKey(deck)).toBe("vinyl-deck:deck");
    expect(parseVisualizerKey("vinyl-deck:deck")).toEqual({
      pluginId: "vinyl-deck",
      visualizerId: "deck",
    });
  });

  it("splits on the first separator only, so a visualizer id may contain one", () => {
    expect(parseVisualizerKey("plug:a:b")).toEqual({ pluginId: "plug", visualizerId: "a:b" });
  });

  it("rejects malformed keys rather than inventing halves", () => {
    for (const bad of ["", ":", "noseparator", ":leading", "trailing:", null, undefined]) {
      expect(parseVisualizerKey(bad as string)).toBeNull();
    }
  });
});

describe("candidatesFor", () => {
  it("filters by declared placement", () => {
    expect(candidatesFor(ALL, "nowplaying")).toEqual([deck, meter]);
    expect(candidatesFor(ALL, "sidebar")).toEqual([deck]);
    expect(candidatesFor(ALL, "miniplayer")).toEqual([meter]);
    expect(candidatesFor(ALL, "fullscreen")).toEqual([]);
  });

  it("survives a registration with no placements", () => {
    // Third-party manifests are untrusted input; a missing array must not throw.
    const broken = { pluginId: "x", id: "y", name: "Y" } as PluginVisualizerRegistration;
    expect(() => candidatesFor([broken], "nowplaying")).not.toThrow();
    expect(candidatesFor([broken], "nowplaying")).toEqual([]);
  });
});

describe("resolveSlot", () => {
  it("returns the selection when it's available for that slot", () => {
    expect(resolveSlot(ALL, { nowplaying: "vinyl-deck:deck" }, "nowplaying")).toBe(
      "vinyl-deck:deck",
    );
  });

  it("returns null for an empty or unset slot", () => {
    expect(resolveSlot(ALL, {}, "nowplaying")).toBeNull();
    expect(resolveSlot(ALL, { nowplaying: null }, "nowplaying")).toBeNull();
  });

  it("returns null when the chosen plugin is gone, without discarding the choice", () => {
    // Plugin disabled/uninstalled: the slot renders empty rather than erroring,
    // and the stored key is untouched so it comes back on re-enable.
    const selection = { nowplaying: "vinyl-deck:deck" };
    expect(resolveSlot([meter], selection, "nowplaying")).toBeNull();
    expect(selection.nowplaying).toBe("vinyl-deck:deck");
  });

  it("returns null when the visualizer no longer declares that placement", () => {
    const narrowed = { ...deck, placements: ["sidebar" as const] };
    expect(resolveSlot([narrowed], { nowplaying: "vinyl-deck:deck" }, "nowplaying")).toBeNull();
    expect(resolveSlot([narrowed], { sidebar: "vinyl-deck:deck" }, "sidebar")).toBe(
      "vinyl-deck:deck",
    );
  });

  it("keeps slots independent", () => {
    const selection = { nowplaying: "meters:vu", sidebar: "vinyl-deck:deck" };
    expect(resolveSlot(ALL, selection, "nowplaying")).toBe("meters:vu");
    expect(resolveSlot(ALL, selection, "sidebar")).toBe("vinyl-deck:deck");
    expect(resolveSlot(ALL, selection, "miniplayer")).toBeNull();
  });
});

describe("buildVisualizerMenuSpecs", () => {
  it("offers None plus every candidate, with the current one checked", () => {
    const onPick = vi.fn();
    const specs = buildVisualizerMenuSpecs(ALL, { nowplaying: "meters:vu" }, "nowplaying", onPick);
    expect(specs.map((s) => ("text" in s ? s.text : "---"))).toEqual([
      "None",
      "---",
      "Vinyl Deck",
      "VU Meters",
    ]);
    const checked = specs.filter((s) => s.kind === "check" && s.checked);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({ text: "VU Meters" });
  });

  it("checks None when nothing is selected", () => {
    const specs = buildVisualizerMenuSpecs(ALL, {}, "nowplaying", vi.fn());
    expect(specs[0]).toMatchObject({ text: "None", checked: true });
  });

  it("checks None when the selection is stale, so the menu never lies", () => {
    const specs = buildVisualizerMenuSpecs(
      [meter],
      { nowplaying: "vinyl-deck:deck" },
      "nowplaying",
      vi.fn(),
    );
    expect(specs[0]).toMatchObject({ text: "None", checked: true });
    expect(specs.filter((s) => s.kind === "check" && s.checked)).toHaveLength(1);
  });

  it("fires the right key, and null for None", () => {
    const onPick = vi.fn();
    const specs = buildVisualizerMenuSpecs(ALL, {}, "nowplaying", onPick);
    (specs.find((s) => "text" in s && s.text === "Vinyl Deck") as { action: () => void }).action();
    expect(onPick).toHaveBeenCalledWith("vinyl-deck:deck");
    (specs[0] as { action: () => void }).action();
    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  it("shows a disabled explanation rather than a bare None when nothing can fill the slot", () => {
    const specs = buildVisualizerMenuSpecs(ALL, {}, "fullscreen", vi.fn());
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ kind: "item", enabled: false });
  });
});
