// The in-app replace (`api.library.replaceTrackFile`): what the host's Replace
// dialog says about the two files, and the "is it the track playing?" decision
// that routes the swap through the player. The swap itself is Rust
// (assistant_write.rs tests); the queue half is asserted through the hook.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { describeQuality, lengthWarning, isTrackBeingReplaced } from "../utils/replaceTrackFile";
import { useQueue } from "../hooks/useQueue";
import type { QueueTrack } from "../types";

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

function entry(over: Partial<QueueTrack> = {}): QueueTrack {
  return {
    key: "q:1",
    path: "file:///music/Sultans of Swing.mp3",
    title: "Sultans of Swing",
    artist_name: "Dire Straits",
    album_title: "Dire Straits",
    duration_secs: 348,
    format: "mp3",
    liked: 0,
    ...over,
  };
}

describe("describeQuality", () => {
  it("reads lossless as depth and rate, not bitrate", () => {
    expect(describeQuality({ format: "flac", bitDepth: 16, sampleRate: 44100, bitrateKbps: 900, fileSize: 40_000_000 }))
      .toBe("FLAC · 16-bit · 44.1 kHz · 38.1 MB");
  });

  it("reads lossy as bitrate", () => {
    expect(describeQuality({ format: "mp3", bitrateKbps: 192, sampleRate: 44100, fileSize: 8_300_000 }))
      .toBe("MP3 · 192 kbps · 7.9 MB");
  });

  it("drops what it doesn't know rather than printing a placeholder", () => {
    expect(describeQuality({ format: "flac", sampleRate: 48000 })).toBe("FLAC · 48 kHz");
    expect(describeQuality({})).toBe("Unknown format");
  });
});

describe("lengthWarning", () => {
  it("is quiet when the lengths agree within a few seconds", () => {
    expect(lengthWarning({ durationSecs: 348 }, { durationSecs: 351 })).toBeNull();
  });

  it("warns when they don't — a live take or a different song", () => {
    expect(lengthWarning({ durationSecs: 348 }, { durationSecs: 420 })).toMatch(/different recording/);
  });

  it("says nothing when either length is unknown", () => {
    expect(lengthWarning({ durationSecs: 348 }, {})).toBeNull();
    expect(lengthWarning({}, { durationSecs: 420 })).toBeNull();
  });
});

describe("isTrackBeingReplaced", () => {
  const path = "file:///music/Sultans of Swing.mp3";

  it("matches by the cached library id when the entry carries one", () => {
    expect(isTrackBeingReplaced(entry({ libraryId: 7 }), 7, path)).toBe(true);
    expect(isTrackBeingReplaced(entry({ libraryId: 8, path }), 7, path)).toBe(false);
  });

  it("falls back to the file URI when the id isn't cached — absent is not 'not in the library'", () => {
    expect(isTrackBeingReplaced(entry({ libraryId: null }), 7, path)).toBe(true);
    expect(isTrackBeingReplaced(entry({ libraryId: undefined, path: "file:///other.mp3" }), 7, path)).toBe(false);
  });

  it("is false with nothing playing", () => {
    expect(isTrackBeingReplaced(null, 7, path)).toBe(false);
  });
});

describe("useQueue.replaceTrackPath", () => {
  function mountQueue() {
    return renderHook(() => {
      const restoredRef = useRef(true);
      return useQueue(restoredRef, vi.fn(), undefined, () => null);
    });
  }

  it("moves every entry holding the old file to the new one, and nothing else", () => {
    const hook = mountQueue();
    act(() => {
      hook.result.current.enqueueTracks([
        entry({ key: "q:1" }),
        entry({ key: "q:2", path: "file:///music/Sultans of Swing.mp3x", title: "Not this one" }),
        entry({ key: "q:3" }),
      ]);
    });
    act(() => { hook.result.current.replaceTrackPath("file:///music/Sultans of Swing.mp3", "file:///music/Sultans of Swing.flac", "flac"); });
    const [a, b, c] = hook.result.current.queue;
    expect(a.path).toBe("file:///music/Sultans of Swing.flac");
    expect(a.format).toBe("flac");
    expect(c.path).toBe("file:///music/Sultans of Swing.flac");
    expect(b.path).toBe("file:///music/Sultans of Swing.mp3x");
    expect(b.format).toBe("mp3");
  });
});
