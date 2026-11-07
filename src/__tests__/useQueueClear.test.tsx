// Coverage for clearQueue — the contract in queue.md ("Clear — index resets
// to -1, playlist context cleared, main_playlist_clear invoked"). Only the
// control API clears the queue now: the panel's Clear was removed when the
// queue history arrived (queue.md "Queue History"), which also records the
// cleared queue first (useQueueHistory.test.tsx).
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useQueue } from "../hooks/useQueue";
import type { QueueTrack } from "../types";
import { useRef } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

// Queue persistence + the thumb-ready listener are side channels this test
// doesn't exercise; stub them so the hook mounts without a backend.
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  combineUnlisten: (...fns: Array<() => void>) => () => fns.forEach((f) => f()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("../telemetry", () => ({ track: vi.fn(), sourceClass: () => "local", bucketCount: () => "0" }));

import { invoke } from "@tauri-apps/api/core";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeTrack(n: number): QueueTrack {
  return {
    key: `lib:${n}`,
    path: `file:///song-${n}.mp3`,
    title: `Song ${n}`,
    artist_name: "Artist",
    album_title: "Album",
    duration_secs: 100,
    format: "mp3",
  };
}

/** Mount useQueue with a settled `restoredRef` so its persistence guard is live. */
function mountQueue() {
  return renderHook(() => {
    const restoredRef = useRef(true);
    return useQueue(restoredRef, () => {});
  });
}

describe("clearQueue", () => {
  it("empties the queue and resets the index", () => {
    const { result } = mountQueue();
    act(() => { result.current.playTracks([makeTrack(1), makeTrack(2)], 1); });
    expect(result.current.queue).toHaveLength(2);
    expect(result.current.queueIndex).toBe(1);

    act(() => { result.current.clearQueue(); });
    expect(result.current.queue).toEqual([]);
    expect(result.current.queueIndex).toBe(-1);
  });

  it("clears the playlist context so the queue banner goes away", () => {
    const { result } = mountQueue();
    act(() => { result.current.playTracks([makeTrack(1)], 0, { name: "Album X", source: "album" }); });
    expect(result.current.playlistContext).toMatchObject({ name: "Album X" });

    act(() => { result.current.clearQueue(); });
    expect(result.current.playlistContext).toBeNull();
  });

  // Not just React state: the backend owns the cover/thumb files, and the
  // debounced write alone won't clean them up (see queue.md "Persistence").
  it("tells the backend to clear the persisted main playlist", () => {
    const { result } = mountQueue();
    act(() => { result.current.playTracks([makeTrack(1)], 0); });
    vi.mocked(invoke).mockClear();

    act(() => { result.current.clearQueue(); });
    expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).toContain("main_playlist_clear");
  });

  it("is safe on an already-empty queue", () => {
    const { result } = mountQueue();
    act(() => { result.current.clearQueue(); });
    expect(result.current.queue).toEqual([]);
    expect(result.current.queueIndex).toBe(-1);
  });

  // The subtle one: clearing ends the play session, so a backfill tail still
  // in flight must not splice itself into the now-empty queue.
  it("ends the play session so a pending backfill tail cannot append", () => {
    const { result } = mountQueue();
    let gen = 0;
    act(() => { gen = result.current.playTracks([makeTrack(1)], 0); });

    act(() => { result.current.clearQueue(); });

    let appended: unknown = "unset";
    act(() => { appended = result.current.appendToPlaySession(gen, [makeTrack(2)]); });
    expect(appended).toBeNull();
    expect(result.current.queue).toEqual([]);
  });

  it("drops a play still loading", () => {
    const { result } = mountQueue();
    act(() => {
      result.current.playTracks([makeTrack(1)], 0);
      result.current.beginLoadingPlay({ mode: "extend", name: "Radio", imagePath: null, source: null, originKey: null });
    });
    expect(result.current.loadingPlay).not.toBeNull();

    act(() => { result.current.clearQueue(); });
    expect(result.current.loadingPlay).toBeNull();
  });

  // A cleared queue must not resurrect on the next play's generation check.
  it("leaves a fresh play able to start its own session", () => {
    const { result } = mountQueue();
    act(() => { result.current.playTracks([makeTrack(1)], 0); });
    act(() => { result.current.clearQueue(); });

    let gen = 0;
    act(() => { gen = result.current.playTracks([makeTrack(3)], 0); });
    let appended: unknown = null;
    act(() => { appended = result.current.appendToPlaySession(gen, [makeTrack(4)]); });

    expect(appended).not.toBeNull();
    expect(result.current.queue.map((t) => t.title)).toEqual(["Song 3", "Song 4"]);
  });
});
