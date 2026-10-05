import { describe, it, expect, vi } from "vitest";
import { buildHeroOverflowItems, buildPluginOverflowItems } from "../utils/heroOverflow";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";

const noop = () => {};

describe("buildHeroOverflowItems", () => {
  it("orders image actions then a divider then plugin items", () => {
    const items = buildHeroOverflowItems({
      entityKind: "album",
      imageActions: {
        onRefresh: noop,
        onSetFromFile: noop,
        onPasteFromClipboard: noop,
        onRemove: noop,
        onSearchImage: noop,
      },
      pluginItems: [{ kind: "action", id: "scrobble", label: "Scrobble album", onClick: noop }],
    });

    const labels = items.map(i => i.kind === "divider" ? "---" : i.label);
    expect(labels).toEqual([
      "Retrieve image",
      "Set image…",
      "Paste image",
      "Remove image",
      "Search image",
      "---",
      "Scrobble album",
    ]);
  });

  it("omits image actions that are not provided", () => {
    const items = buildHeroOverflowItems({
      entityKind: "tag",
      imageActions: { onPasteFromClipboard: noop, onSetFromFile: noop },
      pluginItems: [],
    });

    expect(items.map(i => i.kind === "divider" ? "---" : i.label)).toEqual([
      "Set image…",
      "Paste image",
    ]);
  });

  it("renders track-only actions (radio) after a divider for a track", () => {
    const items = buildHeroOverflowItems({
      entityKind: "track",
      imageActions: { onRefresh: noop },
      radio: { onStart: noop },
      pluginItems: [],
    });

    const labels = items.map(i => i.kind === "divider" ? "---" : i.label);
    expect(labels).toEqual([
      "Retrieve image",
      "---",
      "Start radio",
    ]);
    expect(labels).not.toContain("Find in YouTube");
  });

  it("invokes the action onClick when activated", () => {
    const onRefresh = vi.fn();
    const items = buildHeroOverflowItems({
      entityKind: "artist",
      imageActions: { onRefresh },
      pluginItems: [],
    });
    const refresh = items.find(i => i.kind === "action" && i.id === "image-refresh");
    expect(refresh?.kind).toBe("action");
    if (refresh && refresh.kind === "action") refresh.onClick();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("inserts a divider between sections only when both sides have items", () => {
    const noPluginNoYoutube = buildHeroOverflowItems({
      entityKind: "tag",
      imageActions: { onPasteFromClipboard: noop },
      pluginItems: [],
    });
    expect(noPluginNoYoutube.some(i => i.kind === "divider")).toBe(false);

    const noImageOnly = buildHeroOverflowItems({
      entityKind: "track",
      imageActions: {},
      radio: { onStart: noop },
      pluginItems: [],
    });
    expect(noImageOnly.some(i => i.kind === "divider")).toBe(false);
  });
});

describe("buildPluginOverflowItems", () => {
  const target: PluginContextMenuTarget = { kind: "track", title: "Song", artistName: "Artist" };
  const dispatch = vi.fn();

  it("groups submenuLabel items into one submenu and keeps others flat", () => {
    const matching: PluginMenuItem[] = [
      { pluginId: "search-providers", id: "search:track:b", label: "Bing", targets: ["track"], submenuLabel: "Search", order: 1 },
      { pluginId: "search-providers", id: "search:track:a", label: "Apple", targets: ["track"], submenuLabel: "Search", order: 0 },
      { pluginId: "scrobbler", id: "scrobble", label: "Scrobble", targets: ["track"] },
    ];
    const out = buildPluginOverflowItems(matching, target, dispatch);

    // top level is alphabetical
    expect(out.map(i => (i.kind === "submenu" ? `submenu:${i.label}` : i.kind === "action" ? i.label : "---"))).toEqual([
      "Scrobble",
      "submenu:Search",
    ]);
    const submenu = out.find(i => i.kind === "submenu");
    expect(submenu?.kind).toBe("submenu");
    if (submenu && submenu.kind === "submenu") {
      // sorted by order: Apple (0) before Bing (1)
      expect(submenu.items.map(s => s.label)).toEqual(["Apple", "Bing"]);
    }
  });

  it("dispatches to the owning plugin when a leaf is clicked", () => {
    const matching: PluginMenuItem[] = [
      { pluginId: "search-providers", id: "search:track:g", label: "Google", targets: ["track"], submenuLabel: "Search" },
    ];
    const out = buildPluginOverflowItems(matching, target, dispatch);
    const submenu = out[0];
    expect(submenu.kind).toBe("submenu");
    if (submenu.kind === "submenu") {
      const leaf = submenu.items[0];
      if ("onClick" in leaf) leaf.onClick();
      expect(dispatch).toHaveBeenCalledWith("search-providers", "search:track:g", target);
    }
  });

  it("nests a plugin's own submenu inside its plugin submenu, as the native menu does", () => {
    const matching: PluginMenuItem[] = [
      { pluginId: "ffmpeg", pluginName: "FFmpeg Tools", id: "info", label: "Media Info", targets: ["track"] },
      { pluginId: "ffmpeg", pluginName: "FFmpeg Tools", id: "mp3", label: "MP3", targets: ["track"], submenuLabel: "Convert to…" },
    ];
    const out = buildPluginOverflowItems(matching, target, dispatch);
    expect(out).toHaveLength(1);
    const plugin = out[0];
    if (plugin.kind !== "submenu") throw new Error("expected a plugin submenu");
    expect(plugin.label).toBe("FFmpeg Tools");
    expect(plugin.items.map(s => s.label)).toEqual(["Media Info", "Convert to…"]);
    const convert = plugin.items[1];
    expect("items" in convert && convert.items.map(s => s.label)).toEqual(["MP3"]);
  });

  it("returns [] when nothing matches", () => {
    expect(buildPluginOverflowItems([], target, dispatch)).toEqual([]);
  });
});

describe("buildHeroOverflowItems — enqueue", () => {
  const labels = (items: ReturnType<typeof buildHeroOverflowItems>) => items.map(i => i.kind === "divider" ? "---" : i.label);

  it("leads with Enqueue, then a divider, then the rest", () => {
    const items = buildHeroOverflowItems({
      entityKind: "artist",
      enqueue: noop,
      imageActions: { onRefresh: noop },
      pluginItems: [{ kind: "action", id: "p", label: "Plugin thing", onClick: noop }],
    });
    expect(labels(items)).toEqual(["Enqueue", "---", "Retrieve image", "---", "Plugin thing"]);
  });

  it("is Enqueue alone, with no trailing divider, when nothing else applies", () => {
    expect(labels(buildHeroOverflowItems({ entityKind: "tag", enqueue: noop, imageActions: {}, pluginItems: [] }))).toEqual(["Enqueue"]);
  });

  it("leaves the menu unchanged without it", () => {
    expect(labels(buildHeroOverflowItems({ entityKind: "album", imageActions: { onRefresh: noop }, pluginItems: [] }))).toEqual(["Retrieve image"]);
  });
});
