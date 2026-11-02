// useQueue.enqueueTracks adds what it was given — at the end or at a position.
// There is no duplicate prompt: only the control API leaves out tracks already
// queued (`skipDuplicates`), and the count it reports comes from here.
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

function track(name: string): QueueTrack {
  return {
    key: `q:${name}`, path: `file:///${name}.mp3`, title: name, artist_name: "A",
    album_title: null, duration_secs: null, format: null,
  };
}

function mountQueue() {
  return renderHook(() => {
    const restoredRef = useRef(true);
    return useQueue(restoredRef, vi.fn(), undefined, () => null);
  });
}

const titles = (q: QueueTrack[]) => q.map((t) => t.title);

describe("enqueueTracks", () => {
  it("adds duplicates like anything else", () => {
    const hook = mountQueue();
    act(() => { hook.result.current.enqueueTracks([track("a")]); });
    let outcome;
    act(() => { outcome = hook.result.current.enqueueTracks([track("a"), track("b")]); });
    expect(outcome).toEqual({ added: 2, skippedDuplicates: 0 });
    expect(titles(hook.result.current.queue)).toEqual(["a", "a", "b"]);
  });

  it("skipDuplicates leaves out what is already queued and counts it", () => {
    const hook = mountQueue();
    act(() => { hook.result.current.enqueueTracks([track("a")]); });
    let skip, none;
    act(() => { skip = hook.result.current.enqueueTracks([track("a"), track("b")], { skipDuplicates: true }); });
    expect(skip).toEqual({ added: 1, skippedDuplicates: 1 });
    act(() => { none = hook.result.current.enqueueTracks([track("b")], { skipDuplicates: true }); });
    expect(none).toEqual({ added: 0, skippedDuplicates: 1 });
    expect(titles(hook.result.current.queue)).toEqual(["a", "b"]);
  });

  it("an insert before the playing entry keeps the index on it", () => {
    const hook = mountQueue();
    act(() => { hook.result.current.enqueueTracks([track("a"), track("b")]); });
    act(() => { hook.result.current.setQueueIndex(1); });
    act(() => { hook.result.current.enqueueTracks([track("x"), track("y")], { position: 0 }); });
    expect(titles(hook.result.current.queue)).toEqual(["x", "y", "a", "b"]);
    expect(hook.result.current.queueIndex).toBe(3);
  });

  it("an empty request is a no-op", () => {
    const hook = mountQueue();
    let outcome;
    act(() => { outcome = hook.result.current.enqueueTracks([]); });
    expect(outcome).toEqual({ added: 0, skippedDuplicates: 0 });
    expect(hook.result.current.queue).toEqual([]);
  });
});
