import { describe, it, expect, vi } from "vitest";
import { buildPluginMenuSpecs, layoutPluginMenu, withPluginName, type PluginMenuNode } from "../contextMenu/pluginMenuGroups";
import type { MenuItemSpec } from "../nativeMenu";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";

const target: PluginContextMenuTarget = { kind: "artist", artistName: "Artist" };

const item = (pluginId: string, pluginName: string, id: string, label: string, extra: Partial<PluginMenuItem> = {}): PluginMenuItem =>
  ({ pluginId, pluginName, id, label, targets: ["track"], ...extra });

/** Render a node tree as nested labels: "Leaf" or { "Submenu": [...] }. */
type Shape = string | { [submenu: string]: Shape[] };
const shape = (nodes: PluginMenuNode[]): Shape[] =>
  nodes.map((n) => (n.kind === "leaf" ? n.text : { [n.text]: shape(n.children) }));

describe("layoutPluginMenu", () => {
  it("collapses the crowded track menu to one row per plugin", () => {
    // The track menu from the issue screenshot: 7 plugins, 10 top-level rows.
    const items: PluginMenuItem[] = [
      item("llm", "AI Assistant", "ask", "Ask AI about this…"),
      item("llm", "AI Assistant", "titles", "Clean up titles…"),
      item("ytdlp", "yt-dlp", "dl", "Download…"),
      item("llm", "AI Assistant", "better", "Find better copies…"),
      item("lastfm", "Last.fm", "full", "Play the Full Album"),
      item("ytdlp", "yt-dlp", "watch", "Watch YouTube video"),
      item("ffmpeg", "FFmpeg Tools", "info", "Media Info (FFmpeg)"),
      item("spotify", "Spotify", "radio", "Start radio"),
      item("spotify", "Spotify", "full", "Play the Full Album"),
      item("ffmpeg", "FFmpeg Tools", "mp3", "MP3", { submenuLabel: "Convert to…", order: 1 }),
      item("ffmpeg", "FFmpeg Tools", "flac", "FLAC", { submenuLabel: "Convert to…", order: 0 }),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([
      { "AI Assistant": ["Ask AI about this…", "Clean up titles…", "Find better copies…"] },
      { "FFmpeg Tools": ["Media Info (FFmpeg)", { "Convert to…": ["FLAC", "MP3"] }] },
      { "Play the Full Album": ["Last.fm", "Spotify"] },
      "Spotify: Start radio",
      { "yt-dlp": ["Download…", "Watch YouTube video"] },
    ]);
  });

  it("keeps a single-entry plugin flat and names it, including a lone submenu group", () => {
    const items: PluginMenuItem[] = [
      item("lastfm", "Last.fm", "full", "Play the Full Album"),
      item("ytdlp", "yt-dlp", "mp3", "MP3", { submenuLabel: "Download as" }),
      item("ytdlp", "yt-dlp", "flac", "FLAC", { submenuLabel: "Download as" }),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([
      "Last.fm: Play the Full Album",
      { "yt-dlp: Download as": ["FLAC", "MP3"] },
    ]);
  });

  it("merges a shared action label case-insensitively, keeping the first label's spelling", () => {
    const items: PluginMenuItem[] = [
      item("b", "Beta", "x", "Play the full album"),
      item("a", "Alpha", "y", "Play the Full Album"),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([{ "Play the full album": ["Alpha", "Beta"] }]);
  });

  it("does not merge two same-label items from one plugin", () => {
    const items: PluginMenuItem[] = [
      item("a", "Alpha", "x", "Do it"),
      item("a", "Alpha", "y", "Do it"),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([{ Alpha: ["Do it", "Do it"] }]);
  });

  it("keeps a submenuLabel group shared by several plugins at top level, leaves named", () => {
    const items: PluginMenuItem[] = [
      item("a", "Alpha", "s1", "Google", { submenuLabel: "Search" }),
      item("b", "Beta", "s2", "Bing", { submenuLabel: "Search" }),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([{ Search: ["Beta: Bing", "Alpha: Google"] }]);
  });

  it("falls back to the plugin id when no name was stamped", () => {
    const items: PluginMenuItem[] = [
      { pluginId: "p", id: "1", label: "One", targets: ["track"] },
      { pluginId: "p", id: "2", label: "Two", targets: ["track"] },
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([{ p: ["One", "Two"] }]);
  });

  it("returns [] for no items", () => {
    expect(layoutPluginMenu([])).toEqual([]);
  });
});

describe("buildPluginMenuSpecs", () => {
  it("renders the layout as native specs and dispatches leaves to their plugin", () => {
    const dispatch = vi.fn();
    const items: PluginMenuItem[] = [
      item("lastfm", "Last.fm", "full", "Play the Full Album"),
      item("spotify", "Spotify", "full-sp", "Play the Full Album"),
      item("zz", "Zephyr", "scrobble", "Scrobble"),
    ];
    const specs = buildPluginMenuSpecs(items, target, dispatch);
    const text = (s: MenuItemSpec) => (s.kind === "item" || s.kind === "submenu" ? s.text : "");
    expect(specs.map(text)).toEqual(["Play the Full Album", "Zephyr: Scrobble"]);

    const shared = specs[0];
    if (shared.kind !== "submenu") throw new Error("expected a submenu");
    expect(shared.items.map(text)).toEqual(["Last.fm", "Spotify"]);
    const spotify = shared.items[1];
    if (spotify.kind === "item") spotify.action();
    expect(dispatch).toHaveBeenCalledWith("spotify", "full-sp", target);
  });

  it("returns [] for no matching items", () => {
    expect(buildPluginMenuSpecs([], target, vi.fn())).toEqual([]);
  });
});

describe("withPluginName", () => {
  it("prefixes the owning plugin's name, unless the label already carries it", () => {
    expect(withPluginName("Play the Full Album", "Last.fm")).toBe("Last.fm: Play the Full Album");
    expect(withPluginName("Upgrade with qBittorrent…", "qBittorrent")).toBe("Upgrade with qBittorrent…");
    expect(withPluginName("Scrobble", undefined)).toBe("Scrobble");
    // A label the plugin name already contains collapses to the name ("Web Search: Search").
    expect(withPluginName("Search", "Web Search")).toBe("Web Search");
  });
});
