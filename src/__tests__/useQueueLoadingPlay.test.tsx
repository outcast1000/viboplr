// A play still being built (useQueue → LoadingPlay). While one is live, the
// end of the queue waits for it: a plugin radio seeds the station with one
// track and resolves the rest for 15-25s, and without the wait the seed ends
// mid-resolve, auto-continue plays something unrelated, and the station lands
// behind it. Asserted on the hook because the decision lives in its state (the
// play generation + the loading record), not in a pure helper.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useQueue, type LoadingPlay } from "../hooks/useQueue";
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
    ...overrides,
  };
}

const INFO = { name: "Radio: Song 1", imagePath: null, source: "Spotify", originKey: null };

function mountQueue() {
  const handlePlay = vi.fn();
  const hook = renderHook(() => {
    const restoredRef = useRef(true);
    return useQueue(restoredRef, handlePlay);
  });
  return { hook, handlePlay };
}

type Hook = ReturnType<typeof mountQueue>["hook"];

/** Play a one-track head with the rest still loading — the plugin-radio shape. */
function startStation(hook: Hook) {
  let gen = 0;
  let loading: LoadingPlay | null = null;
  act(() => {
    gen = hook.result.current.playTracks([makeTrack(1)], 0);
    loading = hook.result.current.beginLoadingPlay({ mode: "extend", ...INFO });
  });
  return { gen, loading: loading! };
}

/** The queue ran out: start waiting, without settling. */
function startWaiting(hook: Hook) {
  let waited!: Promise<boolean>;
  act(() => { waited = hook.result.current.waitForLoadingPlay("auto"); });
  return waited;
}

/** The station's tail lands: append it and end the loading play with it. */
function land(hook: Hook, gen: number, loading: LoadingPlay, tracks: QueueTrack[]) {
  act(() => {
    const appended = hook.result.current.appendToPlaySession(gen, tracks);
    hook.result.current.endLoadingPlay(
      loading,
      appended ? { kind: "extended", index: appended.index, first: appended.tracks[0] } : { kind: "nothing" },
    );
  });
}

