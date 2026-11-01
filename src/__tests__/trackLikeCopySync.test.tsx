// Copies of a song's `liked` (library rows, queue entries, the playing track,
// search/detail lists) follow the track-like store from one listener —
// useTrackLikeCopySync — whatever moved the store: a click, an event from
// another surface, a reload. The code that still decides from a copy
// (skip disliked on play, sort by liked, radio seed weights) reads these.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useState } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../utils/tauriEvents", () => ({ subscribe: () => () => {}, safeUnlisten: () => {}, combineUnlisten: () => () => {} }));

import { useTrackLikeCopySync } from "../contexts/TrackLikeContext";
import { TrackLikeStore, applyLikedCopies, type TrackLikeChange } from "../utils/trackLikeStore";
import { subscribeTrackEvents, type TrackEvent } from "../trackEvents";
import { trackLikeKey } from "../likeKeys";
import type { QueueTrack, Track } from "../types";

const JOGA = trackLikeKey("Jóga", "Björk");

function libRow(id: number, title: string, artist: string, liked = 0): Track {
  return { id, title, artist_name: artist, liked } as Track;
}
function entry(key: string, title: string, artist: string, liked = 0): QueueTrack {
  return { key, path: null, title, artist_name: artist, album_title: null, duration_secs: null, format: null, liked };
}

function mount(store: TrackLikeStore, init: { library?: Track[]; queue?: QueueTrack[]; current?: QueueTrack | null }) {
  return renderHook(() => {
    const [library, setLibraryTracks] = useState<Track[]>(init.library ?? []);
    const [queue, setQueue] = useState<QueueTrack[]>(init.queue ?? []);
    const [current, setCurrentTrack] = useState<QueueTrack | null>(init.current ?? null);
    useTrackLikeCopySync(store, { setLibraryTracks, setQueue, setCurrentTrack });
    return { library, queue, current };
  });
}

afterEach(cleanup);

describe("TrackLikeStore change notifications", () => {
  it("names the key a write moved, and stays quiet for a write that moved nothing", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => []);
    const seen: TrackLikeChange[] = [];
    store.onChange((c) => seen.push(c));
    store.set(JOGA, 1);
    store.set(JOGA, 1);
    store.set(JOGA, 0);
    expect(seen).toEqual([{ keys: [JOGA] }, { keys: [JOGA] }]);
  });

  it("reports the first load as everything, a reload as its diff, an unchanged reload as nothing", async () => {
    const store = new TrackLikeStore();
    const seen: TrackLikeChange[] = [];
    store.onChange((c) => seen.push(c));
    await store.load(async () => [{ key: JOGA, liked: 1 }]);
    await store.load(async () => [{ key: JOGA, liked: 1 }]);
    await store.load(async () => []);
    expect(seen).toEqual([{ all: true }, { keys: [JOGA] }]);
  });
});

describe("applyLikedCopies", () => {
  it("keeps the array and untouched rows identical when nothing moved", () => {
    const list = [entry("q:1", "Jóga", "Björk", 1), entry("q:2", "Creep", "Radiohead")];
    expect(applyLikedCopies(list, () => undefined)).toBe(list);
    expect(applyLikedCopies(list, (k) => (k === JOGA ? 1 : undefined))).toBe(list);
    const next = applyLikedCopies(list, (k) => (k === JOGA ? -1 : undefined));
    expect(next).not.toBe(list);
    expect(next[0].liked).toBe(-1);
    expect(next[1]).toBe(list[1]);
  });
});

describe("useTrackLikeCopySync", () => {
  it("a like on a song moves every copy of it — library row, queue entries, playing track — by metadata", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => []);
    const { result } = mount(store, {
      library: [libRow(7, "Jóga", "Björk"), libRow(8, "Creep", "Radiohead")],
      // A plugin copy with a different spelling and no library id.
      queue: [entry("q:1", "JOGA", "Bjork"), entry("q:2", "Creep", "Radiohead")],
      current: entry("q:1", "JOGA", "Bjork"),
    });
    act(() => store.set(JOGA, -1));
    expect(result.current.library[0].liked).toBe(-1);
    expect(result.current.queue[0].liked).toBe(-1);
    expect(result.current.current?.liked).toBe(-1);
    // The other song is untouched.
    expect(result.current.library[1].liked).toBe(0);
  });

  it("a change from elsewhere (an event, a revert) moves the copies the same way", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => [{ key: JOGA, liked: 1 }]);
    const { result } = mount(store, { queue: [entry("q:1", "Jóga", "Björk", 1)] });
    act(() => store.set(JOGA, 0));
    expect(result.current.queue[0].liked).toBe(0);
  });

  it("the first load corrects every copy, including clearing a stale like", async () => {
    const store = new TrackLikeStore();
    const { result } = mount(store, {
      queue: [entry("q:1", "Jóga", "Björk", 0), entry("q:2", "Gone", "Band", 1)],
    });
    await act(() => store.load(async () => [{ key: JOGA, liked: 1 }]));
    expect(result.current.queue.map((t) => t.liked)).toEqual([1, 0]);
  });

  it("a reload that changes nothing leaves the queue the same array (no selection reset, no save)", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => [{ key: JOGA, liked: 1 }]);
    const { result } = mount(store, { queue: [entry("q:1", "Jóga", "Björk", 1)] });
    const before = result.current.queue;
    await act(() => store.load(async () => [{ key: JOGA, liked: 1 }]));
    expect(result.current.queue).toBe(before);
  });

  it("tells the other copies (search results, detail lists) through a liked track event", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => []);
    mount(store, {});
    const events: TrackEvent[] = [];
    const stop = subscribeTrackEvents((e) => events.push(e));
    act(() => store.set(JOGA, 1));
    stop();
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe("liked");
    if (e.kind === "liked") {
      expect(e.likedOf(JOGA)).toBe(1);
      expect(e.likedOf(trackLikeKey("Creep", "Radiohead"))).toBeUndefined();
    }
  });
});
