import { describe, it, expect } from "vitest";
import {
  contributionKey,
  describeMenuTargets,
  filterContributions,
  isContributionEnabled,
  listPluginContributions,
  type ContributionVisibility,
} from "../utils/pluginContributions";
import type {
  PluginMenuItem,
  PluginSearchProvider,
  PluginSidebarItem,
} from "../types/plugin";

const menu = (
  pluginId: string,
  id: string,
  label: string,
  extra: Partial<PluginMenuItem> = {},
): PluginMenuItem => ({ pluginId, id, label, targets: ["track"], ...extra });

const sidebar = (
  pluginId: string,
  id: string,
  label: string,
): PluginSidebarItem => ({ pluginId, id, label, icon: "i" });

const search = (
  pluginId: string,
  providerId: string,
  name: string,
): PluginSearchProvider => ({ pluginId, providerId, name });

const sources = (over: {
  menuItems?: PluginMenuItem[];
  sidebarItems?: PluginSidebarItem[];
  searchProviders?: PluginSearchProvider[];
}) => ({
  menuItems: over.menuItems ?? [],
  sidebarItems: over.sidebarItems ?? [],
  searchProviders: over.searchProviders ?? [],
});

describe("contributionKey / isContributionEnabled", () => {
  it("namespaces by plugin and kind so a shared item id can't collide", () => {
    expect(contributionKey("ytdlp", "menu", "watch")).toBe("ytdlp:menu:watch");
    expect(contributionKey("ytdlp", "sidebar", "watch")).toBe("ytdlp:sidebar:watch");
  });

  it("treats a missing key as enabled", () => {
    expect(isContributionEnabled({}, "ytdlp", "menu", "watch")).toBe(true);
    expect(isContributionEnabled(undefined, "ytdlp", "menu", "watch")).toBe(true);
  });

  it("only an explicit false disables", () => {
    const v: ContributionVisibility = {
      "ytdlp:menu:watch": false,
      "ytdlp:menu:dl": true,
    };
    expect(isContributionEnabled(v, "ytdlp", "menu", "watch")).toBe(false);
    expect(isContributionEnabled(v, "ytdlp", "menu", "dl")).toBe(true);
  });
});

describe("filterContributions", () => {
  const items = [menu("ytdlp", "watch", "Watch"), menu("ffmpeg", "conv", "Convert")];

  it("drops only the disabled item", () => {
    const out = filterContributions(items, "menu", { "ytdlp:menu:watch": false });
    expect(out.map((i) => i.id)).toEqual(["conv"]);
  });

  it("returns the same array reference when nothing of this kind is off", () => {
    expect(filterContributions(items, "menu", {})).toBe(items);
    expect(filterContributions(items, "menu", undefined)).toBe(items);
    // A sidebar item turned off must not affect the menu list.
    expect(filterContributions(items, "menu", { "ytdlp:sidebar:view": false })).toBe(items);
  });

  it("does not confuse kinds that share an item id", () => {
    const sidebars = [sidebar("ytdlp", "watch", "YouTube")];
    const v = { "ytdlp:menu:watch": false };
    expect(filterContributions(items, "menu", v).map((i) => i.id)).toEqual(["conv"]);
    expect(filterContributions(sidebars, "sidebar", v)).toHaveLength(1);
  });

  it("reads a search provider's id from providerId, not id", () => {
    const providers = [search("ytdlp", "ytdlp-search", "yt-dlp"), search("sp", "sp-search", "Spotify")];
    const out = filterContributions(
      providers,
      "search",
      { "ytdlp:search:ytdlp-search": false },
      (p) => p.providerId,
    );
    expect(out.map((p) => p.providerId)).toEqual(["sp-search"]);
  });

  it("leaves a search provider alone when the disabled key is another kind's", () => {
    const providers = [search("ytdlp", "ytdlp-search", "yt-dlp")];
    // Same plugin, same trailing id, different kind — must not match.
    const out = filterContributions(
      providers,
      "search",
      { "ytdlp:menu:ytdlp-search": false },
      (p) => p.providerId,
    );
    expect(out).toBe(providers);
  });
});

describe("describeMenuTargets", () => {
  it("names one, two and many targets readably", () => {
    expect(describeMenuTargets(["track"])).toBe("Right-click menu on tracks");
    expect(describeMenuTargets(["track", "album"])).toBe(
      "Right-click menu on tracks and albums",
    );
    expect(describeMenuTargets(["track", "album", "artist"])).toBe(
      "Right-click menu on tracks, albums and artists",
    );
  });

  it("de-dupes repeated targets", () => {
    expect(describeMenuTargets(["track", "track"])).toBe("Right-click menu on tracks");
  });

  it("falls back when a plugin declares no targets", () => {
    expect(describeMenuTargets([])).toBe("Right-click menu item");
    expect(describeMenuTargets(undefined)).toBe("Right-click menu item");
  });
});

describe("listPluginContributions", () => {
  it("orders sidebar view, then search catalog, then menu items by label", () => {
    const rows = listPluginContributions(
      sources({
        menuItems: [menu("p", "b", "Zebra"), menu("p", "a", "Apple")],
        sidebarItems: [sidebar("p", "v", "Browse")],
        searchProviders: [search("p", "s", "Catalog")],
      }),
    );
    expect(rows.map((r) => [r.kind, r.label])).toEqual([
      ["sidebar", "Browse"],
      ["search", "Catalog"],
      ["menu", "Apple"],
      ["menu", "Zebra"],
    ]);
  });

  it("qualifies a submenu item with its parent label", () => {
    const rows = listPluginContributions(
      sources({ menuItems: [menu("ffmpeg", "mp3", "MP3", { submenuLabel: "Convert to" })] }),
    );
    expect(rows[0].label).toBe("Convert to → MP3");
  });

  it("carries the key the visibility map is written under", () => {
    const rows = listPluginContributions(
      sources({ menuItems: [menu("ytdlp", "watch", "Watch")] }),
    );
    expect(rows[0].key).toBe("ytdlp:menu:watch");
    expect(rows[0].detail).toBe("Right-click menu on tracks");
  });

  it("keys a search provider by its providerId and labels it by name", () => {
    const rows = listPluginContributions(
      sources({ searchProviders: [search("ytdlp", "ytdlp-search", "yt-dlp")] }),
    );
    expect(rows[0]).toMatchObject({
      key: "ytdlp:search:ytdlp-search",
      kind: "search",
      id: "ytdlp-search",
      label: "yt-dlp",
      detail: "Global search (Cmd+K)",
    });
  });

  it("keeps a disabled contribution in the list so it can be turned back on", () => {
    // The list is deliberately visibility-blind — filtering happens elsewhere.
    const rows = listPluginContributions(
      sources({ menuItems: [menu("ytdlp", "watch", "Watch")] }),
    );
    expect(rows).toHaveLength(1);
  });
});
