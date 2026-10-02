// An album page whose album isn't in the library: the tracklist comes from the
// album `ranked_list` provider and the like from the durable name-keyed store.
// A library album keeps using that same fetch for popularity only.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useEntityDetail } from "../hooks/useEntityDetail";
import type { InfoFetchResult } from "../types/informationTypes";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

const RANKED_TYPE = ["album_track_popularity", "Track Popularity", "ranked_list", 604800, 0, [["lastfm", 1]]];

function mockBackend(opts: { album?: unknown; liked?: number; types?: unknown[] }) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "find_album_by_name": return opts.album ?? null;
      case "get_tracks": return [{ id: 7, title: "Joga", artist_name: "Bjork", liked: 0 }];
      case "get_entity_like_state": return opts.liked ?? 0;
      case "info_get_types_for_entity": return opts.types ?? [RANKED_TYPE];
      default: return null;
    }
  });
}

const okList: InfoFetchResult = {
  status: "ok",
  value: { items: [
    { name: "Hunter", subtitle: "Bjork", value: 900 },
    { name: "Joga", subtitle: "Bjork", value: 1200 },
  ] },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useEntityDetail — album not in the library", () => {
  it("lists the provider's tracks in order, metadata-only, filed under the album", async () => {
    mockBackend({});
    const invokeInfoFetch = vi.fn().mockResolvedValue(okList);
    const { result } = renderHook(() =>
      useEntityDetail({ kind: "album", name: "Homogenic", artistName: "Bjork", invokeInfoFetch }));

    await waitFor(() => expect(result.current.tracklistStatus).toBe("ok"));
    expect(result.current.isLibrary).toBe(false);
    expect(result.current.albumTracklist.map(t => t.title)).toEqual(["Hunter", "Joga"]);
    expect(result.current.albumTracklistValues).toEqual([900, 1200]);
    const first = result.current.albumTracklist[0];
    expect(first.path).toBeNull();
    expect(first.album_title).toBe("Homogenic");
    expect(first.album_artist_name).toBe("Bjork");
    expect(invokeInfoFetch).toHaveBeenCalledWith("lastfm", "album_track_popularity",
      { kind: "album", name: "Homogenic", id: 0, artistName: "Bjork" });
  });

  it("reports none when no provider has a tracklist", async () => {
    mockBackend({ types: [] });
    // Hoisted: a fresh function per render is a new effect dependency each time.
    const invokeInfoFetch = vi.fn();
    const { result } = renderHook(() =>
      useEntityDetail({ kind: "album", name: "Homogenic", artistName: "Bjork", invokeInfoFetch }));
    await waitFor(() => expect(result.current.tracklistStatus).toBe("none"));
    expect(result.current.albumTracklist).toEqual([]);
  });

  it("reads the like by name and writes it by name, reverting a failed write", async () => {
    mockBackend({ liked: 1 });
    const onEntityLikeByName = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() =>
      useEntityDetail({ kind: "album", name: "Homogenic", artistName: "Bjork", onEntityLikeByName }));

    await waitFor(() => expect(result.current.liked).toBe(1));
    expect(invoke).toHaveBeenCalledWith("get_entity_like_state", { kind: "album", name: "Homogenic", artistName: "Bjork" });

    await act(async () => { result.current.handleToggleDislike(); });
    expect(onEntityLikeByName).toHaveBeenCalledWith("album", "Homogenic", "Bjork", -1);
    expect(result.current.liked).toBe(-1);

    onEntityLikeByName.mockResolvedValueOnce(false);
    await act(async () => { result.current.handleToggleDislike(); });
    expect(onEntityLikeByName).toHaveBeenLastCalledWith("album", "Homogenic", "Bjork", 0);
    expect(result.current.liked).toBe(-1);
  });
});

describe("useEntityDetail — library album", () => {
  it("gets popularity bars and the full tracklist from the one ranked-list fetch", async () => {
    mockBackend({ album: { id: 3, title: "Homogenic", artist_name: "Bjork", liked: 0 } });
    const invokeInfoFetch = vi.fn().mockResolvedValue(okList);
    const { result } = renderHook(() =>
      useEntityDetail({ kind: "album", name: "Homogenic", artistName: "Bjork", invokeInfoFetch }));

    await waitFor(() => expect(result.current.trackPopularity).toEqual({ 7: 1200 }));
    expect(result.current.isLibrary).toBe(true);
    // The page merges the rows it lacks ("Hunter") into its track list.
    expect(result.current.tracklistStatus).toBe("ok");
    expect(result.current.albumTracklist.map(t => t.title)).toEqual(["Hunter", "Joga"]);
    expect(result.current.rankedTypeId).toBe("album_track_popularity");
    expect(invoke).not.toHaveBeenCalledWith("get_entity_like_state", expect.anything());
  });

  it("does not refetch when a like replaces the entity object", async () => {
    mockBackend({ album: { id: 3, title: "Homogenic", artist_name: "Bjork", liked: 0 } });
    const invokeInfoFetch = vi.fn().mockResolvedValue(okList);
    const onEntityLike = vi.fn();
    const { result } = renderHook(() =>
      useEntityDetail({ kind: "album", name: "Homogenic", artistName: "Bjork", invokeInfoFetch, onEntityLike }));

    await waitFor(() => expect(result.current.tracklistStatus).toBe("ok"));
    act(() => { result.current.handleToggleLike(); });
    expect(result.current.liked).toBe(1);
    expect(result.current.trackPopularity).toEqual({ 7: 1200 });
    expect(invokeInfoFetch).toHaveBeenCalledTimes(1);
  });
});
