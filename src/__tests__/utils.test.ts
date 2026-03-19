import { describe, it, expect } from "vitest";
import { formatDuration, isVideoTrack, getInitials, tidalCoverUrl, collectionKindLabel } from "../utils";
import type { Track } from "../types";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1, path: "/test.mp3", title: "Test", artist_id: null,
    artist_name: null, album_id: null, album_title: null, year: null,
    track_number: null, duration_secs: null, format: null, file_size: null,
    collection_id: null, collection_name: null, subsonic_id: null,
    liked: false, deleted: false,
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("formats seconds into m:ss", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(0)).toBe("--:--");
    expect(formatDuration(3600)).toBe("60:00");
    expect(formatDuration(59)).toBe("0:59");
  });

  it("returns --:-- for null/undefined", () => {
    expect(formatDuration(null)).toBe("--:--");
    expect(formatDuration(undefined)).toBe("--:--");
  });
});

describe("isVideoTrack", () => {
  it("returns true for video formats", () => {
    for (const fmt of ["mp4", "m4v", "mov", "webm"]) {
      expect(isVideoTrack(makeTrack({ format: fmt }))).toBe(true);
    }
  });

  it("returns false for audio formats", () => {
    for (const fmt of ["mp3", "flac", "aac", "wav"]) {
      expect(isVideoTrack(makeTrack({ format: fmt }))).toBe(false);
    }
  });

  it("returns false for null format", () => {
    expect(isVideoTrack(makeTrack({ format: null }))).toBe(false);
  });
});

describe("getInitials", () => {
  it("returns first letters of words", () => {
    expect(getInitials("Pink Floyd")).toBe("PF");
    expect(getInitials("Radiohead")).toBe("R");
    expect(getInitials("The Rolling Stones")).toBe("TR");
  });

  it("handles empty string", () => {
    expect(getInitials("")).toBe("");
  });
});

describe("tidalCoverUrl", () => {
  it("converts dashes to slashes and builds URL", () => {
    expect(tidalCoverUrl("ab-cd-ef-gh")).toBe(
      "https://resources.tidal.com/images/ab/cd/ef/gh/320x320.jpg"
    );
  });

  it("accepts custom size", () => {
    expect(tidalCoverUrl("ab-cd", 640)).toBe(
      "https://resources.tidal.com/images/ab/cd/640x640.jpg"
    );
  });

  it("returns null for null input", () => {
    expect(tidalCoverUrl(null)).toBeNull();
  });
});

describe("collectionKindLabel", () => {
  it("returns labels for known kinds", () => {
    expect(collectionKindLabel("local")).toBe("Local");
    expect(collectionKindLabel("subsonic")).toBe("Server");
    expect(collectionKindLabel("tidal")).toBe("TIDAL");
    expect(collectionKindLabel("seed")).toBe("Test");
  });

  it("returns raw kind for unknown", () => {
    expect(collectionKindLabel("unknown")).toBe("unknown");
  });
});
