import { describe, it, expect } from "vitest";
import { formatDuration, isVideoTrack, getInitials, tidalCoverUrl, collectionKindLabel, parseSubsonicUrl, shouldScrobble } from "../utils";
import type { Track } from "../types";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1, path: "file:///test.mp3", title: "Test", artist_id: null,
    artist_name: null, album_id: null, album_title: null, year: null,
    track_number: null, duration_secs: null, format: null, file_size: null,
    collection_id: null, collection_name: null,
    liked: 0, youtube_url: null,
    added_at: null, modified_at: null,
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

describe("parseSubsonicUrl", () => {
  it("parses user:pass@host", () => {
    const result = parseSubsonicUrl("subsonic://testuser:testpass@demo.navidrome.org");
    expect(result).toEqual({
      serverUrl: "https://demo.navidrome.org",
      username: "testuser",
      password: "testpass",
    });
  });

  it("parses with port and path", () => {
    const result = parseSubsonicUrl("subsonic://user:pass@myserver.com:4533/music");
    expect(result).toEqual({
      serverUrl: "https://myserver.com:4533/music",
      username: "user",
      password: "pass",
    });
  });

  it("decodes percent-encoded credentials", () => {
    const result = parseSubsonicUrl("subsonic://user%40domain:p%40ss%3Aword@host.com");
    expect(result).toEqual({
      serverUrl: "https://host.com",
      username: "user@domain",
      password: "p@ss:word",
    });
  });

  it("returns null for missing username", () => {
    expect(parseSubsonicUrl("subsonic://host.com")).toBeNull();
  });

  it("returns null for invalid URL", () => {
    expect(parseSubsonicUrl("not a url")).toBeNull();
  });

  it("handles empty password", () => {
    const result = parseSubsonicUrl("subsonic://user:@host.com");
    expect(result).toEqual({
      serverUrl: "https://host.com",
      username: "user",
      password: "",
    });
  });
});

describe("shouldScrobble", () => {
  it("returns false for null duration", () => {
    expect(shouldScrobble(100, null)).toBe(false);
  });

  it("returns false for tracks under 30 seconds", () => {
    expect(shouldScrobble(25, 29)).toBe(false);
    expect(shouldScrobble(15, 15)).toBe(false);
  });

  it("returns true at 50% for short tracks", () => {
    // 60s track: threshold = min(30, 240) = 30
    expect(shouldScrobble(29, 60)).toBe(false);
    expect(shouldScrobble(30, 60)).toBe(true);
  });

  it("returns true at 50% for medium tracks", () => {
    // 180s track: threshold = min(90, 240) = 90
    expect(shouldScrobble(89, 180)).toBe(false);
    expect(shouldScrobble(90, 180)).toBe(true);
  });

  it("caps at 240 seconds for long tracks", () => {
    // 1200s track: threshold = min(600, 240) = 240
    expect(shouldScrobble(239, 1200)).toBe(false);
    expect(shouldScrobble(240, 1200)).toBe(true);
  });

  it("returns true for exactly 30s track at 50%", () => {
    expect(shouldScrobble(15, 30)).toBe(true);
    expect(shouldScrobble(14, 30)).toBe(false);
  });
});
