import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  resolveStreamChain,
  stripRemasterSuffix,
  createLibraryStreamResolver,
  type StreamResolver,
} from "../streamResolvers";

function makeResolver(
  overrides: Partial<StreamResolver> & { id: string },
): StreamResolver {
  return {
    name: overrides.id,
    source: "test",
    resolve: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("resolveStreamChain", () => {
  it("returns first non-null result", async () => {
    const resolvers: StreamResolver[] = [
      makeResolver({ id: "a", resolve: vi.fn().mockResolvedValue(null) }),
      makeResolver({
        id: "b",
        resolve: vi.fn().mockResolvedValue({ url: "tidal://123", label: "TIDAL" }),
      }),
      makeResolver({ id: "c", resolve: vi.fn().mockResolvedValue(null) }),
    ];

    const result = await resolveStreamChain(resolvers, "Title", "Artist", "Album");
    expect(result).toEqual({ url: "tidal://123", label: "TIDAL" });
    // Resolver c should not be called since b returned a result
    expect(resolvers[2].resolve).not.toHaveBeenCalled();
  });

  it("returns null when all resolvers return null", async () => {
    const resolvers: StreamResolver[] = [
      makeResolver({ id: "a" }),
      makeResolver({ id: "b" }),
    ];

    const result = await resolveStreamChain(resolvers, "Title", "Artist", null);
    expect(result).toBeNull();
  });

  it("skips resolvers that throw errors", async () => {
    const resolvers: StreamResolver[] = [
      makeResolver({
        id: "a",
        resolve: vi.fn().mockRejectedValue(new Error("network error")),
      }),
      makeResolver({
        id: "b",
        resolve: vi.fn().mockResolvedValue({ url: "file:///song.mp3", label: "Library" }),
      }),
    ];

    const result = await resolveStreamChain(resolvers, "Title", null, null);
    expect(result).toEqual({ url: "file:///song.mp3", label: "Library" });
  });

  it("skips resolvers that exceed timeout", async () => {
    const slowResolve = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ url: "slow://1", label: "Slow" }), 10_000)),
    );
    const resolvers: StreamResolver[] = [
      makeResolver({ id: "slow", resolve: slowResolve }),
      makeResolver({
        id: "fast",
        resolve: vi.fn().mockResolvedValue({ url: "tidal://1", label: "TIDAL" }),
      }),
    ];

    const result = await resolveStreamChain(resolvers, "Title", "Artist", null, null, 50);
    expect(result).toEqual({ url: "tidal://1", label: "TIDAL" });
  });

  it("returns null for empty resolver list", async () => {
    const result = await resolveStreamChain([], "Title", "Artist", null);
    expect(result).toBeNull();
  });
});

