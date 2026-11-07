import { describe, expect, it } from "vitest";
import { clockAt, formatClock, lastCueEnd, readSheet } from "../cuePlayer/sheet";

const item = (sheet: unknown, extra: Record<string, unknown> = {}) => ({ title: "Even Flow", artistName: "Pearl Jam", durationSecs: 293.6, sheet, ...extra });

describe("the Community player's sheet reader", () => {
  it("reads a clip with its camera and runs for the song's length", () => {
    const s = readSheet(item({ mode: "clip", camera: [{ at: 0, until: 10, move: "push-in" }], cues: [{ at: 5, kind: "text", text: "hi" }] }));
    expect(s?.mode).toBe("clip");
    expect(s?.camera).toHaveLength(1);
    expect(s?.length).toBe(293.6);
    expect(s?.title).toBe("Even Flow");
  });

  it("falls back to when the last element leaves when the length isn't known", () => {
    const s = readSheet(item({ cues: [{ at: 5, until: 40 }, { at: 50 }] }, { durationSecs: null }));
    expect(s?.mode).toBe("cards");
    expect(s?.length).toBe(60); // 50 + the default 10s
    expect(lastCueEnd([{ at: 1, kind: "text" }])).toBe(11);
  });

  it("drops cues it can't time, sorts the rest, and strips non-finite numbers", () => {
    const s = readSheet(item({ cues: [{ at: 20, kind: "text" }, { at: "x" }, { at: -1 }, { at: 3, until: 2, size: "big", box: { x: 0, y: 0, w: 100 } }] }));
    expect(s?.cues.map((c) => c.at)).toEqual([3, 20]);
    expect(s?.cues[0].until).toBeUndefined(); // until before at
    expect(s?.cues[0].size).toBeUndefined(); // not a number
    expect(s?.cues[0].box).toBeUndefined(); // h missing
  });

  it("keeps only https pictures", () => {
    const s = readSheet(item({ cues: [{ at: 0, kind: "image", imageUrl: "http://x/a.jpg" }, { at: 1, kind: "image", imageUrl: "https://x/b.jpg" }] }));
    expect(s?.cues[0].imageUrl).toBeUndefined();
    expect(s?.cues[1].imageUrl).toBe("https://x/b.jpg");
  });

  it("ignores an unusable tempo grid and refuses a sheet with nothing to play", () => {
    expect(readSheet(item({ mode: "clip", beats: { bpm: 0, offset: 1 }, cues: [{ at: 0 }] }))?.beats).toBeUndefined();
    expect(readSheet(item({ cues: [] }))).toBeNull();
    expect(readSheet(item({ cues: [{ at: "soon" }] }))).toBeNull();
    expect(readSheet(null)).toBeNull();
  });

  it("formats and runs the clock, holding at the end", () => {
    expect(formatClock(293.6)).toBe("4:53");
    expect(formatClock(-3)).toBe("0:00");
    expect(clockAt(10, 2500, 100)).toBe(12.5);
    expect(clockAt(99, 5000, 100)).toBe(100);
  });
});
