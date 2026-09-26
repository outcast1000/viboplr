import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, act } from "@testing-library/react";
import { PluginViewRenderer } from "../components/PluginViewRenderer";
import type { PluginViewData } from "../types/plugin";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => p,
}));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  safeUnlisten: () => {},
  combineUnlisten: () => () => {},
}));

// A plugin's search results name albums and artists by guesswork (Soulseek
// rows parse them out of a file path). With `artwork: "cached"` the list shows
// art already on disk and never asks the providers, so a search doesn't
// download and keep a cover for every album that merely appeared in it.
// Rendered through the RENDERER: a list-level field has to survive the trip
// from the node to the component, and that pass-through is where fields have
// been silently lost before.
afterEach(cleanup);
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const ITEMS = [
  { id: "a", title: "Romeo", artistName: "Wipers", albumTitle: "Over the Edge" },
  { id: "b", title: "Untitled", artistName: "Somebody" },
];

async function view(node: Partial<PluginViewData>) {
  const data = { type: "track-row-list", selectable: true, items: ITEMS, ...node } as PluginViewData;
  render(<PluginViewRenderer pluginName="Soulseek" data={data} currentTrack={null} />);
  // Let the disk lookups settle so a fetch, if any, has been sent.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const fetches = () => invoke.mock.calls.filter((c) => String(c[0]).startsWith("fetch_"));

describe("track-row-list artwork", () => {
  beforeEach(() => {
    invoke.mockReset();
    // Nothing on disk: the case where a fetch would follow.
    invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "get_entity_image" ? null : undefined));
  });

  it("fetches missing art by default, like the library", async () => {
    await view({});
    // Row a: its album, then (no album art) its artist; row b: its artist.
    expect(fetches().map((c) => c[0]).sort()).toEqual(["fetch_album_image", "fetch_artist_image", "fetch_artist_image"]);
  });

  it("with artwork: cached, only reads the disk", async () => {
    await view({ artwork: "cached" } as Partial<PluginViewData>);
    expect(invoke.mock.calls.filter((c) => c[0] === "get_entity_image").length).toBe(3);
    expect(fetches()).toEqual([]);
  });
});