describe("createLibraryStreamResolver", () => {
  const LOCAL = { path: "file:///music/Fire Spirit.mp3", format: "mp3" };
  const SUBSONIC = { path: "subsonic://navidrome.example/42", format: "mp3" };

  function mockLibrary(matches: Array<{ path: string; format: string | null }>, fileOnDisk = true) {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "find_tracks_by_metadata") return Promise.resolve(matches);
      if (cmd === "file_exists") return Promise.resolve(fileOnDisk);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
  }

  beforeEach(() => {
    invoke.mockReset();
  });

  it("prefers the local copy and attributes it with a file:// sourceUrl", async () => {
    // The prefix is load-bearing: effectiveLocalPath and the queue-thumb
    // localPath derivation both key on it — a bare path reads as remote.
    mockLibrary([LOCAL, SUBSONIC]);
    const result = await createLibraryStreamResolver().resolve("Fire Spirit", "The Gun Club", null, null);
    expect(result).toMatchObject({ url: LOCAL.path, sourceUrl: LOCAL.path, format: "mp3", video: false });
  });

  it("falls through a local row whose file is gone to the network copy", async () => {
    mockLibrary([LOCAL, SUBSONIC], false);
    const result = await createLibraryStreamResolver().resolve("Fire Spirit", "The Gun Club", null, null);
    expect(result).toMatchObject({ url: SUBSONIC.path, sourceUrl: SUBSONIC.path });
  });

  it("returns null when the only copy's file is gone", async () => {
    mockLibrary([LOCAL], false);
    expect(await createLibraryStreamResolver().resolve("Fire Spirit", "The Gun Club", null, null)).toBeNull();
  });

  it("returns null when nothing matches", async () => {
    mockLibrary([]);
    expect(await createLibraryStreamResolver().resolve("Skeletons", "The Sound", null, null)).toBeNull();
  });

  it("strips remaster suffixes from the lookup, not the answer", async () => {
    mockLibrary([LOCAL]);
    await createLibraryStreamResolver().resolve("Fire Spirit - 2011 Remaster", "The Gun Club", "Fire Of Love - Remastered", null);
    expect(invoke).toHaveBeenCalledWith("find_tracks_by_metadata", {
      title: "Fire Spirit",
      artistName: "The Gun Club",
      albumName: "Fire Of Love",
    });
  });

  it("reports the matched copy's media kind so the chain can reclassify", async () => {
    mockLibrary([{ path: "file:///music/Concert.mkv", format: "mkv" }]);
    const result = await createLibraryStreamResolver().resolve("Concert", "Band", null, null);
    expect(result).toMatchObject({ video: true, format: "mkv" });
  });

  describe("preferVideo (the prefer-video pass)", () => {
    const LOCAL_VIDEO = { path: "file:///music/Fire Spirit.mkv", format: "mkv" };

    it("picks the video copy even when an audio copy is preferred by source order", async () => {
      // Without the hint the walk answers with the first copy — the audio one —
      // which the video-only pass would reject, and the user's own music-video
      // file would never be reached.
      mockLibrary([LOCAL, SUBSONIC, LOCAL_VIDEO]);
      const result = await createLibraryStreamResolver().resolve("Fire Spirit", "The Gun Club", null, null, { preferVideo: true });
      expect(result).toMatchObject({ url: LOCAL_VIDEO.path, video: true, format: "mkv" });
    });

    it("answers null when no video copy exists, so the pass falls through", async () => {
      mockLibrary([LOCAL, SUBSONIC]);
      expect(
        await createLibraryStreamResolver().resolve("Fire Spirit", "The Gun Club", null, null, { preferVideo: true }),
      ).toBeNull();
    });

    it("still verifies a local video copy exists on disk", async () => {
      mockLibrary([LOCAL_VIDEO], false);
      expect(
        await createLibraryStreamResolver().resolve("Fire Spirit", "The Gun Club", null, null, { preferVideo: true }),
      ).toBeNull();
    });
  });
});

describe("stripRemasterSuffix", () => {
  it("strips remaster suffix after dash", () => {
    expect(stripRemasterSuffix("Song Title - Remastered 2024")).toBe("Song Title");
    expect(stripRemasterSuffix("Song Title - 2011 Remaster")).toBe("Song Title");
    expect(stripRemasterSuffix("Song Title - Remaster")).toBe("Song Title");
  });

  it("is case-insensitive", () => {
    expect(stripRemasterSuffix("Song - REMASTERED")).toBe("Song");
    expect(stripRemasterSuffix("Song - remastered edition")).toBe("Song");
  });

  it("leaves titles without remaster unchanged", () => {
    expect(stripRemasterSuffix("Song Title")).toBe("Song Title");
    expect(stripRemasterSuffix("Song - Live Version")).toBe("Song - Live Version");
    expect(stripRemasterSuffix("Song - Deluxe Edition")).toBe("Song - Deluxe Edition");
  });

  it("handles null and undefined", () => {
    expect(stripRemasterSuffix(null)).toBeNull();
    expect(stripRemasterSuffix(undefined)).toBeUndefined();
  });

  it("works for album names too", () => {
    expect(stripRemasterSuffix("Abbey Road - 2019 Remaster")).toBe("Abbey Road");
    expect(stripRemasterSuffix("OK Computer - Remastered Deluxe")).toBe("OK Computer");
  });
});
