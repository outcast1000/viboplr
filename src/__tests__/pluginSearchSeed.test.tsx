import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PluginViewRenderer } from "../components/PluginViewRenderer";
import type { PluginViewData } from "../types/plugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  convertFileSrc: (p: string) => p,
}));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  safeUnlisten: () => {},
  combineUnlisten: () => () => {},
}));

afterEach(cleanup);

// The Cmd+K no-match state opens a plugin view WITH the query; the renderer
// must hand it to the view's own search box and run it once. Rendered through
// the renderer because the seed is routed by node position (first hoisted
// search-input), which is exactly what a component-level test would skip.
const SEARCH_VIEW: PluginViewData = {
  type: "layout",
  direction: "vertical",
  children: [
    { type: "tabs", tabs: [{ id: "yt", label: "YouTube" }], activeTab: "yt", action: "ytdlp-source" },
    { type: "search-input", action: "ytdlp-search-submit", placeholder: "Search YouTube…", buttonLabel: "Search" },
    { type: "text", content: "results go here" },
  ],
};

describe("plugin view search seed", () => {
  it("fills the top search box and submits it once", () => {
    const onAction = vi.fn();
    const onSeedConsumed = vi.fn();
    const { rerender } = render(
      <PluginViewRenderer
        pluginName="yt-dlp"
        currentTrack={null}
        data={SEARCH_VIEW}
        onAction={onAction}
        searchSeed={{ text: "heydfd", nonce: 1 }}
        onSearchSeedConsumed={onSeedConsumed}
      />,
    );
    expect((screen.getByPlaceholderText("Search YouTube…") as HTMLInputElement).value).toBe("heydfd");
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith("ytdlp-search-submit", { query: "heydfd" });
    expect(onSeedConsumed).toHaveBeenCalledWith(1);

    // A re-render with the same seed (the plugin redrawing with results) must
    // not run the search again.
    rerender(
      <PluginViewRenderer
        pluginName="yt-dlp"
        currentTrack={null}
        data={{ ...SEARCH_VIEW, children: [...SEARCH_VIEW.children.slice(0, 2), { type: "text", content: "3 results" }] }}
        onAction={onAction}
        searchSeed={{ text: "heydfd", nonce: 1 }}
        onSearchSeedConsumed={onSeedConsumed}
      />,
    );
    expect(onAction).toHaveBeenCalledTimes(1);

    // A fresh seed (same text, new nonce — the user searched it again from
    // Cmd+K) replaces the text and submits again.
    rerender(
      <PluginViewRenderer
        pluginName="yt-dlp"
        currentTrack={null}
        data={SEARCH_VIEW}
        onAction={onAction}
        searchSeed={{ text: "radiohead", nonce: 2 }}
        onSearchSeedConsumed={onSeedConsumed}
      />,
    );
    expect((screen.getByPlaceholderText("Search YouTube…") as HTMLInputElement).value).toBe("radiohead");
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction).toHaveBeenLastCalledWith("ytdlp-search-submit", { query: "radiohead" });
  });

  it("does nothing on a view with no search box", () => {
    const onAction = vi.fn();
    const onSeedConsumed = vi.fn();
    render(
      <PluginViewRenderer
        pluginName="Spotify"
        currentTrack={null}
        data={{ type: "layout", direction: "vertical", children: [{ type: "text", content: "Playlists" }] }}
        onAction={onAction}
        searchSeed={{ text: "heydfd", nonce: 1 }}
        onSearchSeedConsumed={onSeedConsumed}
      />,
    );
    expect(onAction).not.toHaveBeenCalled();
    expect(onSeedConsumed).not.toHaveBeenCalled();
  });
});

// Why HOST_SEARCH_ACTION exists. A TABBED view only renders its search box
// while that tab is the one showing, so on any other tab there is no
// top-level search-input for the seed to land in and the query goes nowhere —
// the user would have to click the tab themselves, which is the retyping this
// whole feature removes. A plugin in that shape handles the reserved action
// instead and routes the query itself; App then skips the seed entirely.
describe("a tabbed plugin view", () => {
  it("has nothing to seed while its search tab is not the one showing", () => {
    const onAction = vi.fn();
    const onSeedConsumed = vi.fn();
    render(
      <PluginViewRenderer
        pluginName="qBittorrent"
        currentTrack={null}
        data={{
          type: "layout",
          direction: "vertical",
          children: [
            {
              type: "tabs",
              tabs: [{ id: "torrents", label: "Torrents" }, { id: "search", label: "Search" }],
              activeTab: "torrents",
              action: "qbt:tab",
            },
            // The torrents tab's filter box: a search-input, but nested inside
            // the header row, so it is neither hoisted nor seedable — and it
            // filters the local list rather than searching indexers, so
            // handing it the query would answer a different question.
            {
              type: "layout",
              direction: "horizontal",
              children: [{ type: "search-input", action: "qbt:list-filter", placeholder: "Filter torrents" }],
            },
          ],
        }}
        onAction={onAction}
        searchSeed={{ text: "the sound lions mouth", nonce: 1 }}
        onSearchSeedConsumed={onSeedConsumed}
      />,
    );
    expect(onAction).not.toHaveBeenCalled();
    expect(onSeedConsumed).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("Filter torrents") as HTMLInputElement).value).toBe("");
  });
});
