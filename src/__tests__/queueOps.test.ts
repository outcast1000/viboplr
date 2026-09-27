// The shared queue-entry operations (plugin bridge, Cmd+K plugin results,
// control API). What they exist to guarantee, and what these tests pin: every
// track that lands gets a like reconcile — including ones the user lets in
// through the duplicate banner — and every enqueue runs the duplicate check,
// with the policy deciding only who answers it.
import { describe, it, expect, vi } from "vitest";
import { addToQueue, playNow, playWithBackfill, type QueueOpsDeps } from "../utils/queueOps";
import type { QueueTrack } from "../types";

const qt = (path: string, title = path): QueueTrack =>
  ({ key: `q:${path}`, path, title, artist_name: "A", album_title: null, liked: 0 }) as unknown as QueueTrack;

function makeDeps(queuePaths: string[] = [], queueIndex = 0) {
  const queued = new Set(queuePaths);
  const deps: QueueOpsDeps = {
    playTracks: vi.fn(() => 7),
    enqueueTracks: vi.fn(),
    insertAtPosition: vi.fn(),
    findDuplicates: vi.fn((tracks: QueueTrack[]) => ({
      duplicates: tracks.filter((t) => queued.has(t.path!)),
      unique: tracks.filter((t) => !queued.has(t.path!)),
    })),
    queueIndex: () => queueIndex,
    playWithBackfill: vi.fn(async () => [] as QueueTrack[]),
    askAboutDuplicates: vi.fn(),
    reconcileLikes: vi.fn(),
  };
  return deps;
}

describe("playNow", () => {
  it("replaces the queue, reconciles likes, and returns the play generation", () => {
    const deps = makeDeps(["a"]);
    const tracks = [qt("a"), qt("b")];
    const ctx = { name: "Mix", source: "control-api" };
    expect(playNow(deps, tracks, { startIndex: 1, context: ctx })).toBe(7);
    expect(deps.playTracks).toHaveBeenCalledWith(tracks, 1, ctx);
    expect(deps.reconcileLikes).toHaveBeenCalledWith(tracks);
    // A replacing play never asks about duplicates.
    expect(deps.findDuplicates).not.toHaveBeenCalled();
  });

  it("defaults to starting at the first track", () => {
    const deps = makeDeps();
    playNow(deps, [qt("a")]);
    expect(deps.playTracks).toHaveBeenCalledWith([expect.anything()], 0, undefined);
  });
});

