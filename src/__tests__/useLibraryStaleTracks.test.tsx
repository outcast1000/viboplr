import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// loadTracks fires a request per query / sort / filter change, and they run
// concurrently. An older, slower answer must not overwrite a newer one — which
// is exactly what typing quickly into the Library search produces.

vi.mock("../store", () => ({
  store: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
  },
}));

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { useLibrary } from "../hooks/useLibrary";
import type { Track } from "../types";

function track(id: number, title: string): Track {
  return { id, title } as unknown as Track;
}

interface Deferred { resolve: (v: Track[]) => void }

describe("useLibrary.loadTracks", () => {
  const pending = new Map<string, Deferred>();

  beforeEach(() => {
    pending.clear();
    invoke.mockReset();
    invoke.mockImplementation((cmd: string, args?: { opts?: { query?: string } }) => {
      if (cmd !== "get_tracks") return Promise.resolve(cmd === "get_track_count" ? 0 : []);
      const query = args?.opts?.query ?? "";
      return new Promise<Track[]>((resolve) => pending.set(query, { resolve }));
    });
  });

  it("drops an older search's answer that lands after a newer one", async () => {
    let query = "a";
    const { result, rerender } = renderHook(() =>
      useLibrary({ current: false }, undefined, () => query),
    );

    // Two loads in flight: "a" first, then "ab".
    query = "ab";
    rerender();
    expect(pending.has("a") && pending.has("ab")).toBe(true);

    // The newer one answers first…
    await act(async () => { pending.get("ab")!.resolve([track(2, "ab result")]); });
    expect(result.current.tracks.map(t => t.title)).toEqual(["ab result"]);

    // …and the stale one arriving afterwards changes nothing.
    await act(async () => { pending.get("a")!.resolve([track(1, "a result")]); });
    expect(result.current.tracks.map(t => t.title)).toEqual(["ab result"]);
  });
});
