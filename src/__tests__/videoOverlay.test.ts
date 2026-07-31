import { describe, it, expect } from "vitest";
import { nextQueueTrack } from "../utils/videoOverlay";
import type { QueueTrack } from "../types";

function makeTrack(overrides: Partial<QueueTrack> = {}): QueueTrack {
  return {
    key: "ext:0",
    path: "file:///a.mp4",
    title: "Song",
    artist_name: "Artist",
    album_title: "Album",
    duration_secs: 100,
    format: "mp4",
    liked: 0,
    ...overrides,
  };
}

describe("nextQueueTrack", () => {
  it("returns the track after the current index", () => {
    const a = makeTrack({ key: "ext:0", title: "A" });
    const b = makeTrack({ key: "ext:1", title: "B" });
    expect(nextQueueTrack([a, b], 0)).toEqual({ track: b, index: 1 });
  });

  it("returns null when current is the last track", () => {
    const a = makeTrack({ key: "ext:0", title: "A" });
    expect(nextQueueTrack([a], 0)).toBeNull();
  });

  it("returns null when the queue is empty", () => {
    expect(nextQueueTrack([], 0)).toBeNull();
  });

  it("returns null when queueIndex is negative", () => {
    const a = makeTrack();
    expect(nextQueueTrack([a], -1)).toBeNull();
  });
});
