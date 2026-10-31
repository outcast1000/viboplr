import { describe, expect, it } from "vitest";
import type { Track } from "../types";
import {
  importSourcePath, importTargetArgs, parseTrackQuery, sameRecordingCopies, storedDefaultCollection,
} from "../utils/libraryImport";

function row(id: number, path: string, duration_secs: number | null): Track {
  return { id, path, title: "Hyperballad", artist_name: "Björk", duration_secs } as Track;
}

describe("sameRecordingCopies", () => {
  it("puts local files first, then the nearest length, and drops another recording", () => {
    const rows = [
      row(1, "subsonic://nav/1", 321),
      row(2, "file:///m/b/gh.mp3", 318),
      row(3, "file:///m/b/live.mp3", 372),
      row(4, "file:///m/b/post.mp3", 321),
    ];
    expect(sameRecordingCopies(rows, 320.5).map((t) => t.id)).toEqual([4, 2, 1]);
  });

  it("keeps everything when the length isn't known", () => {
    const rows = [row(1, "file:///a", 100), row(2, "file:///b", null)];
    expect(sameRecordingCopies(rows, null).map((t) => t.id)).toEqual([1, 2]);
  });

  it("keeps a copy whose own length is unknown", () => {
    expect(sameRecordingCopies([row(1, "file:///a", null)], 300).map((t) => t.id)).toEqual([1]);
  });
});

describe("request parsing", () => {
  it("needs a title and an artist", () => {
    expect(() => parseTrackQuery({ title: "Angel" })).toThrow(/title, artist/);
    expect(() => importTargetArgs({ artist: "Massive Attack" }, null, "importFile")).toThrow(/importFile/);
  });

  it("trims names, drops junk numbers and keeps the default", () => {
    expect(importTargetArgs(
      { title: " Angel ", artist: "Massive Attack", album: "  ", trackNumber: 1.5, collectionId: "3" },
      7, "planImport",
    )).toEqual({
      title: "Angel", artistName: "Massive Attack", albumTitle: null, trackNumber: null,
      collectionId: null, defaultCollectionId: 7, keepWithExisting: true,
    });
    expect(importTargetArgs({ title: "A", artist: "B", keepWithExisting: false }, null, "x").keepWithExisting).toBe(false);
  });

  it("needs a path to import", () => {
    expect(() => importSourcePath({})).toThrow(/path/);
    expect(importSourcePath({ path: " file:///d/x.flac " })).toBe("file:///d/x.flac");
  });

  it("reads the download modal's last collection", () => {
    expect(storedDefaultCollection("12")).toBe(12);
    expect(storedDefaultCollection(null)).toBeNull();
    expect(storedDefaultCollection("nope")).toBeNull();
  });
});
