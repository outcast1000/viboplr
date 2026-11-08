import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { QueueTrack } from "../types";
import type { ContextImageBatch } from "../utils/contextImages";

// Each run answers with whatever batches the test queued for it, and records
// what it was asked.
const runs: ContextImageBatch[][] = [];
const asked: Array<{ providers: unknown[]; purpose: string; excludeTypeIds?: ReadonlySet<string> }> = [];
vi.mock("../utils/contextImages", async (orig) => {
  const actual = await orig<typeof import("../utils/contextImages")>();
  return {
    ...actual,
    gatherContextImages: vi.fn(async (opts: {
      onBatch: (b: ContextImageBatch) => void;
      providers: unknown[];
      purpose: string;
      legacy?: { excludeTypeIds?: ReadonlySet<string> };
    }) => {
      asked.push({ providers: opts.providers, purpose: opts.purpose, excludeTypeIds: opts.legacy?.excludeTypeIds });
      for (const b of runs.shift() ?? []) opts.onBatch(b);
    }),
  };
});

import { useNowPlayingPhotos } from "../hooks/useNowPlayingPhotos";

const track = { key: "q:1", title: "Song", artist_name: "Band" } as QueueTrack;
const batch = (providerKey: string, url: string): ContextImageBatch => ({
  providerKey, providerName: providerKey, order: 0, images: [{ url }],
});
const commonsProvider = { pluginId: "commons", providerId: "era", name: "Commons", key: "commons:era", enabled: true };
const commonsPlugin = {
  id: "commons", status: "active",
  manifest: { contributes: { informationTypes: [{ id: "artist_photos" }], contextImageProviders: [{ id: "era" }] } },
};

function render(enabled: boolean) {
  return renderHook((p: { enabled: boolean }) => useNowPlayingPhotos({
    track, enabled: p.enabled,
    providers: [commonsProvider], invokeProvider: vi.fn(),
    invokeInfoFetch: vi.fn(), pluginStates: [commonsPlugin], pluginsReady: true,
  }), { initialProps: { enabled } });
}

describe("useNowPlayingPhotos", () => {
  beforeEach(() => { runs.length = 0; asked.length = 0; });

  it("fetches nothing while Photos isn't showing", () => {
    runs.push([batch("commons:era", "https://c/1.jpg")]);
    const { result } = render(false);
    expect(result.current).toEqual([]);
    expect(asked).toHaveLength(0);
  });

  it("asks the providers for the Now Playing slideshow, leaving out the galleries they speak for", async () => {
    runs.push([batch("commons:era", "https://c/1.jpg")]);
    const { result } = render(true);
    await waitFor(() => expect(result.current.map((p) => p.url)).toEqual(["https://c/1.jpg"]));
    expect(asked[0].purpose).toBe("nowplaying");
    expect(asked[0].providers).toEqual([commonsProvider]);
    expect([...(asked[0].excludeTypeIds ?? [])]).toEqual(["artist_photos"]);
  });

  it("a re-run for the same song drops a source that no longer has pictures", async () => {
    runs.push([batch("commons:era", "https://c/1.jpg"), batch("getty:era", "https://g/1.jpg")]);
    runs.push([batch("commons:era", "https://c/1.jpg")]);
    const { result, rerender } = render(true);
    await waitFor(() => expect(result.current.map((p) => p.url)).toEqual(["https://c/1.jpg", "https://g/1.jpg"]));
    act(() => rerender({ enabled: false }));
    act(() => rerender({ enabled: true }));
    await waitFor(() => expect(result.current.map((p) => p.url)).toEqual(["https://c/1.jpg"]));
  });

  it("a re-run that finds nothing clears the set", async () => {
    runs.push([batch("commons:era", "https://c/1.jpg")]);
    runs.push([]);
    const { result, rerender } = render(true);
    await waitFor(() => expect(result.current).toHaveLength(1));
    act(() => rerender({ enabled: false }));
    act(() => rerender({ enabled: true }));
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
