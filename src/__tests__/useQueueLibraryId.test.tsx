// `QueueTrack.libraryId` is provenance, `key` is render identity — the split
// exists because the two have opposite uniqueness requirements, and the de-dupe
// in `withUniqueKeys` used to resolve the conflict by destroying provenance
// (when it lived in the `lib:N` key). Asserted through the hook because the
// re-keying lives in useQueue state, not in a pure helper.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useQueue } from "../hooks/useQueue";
import type { Track, QueueTrack } from "../types";
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

function libTrack(n: number): QueueTrack {
  return {
    key: `lib:${n}`,
    libraryId: n,
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
  return renderHook(() => {
    const restoredRef = useRef(true);
    return useQueue(restoredRef, handlePlay, undefined, () => null);
  });
}

describe("libraryId survives queue key de-duplication", () => {
  it("keeps both copies addressable when the same library track is enqueued twice", () => {
    const hook = mountQueue();
    act(() => { hook.result.current.enqueueTracks([libTrack(42)]); });
    act(() => { hook.result.current.enqueueTracks([libTrack(42)]); });

    const queue = hook.result.current.queue;
    expect(queue).toHaveLength(2);
    // Distinct render identities — a collision here is the "phantom row" bug.
    expect(queue[0].key).not.toBe(queue[1].key);
    // ...but the same provenance, which is what makes Delete / Download / View
    // Details behave identically no matter which copy was right-clicked.
    expect(queue.map(t => t.libraryId)).toEqual([42, 42]);
    // The fixture hands both copies the same key on purpose, to exercise the
    // de-dupe; the second is re-keyed to a fresh `q:N` and so no longer
    // restates the row id, which is exactly why provenance can't live there.
    expect(queue[1].key).toMatch(/^q:\d+$/);
  });

  it("keeps provenance for a track repeated within a single played list", () => {
    const hook = mountQueue();
    act(() => { hook.result.current.playTracks([libTrack(7), libTrack(7)], 0); });

    const queue = hook.result.current.queue;
    expect(queue[0].key).not.toBe(queue[1].key);
    expect(queue.map(t => t.libraryId)).toEqual([7, 7]);
  });

  it("leaves libraryId absent for a track that has no library row", () => {
    const hook = mountQueue();
    const external: QueueTrack = { ...libTrack(1), key: "ext:99", libraryId: null };
    act(() => { hook.result.current.enqueueTracks([external]); });
    expect(hook.result.current.queue[0].libraryId).toBeNull();
  });
});

describe("raw library Tracks are converted at the queue's door", () => {
  // The main play paths (list double-click, context-menu Play, play-all, the
  // control API) pass raw `Track[]`, which type-checks structurally against
  // `QueueTrack[]` but carries `id`, not `libraryId`. `toQueueTracks` at the
  // door is what stamps provenance for them — without it every id-based
  // consumer (the now-playing row highlight, queue View Details) went dark
  // for the most common plays.
  function rawLibraryTrack(n: number): Track {
    return {
      id: n,
      path: `file:///song-${n}.mp3`,
      title: `Song ${n}`,
      artist_id: 1,
      artist_name: "Artist",
      album_id: 1,
      album_title: "Album",
      year: null,
      track_number: null,
      duration_secs: 100,
      format: "mp3",
      file_size: null,
      collection_id: 1,
      collection_name: "Music",
      liked: 0,
      added_at: null,
      modified_at: null,
    };
  }

  it("playTracks stamps libraryId and mints a fresh key for a raw Track", () => {
    const hook = mountQueue();
    act(() => { hook.result.current.playTracks([rawLibraryTrack(42)], 0); });

    const [entry] = hook.result.current.queue;
    expect(entry.libraryId).toBe(42);
    // Fresh key, not the row's `lib:42` — and no leftover `id` field: the
    // entry is a real QueueTrack, not a Track wearing one's type.
    expect(entry.key).toMatch(/^q:\d+$/);
    expect("id" in entry).toBe(false);
  });

  it("enqueueTracks converts raw Tracks and passes QueueTracks through untouched", () => {
    const hook = mountQueue();
    const already = libTrack(7);
    act(() => { hook.result.current.enqueueTracks([rawLibraryTrack(42), already]); });

    const queue = hook.result.current.queue;
    expect(queue.map(t => t.libraryId)).toEqual([42, 7]);
    // The QueueTrack kept its own key (no collision to resolve).
    expect(queue[1].key).toBe("lib:7");
  });
});
