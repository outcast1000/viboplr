import { describe, it, expect, vi } from "vitest";
import type { PluginVisualizerRegistration } from "../types/pluginVisualizer";
import {
  visualizerKey,
  candidatesFor,
  resolveSlot,
  resolveFullscreenSlot,
  buildVisualizerMenuSpecs,
  ARTWORK_VISUALIZER_NAME,
  ARTWORK_OPTION_LABELS,
  DEFAULT_ARTWORK_OPTIONS,
  LEGACY_PHOTOS_VISUALIZER_KEY,
  resolveArtworkOptions,
  type ArtworkOptions,
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

describe("visualizerKey", () => {
  it("is pluginId:visualizerId", () => {
    expect(visualizerKey(deck)).toBe("vinyl-deck:deck");
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

describe("resolveFullscreenSlot", () => {
  // A visualizer willing to fill both slots, and one that only does nowplaying.
  const both: PluginVisualizerRegistration = {
    pluginId: "vinyl-deck",
    id: "deck",
    name: "Vinyl Deck",
    placements: ["nowplaying", "fullscreen"],
  };
  const nowPlayingOnly: PluginVisualizerRegistration = {
    pluginId: "meters",
    id: "vu",
    name: "VU Meters",
    placements: ["nowplaying"],
  };

  it("inherits the Now Playing pick when that visualizer declares fullscreen", () => {
    // The point of the fallback: F on the Now Playing view enlarges what's
    // already on screen, with nothing to configure first.
    expect(
      resolveFullscreenSlot([both], { nowplaying: "vinyl-deck:deck" }),
    ).toBe("vinyl-deck:deck");
  });

  it("does not inherit a visualizer that never offered to fill the slot", () => {
    expect(resolveFullscreenSlot([nowPlayingOnly], { nowplaying: "meters:vu" })).toBeNull();
  });

  it("prefers an explicit fullscreen selection over the Now Playing one", () => {
    const fsOnly: PluginVisualizerRegistration = {
      pluginId: "lights",
      id: "strobe",
      name: "Strobe",
      placements: ["fullscreen"],
    };
    expect(
      resolveFullscreenSlot([both, fsOnly], {
        nowplaying: "vinyl-deck:deck",
        fullscreen: "lights:strobe",
      }),
    ).toBe("lights:strobe");
  });

  it("falls back when the explicit choice went stale rather than resolving to nothing", () => {
    // Plugin uninstalled: the inherited pick is still perfectly usable, so
    // fullscreen keeps working instead of silently doing nothing.
    expect(
      resolveFullscreenSlot([both], {
        nowplaying: "vinyl-deck:deck",
        fullscreen: "lights:strobe",
      }),
    ).toBe("vinyl-deck:deck");
  });

  it("is null with nothing selected anywhere", () => {
    expect(resolveFullscreenSlot([both], {})).toBeNull();
    expect(resolveFullscreenSlot([both], { nowplaying: null })).toBeNull();
  });

  it("is null when the Now Playing pick itself is stale", () => {
    expect(resolveFullscreenSlot([nowPlayingOnly], { nowplaying: "vinyl-deck:deck" })).toBeNull();
  });
});

describe("buildVisualizerMenuSpecs", () => {
  it("lists Artwork as a peer of every candidate, with the current one checked", () => {
    // Artwork is first but NOT fenced off behind a separator: an unselected slot
    // renders the track's album/artist image, so it is a choice like the others.
    const onPick = vi.fn();
    const specs = buildVisualizerMenuSpecs(ALL, { nowplaying: "meters:vu" }, "nowplaying", onPick);
    expect(specs.map((s) => ("text" in s ? s.text : "---"))).toEqual([
      "Artwork",
      "Vinyl Deck",
      "VU Meters",
    ]);
    const checked = specs.filter((s) => s.kind === "check" && s.checked);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({ text: "VU Meters" });
  });

  it("never offers a bare 'None' — the old label for the artwork slot", () => {
    // Guards the rename itself: "None" described the mechanism (no plugin) and
    // misdescribed the result (the artwork is what's on screen).
    const texts = buildVisualizerMenuSpecs(ALL, {}, "nowplaying", vi.fn()).map((s) =>
      "text" in s ? s.text : "---",
    );
    expect(texts).not.toContain("None");
  });

  it("checks Artwork when nothing is selected", () => {
    const specs = buildVisualizerMenuSpecs(ALL, {}, "nowplaying", vi.fn());
    expect(specs[0]).toMatchObject({ text: ARTWORK_VISUALIZER_NAME, checked: true });
  });

  it("checks Artwork when the selection is stale, so the menu never lies", () => {
    const specs = buildVisualizerMenuSpecs(
      [meter],
      { nowplaying: "vinyl-deck:deck" },
      "nowplaying",
      vi.fn(),
    );
    expect(specs[0]).toMatchObject({ text: ARTWORK_VISUALIZER_NAME, checked: true });
    expect(specs.filter((s) => s.kind === "check" && s.checked)).toHaveLength(1);
  });

  it("fires the right key, and null for Artwork", () => {
    // Still null on the wire — the rename is presentation only, so no stored
    // `visualizerSlots` needs migrating.
    const onPick = vi.fn();
    const specs = buildVisualizerMenuSpecs(ALL, {}, "nowplaying", onPick);
    (specs.find((s) => "text" in s && s.text === "Vinyl Deck") as { action: () => void }).action();
    expect(onPick).toHaveBeenCalledWith("vinyl-deck:deck");
    (specs[0] as { action: () => void }).action();
    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  it("still offers Artwork, plus a hint, when nothing can fill the slot", () => {
    // It used to return ONLY the disabled hint, so the picker couldn't say what
    // was on screen. The hint stays (it's the one nudge toward Extensions) but
    // now sits under a real, checked entry.
    const specs = buildVisualizerMenuSpecs(ALL, {}, "fullscreen", vi.fn());
    expect(specs[0]).toMatchObject({
      kind: "check",
      text: ARTWORK_VISUALIZER_NAME,
      checked: true,
    });
    expect(specs[specs.length - 1]).toMatchObject({ kind: "item", enabled: false });
  });

  it("picking Artwork works even with no plugin installed", () => {
    // The disabled hint must not be the only actionable-looking row.
    const onPick = vi.fn();
    const specs = buildVisualizerMenuSpecs([], {}, "nowplaying", onPick);
    (specs[0] as { action: () => void }).action();
    expect(onPick).toHaveBeenCalledWith(null);
  });
});

describe("Artwork options", () => {
  const ALL_OFF: ArtworkOptions = { extraImages: false, lyrics: false, info: false, fill: false };

  it("follow the visualizers under a separator, in menu order, with their state", () => {
    const options: ArtworkOptions = { extraImages: true, lyrics: true, info: false, fill: true };
    const specs = buildVisualizerMenuSpecs(ALL, {}, "nowplaying", vi.fn(), { options, onToggle: vi.fn() });
    const sep = specs.findIndex((s) => s.kind === "separator");
    expect(specs.slice(0, sep).map((s) => ("text" in s ? s.text : "---"))).toEqual(["Artwork", "Vinyl Deck", "VU Meters"]);
    expect(specs.slice(sep + 1)).toMatchObject([
      { kind: "check", text: "Show additional images", checked: true, enabled: true },
      { kind: "check", text: "Show lyrics", checked: true, enabled: true },
      { kind: "check", text: "Show info", checked: false, enabled: true },
      { kind: "check", text: "Images fill the view", checked: true, enabled: true },
    ]);
  });

  it("each fires its own option", () => {
    const onToggle = vi.fn();
    const specs = buildVisualizerMenuSpecs([], {}, "nowplaying", vi.fn(), { options: ALL_OFF, onToggle });
    for (const [option, label] of Object.entries(ARTWORK_OPTION_LABELS)) {
      (specs.find((s) => "text" in s && s.text === label) as { action: () => void }).action();
      expect(onToggle).toHaveBeenLastCalledWith(option);
    }
  });

  it("are disabled while a plugin visualizer fills the slot — it uses none of them", () => {
    const specs = buildVisualizerMenuSpecs(ALL, { nowplaying: "vinyl-deck:deck" }, "nowplaying", vi.fn(), {
      options: ALL_OFF,
      onToggle: vi.fn(),
    });
    const labels: string[] = Object.values(ARTWORK_OPTION_LABELS);
    const optionSpecs = specs.filter((s) => "text" in s && labels.includes(s.text));
    expect(optionSpecs).toHaveLength(4);
    for (const s of optionSpecs) expect(s).toMatchObject({ enabled: false });
  });

  it("follow `live` — what the surface shows — over the placement's pick", () => {
    // Fullscreen resolves its own slot: a windowed plugin pick that can't go
    // fullscreen leaves Artwork on screen there, and the options must work.
    const labels: string[] = Object.values(ARTWORK_OPTION_LABELS);
    const options = (sel: Record<string, string | null>, live: boolean) =>
      buildVisualizerMenuSpecs(ALL, sel, "nowplaying", vi.fn(), { options: ALL_OFF, onToggle: vi.fn(), live })
        .filter((s) => "text" in s && labels.includes(s.text));
    for (const s of options({ nowplaying: "vinyl-deck:deck" }, true)) expect(s).toMatchObject({ enabled: true });
    for (const s of options({}, false)) expect(s).toMatchObject({ enabled: false });
  });

  it("read a partial or malformed saved value as off, never undefined", () => {
    const partial = { info: true } as unknown as typeof DEFAULT_ARTWORK_OPTIONS;
    expect(resolveArtworkOptions(partial, false, {})).toEqual({
      extraImages: false, lyrics: true, info: true, fill: false,
    });
    const junk = { extraImages: "yes", info: 1, fill: null } as unknown as typeof DEFAULT_ARTWORK_OPTIONS;
    expect(resolveArtworkOptions(junk, false, {})).toEqual({
      extraImages: false, lyrics: true, info: false, fill: false,
    });
  });

  it("are left out when the caller passes none", () => {
    const texts = buildVisualizerMenuSpecs(ALL, {}, "sidebar", vi.fn()).map((s) => ("text" in s ? s.text : "---"));
    expect(texts).not.toContain("Show lyrics");
  });

  it("resolve lyrics from the inverted lyricsHidden flag", () => {
    expect(resolveArtworkOptions(DEFAULT_ARTWORK_OPTIONS, false, {})).toEqual({
      extraImages: false, lyrics: true, info: false, fill: false,
    });
    expect(resolveArtworkOptions(DEFAULT_ARTWORK_OPTIONS, true, {}).lyrics).toBe(false);
  });
});

describe("the retired Photos visualizer", () => {
  it("resolves to Artwork in every slot", () => {
    expect(resolveSlot([], { nowplaying: LEGACY_PHOTOS_VISUALIZER_KEY }, "nowplaying")).toBeNull();
    expect(resolveFullscreenSlot([], { nowplaying: LEGACY_PHOTOS_VISUALIZER_KEY })).toBeNull();
    const specs = buildVisualizerMenuSpecs([], { nowplaying: LEGACY_PHOTOS_VISUALIZER_KEY }, "nowplaying", vi.fn());
    expect(specs[0]).toMatchObject({ text: ARTWORK_VISUALIZER_NAME, checked: true });
    expect(specs.map((s) => ("text" in s ? s.text : "---"))).not.toContain("Photos");
  });

  it("reads as 'Show additional images' on until the user sets the option", () => {
    const sel = { nowplaying: LEGACY_PHOTOS_VISUALIZER_KEY };
    expect(resolveArtworkOptions(DEFAULT_ARTWORK_OPTIONS, false, sel).extraImages).toBe(true);
    expect(
      resolveArtworkOptions({ ...DEFAULT_ARTWORK_OPTIONS, extraImagesSet: true }, false, sel).extraImages,
    ).toBe(false);
  });
});

