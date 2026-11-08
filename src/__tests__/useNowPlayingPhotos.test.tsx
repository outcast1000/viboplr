import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { QueueTrack } from "../types";
import type { TrackGallery } from "../utils/trackGalleries";

// Each run answers with whatever galleries the test queued for it.
const runs: TrackGallery[][] = [];
vi.mock("../utils/trackGalleries", async (orig) => {
  const actual = await orig<typeof import("../utils/trackGalleries")>();
  return {
    ...actual,
    gatherTrackGalleries: vi.fn(async (opts: { onGallery: (g: TrackGallery) => void }) => {
      for (const g of runs.shift() ?? []) opts.onGallery(g);
    }),
  };
});

import { useNowPlayingPhotos } from "../hooks/useNowPlayingPhotos";

const track = { key: "q:1", title: "Song", artist_name: "Band" } as QueueTrack;
const gallery = (typeId: string, url: string): TrackGallery => ({
  about: "artist", typeId, name: typeId, images: [{ url }],
});

function render(enabled: boolean) {
  return renderHook((p: { enabled: boolean }) => useNowPlayingPhotos({
    track, enabled: p.enabled, invokeInfoFetch: vi.fn(), pluginStates: [], pluginsReady: true,
  }), { initialProps: { enabled } });
}

describe("useNowPlayingPhotos", () => {
  beforeEach(() => { runs.length = 0; });

  it("fetches nothing while Photos isn't showing", () => {
    runs.push([gallery("commons", "https://c/1.jpg")]);
    const { result } = render(false);
    expect(result.current).toEqual([]);
    expect(runs).toHaveLength(1);
  });

  it("a re-run for the same song drops a source that no longer has pictures", async () => {
    runs.push([gallery("commons", "https://c/1.jpg"), gallery("getty", "https://g/1.jpg")]);
    runs.push([gallery("commons", "https://c/1.jpg")]);
    const { result, rerender } = render(true);
    await waitFor(() => expect(result.current.map((p) => p.url)).toEqual(["https://c/1.jpg", "https://g/1.jpg"]));
    act(() => rerender({ enabled: false }));
    act(() => rerender({ enabled: true }));
    await waitFor(() => expect(result.current.map((p) => p.url)).toEqual(["https://c/1.jpg"]));
  });

  it("a re-run that finds nothing clears the set", async () => {
    runs.push([gallery("commons", "https://c/1.jpg")]);
    runs.push([]);
    const { result, rerender } = render(true);
    await waitFor(() => expect(result.current).toHaveLength(1));
    act(() => rerender({ enabled: false }));
    act(() => rerender({ enabled: true }));
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
