// Holding the end of the queue for a backfill tail. A plugin radio seeds the
// station with one track and resolves the rest for 15-25s; without the hold the
// seed ends mid-resolve, auto-continue plays something unrelated, and the
// station lands behind it. Asserted here because the decision lives in useQueue
// state (the play generation + the pending-tail flag), not a pure helper.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useQueue } from "../hooks/useQueue";
import type { QueueTrack } from "../types";
import { useRef } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  combineUnlisten: (...fns: Array<() => void>) => () => fns.forEach((f) => f()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("../telemetry", () => ({ track: vi.fn(), sourceClass: () => "local", bucketCount: () => "0" }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeTrack(n: number, overrides: Partial<QueueTrack> = {}): QueueTrack {
  return {
    key: `lib:${n}`,
    path: `file:///song-${n}.mp3`,
    title: `Song ${n}`,
    artist_name: "Artist",
    album_title: "Album",
    duration_secs: 100,
    format: "mp3",
    liked: 0,
    ...overrides,
  };
}

function mountQueue() {
  const handlePlay = vi.fn();
  const onAbandoned = vi.fn();
  const hook = renderHook(() => {
    const restoredRef = useRef(true);
    return useQueue(restoredRef, handlePlay, undefined, () => null, onAbandoned);
  });
  return { hook, handlePlay, onAbandoned };
}

/** Play a one-track head and declare its tail pending — the plugin-radio shape. */
function startStation(hook: ReturnType<typeof mountQueue>["hook"]) {
  let gen = 0;
  act(() => {
    gen = hook.result.current.playTracks([makeTrack(1)], 0);
    hook.result.current.markBackfillPending(gen);
  });
  return gen;
}

describe("holdForBackfillTail", () => {
  it("refuses to hold when no tail is pending", () => {
    const { hook } = mountQueue();
    act(() => { hook.result.current.playTracks([makeTrack(1)], 0); });
    let held = true;
    act(() => { held = hook.result.current.holdForBackfillTail(); });
    // Nothing to wait for — the caller falls through to auto-continue / stop.
    expect(held).toBe(false);
  });

  it("holds, then starts the first track of the tail when it lands", () => {
    const { hook, handlePlay } = mountQueue();
    const gen = startStation(hook);
    handlePlay.mockClear();

    let held = false;
    act(() => { held = hook.result.current.holdForBackfillTail(); });
    expect(held).toBe(true);
    // Held means held: nothing plays until the tail arrives.
    expect(handlePlay).not.toHaveBeenCalled();

    act(() => { hook.result.current.appendToPlaySession(gen, [makeTrack(2), makeTrack(3)]); });
    expect(handlePlay).toHaveBeenCalledTimes(1);
    expect(handlePlay.mock.calls[0][0]).toMatchObject({ title: "Song 2" });
    expect(handlePlay.mock.calls[0][1]).toBe("auto");
    expect(hook.result.current.queueIndex).toBe(1);
    expect(hook.result.current.queue.map((t) => t.title)).toEqual(["Song 1", "Song 2", "Song 3"]);
  });

  // The resume must play the *queued* object: withUniqueKeys re-keys a tail
  // entry that collides with one already in the queue, and playing the pre-key
  // copy would give the now-playing row an identity no queue entry has.
  it("plays the re-keyed copy when the tail collides with the queue", () => {
    const { hook, handlePlay } = mountQueue();
    const gen = startStation(hook);
    handlePlay.mockClear();
    act(() => { hook.result.current.holdForBackfillTail(); });
    act(() => { hook.result.current.appendToPlaySession(gen, [makeTrack(1)]); });

    const queued = hook.result.current.queue[1];
    expect(queued.key).not.toBe("lib:1");
    expect(handlePlay.mock.calls[0][0].key).toBe(queued.key);
  });

  it("releases the end-of-queue decision when the tail never arrives", () => {
    const { hook, handlePlay, onAbandoned } = mountQueue();
    const gen = startStation(hook);
    handlePlay.mockClear();
    act(() => { hook.result.current.holdForBackfillTail(); });

    act(() => { hook.result.current.settleBackfill(gen); });
    expect(onAbandoned).toHaveBeenCalledTimes(1);
    expect(handlePlay).not.toHaveBeenCalled();
  });

  it("does not release it when the tail did land", () => {
    const { hook, onAbandoned } = mountQueue();
    const gen = startStation(hook);
    act(() => { hook.result.current.holdForBackfillTail(); });
    act(() => { hook.result.current.appendToPlaySession(gen, [makeTrack(2)]); });
    act(() => { hook.result.current.settleBackfill(gen); });
    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it("drops the hold when the user plays something else", () => {
    const { hook, handlePlay, onAbandoned } = mountQueue();
    const staleGen = startStation(hook);
    act(() => { hook.result.current.holdForBackfillTail(); });

    // A new session: the held-for stop belonged to the station the user just
    // walked away from, so neither its tail nor its abandonment may touch this.
    let gen = 0;
    act(() => { gen = hook.result.current.playTracks([makeTrack(5), makeTrack(6)], 0); });
    handlePlay.mockClear();

    let stale = true;
    act(() => { stale = hook.result.current.appendToPlaySession(staleGen, [makeTrack(9)]); });
    expect(stale).toBe(false);
    act(() => { hook.result.current.settleBackfill(staleGen); });
    expect(onAbandoned).not.toHaveBeenCalled();

    act(() => { hook.result.current.appendToPlaySession(gen, [makeTrack(7)]); });
    expect(handlePlay).not.toHaveBeenCalled();
    expect(hook.result.current.queueIndex).toBe(0);
  });

  it("drops the hold when the queue is cleared", () => {
    const { hook, onAbandoned } = mountQueue();
    const gen = startStation(hook);
    act(() => { hook.result.current.holdForBackfillTail(); });
    act(() => { hook.result.current.clearQueue(); });
    act(() => { hook.result.current.settleBackfill(gen); });
    expect(onAbandoned).not.toHaveBeenCalled();
    expect(hook.result.current.queue).toEqual([]);
  });
});
