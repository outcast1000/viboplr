// Library `Track` copies of a song's `liked` (the library list, Library search
// results, detail-page lists, the track page) follow the track-like store from
// one listener — useTrackLikeCopySync — whatever moved the store: a click, an
// event from another surface, a reload. Code that decides from a library row
// (skip disliked on play, sort by liked) reads these. Queue entries carry no
// `liked` at all.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useState } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../utils/tauriEvents", () => ({ subscribe: () => () => {}, safeUnlisten: () => {}, combineUnlisten: () => () => {} }));

import { useTrackLikeCopySync } from "../contexts/TrackLikeContext";
import { TrackLikeStore, applyLikedCopies, type TrackLikeChange } from "../utils/trackLikeStore";
import { subscribeTrackEvents, type TrackEvent } from "../trackEvents";
import { trackLikeKey } from "../likeKeys";
import type { Track } from "../types";

const JOGA = trackLikeKey("Jóga", "Björk");

function libRow(id: number, title: string, artist: string, liked = 0): Track {
  return { id, title, artist_name: artist, liked } as Track;
}

function mount(store: TrackLikeStore, library: Track[]) {
  return renderHook(() => {
    const [rows, setLibraryTracks] = useState<Track[]>(library);
    useTrackLikeCopySync(store, { setLibraryTracks });
    return rows;
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
    const list = [libRow(1, "Jóga", "Björk", 1), libRow(2, "Creep", "Radiohead")];
    expect(applyLikedCopies(list, () => undefined)).toBe(list);
    expect(applyLikedCopies(list, (k) => (k === JOGA ? 1 : undefined))).toBe(list);
    const next = applyLikedCopies(list, (k) => (k === JOGA ? -1 : undefined));
    expect(next).not.toBe(list);
    expect(next[0].liked).toBe(-1);
    expect(next[1]).toBe(list[1]);
  });
});

describe("useTrackLikeCopySync", () => {
  it("a like on a song moves every library row of it, matched by metadata", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => []);
    // The same song in two collections, one spelled without accents.
    const { result } = mount(store, [libRow(7, "Jóga", "Björk"), libRow(9, "JOGA", "Bjork"), libRow(8, "Creep", "Radiohead")]);
    act(() => store.set(JOGA, -1));
    expect(result.current.map((t) => t.liked)).toEqual([-1, -1, 0]);
  });

  it("the first load corrects every row, including clearing a stale like", async () => {
    const store = new TrackLikeStore();
    const { result } = mount(store, [libRow(1, "Jóga", "Björk", 0), libRow(2, "Gone", "Band", 1)]);
    await act(() => store.load(async () => [{ key: JOGA, liked: 1 }]));
    expect(result.current.map((t) => t.liked)).toEqual([1, 0]);
  });

  it("a reload that changes nothing leaves the list the same array", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => [{ key: JOGA, liked: 1 }]);
    const { result } = mount(store, [libRow(1, "Jóga", "Björk", 1)]);
    const before = result.current;
    await act(() => store.load(async () => [{ key: JOGA, liked: 1 }]));
    expect(result.current).toBe(before);
  });

  it("tells the other copies (search results, detail lists, track page) through a liked track event", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => []);
    mount(store, []);
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
