// findDuplicates compares paths, but a metadata-only entry (no path yet — the
// stream resolvers find one at play time) has none: such entries match each
// other by song identity instead. Comparing the nulls as paths made every
// one a "duplicate" of every other, so the control API skipped them all.
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

function track(key: string, title: string, artist: string | null, path: string | null): QueueTrack {
  return { key, path, title, artist_name: artist, album_title: null, duration_secs: null, format: null, liked: 0 };
}

function mountQueue() {
  return renderHook(() => {
    const restoredRef = useRef(true);
    return useQueue(restoredRef, vi.fn(), undefined, () => null);
  });
}

describe("findDuplicates", () => {
  it("tells metadata-only entries apart by song, not by their missing path", () => {
    const hook = mountQueue();
    act(() => {
      hook.result.current.enqueueTracks([
        track("q:1", "So What", "Miles Davis", null),
        track("q:2", "Song", "Artist", "file:///song.mp3"),
      ]);
    });
    const incoming = [
      track("q:3", "Blue in Green", "Miles Davis", null),
      track("q:4", "so what", "Miles Davis", null),
      track("q:5", "Other", "Artist", "file:///song.mp3"),
      track("q:6", "Song", "Artist", "file:///other.mp3"),
    ];
    const { duplicates, unique } = hook.result.current.findDuplicates(incoming);
    expect(duplicates.map((t) => t.key)).toEqual(["q:4", "q:5"]);
    expect(unique.map((t) => t.key)).toEqual(["q:3", "q:6"]);
  });
});
