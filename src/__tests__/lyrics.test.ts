import { describe, it, expect } from "vitest";
import {
  parseLrc,
  currentSyncedLineIndex,
  activeSyncedLine,
  syncedLyricsFitMedia,
  plainLines,
  pickLineByRatio,
  hashStringToRatio,
  lyricPosition,
  clampLyricOffset,
  formatLyricOffset,
  lyricOffsetKey,
  centeredScrollTop,
  LYRIC_OFFSET_MAX,
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

describe("centeredScrollTop", () => {
  // A 400px-tall lyrics box at viewport y=100, holding 2000px of lines,
  // currently scrolled 300px in.
  const box = { top: 100, scrollTop: 300, viewHeight: 400, scrollHeight: 2000 };

  it("centers the line within the container", () => {
    // Line is 20px tall at viewport y=150 → 50px below the box top, i.e. at
    // content offset 350. Centered, its middle (360) sits at half the view
    // height (200), so scrollTop = 360 − 200 = 160.
    expect(centeredScrollTop(box, { top: 150, height: 20 })).toBe(160);
  });

  it("is a no-op for a line already centered", () => {
    // Middle of the view is box.top + 200 = 300; a 20px line centered there
    // starts at 290.
    expect(centeredScrollTop(box, { top: 290, height: 20 })).toBe(box.scrollTop);
  });

  it("clamps at the top for a line near the start", () => {
    // First line of the song: centering it would need a negative scrollTop.
    expect(centeredScrollTop({ ...box, scrollTop: 0 }, { top: 110, height: 20 })).toBe(0);
  });

  it("clamps at the bottom for a line near the end", () => {
    // Last line: the box can scroll at most scrollHeight − viewHeight = 1600.
    // This clamp is the case the ancestor-scrolling bug lived in — with
    // scrollIntoView, the leftover centering distance was taken from the
    // Now Playing view's own overflow:hidden box instead.
    expect(centeredScrollTop({ ...box, scrollTop: 1600 }, { top: 470, height: 20 })).toBe(1600);
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

  it("rejects lyrics that cover only a sliver of a long video", () => {
    // A concert/DJ-set upload, or an extended edit: the lyrics are real but
    // they describe a fraction of what is on screen, so they can't be in sync.
    expect(syncedLyricsFitMedia(lines, 600)).toBe(false);
    const song = parseLrc("[03:20.00]end"); // last line at 200s
    expect(syncedLyricsFitMedia(song, 4800)).toBe(false); // 80-minute concert
    expect(syncedLyricsFitMedia(song, 480)).toBe(false);  // 8-minute extended remix (0.42)
  });

  it("accepts a music video with an ordinary intro/outro", () => {
    const song = parseLrc("[03:20.00]end"); // last line at 200s
    expect(syncedLyricsFitMedia(song, 270)).toBe(true); // 4:30 video → 0.74
    expect(syncedLyricsFitMedia(song, 215)).toBe(true); // 3:35 video → 0.93
  });

  it("applies the coverage floor at the boundary", () => {
    const song = parseLrc("[01:00.00]end"); // last line at 60s
    expect(syncedLyricsFitMedia(song, 100)).toBe(true);  // exactly 0.6
    expect(syncedLyricsFitMedia(song, 101)).toBe(false); // just under
    expect(syncedLyricsFitMedia(song, 200, 10, 0.3)).toBe(true); // floor is tunable
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

describe("lyricPosition", () => {
  // The sign is the whole point of the helper: this is the direction a music
  // video with an intro needs, and getting it backwards is silent (the lyrics
  // just go further out of sync as you "fix" them).
  it("a POSITIVE offset delays the lyrics", () => {
    // 15s intro: at 20s of video, the song itself is 5s in.
    expect(lyricPosition(20, 15)).toBe(5);
    const lines = parseLrc(LRC); // first line at 1s
    // Without the offset the first line is already up at 2s...
    expect(currentSyncedLineIndex(lines, 2)).toBe(0);
    // ...with a +5s delay it isn't yet.
    expect(currentSyncedLineIndex(lines, lyricPosition(2, 5))).toBe(-1);
    expect(currentSyncedLineIndex(lines, lyricPosition(6.5, 5))).toBe(0);
  });

  it("a NEGATIVE offset advances them", () => {
    expect(lyricPosition(20, -3)).toBe(23);
    const lines = parseLrc(LRC); // second line at 5.5s
    expect(currentSyncedLineIndex(lines, lyricPosition(4, -2))).toBe(1);
  });

  it("is identity at zero", () => {
    expect(lyricPosition(42.5, 0)).toBe(42.5);
  });
});

describe("clampLyricOffset", () => {
  it("quantises to one decimal so repeated steps stay readable", () => {
    expect(clampLyricOffset(0.5 + 0.5 + 0.5)).toBe(1.5);
    expect(clampLyricOffset(1.5000000000000002)).toBe(1.5);
    expect(clampLyricOffset(0.24)).toBe(0.2);
  });

  it("clamps to the supported range in both directions", () => {
    expect(clampLyricOffset(999)).toBe(LYRIC_OFFSET_MAX);
    expect(clampLyricOffset(-999)).toBe(-LYRIC_OFFSET_MAX);
  });

  // Non-finite is corrupt input, not a big offset — falling through to the clamp
  // would silently apply a full 60s delay from a garbage stored value.
  it("treats non-finite input as no offset", () => {
    expect(clampLyricOffset(NaN)).toBe(0);
    expect(clampLyricOffset(Infinity)).toBe(0);
    expect(clampLyricOffset(-Infinity)).toBe(0);
  });

  it("still clamps large finite values", () => {
    expect(clampLyricOffset(Number.MAX_SAFE_INTEGER)).toBe(LYRIC_OFFSET_MAX);
  });
});

describe("formatLyricOffset", () => {
  it("signs the value and keeps one decimal", () => {
    expect(formatLyricOffset(0)).toBe("0.0s");
    expect(formatLyricOffset(2.5)).toBe("+2.5s");
    expect(formatLyricOffset(-1)).toBe("−1.0s");
  });

  it("uses a true minus sign, not a hyphen", () => {
    expect(formatLyricOffset(-1)).toContain("−");
    expect(formatLyricOffset(-1)).not.toContain("-");
  });
});

describe("lyricOffsetKey", () => {
  it("keys on metadata, case-insensitively", () => {
    expect(lyricOffsetKey({ title: "Jóga", artist_name: "Björk" }))
      .toBe(lyricOffsetKey({ title: "JÓGA", artist_name: "BJÖRK" }));
  });

  it("separates different songs and a missing artist", () => {
    expect(lyricOffsetKey({ title: "A", artist_name: "X" }))
      .not.toBe(lyricOffsetKey({ title: "B", artist_name: "X" }));
    expect(lyricOffsetKey({ title: "A", artist_name: null })).toBe("track::a");
  });
});
