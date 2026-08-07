import { describe, it, expect, vi } from "vitest";
import type { PluginVisualizerRegistration } from "../types/pluginVisualizer";
import type { MenuItemSpec } from "../nativeMenu";
import {
  buildNowPlayingMenuSpecs,
  type NowPlayingMenuDeps,
} from "../contextMenu/buildNowPlayingMenuSpecs";

const deck: PluginVisualizerRegistration = {
  pluginId: "vinyl-deck",
  id: "deck",
  name: "Vinyl Deck",
  placements: ["nowplaying", "fullscreen"],
};

function deps(over: Partial<NowPlayingMenuDeps> = {}): NowPlayingMenuDeps {
  return {
    visualizers: [deck],
    selection: {},
    onPickVisualizer: vi.fn(),
    hasLyrics: true,
    lyricsHidden: false,
    onToggleLyrics: vi.fn(),
    onEnterFullscreen: vi.fn(),
    ...over,
  };
}

const texts = (specs: MenuItemSpec[]) => specs.map((s) => ("text" in s ? s.text : "---"));

function find(specs: MenuItemSpec[], text: string) {
  const hit = specs.find((s) => "text" in s && s.text === text);
  if (!hit) throw new Error(`no menu item "${text}" in ${texts(specs).join(", ")}`);
  return hit;
}

describe("buildNowPlayingMenuSpecs", () => {
  it("leads with the visualizer picker as a submenu", () => {
    const specs = buildNowPlayingMenuSpecs(deps());
    expect(specs[0]).toMatchObject({ kind: "submenu", text: "Visualizer" });
    // The submenu is the shared picker, so it carries None + every candidate.
    const sub = specs[0] as Extract<MenuItemSpec, { kind: "submenu" }>;
    expect(texts(sub.items)).toEqual(["None", "---", "Vinyl Deck"]);
  });

  it("routes a pick from the submenu to the callback", () => {
    const onPickVisualizer = vi.fn();
    const specs = buildNowPlayingMenuSpecs(deps({ onPickVisualizer }));
    const sub = specs[0] as Extract<MenuItemSpec, { kind: "submenu" }>;
    (find(sub.items, "Vinyl Deck") as { action: () => void }).action();
    expect(onPickVisualizer).toHaveBeenCalledWith("vinyl-deck:deck");
  });

  it("omits the fullscreen item when nothing can fill that slot", () => {
    // A permanently-greyed item is noise; the capability simply isn't there.
    const specs = buildNowPlayingMenuSpecs(deps({ onEnterFullscreen: null }));
    expect(texts(specs)).not.toContain("Fullscreen");
  });

  it("offers fullscreen when it is available, and fires it", () => {
    const onEnterFullscreen = vi.fn();
    const specs = buildNowPlayingMenuSpecs(deps({ onEnterFullscreen }));
    (find(specs, "Fullscreen") as { action: () => void }).action();
    expect(onEnterFullscreen).toHaveBeenCalled();
  });

  it("checks Show lyrics only when lyrics are actually on screen", () => {
    expect(find(buildNowPlayingMenuSpecs(deps()), "Show lyrics")).toMatchObject({
      checked: true,
      enabled: true,
    });
    expect(
      find(buildNowPlayingMenuSpecs(deps({ lyricsHidden: true })), "Show lyrics"),
    ).toMatchObject({ checked: false, enabled: true });
  });

  it("keeps Show lyrics present but disabled and unchecked when the track has none", () => {
    // Present so the menu doesn't reshuffle between tracks; unchecked because
    // nothing is on screen; disabled because there is nothing to toggle.
    const item = find(buildNowPlayingMenuSpecs(deps({ hasLyrics: false })), "Show lyrics");
    expect(item).toMatchObject({ kind: "check", checked: false, enabled: false });
  });

  it("does not report lyrics as shown just because the user never collapsed them", () => {
    // hasLyrics=false + lyricsHidden=false is the common case on an instrumental;
    // a naive `!lyricsHidden` check would tick the box over an empty column.
    const item = find(
      buildNowPlayingMenuSpecs(deps({ hasLyrics: false, lyricsHidden: false })),
      "Show lyrics",
    );
    expect(item).toMatchObject({ checked: false });
  });

  it("toggles lyrics through the callback", () => {
    const onToggleLyrics = vi.fn();
    const specs = buildNowPlayingMenuSpecs(deps({ onToggleLyrics }));
    (find(specs, "Show lyrics") as { action: () => void }).action();
    expect(onToggleLyrics).toHaveBeenCalled();
  });

  it("still offers the picker when no visualizer plugin is installed", () => {
    // The submenu explains itself rather than the menu hiding the feature —
    // otherwise there is no surface telling the user visualizers exist.
    const specs = buildNowPlayingMenuSpecs(deps({ visualizers: [] }));
    const sub = specs[0] as Extract<MenuItemSpec, { kind: "submenu" }>;
    expect(sub.items).toHaveLength(1);
    expect(sub.items[0]).toMatchObject({ kind: "item", enabled: false });
  });
});
