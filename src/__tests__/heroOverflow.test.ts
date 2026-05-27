import { describe, it, expect, vi } from "vitest";
import { buildHeroOverflowItems } from "../utils/heroOverflow";

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
        webSearches: [{ id: "google", label: "Google", onClick: noop }],
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
      "Search Google",
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

  it("renders YouTube section with Find/Set when no url is set (track)", () => {
    const items = buildHeroOverflowItems({
      entityKind: "track",
      imageActions: { onRefresh: noop },
      youtube: { url: null, onFind: noop, onSetUrl: noop },
      pluginItems: [],
    });

    expect(items.map(i => i.kind === "divider" ? "---" : i.label)).toEqual([
      "Retrieve image",
      "---",
      "Find in YouTube",
      "Set YouTube URL",
    ]);
  });

  it("renders YouTube section with Edit/Remove when url is set (track)", () => {
    const items = buildHeroOverflowItems({
      entityKind: "track",
      imageActions: { onRefresh: noop },
      youtube: { url: "https://youtu.be/x", onFind: noop, onSetUrl: noop, onClear: noop },
      pluginItems: [],
    });

    const labels = items.map(i => i.kind === "divider" ? "---" : i.label);
    expect(labels).toContain("Find in YouTube");
    expect(labels).toContain("Edit YouTube URL");
    expect(labels).toContain("Remove YouTube URL");
    expect(labels).not.toContain("Set YouTube URL");
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
      youtube: { url: null, onFind: noop, onSetUrl: noop },
      pluginItems: [],
    });
    expect(noImageOnly.some(i => i.kind === "divider")).toBe(false);
  });
});
