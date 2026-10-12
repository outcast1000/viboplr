// insertNextAndPlay is what a viboplr://play link runs (utils/appLinks.ts):
// any web page can fire one, so it must start the song without taking the
// user's queue away — insert after the playing entry, never replace.
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
    key: `q:${n}`,
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
  const handlePlay = vi.fn();
  const hook = renderHook(() => {
    const restoredRef = useRef(true);
    return useQueue(restoredRef, handlePlay);
  });
  return { ...hook, handlePlay };
}

describe("insertNextAndPlay", () => {
  it("inserts after the playing entry, keeps the rest, and plays it", () => {
    const { result, handlePlay } = mountQueue();
    act(() => { result.current.playTracks([makeTrack(1), makeTrack(2), makeTrack(3)], 1); });
    handlePlay.mockClear();

    let inserted: QueueTrack | undefined;
    act(() => { inserted = result.current.insertNextAndPlay(makeTrack(9)); });

    expect(result.current.queue.map((t) => t.title)).toEqual(["Song 1", "Song 2", "Song 9", "Song 3"]);
    expect(result.current.queueIndex).toBe(2);
    expect(handlePlay).toHaveBeenCalledTimes(1);
    expect(handlePlay.mock.calls[0][0]).toBe(inserted);
  });

  it("starts an empty queue at index 0", () => {
    const { result, handlePlay } = mountQueue();
    act(() => { result.current.insertNextAndPlay(makeTrack(9)); });
    expect(result.current.queue.map((t) => t.title)).toEqual(["Song 9"]);
    expect(result.current.queueIndex).toBe(0);
    expect(handlePlay).toHaveBeenCalledTimes(1);
  });
});
