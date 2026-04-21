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
  it("returns true when enabled and track is remote and not resolved from Library", () => {
    expect(shouldAutoSave(true, "tidal://123/456", "TIDAL")).toBe(true);
  });

  it("returns false when auto-save is disabled", () => {
    expect(shouldAutoSave(false, "tidal://123/456", "TIDAL")).toBe(false);
  });

  it("returns false for local file:// tracks", () => {
    expect(shouldAutoSave(true, "file:///path/song.mp3", "Local")).toBe(false);
  });

  it("returns false when resolved from Library (local copy found)", () => {
    expect(shouldAutoSave(true, "tidal://123/456", "Library")).toBe(false);
  });

  it("returns true for subsonic:// tracks", () => {
    expect(shouldAutoSave(true, "subsonic://server/123", "Subsonic")).toBe(true);
  });
});
