import { describe, it, expect, vi } from "vitest";
import { buildPluginMenuSpecs, groupBySubmenuLabel, withPluginName } from "../contextMenu/pluginMenuGroups";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";

const target: PluginContextMenuTarget = { kind: "artist", artistName: "Artist" };

describe("groupBySubmenuLabel", () => {
  it("splits flat items from sorted submenu groups", () => {
    const items: PluginMenuItem[] = [
      { pluginId: "p", id: "z", label: "Zed", targets: ["artist"], submenuLabel: "Search", order: 2 },
      { pluginId: "p", id: "a", label: "Apple", targets: ["artist"], submenuLabel: "Search", order: 0 },
      { pluginId: "p", id: "flat", label: "Flat", targets: ["artist"] },
    ];
    const { flat, groups } = groupBySubmenuLabel(items);
    expect(flat.map(i => i.label)).toEqual(["Flat"]);
    expect(groups.length).toBe(1);
    const [label, grouped] = groups[0];
    expect(label).toBe("Search");
    expect(grouped.map(i => i.label)).toEqual(["Apple", "Zed"]);
  });
});

describe("buildPluginMenuSpecs", () => {
  it("emits flat items then one native submenu per group", () => {
    const dispatch = vi.fn();
    const items: PluginMenuItem[] = [
      { pluginId: "search-providers", id: "search:artist:g", label: "Google", targets: ["artist"], submenuLabel: "Search", order: 0 },
      { pluginId: "search-providers", id: "search:artist:x", label: "X", targets: ["artist"], submenuLabel: "Search", order: 1 },
      { pluginId: "scrobbler", id: "scrobble", label: "Scrobble", targets: ["artist"] },
    ];
    const specs = buildPluginMenuSpecs(items, target, dispatch);

    expect(specs.map(s => s.kind)).toEqual(["item", "submenu"]);
    const flat = specs[0];
    expect(flat.kind === "item" && flat.text).toBe("Scrobble");

    const submenu = specs[1];
    expect(submenu.kind).toBe("submenu");
    if (submenu.kind === "submenu") {
      expect(submenu.text).toBe("Search");
      expect(submenu.items.map(i => (i.kind === "item" ? i.text : "?"))).toEqual(["Google", "X"]);
      // leaf dispatches to the owning plugin
      const leaf = submenu.items[0];
      if (leaf.kind === "item") leaf.action();
      expect(dispatch).toHaveBeenCalledWith("search-providers", "search:artist:g", target);
    }
  });

  it("returns [] for no matching items", () => {
    expect(buildPluginMenuSpecs([], target, vi.fn())).toEqual([]);
  });
});

describe("plugin name in menu labels", () => {
  it("prefixes the owning plugin's name, unless the label already carries it", () => {
    expect(withPluginName("Play the Full Album", "Last.fm")).toBe("Last.fm: Play the Full Album");
    expect(withPluginName("Upgrade with qBittorrent…", "qBittorrent")).toBe("Upgrade with qBittorrent…");
    expect(withPluginName("Scrobble", undefined)).toBe("Scrobble");
    // A label the plugin name already contains collapses to the name ("Web Search: Search").
    expect(withPluginName("Search", "Web Search")).toBe("Web Search");
  });

  it("names the plugin on flat items, on a single-plugin submenu, and on leaves of a shared one", () => {
    const items: PluginMenuItem[] = [
      { pluginId: "lastfm", pluginName: "Last.fm", id: "full", label: "Play the Full Album", targets: ["track"] },
      { pluginId: "ytdlp", pluginName: "yt-dlp", id: "mp3", label: "MP3", targets: ["track"], submenuLabel: "Download as" },
      { pluginId: "ytdlp", pluginName: "yt-dlp", id: "flac", label: "FLAC", targets: ["track"], submenuLabel: "Download as" },
      { pluginId: "a", pluginName: "Alpha", id: "s1", label: "Google", targets: ["track"], submenuLabel: "Search" },
      { pluginId: "b", pluginName: "Beta", id: "s2", label: "Bing", targets: ["track"], submenuLabel: "Search" },
    ];
    const specs = buildPluginMenuSpecs(items, target, vi.fn());
    const text = (s: (typeof specs)[number]) => (s.kind === "item" || s.kind === "submenu" ? s.text : "");
    expect(specs.map(text)).toEqual(["Last.fm: Play the Full Album", "yt-dlp: Download as", "Search"]);
    const leaves = (s: (typeof specs)[number]) => (s.kind === "submenu" ? s.items.map(text) : []);
    expect(leaves(specs[1])).toEqual(["FLAC", "MP3"]);
    expect(leaves(specs[2])).toEqual(["Beta: Bing", "Alpha: Google"]);
  });
});
