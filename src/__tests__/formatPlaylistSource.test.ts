import { describe, it, expect } from "vitest";
import { formatPlaylistSource } from "../components/QueuePanel";

describe("formatPlaylistSource", () => {
  it("returns null for null/undefined/empty", () => {
    expect(formatPlaylistSource(null)).toBeNull();
    expect(formatPlaylistSource(undefined)).toBeNull();
    expect(formatPlaylistSource("")).toBeNull();
  });

  it("maps known kinds to friendly labels", () => {
    expect(formatPlaylistSource("album")).toBe("Playing from album");
    expect(formatPlaylistSource("artist")).toBe("Playing from artist");
    expect(formatPlaylistSource("tag")).toBe("Playing from tag");
    expect(formatPlaylistSource("playlist")).toBe("Playing from playlist");
  });

  it("normalizes case and whitespace", () => {
    expect(formatPlaylistSource("ALBUM")).toBe("Playing from album");
    expect(formatPlaylistSource("  artist  ")).toBe("Playing from artist");
  });

  it("falls back to verbatim 'Playing from <source>' for unknown kinds", () => {
    expect(formatPlaylistSource("mixtape")).toBe("Playing from mixtape");
    expect(formatPlaylistSource("Spotify Radio")).toBe("Playing from spotify radio");
  });
});
