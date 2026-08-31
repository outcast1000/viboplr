// playTracks' continuation rule: when a new list replaces the queue and opens
// on the very song that's already audibly playing (Start Radio — core or
// plugin — seeds the station with the current track), the queue is replaced
// around the music instead of restarting it from zero. Asserted here because
// the decision lives in useQueue state, not a pure helper.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useQueue } from "../hooks/useQueue";
import type { QueueTrack } from "../types";
import { useRef } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

// Queue persistence + the thumb-ready listener are side channels this test
// doesn't exercise; stub them so the hook mounts without a backend.
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

function makeTrack(n: number, overrides: Partial<QueueTrack> = {}): QueueTrack {
  return {
    key: `lib:${n}`,
    path: `file:///song-${n}.mp3`,
    title: `Song ${n}`,
    artist_name: "Artist",
    album_title: "Album",
    duration_secs: 100,
    format: "mp3",
    liked: 0,
    ...overrides,
  };
}

/** Mount useQueue with a settled `restoredRef` and a controllable "what's
 *  audibly playing" answer. */
function mountQueue(getPlaying: () => QueueTrack | null) {
  const handlePlay = vi.fn();
  const hook = renderHook(() => {
    const restoredRef = useRef(true);
    return useQueue(restoredRef, handlePlay, undefined, getPlaying);
  });
  return { hook, handlePlay };
}

describe("playTracks continuation", () => {
  it("keeps the current track playing when the new list opens on it", () => {
    const { hook, handlePlay } = mountQueue(() => makeTrack(1));
    act(() => {
      hook.result.current.playTracks([makeTrack(1), makeTrack(2)], 0, { name: "Radio: Song 1", source: "radio" });
    });

    expect(handlePlay).not.toHaveBeenCalled();
    expect(hook.result.current.queue.map((t) => t.title)).toEqual(["Song 1", "Song 2"]);
    expect(hook.result.current.queueIndex).toBe(0);
    // The rest of the replacement still happens — new context, new banner.
    expect(hook.result.current.playlistContext).toMatchObject({ name: "Radio: Song 1" });
  });

  // A same-song copy from another surface carries a different ext:/lib: key;
  // sameSong's title+artist fallback is what matches it (a plugin radio's seed
  // is a freshly minted QueueTrack, never the playing object itself).
  it("matches a same-song copy by metadata and adopts the playing key", () => {
    const playing = makeTrack(1, { key: "ext:41" });
    const { hook, handlePlay } = mountQueue(() => playing);
    act(() => {
      hook.result.current.playTracks([makeTrack(1), makeTrack(2)], 0);
    });

    expect(handlePlay).not.toHaveBeenCalled();
    // Key-based identity (edit-info patching, sameSong's fast path) keeps
    // seeing one song: the queue entry now carries the playing copy's key.
    expect(hook.result.current.queue[0].key).toBe("ext:41");
  });

  it("does not adopt the playing key when another entry already holds it", () => {
    const playing = makeTrack(2); // key lib:2
    const { hook, handlePlay } = mountQueue(() => playing);
    act(() => {
      hook.result.current.playTracks([makeTrack(2, { key: "ext:5" }), makeTrack(2)], 0);
    });

    expect(handlePlay).not.toHaveBeenCalled();
    // Still continues, but the first entry keeps its own key — adopting lib:2
    // would collide with the second entry and break React reconciliation.
    const keys = hook.result.current.queue.map((t) => t.key);
    expect(keys[0]).toBe("ext:5");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("restarts when nothing is audibly playing", () => {
    const { hook, handlePlay } = mountQueue(() => null);
    act(() => {
      hook.result.current.playTracks([makeTrack(1), makeTrack(2)], 0);
    });
    expect(handlePlay).toHaveBeenCalledTimes(1);
    expect(handlePlay.mock.calls[0][0]).toMatchObject({ title: "Song 1" });
  });

  it("restarts when the new list opens on a different song", () => {
    const { hook, handlePlay } = mountQueue(() => makeTrack(3));
    act(() => {
      hook.result.current.playTracks([makeTrack(1), makeTrack(2)], 0);
    });
    expect(handlePlay).toHaveBeenCalledTimes(1);
  });

  // An explicit click deeper into a list is "play this now", even when it lands
  // on the song already playing — only the first entry qualifies.
  it("restarts on an explicit start deeper in the list", () => {
    const { hook, handlePlay } = mountQueue(() => makeTrack(2));
    act(() => {
      hook.result.current.playTracks([makeTrack(1), makeTrack(2)], 1);
    });
    expect(handlePlay).toHaveBeenCalledTimes(1);
    expect(handlePlay.mock.calls[0][0]).toMatchObject({ title: "Song 2" });
  });

  // A continuation is still a fresh play session: the plugin radio path plays
  // the seed via playWithBackfill and appends the station to the generation
  // playTracks returns, so that generation must be the live one.
  it("still starts a fresh play session for the backfill tail", () => {
    const { hook } = mountQueue(() => makeTrack(1));
    let oldGen = 0;
    act(() => { oldGen = hook.result.current.playTracks([makeTrack(1)], 0); });
    let gen = 0;
    act(() => { gen = hook.result.current.playTracks([makeTrack(1)], 0); });

    let staleAppended = true;
    act(() => { staleAppended = hook.result.current.appendToPlaySession(oldGen, [makeTrack(9)]); });
    expect(staleAppended).toBe(false);

    let appended = false;
    act(() => { appended = hook.result.current.appendToPlaySession(gen, [makeTrack(2)]); });
    expect(appended).toBe(true);
    expect(hook.result.current.queue.map((t) => t.title)).toEqual(["Song 1", "Song 2"]);
  });
});
