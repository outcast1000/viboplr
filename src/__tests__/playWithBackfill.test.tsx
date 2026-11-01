// usePlayActions.playWithBackfill on the real queue hook: both shapes of a
// play whose list takes time to build — a known head (extend) and none
// (switch) — share one path, so both are pinned here end to end.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { useQueue } from "../hooks/useQueue";
import { usePlayActions } from "../hooks/usePlayActions";
import type { QueueTrack } from "../types";

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

function t(n: number): QueueTrack {
  return { key: `k:${n}`, path: `file:///${n}.mp3`, title: `Song ${n}`, artist_name: "A", album_title: null, duration_secs: 100, format: "mp3" };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function mount() {
  const handlePlay = vi.fn();
  const notify = vi.fn();
  const hook = renderHook(() => {
    const restoredRef = useRef(true);
    const q = useQueue(restoredRef, handlePlay);
    const pa = usePlayActions({
      playTracks: q.playTracks,
      enqueueTracks: vi.fn(),
      appendToPlaySession: q.appendToPlaySession,
      beginLoadingPlay: q.beginLoadingPlay,
      isLoadingPlayLive: q.isLoadingPlayLive,
      endLoadingPlay: q.endLoadingPlay,
      setPlaylistContext: q.setPlaylistContext,
      albums: [], artists: [], tags: [],
      getAlbumImage: () => null, getArtistImage: () => null, getTagImage: () => null,
      notify,
      radioOptions: { artistShare: 50, taste: "mixed", spreadArtists: false },
    });
    return { q, pa };
  });
  return { hook, handlePlay, notify };
}

const titles = (q: QueueTrack[]) => q.map((x) => x.title);

describe("playWithBackfill — known head (extend)", () => {
  it("plays the head at once, shows it loading, appends the rest", async () => {
    const { hook, handlePlay } = mount();
    const rest = deferred<QueueTrack[]>();
    let done!: Promise<QueueTrack[]>;
    act(() => {
      done = hook.result.current.pa.playWithBackfill({
        head: [t(1)], context: { name: "Radio: Song 1" }, resolveTail: () => rest.promise, source: "Spotify",
      });
    });
    expect(handlePlay).toHaveBeenCalledTimes(1);
    expect(hook.result.current.q.loadingPlay).toMatchObject({ mode: "extend", name: "Radio: Song 1", source: "Spotify" });

    await act(async () => { rest.resolve([t(1), t(2), t(3)]); await done; });
    expect(titles(hook.result.current.q.queue)).toEqual(["Song 1", "Song 2", "Song 3"]);
    expect(hook.result.current.q.loadingPlay).toBeNull();
  });

  it("keeps the head and says the rest failed", async () => {
    const { hook, notify } = mount();
    await act(async () => {
      await hook.result.current.pa.playWithBackfill({
        head: [t(1)], context: { name: "Mix" }, resolveTail: async () => { throw new Error("scrape failed"); },
        tailErrorMessage: "Couldn't load the rest of “Mix”.",
      });
    });
    expect(titles(hook.result.current.q.queue)).toEqual(["Song 1"]);
    expect(notify).toHaveBeenCalledWith("Couldn't load the rest of “Mix”.", { kind: "error" });
    expect(hook.result.current.q.loadFailure).toBe("Couldn't load the rest of “Mix”.");
  });
});

describe("playWithBackfill — no head (switch)", () => {
  it("leaves the current queue playing until the list lands, then replaces it", async () => {
    const { hook, handlePlay } = mount();
    act(() => { hook.result.current.q.playTracks([t(8), t(9)], 0); });
    handlePlay.mockClear();

    const list = deferred<QueueTrack[]>();
    let done!: Promise<QueueTrack[]>;
    act(() => {
      done = hook.result.current.pa.playWithBackfill({ head: [], context: { name: "Discover Weekly" }, resolveTail: () => list.promise });
    });
    // Nothing changed yet: the old queue still plays.
    expect(handlePlay).not.toHaveBeenCalled();
    expect(titles(hook.result.current.q.queue)).toEqual(["Song 8", "Song 9"]);
    expect(hook.result.current.q.loadingPlay?.mode).toBe("switch");

    await act(async () => { list.resolve([t(1), t(2)]); await done; });
    expect(titles(hook.result.current.q.queue)).toEqual(["Song 1", "Song 2"]);
    expect(handlePlay).toHaveBeenCalledTimes(1);
    expect(hook.result.current.q.playlistContext).toMatchObject({ name: "Discover Weekly" });
    expect(hook.result.current.q.loadingPlay).toBeNull();
  });

  it("drops a cancelled switch's list when it lands", async () => {
    const { hook, handlePlay, notify } = mount();
    act(() => { hook.result.current.q.playTracks([t(8)], 0); });
    handlePlay.mockClear();
    const list = deferred<QueueTrack[]>();
    let done!: Promise<QueueTrack[]>;
    act(() => {
      done = hook.result.current.pa.playWithBackfill({
        head: [], context: { name: "Discover Weekly" }, resolveTail: () => list.promise, tailErrorMessage: "Couldn't load it.",
      });
    });
    act(() => { hook.result.current.q.cancelLoadingPlay(); });

    let landed: QueueTrack[] = [];
    await act(async () => { list.resolve([t(1)]); landed = await done; });
    expect(landed).toEqual([]);
    expect(titles(hook.result.current.q.queue)).toEqual(["Song 8"]);
    expect(handlePlay).not.toHaveBeenCalled();
    // Cancelling isn't a failure.
    expect(notify).not.toHaveBeenCalled();
  });

  it("drops it when the user plays something else meanwhile", async () => {
    const { hook } = mount();
    const list = deferred<QueueTrack[]>();
    let done!: Promise<QueueTrack[]>;
    act(() => {
      done = hook.result.current.pa.playWithBackfill({ head: [], context: { name: "Weekly" }, resolveTail: () => list.promise });
    });
    act(() => { hook.result.current.q.playTracks([t(5)], 0); });
    await act(async () => { list.resolve([t(1)]); await done; });
    expect(titles(hook.result.current.q.queue)).toEqual(["Song 5"]);
  });

  it("leaves the queue alone and says so when the list fails", async () => {
    const { hook, notify } = mount();
    act(() => { hook.result.current.q.playTracks([t(8)], 0); });
    await act(async () => {
      await hook.result.current.pa.playWithBackfill({
        head: [], context: { name: "Weekly" }, resolveTail: async () => [], tailErrorMessage: "Couldn't load “Weekly”.",
      });
    });
    expect(titles(hook.result.current.q.queue)).toEqual(["Song 8"]);
    expect(notify).toHaveBeenCalledWith("Couldn't load “Weekly”.", { kind: "error" });
    expect(hook.result.current.q.loadingPlay).toBeNull();
  });
});
