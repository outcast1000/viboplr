import { describe, it, expect } from "vitest";
import {
  parseLrc,
  currentSyncedLineIndex,
  activeSyncedLine,
  syncedLyricsFitMedia,
  plainLines,
  pickLineByRatio,
  hashStringToRatio,
} from "../utils/lyrics";

const LRC = ["[00:01.00]First line", "[00:05.50]Second line", "[00:10.00]Third line"].join("\n");

describe("parseLrc", () => {
  it("parses timestamps and text", () => {
    const lines = parseLrc(LRC);
    expect(lines).toEqual([
      { time: 1, text: "First line" },
      { time: 5.5, text: "Second line" },
      { time: 10, text: "Third line" },
    ]);
  });

  it("handles millisecond timestamps and ignores non-LRC lines", () => {
    const lines = parseLrc("metadata\n[00:02.500]Hello\nnope");
    expect(lines).toEqual([{ time: 2.5, text: "Hello" }]);
  });

  it("returns empty for plain text", () => {
    expect(parseLrc("just\nsome\nwords")).toEqual([]);
  });
});

describe("currentSyncedLineIndex", () => {
  const lines = parseLrc(LRC);
  it("returns -1 before the first line", () => {
    expect(currentSyncedLineIndex(lines, 0)).toBe(-1);
  });
  it("returns the active line index", () => {
    expect(currentSyncedLineIndex(lines, 1)).toBe(0);
    expect(currentSyncedLineIndex(lines, 7)).toBe(1);
    expect(currentSyncedLineIndex(lines, 999)).toBe(2);
  });
});

describe("activeSyncedLine", () => {
  const lines = parseLrc(LRC);
  it("returns the line currently being sung", () => {
    expect(activeSyncedLine(lines, 1)).toBe("First line");
    expect(activeSyncedLine(lines, 6)).toBe("Second line");
    expect(activeSyncedLine(lines, 999)).toBe("Third line");
  });
  it("returns null before the first line (intro)", () => {
    expect(activeSyncedLine(lines, 0)).toBeNull();
  });
  it("returns null on a blank instrumental-gap line instead of lingering on the last sung line", () => {
    const gapped = parseLrc(["[00:01.00]Sing", "[00:05.00]", "[00:09.00]Again"].join("\n"));
    expect(activeSyncedLine(gapped, 3)).toBe("Sing");
    expect(activeSyncedLine(gapped, 6)).toBeNull();
    expect(activeSyncedLine(gapped, 10)).toBe("Again");
  });
  it("returns null when there are no lines", () => {
    expect(activeSyncedLine([], 5)).toBeNull();
  });
});

describe("plainLines", () => {
  it("trims and drops blank lines", () => {
    expect(plainLines("  a \n\n  b\n   \nc")).toEqual(["a", "b", "c"]);
  });
});

describe("pickLineByRatio", () => {
  const lines = ["a", "b", "c", "d"];
  it("maps ratio to an index", () => {
    expect(pickLineByRatio(lines, 0)).toBe("a");
    expect(pickLineByRatio(lines, 0.5)).toBe("c");
    expect(pickLineByRatio(lines, 0.99)).toBe("d");
  });
  it("clamps out-of-range ratios into bounds", () => {
    expect(pickLineByRatio(lines, 1)).toBe("d");
    expect(pickLineByRatio(lines, -1)).toBe("a");
  });
  it("returns null for an empty list", () => {
    expect(pickLineByRatio([], 0.5)).toBeNull();
  });
});

describe("hashStringToRatio", () => {
  it("is deterministic and in [0,1)", () => {
    const r = hashStringToRatio("track:42");
    expect(r).toBe(hashStringToRatio("track:42"));
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });
  it("varies between different inputs", () => {
    expect(hashStringToRatio("song-a:100")).not.toBe(hashStringToRatio("song-b:250"));
  });
});

describe("syncedLyricsFitMedia", () => {
  const lines = parseLrc(LRC); // last line at 10s

  it("accepts lyrics that fit within the media length (+ tolerance)", () => {
    expect(syncedLyricsFitMedia(lines, 12)).toBe(true);   // ends 10s, media 12s
    expect(syncedLyricsFitMedia(lines, 10)).toBe(true);   // exactly
    expect(syncedLyricsFitMedia(lines, 5)).toBe(true);    // within default 10s tolerance
  });

  it("accepts a much longer (extended/instrumental) video", () => {
    expect(syncedLyricsFitMedia(lines, 600)).toBe(true);
  });

  it("rejects lyrics that run well past the media (wrong/short clip)", () => {
    expect(syncedLyricsFitMedia(lines, 3, 2)).toBe(false); // 10s lyrics, 3s media, tight tolerance
    const longLrc = parseLrc("[03:20.00]end"); // last line at 200s
    expect(syncedLyricsFitMedia(longLrc, 30)).toBe(false); // full-song lyrics over a 30s preview
  });

  it("allows when the media duration is unknown", () => {
    expect(syncedLyricsFitMedia(lines, null)).toBe(true);
    expect(syncedLyricsFitMedia(lines, 0)).toBe(true);
    expect(syncedLyricsFitMedia(lines, undefined)).toBe(true);
  });

  it("rejects empty lyrics against a known duration", () => {
    expect(syncedLyricsFitMedia([], 180)).toBe(false);
  });
});
