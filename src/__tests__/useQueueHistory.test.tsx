// useQueue's half of the queue history (queue.md "Queue History"): every
// replacement hands the outgoing queue to `beforeReplace` before anything
// changes, and `restoreQueue` puts a queue back without counting as a play.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { useQueue, type OutgoingQueue } from "../hooks/useQueue";
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

function makeTrack(n: number): QueueTrack {
  return { key: `q:t${n}`, path: `file:///song-${n}.mp3`, title: `Song ${n}`, artist_name: "Artist", album_title: "Album", duration_secs: 100, format: "mp3" };
}

function mount(playing: QueueTrack | null = null) {
  const handlePlay = vi.fn();
  const onPlay = vi.fn();
  const handedOver: OutgoingQueue[] = [];
  const hook = renderHook(() => {
    const restoredRef = useRef(true);
    return useQueue(restoredRef, handlePlay, onPlay, () => playing, undefined, (o) => handedOver.push(o));
  });
  return { ...hook, handlePlay, onPlay, handedOver };
}

describe("beforeReplace", () => {
  it("hands over the queue a play replaces, as it was, before it changes", () => {
    const { result, handedOver } = mount();
    act(() => { result.current.playTracks([makeTrack(1), makeTrack(2)], 1, { name: "Album" }); });
    act(() => { result.current.enqueueTracks([makeTrack(3)]); });
    act(() => { result.current.playTracks([makeTrack(9)], 0); });
    // The first play replaced an empty queue; the second the album as edited.
    expect(handedOver).toHaveLength(2);
    expect(handedOver[0]).toMatchObject({ tracks: [], index: -1, context: null, reason: "play" });
    expect(handedOver[1].tracks.map((t) => t.title)).toEqual(["Song 1", "Song 2", "Song 3"]);
    expect(handedOver[1]).toMatchObject({ index: 1, context: { name: "Album" }, reason: "play" });
  });

  it("hands over a cleared queue", () => {
    const { result, handedOver } = mount();
    act(() => { result.current.playTracks([makeTrack(1)], 0); });
    act(() => { result.current.clearQueue(); });
    expect(handedOver.at(-1)).toMatchObject({ reason: "clear", index: 0 });
    expect(handedOver.at(-1)!.tracks).toHaveLength(1);
  });

  it("isn't called by edits that keep the queue", () => {
    const { result, handedOver } = mount();
    act(() => { result.current.playTracks([makeTrack(1), makeTrack(2)], 0); });
    const before = handedOver.length;
    act(() => { result.current.enqueueTracks([makeTrack(3)]); });
    act(() => { result.current.playNextInQueue(makeTrack(4)); });
    act(() => { result.current.removeFromQueue(1); });
    act(() => { result.current.randomizeQueue(); });
    expect(handedOver).toHaveLength(before);
  });
});

describe("restoreQueue", () => {
  it("puts the queue back on its entry and resumes it, without a new play", () => {
    const { result, onPlay, handedOver } = mount();
    act(() => { result.current.playTracks([makeTrack(9)], 0); });
    onPlay.mockClear();
    const resume = vi.fn();
    act(() => { result.current.restoreQueue([makeTrack(1), makeTrack(2), makeTrack(3)], 2, { name: "Album" }, resume); });
    expect(result.current.queue.map((t) => t.title)).toEqual(["Song 1", "Song 2", "Song 3"]);
    expect(result.current.queueIndex).toBe(2);
    expect(result.current.playlistContext).toEqual({ name: "Album" });
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ title: "Song 3" }));
    // Not a play: Latest play and "open Now Playing" don't hear about it.
    expect(onPlay).not.toHaveBeenCalled();
    expect(handedOver.at(-1)).toMatchObject({ reason: "restore" });
    expect(handedOver.at(-1)!.tracks.map((t) => t.title)).toEqual(["Song 9"]);
  });

  // Back right after starting radio from the playing song: the queue it
  // returns to is on that same song, which keeps playing.
  it("keeps the music running when the entry is the song already playing", () => {
    const playing = { ...makeTrack(2), key: "q:live" };
    const { result } = mount(playing);
    const resume = vi.fn();
    act(() => { result.current.restoreQueue([makeTrack(1), makeTrack(2)], 1, null, resume); });
    expect(resume).not.toHaveBeenCalled();
    expect(result.current.queue[1].key).toBe("q:live");
  });

  it("does play a different file of the same song", () => {
    const playing = { ...makeTrack(2), path: "file:///live-take.mp3" };
    const { result } = mount(playing);
    const resume = vi.fn();
    act(() => { result.current.restoreQueue([makeTrack(1), makeTrack(2)], 1, null, resume); });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("ends the play session, dropping a play still loading", () => {
    const { result } = mount();
    act(() => { result.current.playTracks([makeTrack(1)], 0); });
    act(() => { result.current.beginLoadingPlay({ mode: "switch", name: "Radio: X", imagePath: null, source: null, originKey: null }); });
    expect(result.current.loadingPlay).not.toBeNull();
    act(() => { result.current.restoreQueue([makeTrack(2)], 0, null, vi.fn()); });
    expect(result.current.loadingPlay).toBeNull();
  });

  it("ignores an empty list", () => {
    const { result, handedOver } = mount();
    act(() => { result.current.playTracks([makeTrack(1)], 0); });
    const before = handedOver.length;
    act(() => { result.current.restoreQueue([], 0, null, vi.fn()); });
    expect(result.current.queue).toHaveLength(1);
    expect(handedOver).toHaveLength(before);
  });
});