describe("addToQueue", () => {
  it("appends by default and reconciles what landed", () => {
    const deps = makeDeps();
    const tracks = [qt("a"), qt("b")];
    expect(addToQueue(deps, tracks, { duplicates: "ask" }))
      .toEqual({ added: 2, skippedDuplicates: 0, awaitingUser: false });
    expect(deps.enqueueTracks).toHaveBeenCalledWith(tracks);
    expect(deps.reconcileLikes).toHaveBeenCalledWith(tracks);
    expect(deps.askAboutDuplicates).not.toHaveBeenCalled();
  });

  it("\"next\" inserts after the live queue index; a number is absolute", () => {
    const deps = makeDeps([], 4);
    addToQueue(deps, [qt("a")], { position: "next", duplicates: "skip" });
    expect(deps.insertAtPosition).toHaveBeenLastCalledWith([expect.anything()], 5);
    addToQueue(deps, [qt("b")], { position: 2, duplicates: "skip" });
    expect(deps.insertAtPosition).toHaveBeenLastCalledWith([expect.anything()], 2);
    expect(deps.enqueueTracks).not.toHaveBeenCalled();
  });

  it("ask: duplicates raise the banner, insert nothing yet, and hand it the reconcile", () => {
    const deps = makeDeps(["a"], 3);
    const tracks = [qt("a"), qt("b")];
    expect(addToQueue(deps, tracks, { position: "next", duplicates: "ask" }))
      .toEqual({ added: 0, skippedDuplicates: 0, awaitingUser: true });
    expect(deps.askAboutDuplicates).toHaveBeenCalledWith(
      { all: tracks, duplicates: [tracks[0]], unique: [tracks[1]], position: 4 },
      deps.reconcileLikes,
    );
    expect(deps.enqueueTracks).not.toHaveBeenCalled();
    expect(deps.insertAtPosition).not.toHaveBeenCalled();
    expect(deps.reconcileLikes).not.toHaveBeenCalled();
  });

  it("ask: an append leaves the banner's position unset", () => {
    const deps = makeDeps(["a"]);
    addToQueue(deps, [qt("a")], { duplicates: "ask" });
    expect(vi.mocked(deps.askAboutDuplicates).mock.calls[0][0].position).toBeUndefined();
  });

  it("skip: duplicates are left out and counted", () => {
    const deps = makeDeps(["a"]);
    const tracks = [qt("a"), qt("b")];
    expect(addToQueue(deps, tracks, { duplicates: "skip" }))
      .toEqual({ added: 1, skippedDuplicates: 1, awaitingUser: false });
    expect(deps.enqueueTracks).toHaveBeenCalledWith([tracks[1]]);
    expect(deps.reconcileLikes).toHaveBeenCalledWith([tracks[1]]);
  });

  it("allow: everything lands, but the check still runs", () => {
    const deps = makeDeps(["a"]);
    const tracks = [qt("a"), qt("b")];
    expect(addToQueue(deps, tracks, { duplicates: "allow" }))
      .toEqual({ added: 2, skippedDuplicates: 0, awaitingUser: false });
    expect(deps.findDuplicates).toHaveBeenCalledWith(tracks);
    expect(deps.enqueueTracks).toHaveBeenCalledWith(tracks);
  });

  it("skip with nothing new touches neither the queue nor the like store", () => {
    const deps = makeDeps(["a"]);
    expect(addToQueue(deps, [qt("a")], { duplicates: "skip" }))
      .toEqual({ added: 0, skippedDuplicates: 1, awaitingUser: false });
    expect(deps.enqueueTracks).not.toHaveBeenCalled();
    expect(deps.reconcileLikes).not.toHaveBeenCalled();
  });

  it("an empty request is a no-op", () => {
    const deps = makeDeps();
    expect(addToQueue(deps, [], { duplicates: "ask" }))
      .toEqual({ added: 0, skippedDuplicates: 0, awaitingUser: false });
    expect(deps.findDuplicates).not.toHaveBeenCalled();
  });
});

describe("playWithBackfill", () => {
  it("reconciles the head at once and the tail when it lands", async () => {
    const deps = makeDeps();
    const head = [qt("h")];
    const tail = [qt("t1"), qt("t2")];
    let release!: (t: QueueTrack[]) => void;
    vi.mocked(deps.playWithBackfill).mockReturnValue(new Promise((r) => { release = r; }));
    const done = playWithBackfill(deps, { head, resolveTail: async () => tail });
    expect(deps.reconcileLikes).toHaveBeenCalledTimes(1);
    expect(deps.reconcileLikes).toHaveBeenCalledWith(head);
    release(tail);
    await expect(done).resolves.toBe(tail);
    expect(deps.reconcileLikes).toHaveBeenLastCalledWith(tail);
  });

  it("an empty head starts nothing", async () => {
    const deps = makeDeps();
    await expect(playWithBackfill(deps, { head: [], resolveTail: async () => [qt("t")] })).resolves.toEqual([]);
    expect(deps.playWithBackfill).not.toHaveBeenCalled();
  });

  it("a tail that appended nothing (stale / failed) is not reconciled", async () => {
    const deps = makeDeps();
    await playWithBackfill(deps, { head: [qt("h")], resolveTail: async () => [] });
    expect(deps.reconcileLikes).toHaveBeenCalledTimes(1);
  });
});
