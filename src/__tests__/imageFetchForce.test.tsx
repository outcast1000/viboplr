// The `force` flag on the entity-image fetch commands separates two callers
// that used to be indistinguishable, and conflating them made the backend's
// 24h failure suppression unreachable: every automatic cache miss cleared the
// recorded failure, so an entity no provider has art for was re-resolved on a
// loop (observed: the same four entities every ~20s, each pass costing an
// iTunes + Deezer + MusicBrainz round trip).
//
// These assertions are about the flag *per path*, which is the part that was
// wrong — the backend's own gate is covered by db/image_failures.rs.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  combineUnlisten: () => () => {},
}));

import { useImageCache } from "../hooks/useImageCache";

/** The fetch invoke for `command`, or undefined if it never happened. */
function fetchCall(command: string): Record<string, unknown> | undefined {
  const call = invoke.mock.calls.find((c) => c[0] === command);
  return call?.[1] as Record<string, unknown> | undefined;
}

describe("entity image fetch force flag", () => {
  beforeEach(() => {
    invoke.mockReset();
    // get_entity_image resolves to "no image on disk", which is what sends
    // getImage down the automatic fetch path.
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_entity_image" ? Promise.resolve(null) : Promise.resolve(undefined),
    );
  });
  afterEach(cleanup);

  it("does not force when a surface merely needs a thumbnail", async () => {
    const { result } = renderHook(() => useImageCache("artist"));
    await act(async () => {
      result.current.getImage("Some Artist");
      await Promise.resolve();
    });
    expect(fetchCall("fetch_artist_image")).toEqual({ artistName: "Some Artist", force: false });
  });

  it("forces when the caller explicitly asks to re-fetch", async () => {
    const { result } = renderHook(() => useImageCache("artist"));
    await act(async () => {
      result.current.requestFetch("Some Artist");
    });
    expect(fetchCall("fetch_artist_image")).toEqual({ artistName: "Some Artist", force: true });
  });

  it("carries the album's artist alongside the flag", async () => {
    const { result } = renderHook(() => useImageCache("album"));
    await act(async () => {
      result.current.getImage("Some Album", "Some Artist");
      await Promise.resolve();
    });
    expect(fetchCall("fetch_album_image")).toEqual({
      albumTitle: "Some Album",
      artistName: "Some Artist",
      force: false,
    });
  });

  it("sends the tag path through the same split", async () => {
    const { result } = renderHook(() => useImageCache("tag"));
    await act(async () => {
      result.current.requestFetch("shoegaze");
    });
    expect(fetchCall("fetch_tag_image")).toEqual({ tagName: "shoegaze", force: true });
  });
});
