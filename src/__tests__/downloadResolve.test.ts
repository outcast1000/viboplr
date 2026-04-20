import { describe, it, expect } from "vitest";
import { resolveDownload } from "../hooks/useDownloads";
import type { DownloadProvider } from "../types/plugin";

describe("resolveDownload", () => {
  it("returns first successful result", async () => {
    const providers: DownloadProvider[] = [
      { id: "p1:a", name: "A", source: "p1", resolve: async () => null },
      { id: "p2:b", name: "B", source: "p2", resolve: async () => ({ url: "https://cdn.example.com/track.flac", headers: null, metadata: null }) },
    ];
    const result = await resolveDownload(providers, "Song", "Artist", "Album", "flac");
    expect(result).toEqual({ url: "https://cdn.example.com/track.flac", headers: null, metadata: null });
  });

  it("returns null when all providers fail", async () => {
    const providers: DownloadProvider[] = [
      { id: "p1:a", name: "A", source: "p1", resolve: async () => null },
      { id: "p2:b", name: "B", source: "p2", resolve: async () => { throw new Error("fail"); } },
    ];
    const result = await resolveDownload(providers, "Song", "Artist", "Album", "flac");
    expect(result).toBeNull();
  });

  it("skips erroring providers and continues", async () => {
    const providers: DownloadProvider[] = [
      { id: "p1:a", name: "A", source: "p1", resolve: async () => { throw new Error("crash"); } },
      { id: "p2:b", name: "B", source: "p2", resolve: async () => ({ url: "https://ok.com/t.flac", headers: null, metadata: null }) },
    ];
    const result = await resolveDownload(providers, "Song", "Artist", "Album", "flac");
    expect(result?.url).toBe("https://ok.com/t.flac");
  });

  it("times out slow providers", async () => {
    const providers: DownloadProvider[] = [
      { id: "p1:slow", name: "Slow", source: "p1", resolve: () => new Promise((r) => setTimeout(() => r({ url: "https://late.com", headers: null, metadata: null }), 200)) },
      { id: "p2:fast", name: "Fast", source: "p2", resolve: async () => ({ url: "https://fast.com/t.flac", headers: null, metadata: null }) },
    ];
    const result = await resolveDownload(providers, "Song", "Artist", "Album", "flac", 50);
    expect(result?.url).toBe("https://fast.com/t.flac");
  });
});
