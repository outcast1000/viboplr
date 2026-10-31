// What a filling play session reports to Latest play. A plugin radio plays a
// one-track head and appends the station behind it seconds later; the card is
// recorded from `onPlaySessionFilled`, so it must carry head + tail — the bug
// this pins was a card that replayed only the seed.
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

function makeTrack(n: number): QueueTrack {
  return {
    key: `q:t${n}`,
    path: `file:///song-${n}.mp3`,
    title: `Song ${n}`,
    artist_name: "Artist",
    album_title: "Album",
    duration_secs: 100,
    format: "mp3",
    liked: 0,
  };
}

function mountQueue() {
  const onPlay = vi.fn();
  const onFilled = vi.fn();
  const hook = renderHook(() => {
    const restoredRef = useRef(true);
    return useQueue(restoredRef, vi.fn(), onPlay, () => null, undefined, onFilled);
  });
  return { hook, onPlay, onFilled };
}

const titles = (tracks: QueueTrack[]) => tracks.map((t) => t.title);

describe("onPlaySessionFilled", () => {
  it("reports the head and the appended tail once the backfill settles", () => {
    const { hook, onPlay, onFilled } = mountQueue();
    let gen = 0;
    act(() => {
      gen = hook.result.current.playTracks([makeTrack(1)], 0, { name: "Rammstein & Similar" }, { fillsLater: true });
      hook.result.current.markBackfillPending(gen);
    });
    // The head is announced as a filling play, under the generation it returned.
    expect(onPlay).toHaveBeenCalledWith(expect.any(Array), 0, { name: "Rammstein & Similar" }, { gen, fillsLater: true });
    expect(onFilled).not.toHaveBeenCalled();

    act(() => { hook.result.current.appendToPlaySession(gen, [makeTrack(2), makeTrack(3)]); });
    expect(onFilled).not.toHaveBeenCalled();
    act(() => { hook.result.current.settleBackfill(gen); });

    expect(onFilled).toHaveBeenCalledTimes(1);
    expect(onFilled.mock.calls[0][0]).toBe(gen);
    expect(titles(onFilled.mock.calls[0][1])).toEqual(["Song 1", "Song 2", "Song 3"]);
  });

  it("leaves the user's own enqueues out of the session", () => {
    const { hook, onFilled } = mountQueue();
    let gen = 0;
    act(() => {
      gen = hook.result.current.playTracks([makeTrack(1)], 0, null, { fillsLater: true });
      hook.result.current.markBackfillPending(gen);
    });
    act(() => { hook.result.current.enqueueTracks([makeTrack(9)]); });
    act(() => { hook.result.current.appendToPlaySession(gen, [makeTrack(2)]); });
    act(() => { hook.result.current.settleBackfill(gen); });
    expect(titles(onFilled.mock.calls[0][1])).toEqual(["Song 1", "Song 2"]);
  });

  it("reports the head alone when the tail never lands", () => {
    const { hook, onFilled } = mountQueue();
    let gen = 0;
    act(() => {
      gen = hook.result.current.playTracks([makeTrack(1)], 0, null, { fillsLater: true });
      hook.result.current.markBackfillPending(gen);
    });
    act(() => { hook.result.current.settleBackfill(gen); });
    expect(titles(onFilled.mock.calls[0][1])).toEqual(["Song 1"]);
  });

  it("stays quiet for a session the user already replaced", () => {
    const { hook, onPlay, onFilled } = mountQueue();
    let gen = 0;
    act(() => {
      gen = hook.result.current.playTracks([makeTrack(1)], 0, null, { fillsLater: true });
      hook.result.current.markBackfillPending(gen);
    });
    act(() => { hook.result.current.playTracks([makeTrack(5), makeTrack(6)], 0); });
    // The ordinary play is announced as complete, under the next generation.
    expect(onPlay).toHaveBeenLastCalledWith(expect.any(Array), 0, null, { gen: gen + 1, fillsLater: false });
    act(() => {
      hook.result.current.appendToPlaySession(gen, [makeTrack(2)]);
      hook.result.current.settleBackfill(gen);
    });
    expect(onFilled).not.toHaveBeenCalled();
  });
});
