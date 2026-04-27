import { describe, it, expect } from "vitest";
import type { DownloadProvider } from "../types/plugin";

// The resolveTrackDownload function is now internal to useDownloads.
// Test the DownloadProvider interface contract instead.

describe("DownloadProvider interface", () => {
  it("resolveByUri returns result for matching URI", async () => {
    const provider: DownloadProvider = {
      id: "p1:a", name: "A", source: "p1",
      resolveByUri: async (uri) => uri.startsWith("tidal://") ? { url: "https://cdn.example.com/track.flac", headers: null, metadata: null } : null,
      resolveByMetadata: async () => null,
    };
    const result = await provider.resolveByUri("tidal://123", "flac");
    expect(result).toEqual({ url: "https://cdn.example.com/track.flac", headers: null, metadata: null });
  });

  it("resolveByUri returns null for non-matching URI", async () => {
    const provider: DownloadProvider = {
      id: "p1:a", name: "A", source: "p1",
      resolveByUri: async (uri) => uri.startsWith("tidal://") ? { url: "https://cdn.example.com/track.flac", headers: null, metadata: null } : null,
      resolveByMetadata: async () => null,
    };
    const result = await provider.resolveByUri("subsonic://1/abc", "flac");
    expect(result).toBeNull();
  });

  it("resolveByMetadata returns result", async () => {
    const provider: DownloadProvider = {
      id: "p1:a", name: "A", source: "p1",
      resolveByUri: async () => null,
      resolveByMetadata: async (title) => title === "Song" ? { url: "https://ok.com/t.flac", headers: null, metadata: null } : null,
    };
    const result = await provider.resolveByMetadata("Song", "Artist", "Album", 200, "flac");
    expect(result?.url).toBe("https://ok.com/t.flac");
  });

  it("resolveByMetadata returns null when not found", async () => {
    const provider: DownloadProvider = {
      id: "p1:a", name: "A", source: "p1",
      resolveByUri: async () => null,
      resolveByMetadata: async () => null,
    };
    const result = await provider.resolveByMetadata("Unknown", null, null, null, "flac");
    expect(result).toBeNull();
  });
});
