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

  it("renders only Find in YouTube for the YouTube section (track)", () => {
    const items = buildHeroOverflowItems({
      entityKind: "track",
      imageActions: { onRefresh: noop },
      youtube: { onFind: noop },
      pluginItems: [],
    });

    const labels = items.map(i => i.kind === "divider" ? "---" : i.label);
    expect(labels).toEqual([
      "Retrieve image",
      "---",
      "Find in YouTube",
    ]);
    expect(labels).not.toContain("Set YouTube URL");
    expect(labels).not.toContain("Edit YouTube URL");
    expect(labels).not.toContain("Remove YouTube URL");
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
      youtube: { onFind: noop },
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

    // flat item first, then the grouped submenu
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
      submenu.items[0].onClick();
      expect(dispatch).toHaveBeenCalledWith("search-providers", "search:track:g", target);
    }
  });

  it("returns [] when nothing matches", () => {
    expect(buildPluginOverflowItems([], target, dispatch)).toEqual([]);
  });
});
