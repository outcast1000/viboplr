// useLatestPlay: the Latest play cards as the queue's Back / Forward history
// (queue.md "Queue History"). The cursor, the as-left rewrite and the order a
// new play leaves the cards in live here; the pure parts are queueHistory.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { QueueTrack } from "../types";
import type { OutgoingQueue, PlaylistContext } from "../hooks/useQueue";

const snapshots = new Map<string, unknown>();
const stored = new Map<string, unknown>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "recent_play_write": snapshots.set(args.id as string, args.manifest); return null;
      case "recent_play_read": return snapshots.get(args.id as string);
      case "recent_play_delete": for (const id of args.ids as string[]) snapshots.delete(id); return null;
      case "recent_play_gc": return 0;
      case "find_track_ids_by_paths": return [];
      default: return null;
    }
  }),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("../store", () => ({
  store: {
    get: vi.fn(async (k: string) => stored.get(k)),
    set: vi.fn(async (k: string, v: unknown) => { stored.set(k, v); }),
  },
}));
vi.mock("../playback/positionStore", () => ({ getPlaybackPosition: () => 42.7 }));

import { useLatestPlay, type LatestPlayDeps } from "../hooks/useLatestPlay";
import { sessionKey } from "../utils/recentPlays";

beforeEach(() => { snapshots.clear(); stored.clear(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function makeTrack(n: number): QueueTrack {
  return { key: `q:t${n}`, path: `file:///song-${n}.mp3`, title: `Song ${n}`, artist_name: "Artist", album_title: "Album", duration_secs: 100, format: "mp3" };
}
const album = (name: string): PlaylistContext => ({ name, source: "album", metadata: { artist: "Artist" } });

function mount(opts: { playing?: boolean } = {}) {
  const restoreQueue = vi.fn();
  const deps = {
    queueHook: { queue: [makeTrack(0)], restoreQueue, playTracks: vi.fn() },
    playActions: {}, playMixtapeFile: vi.fn(), notify: vi.fn(),
    isPlaying: () => opts.playing ?? true,
    playAt: vi.fn(), cueAt: vi.fn(), resume: vi.fn(),
  } as unknown as LatestPlayDeps;
  const hook = renderHook(() => {
    const restoredRef = useRef(true);
    const depsRef = useRef<LatestPlayDeps | null>(deps);
    return useLatestPlay(restoredRef, depsRef);
  });
  // The fake queue: a restore hands over the queue it replaces, as useQueue's does.
  restoreQueue.mockImplementation((tracks: QueueTrack[], index: number, _ctx: unknown, resume: (t: QueueTrack) => void) => {
    hook.result.current.beforeReplace({ tracks: [makeTrack(99)], index: 0, context: null, reason: "restore" });
    resume(tracks[index]);
  });
  return { ...hook, deps, restoreQueue };
}

/** Drive one play the way useQueue does: hand over the old queue, then onPlay. */
function play(h: ReturnType<typeof mount>, out: OutgoingQueue | null, tracks: QueueTrack[], ctx: PlaylistContext | null) {
  if (out) h.result.current.beforeReplace(out);
  h.result.current.onPlay(tracks, 0, ctx, { gen: 1, fillsLater: false });
}

const names = (h: ReturnType<typeof mount>) =>
  [...(h.result.current.recentPlays ?? [])].sort((a, b) => b.ts - a.ts).map((p) => p.name);

describe("useLatestPlay", () => {
  it("records each play as a card and points the cursor at it", async () => {
    const h = mount();
    await waitFor(() => expect(h.result.current.recentPlays).not.toBeNull());
    act(() => play(h, null, [makeTrack(1), makeTrack(2)], album("A")));
    await waitFor(() => expect(names(h)).toEqual(["A"]));
    expect(h.result.current.currentKey).toBe(sessionKey({ source: "album", name: "A", artistName: "Artist" }));
    expect(h.result.current.backTo).toBeNull();
  });

  it("rewrites the replaced card as it was left and puts it behind the new one", async () => {
    const h = mount();
    await waitFor(() => expect(h.result.current.recentPlays).not.toBeNull());
    act(() => play(h, null, [makeTrack(1)], album("A")));
    await waitFor(() => expect(names(h)).toEqual(["A"]));
    act(() => play(h, null, [makeTrack(5)], album("B")));
    await waitFor(() => expect(names(h)).toEqual(["B", "A"]));
    // Back to A, then a new play C: A was the last thing heard, so it lands
    // right behind C and ahead of B.
    act(() => h.result.current.goBack());
    await waitFor(() => expect(h.restoreQueue).toHaveBeenCalled());
    const edited = [makeTrack(1), makeTrack(2), makeTrack(3)];
    act(() => play(h, { tracks: edited, index: 2, context: album("A"), reason: "play" }, [makeTrack(7)], album("C")));
    await waitFor(() => expect(names(h)).toEqual(["C", "A", "B"]));
    const a = h.result.current.recentPlays!.find((p) => p.name === "A")!;
    expect(a).toMatchObject({ startIndex: 2, positionSecs: 42 });
    expect((snapshots.get(a.snapshotId!) as { tracks: unknown[] }).tracks).toHaveLength(3);
  });

  it("Back puts the previous card back where it was left, Forward returns", async () => {
    const h = mount();
    await waitFor(() => expect(h.result.current.recentPlays).not.toBeNull());
    act(() => play(h, null, [makeTrack(1), makeTrack(2)], album("A")));
    await waitFor(() => expect(names(h)).toEqual(["A"]));
    act(() => play(h, { tracks: [makeTrack(1), makeTrack(2)], index: 1, context: album("A"), reason: "play" }, [makeTrack(5)], album("B")));
    await waitFor(() => expect(h.result.current.backTo?.name).toBe("A"));

    act(() => h.result.current.goBack());
    await waitFor(() => expect(h.restoreQueue).toHaveBeenCalledTimes(1));
    const [tracks, index, ctx] = h.restoreQueue.mock.calls[0];
    expect((tracks as QueueTrack[]).map((t) => t.title)).toEqual(["Song 1", "Song 2"]);
    expect(index).toBe(1);
    expect(ctx).toMatchObject({ name: "A", source: "album" });
    // Playing now, so it resumes at the position it was left at.
    expect(h.deps.playAt).toHaveBeenCalledWith(expect.objectContaining({ title: "Song 2" }), 42);
    await waitFor(() => expect(h.result.current.forwardTo?.name).toBe("B"));
    // Stepping doesn't reorder the cards.
    expect(names(h)).toEqual(["B", "A"]);
    expect(h.result.current.backTo).toBeNull();
  });

  it("cues instead of playing when Back is pressed while paused", async () => {
    const h = mount({ playing: false });
    await waitFor(() => expect(h.result.current.recentPlays).not.toBeNull());
    act(() => play(h, null, [makeTrack(1)], album("A")));
    act(() => play(h, { tracks: [makeTrack(1)], index: 0, context: album("A"), reason: "play" }, [makeTrack(5)], album("B")));
    await waitFor(() => expect(h.result.current.backTo?.name).toBe("A"));
    act(() => h.result.current.goBack());
    await waitFor(() => expect(h.deps.cueAt).toHaveBeenCalledWith(expect.objectContaining({ title: "Song 1" }), 42));
    expect(h.deps.playAt).not.toHaveBeenCalled();
  });

  it("records a queue no play made as a card when it is left", async () => {
    const h = mount();
    await waitFor(() => expect(h.result.current.recentPlays).not.toBeNull());
    // Nothing recorded the live queue (built by hand): leaving it makes a card.
    act(() => play(h, { tracks: [makeTrack(1), makeTrack(2)], index: 0, context: null, reason: "play" }, [makeTrack(5)], album("B")));
    await waitFor(() => expect(h.result.current.recentPlays).toHaveLength(2));
    const q = h.result.current.recentPlays!.find((p) => p.source === "queue")!;
    expect(q.name).toMatch(/^Your queue · \d\d:\d\d$/);
    expect(names(h)[0]).toBe("B");
  });

  it("an emptied queue leaves no cursor; Back goes to the card that was cleared", async () => {
    const h = mount();
    await waitFor(() => expect(h.result.current.recentPlays).not.toBeNull());
    act(() => play(h, null, [makeTrack(1)], album("A")));
    act(() => play(h, { tracks: [makeTrack(1)], index: 0, context: album("A"), reason: "play" }, [makeTrack(5)], album("B")));
    await waitFor(() => expect(names(h)).toEqual(["B", "A"]));
    act(() => h.result.current.beforeReplace({ tracks: [makeTrack(5)], index: 0, context: album("B"), reason: "clear" }));
    await waitFor(() => expect(h.result.current.currentKey).toBeNull());
    expect(h.result.current.backTo?.name).toBe("B");
  });

  it("restores the cursor from the store at launch", async () => {
    stored.set("recentPlaySessions", [{ source: "album", name: "A", artistName: "Artist", ts: 1 }, { source: "album", name: "B", artistName: "Artist", ts: 2 }]);
    stored.set("latestPlayCurrent", "album::a::artist");
    const h = mount();
    await waitFor(() => expect(h.result.current.forwardTo?.name).toBe("B"));
    expect(h.result.current.backTo).toBeNull();
  });
});
