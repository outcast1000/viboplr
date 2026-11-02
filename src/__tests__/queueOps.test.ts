// The shared queue-entry operations (plugin bridge, Cmd+K plugin results,
// control API). Placement and the API's skip live in useQueue.enqueueTracks
// (useQueueEnqueue.test.tsx); what these pin is that addToQueue hands every
// enqueue to it with the right absolute position.
// (There is no like step: queue entries carry no like of their own.)
import { describe, it, expect, vi } from "vitest";
import { addToQueue, playNow, playWithBackfill, type QueueOpsDeps } from "../utils/queueOps";
import type { QueueTrack } from "../types";

const qt = (path: string, title = path): QueueTrack =>
  ({ key: `q:${path}`, path, title, artist_name: "A", album_title: null }) as unknown as QueueTrack;

const OUTCOME = { added: 1, skippedDuplicates: 0 };

function makeDeps(queueIndex = 0) {
  const deps: QueueOpsDeps = {
    playTracks: vi.fn(() => 7),
    enqueueTracks: vi.fn(() => OUTCOME),
    queueIndex: () => queueIndex,
    playWithBackfill: vi.fn(async () => [] as QueueTrack[]),
  };
  return deps;
}

describe("playNow", () => {
  it("replaces the queue and returns the play generation", () => {
    const deps = makeDeps();
    const tracks = [qt("a"), qt("b")];
    const ctx = { name: "Mix", source: "control-api" };
    expect(playNow(deps, tracks, { startIndex: 1, context: ctx })).toBe(7);
    expect(deps.playTracks).toHaveBeenCalledWith(tracks, 1, ctx);
    // A replacing play is not an enqueue.
    expect(deps.enqueueTracks).not.toHaveBeenCalled();
  });

  it("defaults to starting at the first track", () => {
    const deps = makeDeps();
    playNow(deps, [qt("a")]);
    expect(deps.playTracks).toHaveBeenCalledWith([expect.anything()], 0, undefined);
  });
});

describe("addToQueue", () => {
  it("appends by default and returns the enqueue's outcome", () => {
    const deps = makeDeps();
    const tracks = [qt("a"), qt("b")];
    expect(addToQueue(deps, tracks)).toBe(OUTCOME);
    expect(deps.enqueueTracks).toHaveBeenCalledWith(tracks, { position: undefined, skipDuplicates: undefined });
  });

  it("\"next\" inserts after the live queue index; a number is absolute", () => {
    const deps = makeDeps(4);
    addToQueue(deps, [qt("a")], { position: "next", skipDuplicates: true });
    expect(deps.enqueueTracks).toHaveBeenLastCalledWith([expect.anything()], { position: 5, skipDuplicates: true });
    addToQueue(deps, [qt("b")], { position: 2 });
    expect(deps.enqueueTracks).toHaveBeenLastCalledWith([expect.anything()], { position: 2, skipDuplicates: undefined });
  });
});

describe("playWithBackfill", () => {
  it("starts the head and resolves with what the tail appended", async () => {
    const deps = makeDeps();
    const head = [qt("h")];
    const tail = [qt("t1"), qt("t2")];
    vi.mocked(deps.playWithBackfill).mockResolvedValue(tail);
    const resolveTail = async () => tail;
    await expect(playWithBackfill(deps, { head, resolveTail })).resolves.toBe(tail);
    expect(deps.playWithBackfill).toHaveBeenCalledWith({ head, resolveTail });
  });

  // No known first track: still the same path (a switch — the list replaces
  // the queue when it lands), not a no-op.
  it("passes an empty head through", async () => {
    const deps = makeDeps();
    const list = [qt("t")];
    vi.mocked(deps.playWithBackfill).mockResolvedValue(list);
    const resolveTail = async () => list;
    await expect(playWithBackfill(deps, { head: [], resolveTail })).resolves.toBe(list);
    expect(deps.playWithBackfill).toHaveBeenCalledWith({ head: [], resolveTail });
  });
});
