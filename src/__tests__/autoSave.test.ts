import { describe, it, expect } from "vitest";
import { isRemoteScheme, shouldAutoSave } from "../queueEntry";

describe("isRemoteScheme", () => {
  it("returns true for tidal:// URLs", () => {
    expect(isRemoteScheme("tidal://123/456")).toBe(true);
  });

  it("returns true for subsonic:// URLs", () => {
    expect(isRemoteScheme("subsonic://server.com/123")).toBe(true);
  });

  it("returns false for file:// URLs", () => {
    expect(isRemoteScheme("file:///path/to/song.mp3")).toBe(false);
  });

  it("returns false for http/https URLs", () => {
    expect(isRemoteScheme("https://cdn.example.com/stream")).toBe(false);
  });

  it("returns false for paths without scheme", () => {
    expect(isRemoteScheme("/path/to/song.mp3")).toBe(false);
  });
});

describe("shouldAutoSave", () => {
  const map = { "tidal-browse:tidal-fallback": true, "youtube:youtube-fallback": false };

  it("returns true when resolver is enabled in map", () => {
    expect(shouldAutoSave(map, "tidal://123/456", "tidal-browse:tidal-fallback")).toBe(true);
  });

  it("returns false when resolver is disabled in map", () => {
    expect(shouldAutoSave(map, "external://yt/abc", "youtube:youtube-fallback")).toBe(false);
  });

  it("returns false when resolver ID is null", () => {
    expect(shouldAutoSave(map, "tidal://123/456", null)).toBe(false);
  });

  it("returns false when resolver ID is not in map", () => {
    expect(shouldAutoSave(map, "tidal://123/456", "unknown:resolver")).toBe(false);
  });

  it("returns false for local file:// tracks", () => {
    expect(shouldAutoSave(map, "file:///path/song.mp3", "tidal-browse:tidal-fallback")).toBe(false);
  });

  it("returns false with empty map", () => {
    expect(shouldAutoSave({}, "tidal://123/456", "tidal-browse:tidal-fallback")).toBe(false);
  });
});