describe("waitForLoadingPlay", () => {
  it("doesn't wait when nothing is loading", async () => {
    const { hook } = mountQueue();
    act(() => { hook.result.current.playTracks([makeTrack(1)], 0); });
    let waited = true;
    await act(async () => { waited = await hook.result.current.waitForLoadingPlay("auto"); });
    // Nothing to wait for — the caller falls through to auto-continue / stop.
    expect(waited).toBe(false);
    expect(hook.result.current.playbackWaiting).toBe(false);
  });

  it("waits, then starts the first track that lands", async () => {
    const { hook, handlePlay } = mountQueue();
    const { gen, loading } = startStation(hook);
    handlePlay.mockClear();

    const waited = startWaiting(hook);
    expect(hook.result.current.playbackWaiting).toBe(true);
    // Waiting means waiting: nothing plays until the tail arrives.
    expect(handlePlay).not.toHaveBeenCalled();

    land(hook, gen, loading, [makeTrack(2), makeTrack(3)]);
    await act(async () => { expect(await waited).toBe(true); });

    expect(handlePlay).toHaveBeenCalledTimes(1);
    expect(handlePlay.mock.calls[0][0]).toMatchObject({ title: "Song 2" });
    expect(handlePlay.mock.calls[0][1]).toBe("auto");
    expect(hook.result.current.queueIndex).toBe(1);
    expect(hook.result.current.queue.map((t) => t.title)).toEqual(["Song 1", "Song 2", "Song 3"]);
    expect(hook.result.current.playbackWaiting).toBe(false);
    expect(hook.result.current.loadingPlay).toBeNull();
  });

  // The waiter must play the *queued* object: withUniqueKeys re-keys a tail
  // entry that collides with one already in the queue, and playing the pre-key
  // copy would give the now-playing row an identity no queue entry has.
  it("plays the re-keyed copy when the tail collides with the queue", async () => {
    const { hook, handlePlay } = mountQueue();
    const { gen, loading } = startStation(hook);
    handlePlay.mockClear();
    const waited = startWaiting(hook);
    land(hook, gen, loading, [makeTrack(1)]);
    await act(async () => { await waited; });

    const queued = hook.result.current.queue[1];
    expect(queued.key).not.toBe("lib:1");
    expect(handlePlay.mock.calls[0][0].key).toBe(queued.key);
  });

  it("hands the decision back when nothing lands", async () => {
    const { hook, handlePlay } = mountQueue();
    const { loading } = startStation(hook);
    handlePlay.mockClear();
    const waited = startWaiting(hook);

    act(() => { hook.result.current.endLoadingPlay(loading, { kind: "nothing" }, "Couldn't load the rest."); });
    // False: the caller's end-of-queue decision (auto-continue, stop) is due.
    await act(async () => { expect(await waited).toBe(false); });
    expect(handlePlay).not.toHaveBeenCalled();
    expect(hook.result.current.loadFailure).toBe("Couldn't load the rest.");
  });

  it("lets only the first waiter decide", async () => {
    const { hook, handlePlay } = mountQueue();
    const { gen, loading } = startStation(hook);
    handlePlay.mockClear();
    const first = startWaiting(hook);
    // The track ended, then the user pressed Next: one wait, one start.
    let second = false;
    await act(async () => { second = await hook.result.current.waitForLoadingPlay("user"); });
    expect(second).toBe(true);

    land(hook, gen, loading, [makeTrack(2)]);
    await act(async () => { await first; });
    expect(handlePlay).toHaveBeenCalledTimes(1);
  });

  it("stands down when the user plays something else meanwhile", async () => {
    const { hook, handlePlay } = mountQueue();
    const { gen: staleGen, loading } = startStation(hook);
    const waited = startWaiting(hook);

    // A new session: the station the user walked away from is dropped, and
    // so is the wait for it.
    act(() => { hook.result.current.playTracks([makeTrack(5), makeTrack(6)], 0); });
    handlePlay.mockClear();
    await act(async () => { expect(await waited).toBe(true); });

    expect(hook.result.current.loadingPlay).toBeNull();
    expect(hook.result.current.isLoadingPlayLive(loading)).toBe(false);
    let stale: unknown = "unset";
    act(() => { stale = hook.result.current.appendToPlaySession(staleGen, [makeTrack(9)]); });
    expect(stale).toBeNull();
    expect(handlePlay).not.toHaveBeenCalled();
    expect(hook.result.current.queueIndex).toBe(0);
  });

  it("stands down when the queue is cleared", async () => {
    const { hook, handlePlay } = mountQueue();
    startStation(hook);
    const waited = startWaiting(hook);
    act(() => { hook.result.current.clearQueue(); });
    await act(async () => { expect(await waited).toBe(true); });
    expect(hook.result.current.loadingPlay).toBeNull();
    expect(hook.result.current.queue).toEqual([]);
    expect(handlePlay).toHaveBeenCalledTimes(1); // the head only
  });
});

describe("switch (no known first track)", () => {
  function startSwitch(hook: Hook) {
    let loading: LoadingPlay | null = null;
    act(() => {
      hook.result.current.playTracks([makeTrack(1)], 0);
      loading = hook.result.current.beginLoadingPlay({ mode: "switch", ...INFO });
    });
    return loading!;
  }

  it("waits for the switch at the end of the old queue, and stands down when it lands", async () => {
    const { hook, handlePlay } = mountQueue();
    startSwitch(hook);
    const waited = startWaiting(hook);
    handlePlay.mockClear();

    // Landing replaces the queue — playTracks starts it itself.
    act(() => { hook.result.current.playTracks([makeTrack(7), makeTrack(8)], 0); });
    await act(async () => { expect(await waited).toBe(true); });
    expect(handlePlay).toHaveBeenCalledTimes(1);
    expect(handlePlay.mock.calls[0][0]).toMatchObject({ title: "Song 7" });
    expect(hook.result.current.loadingPlay).toBeNull();
  });

  it("Cancel drops it, and the end of the queue goes ahead", async () => {
    const { hook } = mountQueue();
    const loading = startSwitch(hook);
    expect(hook.result.current.loadingPlay?.mode).toBe("switch");
    const waited = startWaiting(hook);

    act(() => { hook.result.current.cancelLoadingPlay(); });
    await act(async () => { expect(await waited).toBe(false); });
    expect(hook.result.current.loadingPlay).toBeNull();
    // What it resolves later is discarded by the caller.
    expect(hook.result.current.isLoadingPlayLive(loading)).toBe(false);
  });

  it("enqueuing to the old queue doesn't drop it", () => {
    const { hook } = mountQueue();
    const loading = startSwitch(hook);
    act(() => { hook.result.current.addToQueue(makeTrack(2)); });
    expect(hook.result.current.isLoadingPlayLive(loading)).toBe(true);
  });
});
