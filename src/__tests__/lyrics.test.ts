import { describe, it, expect } from "vitest";
import {
  parseLrc,
  currentSyncedLineIndex,
  syncedLineAt,
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

describe("syncedLineAt", () => {
  const lines = parseLrc(LRC);
  it("returns the current line", () => {
    expect(syncedLineAt(lines, 6)).toBe("Second line");
  });
  it("falls back to the first line before playback reaches the first timestamp", () => {
    expect(syncedLineAt(lines, 0)).toBe("First line");
  });
  it("walks back over blank instrumental-gap lines", () => {
    const gapped = parseLrc(["[00:01.00]Sing", "[00:05.00]", "[00:09.00]"].join("\n"));
    expect(syncedLineAt(gapped, 10)).toBe("Sing");
  });
  it("returns null when there are no lines or none are sung", () => {
    expect(syncedLineAt([], 5)).toBeNull();
    expect(syncedLineAt(parseLrc("[00:01.00]\n[00:02.00]"), 5)).toBeNull();
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
